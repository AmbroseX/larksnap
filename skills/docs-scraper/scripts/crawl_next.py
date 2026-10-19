#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抓 Palantir docs 这类 Next.js 文档站：正文 Markdown 直接躺在页面的 __NEXT_DATA__ 里，
不用浏览器、不用 HTML 转换。侧边栏树也在同一份 JSON 里，所以边抓边扩展待抓队列，
一直循环到没有新链接为止（BFS 闭包）。

用法：
  python3 crawl_next.py --seed https://www.palantir.com/docs/zh/foundry/transforms-python/getting-started/ \
      --scope /zh/foundry/transforms-python/ --out ./out --concurrency 8
"""
import argparse, gzip, json, os, queue, re, sys, threading, time, urllib.error, urllib.request
from urllib.parse import urlsplit

HOST = "https://www.palantir.com"
DOCS_PREFIX = "/docs"
OTHER_LOCALES = {"jp", "kr", "en"}          # 抓中文时，其它语种直接跳过
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " \
     "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"

class R308(urllib.request.HTTPRedirectHandler):
    def http_error_308(self, req, fp, code, msg, headers):
        return self.http_error_301(req, fp, 301, msg, headers)
    https_error_308 = http_error_308


OPENER = urllib.request.build_opener(R308)

NEXT_RE = re.compile(r'id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
# 正文里的站内链接：](/docs/xxx) 或 ](/zh/xxx)
MD_LINK_RE = re.compile(r'\]\((/(?:docs|zh|foundry)[^)\s"]*)')


# ---------- URL 规范化 ----------
def norm(u, lang="zh"):
    """把各种写法统一成 /zh/foundry/xxx/yyy/ 这种带语言前缀的路径；不要的返回 None。"""
    if not u:
        return None
    u = u.split("#")[0].split("?")[0]
    if u.startswith("http"):
        s = urlsplit(u)
        if s.netloc not in ("www.palantir.com", "palantir.com"):
            return None
        u = s.path
    if not u.startswith("/"):
        return None
    if u.startswith(DOCS_PREFIX):
        u = u[len(DOCS_PREFIX):] or "/"
    seg = [x for x in u.split("/") if x]
    if not seg:
        return None
    if seg[0] in OTHER_LOCALES:            # /jp/... /kr/... 不要
        return None
    if seg[0] != lang:                     # 正文链接常常不带语言前缀，补上
        seg = [lang] + seg
    return "/" + "/".join(seg) + "/"


def to_url(path):
    # 站点会把带尾斜杠的地址 308 跳到不带的，直接请求不带的，少一次往返
    return HOST + DOCS_PREFIX + path.rstrip("/")


def to_file(out, path):
    rel = path.strip("/")
    return os.path.join(out, *rel.split("/")) + ".md"


# ---------- 抓取 ----------
def fetch(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept-Encoding": "gzip",
                "Accept-Language": "zh-CN,zh;q=0.9",
            })
            with OPENER.open(req, timeout=45) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (404, 403):        # 没救，别重试
                raise
            time.sleep(1.5 * (i + 1))
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


# ---------- 解析一页 ----------
def collect_links(node, out):
    """递归把树里所有 link.url 收出来（侧边栏 / 顶部导航结构一样）。"""
    if isinstance(node, list):
        for x in node:
            collect_links(x, out)
    elif isinstance(node, dict):
        link = node.get("link")
        if isinstance(link, dict) and link.get("url"):
            out.append(link["url"])
        if node.get("url"):
            out.append(node["url"])
        for k in ("items", "children", "pages"):
            if node.get(k):
                collect_links(node[k], out)


def parse(html):
    m = NEXT_RE.search(html)
    if not m:
        return None
    pp = json.loads(m.group(1))["props"]["pageProps"]
    raw = []
    collect_links(pp.get("sidebarNavProps") or {}, raw)   # 侧边栏整棵树
    collect_links(pp.get("navBarProps") or {}, raw)       # 顶部各大分类
    nb = pp.get("pageNeighbours") or {}                   # 上一页/下一页
    for k in ("previousPage", "nextPage"):
        if isinstance(nb.get(k), dict) and nb[k].get("url"):
            raw.append(nb[k]["url"])
    md = pp.get("markdown") or ""
    raw += MD_LINK_RE.findall(md)                         # 正文里的站内链接
    meta = (pp.get("metadata") or {}).get("data") or {}
    return {
        "markdown": md,
        "title": meta.get("pageTitle") or "",
        "desc": meta.get("seoDescription") or "",
        "product": pp.get("productId") or "",
        "category": pp.get("categoryId") or "",
        "section": pp.get("sectionId") or "",
        "links": raw,
    }


def read_head(fp):
    """读回落盘文件头部的 title/category/section，用于续抓时重建清单。"""
    out = {}
    try:
        raw = open(fp, encoding="utf-8").read()
        out["chars"] = len(raw)
        if raw.startswith("---\n"):
            head = raw.split("\n---\n", 1)[0]
            for line in head.splitlines()[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    v = v.strip()
                    if v.startswith('"'):
                        try:
                            v = json.loads(v)
                        except Exception:
                            pass
                    out[k.strip()] = v
    except Exception:
        pass
    return out


# ---------- 并发 BFS ----------
class Crawler:
    def __init__(self, scope, out, lang, conc, limit, delay):
        self.scope, self.out, self.lang = scope, out, lang
        self.limit, self.delay = limit, delay
        self.q = queue.Queue()
        self.seen = set()               # 进过队列的
        self.lock = threading.Lock()
        self.done = 0
        self.fail = []
        self.manifest = []
        self.conc = conc
        self.inflight = 0          # 正在抓的页数，防止线程提前散伙
        self.resume = False
        self.skipped = 0
        self.linkcache = {}        # path -> 出链列表，续抓时靠它继续扩展队列
        self.lf = None
        self.stop = False

    def push(self, path):
        if not path or not path.startswith(self.scope):
            return
        with self.lock:
            if path in self.seen or (self.limit and len(self.seen) >= self.limit):
                return
            self.seen.add(path)
        self.q.put(path)

    def worker(self):
        while not self.stop:
            try:
                path = self.q.get(timeout=1)
            except queue.Empty:
                # 队列空了还不能走：可能别人正在抓的页会吐出新链接
                with self.lock:
                    if self.inflight == 0:
                        self.stop = True
                        return
                continue
            with self.lock:
                self.inflight += 1
            try:
                self.handle(path)
            except Exception as e:
                with self.lock:
                    self.fail.append((path, repr(e)[:120]))
            finally:
                with self.lock:
                    self.inflight -= 1
                self.q.task_done()
                if self.delay:
                    time.sleep(self.delay)

    def handle(self, path):
        fp0 = to_file(self.out, path)
        # 续抓：正文已在磁盘、出链也在缓存里，才真的能跳过；
        # 只有正文没出链的话还得重抓一次，否则 BFS 就断了
        if self.resume and os.path.exists(fp0) and os.path.getsize(fp0) > 0 \
                and path in self.linkcache:
            for u in self.linkcache[path]:
                self.push(norm(u, self.lang))
            info = read_head(fp0)          # 从已落盘文件的头部把清单条目补回来
            with self.lock:
                self.skipped += 1
                self.manifest.append({"path": path, "title": info.get("title", ""),
                                      "file": os.path.relpath(fp0, self.out),
                                      "category": info.get("category", ""),
                                      "section": info.get("section", ""),
                                      "chars": info.get("chars", 0)})
            return
        html = fetch(to_url(path))
        d = parse(html)
        if not d:
            raise RuntimeError("页面里没有 __NEXT_DATA__")
        if not d["markdown"].strip():
            raise RuntimeError("markdown 为空（可能是 404 软跳转）")
        # 先把新链接塞进队列，再落盘 —— 这样队列不会提前干涸
        for u in d["links"]:
            self.push(norm(u, self.lang))
        fp = to_file(self.out, path)
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        head = (f"---\ntitle: {json.dumps(d['title'], ensure_ascii=False)}\n"
                f"source: {to_url(path)}\n"
                f"product: {d['product']}\ncategory: {d['category']}\nsection: {d['section']}\n---\n\n")
        with open(fp, "w", encoding="utf-8") as f:
            f.write(head + d["markdown"])
        with self.lock:
            if self.lf:
                self.lf.write(json.dumps({"p": path, "l": d["links"]}, ensure_ascii=False) + "\n")
                self.lf.flush()
            self.done += 1
            self.manifest.append({"path": path, "title": d["title"], "file": os.path.relpath(fp, self.out),
                                  "category": d["category"], "section": d["section"], "chars": len(d["markdown"])})
            n, q = self.done, self.q.qsize()
        print(f"[{n}] 队列剩 {q}  {path}", flush=True)

    def load_cache(self):
        fp = os.path.join(self.out, "_links.jsonl")
        if os.path.exists(fp):
            for line in open(fp, encoding="utf-8"):
                try:
                    r = json.loads(line)
                    self.linkcache[r["p"]] = r["l"]
                except Exception:
                    pass
        print(f"出链缓存：{len(self.linkcache)} 页")

    def run(self, seeds):
        os.makedirs(self.out, exist_ok=True)
        if self.resume:
            self.load_cache()
        self.lf = open(os.path.join(self.out, "_links.jsonl"), "a", encoding="utf-8")
        for s in seeds:
            self.push(s)
        ts = [threading.Thread(target=self.worker, daemon=True) for _ in range(self.conc)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        if self.lf:
            self.lf.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", action="append", required=True, help="起始页，可给多个")
    ap.add_argument("--scope", required=True, help="只抓这个路径前缀下的，如 /zh/foundry/")
    ap.add_argument("--out", default="./out")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0, help="最多抓几页，0=不限")
    ap.add_argument("--resume", action="store_true", help="已落盘的页跳过，接着抓")
    ap.add_argument("--delay", type=float, default=0.15, help="每个线程每页之间歇多久（秒）")
    a = ap.parse_args()

    seeds = [norm(s, a.lang) for s in a.seed]
    c = Crawler(a.scope, a.out, a.lang, a.concurrency, a.limit, a.delay)
    c.resume = a.resume
    t0 = time.time()
    c.run(seeds)

    os.makedirs(a.out, exist_ok=True)
    # 续抓时跳过的页不在内存里，得和上次的清单合并，不然索引会被覆盖成空的
    mp = os.path.join(a.out, "_manifest.json")
    merged = {}
    if os.path.exists(mp):
        try:
            for r in json.load(open(mp, encoding="utf-8")):
                merged[r["path"]] = r
        except Exception:
            pass
    for r in c.manifest:
        merged[r["path"]] = r
    c.manifest = sorted(merged.values(), key=lambda x: x["path"])
    with open(mp, "w", encoding="utf-8") as f:
        json.dump(c.manifest, f, ensure_ascii=False, indent=1)
    lines = ["# 目录\n"]
    for m in c.manifest:
        lines.append(f"- [{m['title'] or m['path']}]({m['file']})")
    with open(os.path.join(a.out, "_index.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"\n完成：新抓 {c.done} 页，跳过 {c.skipped} 页，失败 {len(c.fail)}，耗时 {time.time()-t0:.1f}s，输出 {a.out}")
    for p, e in c.fail[:20]:
        print("  失败:", p, e)


if __name__ == "__main__":
    main()
