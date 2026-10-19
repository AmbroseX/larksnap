#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给一个文档站地址，探它是什么框架、有没有「捷径」能直接拿到原始 Markdown。
用法: python3 probe_docs.py https://xxx/docs/ https://yyy/guide/ ...
"""
import concurrent.futures as cf, gzip, json, re, sys, urllib.error, urllib.request, zlib
from urllib.parse import urlsplit, urlunsplit

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


class R308(urllib.request.HTTPRedirectHandler):
    def http_error_308(self, req, fp, code, msg, headers):
        return self.http_error_301(req, fp, 301, msg, headers)
    https_error_308 = http_error_308


OPENER = urllib.request.build_opener(R308)


def get(url, limit=400_000):
    """返回 (状态码, 内容类型, 正文前 limit 字节, 最终地址)。失败返回 (0, err, '', url)"""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Accept-Encoding": "gzip", "Accept": "*/*"})
        with OPENER.open(req, timeout=25) as r:
            raw = r.read(limit)
            if r.headers.get("Content-Encoding") == "gzip":
                try:
                    # 只读了前 limit 字节，gzip 流是截断的，得用增量解压
                    raw = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(raw)
                except Exception:
                    try:
                        raw = gzip.decompress(raw)
                    except Exception:
                        pass
            return r.status, (r.headers.get("Content-Type") or "").split(";")[0], \
                   raw.decode("utf-8", "replace"), r.url
    except urllib.error.HTTPError as e:
        return e.code, "", "", url
    except Exception as e:
        return 0, type(e).__name__, "", url


# 框架指纹：命中的关键词 -> 框架名
FINGER = [
    ("Mintlify",   ["mintlify.com", "_mintlify", "mintlify-assets"]),
    ("Docusaurus", ["__docusaurus", "docusaurus.config", "/assets/js/runtime~main"]),
    ("VitePress",  ["__VP_HASH_MAP__", "VPDoc", "vitepress/dist"]),
    ("Nextra",     ["__nextra", "nextra-content", "nextra-scrollbar"]),
    ("Starlight",  ["starlight/", "sl-markdown-content", "astro-island"]),
    ("Fumadocs",   ["fumadocs", "fd-sidebar"]),
    ("MkDocs-Material", ["data-md-color-scheme", "md-header__", "md-nav__"]),
    ("Sphinx",     ["documentation_options.js", "_static/basic.css", "sphinx-highlight"]),
    ("GitBook",    ["gitbook.io", "gitbook-x-prod", "__GITBOOK"]),
    ("Docsify",    ["docsify.min.js", "docsify/lib"]),
    ("Next.js",    ["__NEXT_DATA__", "/_next/static"]),
]


def fingerprint(html):
    low = html.lower()
    hits = [name for name, keys in FINGER if any(k.lower() in low for k in keys)]
    return hits


def has_next_markdown(html):
    """Next.js 站：__NEXT_DATA__ 里有没有现成的 markdown 字段"""
    m = re.search(r'id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        return None
    try:
        pp = json.loads(m.group(1))["props"]["pageProps"]
    except Exception:
        return None
    for k in ("markdown", "mdxSource", "content", "source", "body", "compiledSource"):
        v = pp.get(k)
        if isinstance(v, str) and len(v) > 200:
            return f"pageProps.{k} ({len(v)} 字)"
    return "有 __NEXT_DATA__ 但没现成正文字段"


def looks_html(ct, body):
    b = body.lstrip()[:200].lower()
    return "html" in ct or b.startswith("<!doctype") or b.startswith("<html")


def check(url, want="text"):
    """探一个地址。返回 (是否真的可用, 说明)。专门防「返回 200 的软 404 页」。"""
    code, ct, body, final = get(url, limit=200_000)
    if code != 200 or not body.strip():
        return False, f"{code or ct}"
    if want == "zip":
        if not body.startswith("PK"):
            return False, "不是zip"
        return True, f"{len(body)}+字节"
    if want == "inv":
        if not body.lstrip().startswith("# Sphinx inventory"):
            return False, "软404(不是inv)"
        return True, f"{len(body)}+字节"
    if want == "text" and looks_html(ct, body):
        return False, "软404(返回HTML)"
    if want == "json":
        if looks_html(ct, body):
            return False, "软404(返回HTML)"
        if body.lstrip()[:1] not in "{[":
            return False, "不是JSON"
    return True, f"{len(body)}+字节 {ct or ''}".strip()


def probe(url):
    s = urlsplit(url)
    origin = urlunsplit((s.scheme, s.netloc, "", "", ""))
    path = s.path.rstrip("/")
    # 文档根，比如 /docs/zh/foundry/a/b -> 猜 /docs
    seg = [x for x in path.split("/") if x]
    docroot = origin + ("/" + seg[0] if seg else "")

    code, ct, html, final = get(url)
    out = {"url": url, "status": code, "final": final,
           "frameworks": fingerprint(html) if html else [],
           "shortcuts": []}
    if html:
        nm = has_next_markdown(html)
        if nm:
            out["next_markdown"] = nm

    # 逐级路径前缀都当成「文档根」试一遍：
    # /en/latest/xxx 这类带语言和版本号的站，索引文件挂在第二三层，只试根目录会漏
    bases = [origin]
    acc = ""
    for x in seg:
        acc += "/" + x
        bases.append(origin + acc)
    bases = list(dict.fromkeys(bases))

    jobs = []
    for b in bases:
        jobs += [
            (f"llms-full.txt @{b[len(origin):] or '/'}", b + "/llms-full.txt", "text"),
            (f"llms.txt @{b[len(origin):] or '/'}", b + "/llms.txt", "text"),
            (f"MkDocs全文索引 @{b[len(origin):] or '/'}", b + "/search/search_index.json", "json"),
            (f"Sphinx objects.inv @{b[len(origin):] or '/'}", b + "/objects.inv", "inv"),
        ]
    jobs.append(("sitemap.xml", origin + "/sitemap.xml", "text"))
    # ReadTheDocs 托管的站：整站打包下载
    for lv in ("en/latest", "en/stable"):
        jobs.append((f"RTD整包 {lv}", f"{origin}/_/downloads/{lv}/htmlzip/", "zip"))

    # 单页级捷径：能不能直接拿这一页的源码
    page_probes = [
        ("<页面>.md", path + ".md", "text"),
        ("<页面>/index.md", path + "/index.md", "text"),
        ("<页面>.html.md", path + ".html.md", "text"),
    ]
    jobs += [(n, origin + p, w) for n, p, w in page_probes if path]
    # Sphinx 原始 rst：_sources 挂在文档根下
    for b in bases:
        rest = path[len(b) - len(origin):]
        if rest:
            jobs.append((f"Sphinx _sources @{b[len(origin):] or '/'}",
                         b + "/_sources" + re.sub(r'\.html$', '', rest) + ".rst.txt", "text"))
    seen_u = set()
    jobs = [j for j in jobs if not (j[1] in seen_u or seen_u.add(j[1]))]

    with cf.ThreadPoolExecutor(8) as ex:
        futs = {ex.submit(check, u, w): (n, u) for n, u, w in jobs}
        for f in cf.as_completed(futs):
            n, u = futs[f]
            try:
                ok, note = f.result()
            except Exception as e:
                ok, note = False, type(e).__name__
            if ok:
                out["shortcuts"].append((n, u, note))
    return out


def main():
    urls = sys.argv[1:]
    with cf.ThreadPoolExecutor(6) as ex:
        for r in ex.map(probe, urls):
            print("=" * 78)
            print(f"{r['url']}  [{r['status']}]")
            if r["final"] != r["url"]:
                print(f"  跳转到: {r['final']}")
            print(f"  框架指纹: {', '.join(r['frameworks']) or '认不出'}")
            if r.get("next_markdown"):
                print(f"  ★ __NEXT_DATA__: {r['next_markdown']}")
            if r["shortcuts"]:
                for n, u, note in sorted(r["shortcuts"]):
                    print(f"  ★ {n:26s} {note:22s} {u}")
            else:
                print("  (没探到捷径，得走侧边栏 BFS + HTML 转换)")


if __name__ == "__main__":
    main()
