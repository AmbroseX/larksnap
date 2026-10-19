#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
兜底方案：没有任何「捷径」的文档站（Starlight / Tailwind / Docusaurus / MkDocs 等），
用 sitemap 拿 URL 清单，抓 HTML，自己转成 Markdown。

需要 bs4 + lxml，用 miniconda 那个解释器跑：
  ~/miniconda3/bin/python3 crawl_html.py --sitemap https://docs.vllm.ai/sitemap.xml \
      --scope /en/latest/ --out ./out --concurrency 8
"""
import argparse, gzip, json, os, queue, re, threading, time, urllib.error, urllib.request, zlib
from urllib.parse import urljoin, urlsplit
from bs4 import BeautifulSoup, NavigableString, Tag

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# 正文容器：按顺序试，命中即止。覆盖主流文档框架
MAIN_SELECTORS = [
    ".md-content__inner",            # MkDocs Material
    "article.md-content__inner",
    ".theme-doc-markdown",           # Docusaurus
    ".sl-markdown-content",          # Starlight
    "main .vp-doc",                  # VitePress
    "div.document .body",            # Sphinx 经典主题
    "div[itemprop='articleBody']",   # Sphinx RTD 主题
    "article[role='main']",
    "main[role='main']",
    "[role='main']",
    "article",
    "main",
]
# 正文里要扔掉的噪音
DROP = ["script", "style", "noscript", "nav", "footer", "form", "svg",
        ".headerlink", ".md-source-file", ".md-content__button", ".edit-this-page",
        ".theme-doc-toc-mobile", ".pagination-nav", "[aria-hidden='true']"]


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
                "User-Agent": UA, "Accept-Encoding": "gzip"})
            with OPENER.open(req, timeout=45) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    try:
                        raw = gzip.decompress(raw)
                    except Exception:
                        raw = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(raw)
                return raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (404, 403, 410):
                raise
            time.sleep(1.5 * (i + 1))
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


# ---------- HTML -> Markdown ----------
LANG_RE = re.compile(r'(?:language|highlight|lang)[-_]([a-z0-9+#]+)', re.I)


def guess_lang(node):
    """从 class 里猜代码语言：language-python / highlight-py / lang-js 都认"""
    for el in (node, node.parent, node.find("code") if isinstance(node, Tag) else None):
        if not isinstance(el, Tag):
            continue
        for c in (el.get("class") or []):
            m = LANG_RE.search(c)
            if m and m.group(1).lower() not in ("text", "none"):
                return m.group(1).lower()
    return ""


def inline(node, base):
    """行内元素转文本"""
    if isinstance(node, NavigableString):
        return re.sub(r'\s+', ' ', str(node))
    if not isinstance(node, Tag):
        return ""
    n = node.name
    if n in ("script", "style"):
        return ""
    if n == "br":
        return "\n"
    kids = "".join(inline(c, base) for c in node.children)
    if n == "code":
        t = kids.strip()
        return f"`{t}`" if t else ""
    if n in ("strong", "b"):
        return f"**{kids.strip()}**" if kids.strip() else ""
    if n in ("em", "i"):
        return f"*{kids.strip()}*" if kids.strip() else ""
    if n == "del":
        return f"~~{kids.strip()}~~" if kids.strip() else ""
    if n == "a":
        href = (node.get("href") or "").strip()
        t = kids.strip()
        if not t:
            return ""
        if not href or href.startswith("#"):
            return t
        return f"[{t}]({urljoin(base, href)})"
    if n == "img":
        src = (node.get("src") or "").strip()
        return f"![{node.get('alt','')}]({urljoin(base, src)})" if src else ""
    return kids


def cell_text(td, base):
    return inline(td, base).strip().replace("|", "\\|").replace("\n", " ")


def block(node, base, depth=0):
    """块级元素转 Markdown，返回若干段落"""
    if isinstance(node, NavigableString):
        t = re.sub(r'\s+', ' ', str(node)).strip()
        return [t] if t else []
    if not isinstance(node, Tag):
        return []
    n = node.name
    if n in ("script", "style", "noscript"):
        return []

    if re.fullmatch(r'h[1-6]', n or ""):
        t = inline(node, base).strip()
        return [f"{'#' * int(n[1])} {t}"] if t else []

    if n == "pre":
        code = node.get_text()
        code = code.rstrip("\n")
        if not code.strip():
            return []
        return [f"```{guess_lang(node)}\n{code}\n```"]

    if n in ("ul", "ol"):
        out, i = [], 1
        for li in node.find_all("li", recursive=False):
            mark = f"{i}." if n == "ol" else "-"
            i += 1
            # 先取 li 里的行内内容，再递归处理嵌套的块
            head_parts, tail = [], []
            for c in li.children:
                if isinstance(c, Tag) and c.name in ("ul", "ol", "pre", "table", "blockquote"):
                    tail += block(c, base, depth + 1)
                else:
                    head_parts.append(inline(c, base))
            head = re.sub(r'\s+', ' ', "".join(head_parts)).strip()
            pad = "  " * depth
            if head:
                out.append(f"{pad}{mark} {head}")
            for t in tail:
                out.append("\n".join(("  " * (depth + 1)) + ln for ln in t.split("\n")))
        return out

    if n == "table":
        rows = node.find_all("tr")
        if not rows:
            return []
        head = [cell_text(c, base) for c in rows[0].find_all(["th", "td"])]
        if not head:
            return []
        lines = ["| " + " | ".join(head) + " |",
                 "| " + " | ".join("---" for _ in head) + " |"]
        for r in rows[1:]:
            cells = [cell_text(c, base) for c in r.find_all(["th", "td"])]
            if cells:
                cells += [""] * (len(head) - len(cells))
                lines.append("| " + " | ".join(cells[:len(head)]) + " |")
        return ["\n".join(lines)]

    if n == "blockquote":
        inner = []
        for c in node.children:
            inner += block(c, base, depth)
        if not inner:
            return []
        return ["\n".join("> " + ln for p in inner for ln in p.split("\n"))]

    if n == "hr":
        return ["---"]

    if n == "p":
        t = inline(node, base).strip()
        return [t] if t else []

    # 其它容器：递归往下走
    out = []
    for c in node.children:
        out += block(c, base, depth)
    return out


def html_to_md(soup_main, base):
    parts = []
    for c in soup_main.children:
        parts += block(c, base)
    md = "\n\n".join(p for p in parts if p and p.strip())
    return re.sub(r'\n{3,}', '\n\n', md).strip()


def pick_main(soup):
    """挑出正文容器，顺便把导航、脚注这些噪音删掉"""
    main = None
    for sel in MAIN_SELECTORS:
        try:
            main = soup.select_one(sel)
        except Exception:
            main = None
        if main and len(main.get_text(strip=True)) > 120:
            break
        main = None
    if main is None:
        main = soup.body or soup
    for sel in DROP:
        for el in main.select(sel):
            el.decompose()
    return main


def load_sitemap(url, scope, host_only=True):
    """读 sitemap（支持 sitemap 索引嵌套一层），返回落在 scope 里的路径"""
    seen, out = set(), []
    todo = [url]
    while todo:
        u = todo.pop()
        if u in seen:
            continue
        seen.add(u)
        try:
            xml = fetch(u)
        except Exception as e:
            print(f"  sitemap 读不了 {u}: {e}")
            continue
        locs = re.findall(r'<loc>\s*([^<]+?)\s*</loc>', xml)
        if "<sitemapindex" in xml[:2000]:
            todo += [l for l in locs if l.endswith(".xml")][:50]
            continue
        for l in locs:
            p = urlsplit(l).path
            if p.startswith(scope):
                out.append(p.rstrip("/") or "/")
    return sorted(set(out))


class Crawler:
    def __init__(self, origin, out, conc, delay, limit, scope="", bfs=False):
        self.origin, self.out = origin, out
        self.scope, self.bfs = scope, bfs
        self.seen = set()
        self.conc, self.delay, self.limit = conc, delay, limit
        self.q = queue.Queue()
        self.lock = threading.Lock()
        self.inflight = 0
        self.done, self.fail, self.manifest = 0, [], []
        self.total = 0

    def push(self, p):
        if not p or not p.startswith(self.scope):
            return
        with self.lock:
            if p in self.seen or (self.limit and len(self.seen) >= self.limit):
                return
            self.seen.add(p)
            self.total = len(self.seen)
        self.q.put(p)

    def collect(self, soup, url):
        """BFS 模式：整页所有 <a> 都收（侧边栏也在里面），过滤后进队列"""
        for a in soup.find_all("a", href=True):
            h = a["href"].split("#")[0].strip()
            if not h or h.startswith(("mailto:", "tel:", "javascript:")):
                continue
            u = urljoin(url, h)
            sp = urlsplit(u)
            if sp.netloc != urlsplit(self.origin).netloc:
                continue
            q = sp.path.rstrip("/") or "/"
            if re.search(r'\.(png|jpe?g|gif|svg|webp|pdf|zip|css|js|ico|mp4|xml|txt)$', q, re.I):
                continue
            self.push(q)

    def handle(self, path):
        url = self.origin + path
        soup = BeautifulSoup(fetch(url), "lxml")
        if self.bfs:
            self.collect(soup, url)
        h1 = soup.find(["h1"])
        title = h1.get_text(" ", strip=True) if h1 else (
            soup.title.get_text(strip=True) if soup.title else path)
        title = re.sub(r'\s*[¶#]\s*$', '', title)
        md = html_to_md(pick_main(soup), url)
        if len(md) < 40:
            raise RuntimeError("正文太短，可能选错了容器")
        fp = os.path.join(self.out, *(path.strip("/") or "index").split("/")) + ".md"
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        with open(fp, "w", encoding="utf-8") as f:
            f.write(f"---\ntitle: {json.dumps(title, ensure_ascii=False)}\n"
                    f"source: {url}\n---\n\n{md}\n")
        with self.lock:
            self.done += 1
            self.manifest.append({"path": path, "title": title,
                                  "file": os.path.relpath(fp, self.out), "chars": len(md)})
            n = self.done
        if n % 10 == 0 or n == self.total:
            print(f"  [{n}/{self.total}] {path}", flush=True)

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

    def run(self, paths):
        if self.bfs:
            for p in paths:
                self.push(p)
        else:
            if self.limit:
                paths = paths[:self.limit]
            self.total = len(paths)
            for p in paths:
                self.q.put(p)
        ts = [threading.Thread(target=self.worker, daemon=True) for _ in range(self.conc)]
        [t.start() for t in ts]
        [t.join() for t in ts]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sitemap", help="URL 清单来源；没有 sitemap 的站改用 --seed")
    ap.add_argument("--seed", action="append", help="没 sitemap 时从这里开始顺着链接爬")
    ap.add_argument("--scope", required=True)
    ap.add_argument("--out", default="./out")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--delay", type=float, default=0.15)
    a = ap.parse_args()

    if not a.sitemap and not a.seed:
        print("要么给 --sitemap，要么给 --seed"); return
    src = a.sitemap or a.seed[0]
    s = urlsplit(src)
    origin = f"{s.scheme}://{s.netloc}"
    bfs = not a.sitemap
    if bfs:
        paths = [urlsplit(u).path.rstrip("/") or "/" for u in a.seed]
        print(f"没有 sitemap，从 {len(paths)} 个种子顺着链接爬，scope={a.scope}")
    else:
        print(f"读 sitemap: {a.sitemap}")
        paths = load_sitemap(a.sitemap, a.scope)
        print(f"scope={a.scope} 命中 {len(paths)} 个页面" + (f"（本次只抓前 {a.limit} 个）" if a.limit else ""))
        if not paths:
            print("sitemap 里没有符合 scope 的页面，检查 --scope"); return

    c = Crawler(origin, a.out, a.concurrency, a.delay, a.limit, a.scope, bfs)
    t0 = time.time()
    c.run(paths)

    os.makedirs(a.out, exist_ok=True)
    c.manifest.sort(key=lambda x: x["path"])
    json.dump(c.manifest, open(os.path.join(a.out, "_manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    with open(os.path.join(a.out, "_index.md"), "w", encoding="utf-8") as f:
        f.write("# 目录\n\n" + "\n".join(
            f"- [{m['title'] or m['path']}]({m['file']})" for m in c.manifest) + "\n")
    print(f"\n完成：{c.done} 页，失败 {len(c.fail)}，耗时 {time.time()-t0:.1f}s -> {a.out}")
    for p, e in c.fail[:10]:
        print("  失败:", p, e)


if __name__ == "__main__":
    main()
