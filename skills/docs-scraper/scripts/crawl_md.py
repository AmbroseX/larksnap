#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用版：适用于「页面地址后面加 .md 就能拿到原始 Markdown」的文档站
（Stripe / react.dev / VitePress / GitBook / Mintlify 这一大类）。

正文本身就是 Markdown，里面的链接就是天然的爬取队列，所以照样是并发 BFS，
但比 Palantir 那版更通用：不认框架、不认语言前缀，只认「同源 + 路径前缀」。

用法:
  python3 crawl_md.py --seed https://docs.stripe.com/payments --scope /payments --out ./out
"""
import argparse, gzip, json, os, queue, re, threading, time, urllib.error, urllib.request, zlib
from urllib.parse import urljoin, urlsplit

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
LINK_RE = re.compile(r'\]\(\s*<?([^)>\s"]+)')      # Markdown 里的 [xx](yy)


class R308(urllib.request.HTTPRedirectHandler):
    def http_error_308(self, req, fp, code, msg, headers):
        return self.http_error_301(req, fp, 301, msg, headers)
    https_error_308 = http_error_308


OPENER = urllib.request.build_opener(R308)


def fetch(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept-Encoding": "gzip", "Accept": "text/markdown,*/*"})
            with OPENER.open(req, timeout=45) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(raw)
                ct = (r.headers.get("Content-Type") or "").split(";")[0]
                return raw.decode("utf-8", "replace"), ct, r.url
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (404, 403, 410):
                raise
            time.sleep(1.5 * (i + 1))
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


def strip_frontmatter(body):
    """有些站的 .md 自带 YAML 头（标题在里面），拆出来别套两层"""
    if not body.startswith("---\n"):
        return {}, body
    end = body.find("\n---", 4)
    if end < 0:
        return {}, body
    head, rest = body[4:end], body[end + 4:].lstrip("\n")
    fm = {}
    for line in head.splitlines():
        if ":" in line and not line.startswith((" ", "\t", "-")):
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip().strip('"\'')
    return fm, rest


class Crawler:
    def __init__(self, base, scope, out, conc, limit, delay, suffix):
        s = urlsplit(base)
        self.origin = f"{s.scheme}://{s.netloc}"
        self.host = s.netloc
        self.scope, self.out = scope, out
        self.conc, self.limit, self.delay = conc, limit, delay
        self.suffix = suffix
        self.q = queue.Queue()
        self.seen, self.lock = set(), threading.Lock()
        self.inflight = 0
        self.done, self.skipped = 0, 0
        self.fail, self.manifest = [], []
        self.alt = {}          # 路径 -> 另一种解析结果，404 时兜底试一次
        self.dirs = set()      # 哪些路径是「目录」（原地址带尾斜杠），影响 ./ 的解析
        self.hosts = {self.host}   # 整站跳到别的域名时，把新域名也认下来

    def _clean(self, p):
        if p.endswith(self.suffix):
            p = p[: -len(self.suffix)]
        p = p.rstrip("/") or "/"
        if re.search(r'\.(png|jpe?g|gif|svg|webp|pdf|zip|css|js|ico|mp4)$', p, re.I):
            return None
        return p

    def norm(self, u, cur):
        """把 markdown 里的链接解析成本站绝对路径。
        裸相对链接（不带 / 也不带 ./）在文档站里几乎都是「站点根相对」的写法，
        按根解析；真的想写兄弟页会用 ./ 或 ../。两种解释不一致时记下备胎，404 再试。"""
        if not u or u.startswith(("mailto:", "tel:", "#", "data:")):
            return None
        bare = not u.startswith(("/", "./", "../", "http")) and "://" not in u
        # cur 是目录的话要补尾斜杠，不然 urljoin 把 /guide 当文件，./cli 会解析成 /cli
        curbase = self.origin + cur + ("/" if cur in self.dirs else "")
        main = urljoin(self.origin + "/" if bare else curbase, u)
        s = urlsplit(main)
        if s.netloc not in self.hosts:
            return None
        p = s.path
        was_dir = s.path.endswith("/")
        p = self._clean(p)
        if was_dir and p:
            self.dirs.add(p)
        if bare and p:
            other = self._clean(urlsplit(urljoin(curbase, u)).path)
            if other and other != p:
                self.alt.setdefault(p, other)
        return p

    def push(self, p):
        if not p or not p.startswith(self.scope):
            return
        with self.lock:
            if p in self.seen or (self.limit and len(self.seen) >= self.limit):
                return
            self.seen.add(p)
        self.q.put(p)

    def handle(self, path):
        try:
            body, ct, final = fetch(self.origin + path + self.suffix)
        except urllib.error.HTTPError as e:
            other = self.alt.get(path)
            if e.code == 404 and other:
                self.push(other)          # 换一种解析方式，当成新任务重新排队
                return
            raise
        if body.lstrip()[:200].lower().startswith(("<!doctype", "<html")):
            raise RuntimeError("返回的是 HTML，不是 Markdown（该站可能不支持 .md）")
        if not body.strip():
            raise RuntimeError("空内容")
        # 整站跳到别的域名（比如 docs.x.com -> platform.x.com），把新域名也认下来
        fh = urlsplit(final).netloc
        if fh and fh not in self.hosts:
            with self.lock:
                self.hosts.add(fh)
        fm, body = strip_frontmatter(body)
        for u in LINK_RE.findall(body):
            self.push(self.norm(u, path))
        fp = os.path.join(self.out, *(path.strip("/") or "index").split("/")) + ".md"
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        m = re.search(r'^#\s+(.+)$', body, re.M)
        title = fm.get("title") or (m.group(1).strip() if m else "")
        with open(fp, "w", encoding="utf-8") as f:
            f.write(f"---\ntitle: {json.dumps(title, ensure_ascii=False)}\n"
                    f"source: {self.origin + path}\n---\n\n" + body)
        with self.lock:
            self.done += 1
            self.manifest.append({"path": path, "title": title,
                                  "file": os.path.relpath(fp, self.out), "chars": len(body)})
            n, qn = self.done, self.q.qsize()
        print(f"[{n}] 队列剩 {qn}  {path}", flush=True)

    def worker(self):
        while True:
            try:
                path = self.q.get(timeout=1)
            except queue.Empty:
                with self.lock:
                    if self.inflight == 0:
                        return
                continue
            with self.lock:
                self.inflight += 1
            try:
                self.handle(path)
            except Exception as e:
                with self.lock:
                    self.fail.append((path, repr(e)[:110]))
            finally:
                with self.lock:
                    self.inflight -= 1
                self.q.task_done()
                if self.delay:
                    time.sleep(self.delay)

    def run(self, seeds):
        for s in seeds:
            self.push(s)
        ts = [threading.Thread(target=self.worker, daemon=True) for _ in range(self.conc)]
        [t.start() for t in ts]
        [t.join() for t in ts]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", action="append", required=True)
    ap.add_argument("--scope", required=True, help="只抓这个路径前缀下的，如 /payments")
    ap.add_argument("--out", default="./out")
    ap.add_argument("--suffix", default=".md", help="原始文件后缀，个别站是 .html.md")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--delay", type=float, default=0.15)
    a = ap.parse_args()

    c = Crawler(a.seed[0], a.scope, a.out, a.concurrency, a.limit, a.delay, a.suffix)
    seeds = []
    for u in a.seed:
        sp = urlsplit(u).path
        p = sp.rstrip("/") or "/"
        if sp.endswith("/"):
            c.dirs.add(p)
        seeds.append(p)
    t0 = time.time()
    c.run(seeds)

    os.makedirs(a.out, exist_ok=True)
    c.manifest.sort(key=lambda x: x["path"])
    json.dump(c.manifest, open(os.path.join(a.out, "_manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    with open(os.path.join(a.out, "_index.md"), "w", encoding="utf-8") as f:
        f.write("# 目录\n\n" + "\n".join(
            f"- [{m['title'] or m['path']}]({m['file']})" for m in c.manifest) + "\n")
    print(f"\n完成：{c.done} 页，失败 {len(c.fail)}，耗时 {time.time()-t0:.1f}s，输出 {a.out}")
    for p, e in c.fail[:10]:
        print("  失败:", p, e)


if __name__ == "__main__":
    main()
