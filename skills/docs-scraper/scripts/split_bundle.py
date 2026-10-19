#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「一次请求下整包」的文档拆成一页一个 Markdown 文件。
支持两种包（自动识别）：
  1. MkDocs Material 的 search/search_index.json —— 按小节存的，要按页合并
  2. Mintlify 风格的 llms-full.txt —— 每页以 "# 标题 / Source: 网址" 开头

用法:
  python3 split_bundle.py --in vllm_idx.json --out ./out_vllm --base https://docs.vllm.ai/en/latest/
  python3 split_bundle.py --in sglang_llms.txt --out ./out_sglang
"""
import argparse, json, os, re, sys
from urllib.parse import urlsplit

BLOCK_RE = re.compile(r'^# (?P<title>.+)\nSource:[ \t]*(?P<url>\S+)[ \t]*$', re.M)


def safe_path(out, rel, default="index"):
    rel = (rel or "").strip("/")
    parts = [re.sub(r'[^\w.\-一-鿿]+', '-', p).strip("-") or "_"
             for p in rel.split("/") if p]
    if not parts:
        parts = [default]
    return os.path.join(out, *parts) + ".md"


def write(fp, title, source, body):
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, "w", encoding="utf-8") as f:
        f.write(f"---\ntitle: {json.dumps(title, ensure_ascii=False)}\n"
                f"source: {source}\n---\n\n{body}\n")


def split_mkdocs(data, out, base):
    """search_index.json：一条 = 一个小节，按 location 的锚点前缀归并成页"""
    pages = {}
    for x in data["docs"]:
        loc = x.get("location", "")
        key = loc.split("#")[0]
        pages.setdefault(key, []).append(x)

    n = 0
    for key, entries in sorted(pages.items()):
        root = [e for e in entries if "#" not in e.get("location", "")]
        secs = [e for e in entries if "#" in e.get("location", "")]
        title = (root[0]["title"] if root else (secs[0]["title"] if secs else key)) or key
        parts = []
        head = root[0]["text"].strip() if root else ""
        if head:
            parts.append(head)
        for e in secs:
            t = (e.get("text") or "").strip()
            if not t or (head and t in head):     # 小节内容已经包含在整页正文里就别重复
                continue
            parts.append(f"## {e.get('title') or ''}\n\n{t}")
        body = "\n\n".join(parts).strip()
        if not body:
            continue
        write(safe_path(out, key), title, (base.rstrip("/") + "/" + key) if base else key, body)
        n += 1
    return n


def split_llms_full(text, out):
    """llms-full.txt：按 '# 标题 / Source: 网址' 切块"""
    marks = list(BLOCK_RE.finditer(text))
    if len(marks) < 3:
        return 0
    n = 0
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[m.end():end].strip()
        url = m.group("url")
        if not body:
            continue
        write(safe_path(out, urlsplit(url).path), m.group("title").strip(), url, body)
        n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base", default="", help="MkDocs 索引用：页面地址前缀，用来还原 source")
    a = ap.parse_args()

    raw = open(a.src, encoding="utf-8", errors="replace").read()
    n = 0
    try:
        data = json.loads(raw)
    except Exception:
        data = None

    if isinstance(data, dict) and isinstance(data.get("docs"), list):
        print(f"识别为 MkDocs 全文索引：{len(data['docs'])} 条")
        n = split_mkdocs(data, a.out, a.base)
    else:
        n = split_llms_full(raw, a.out)
        if n:
            print("识别为 llms-full.txt（带 Source 标记）")

    if not n:
        heads = len(re.findall(r'^# ', raw, re.M))
        print("没认出格式，拆不了。", file=sys.stderr)
        print(f"提示：文件里有 {heads} 个一级标题，但没有 'Source: 网址' 这样的分页标记。\n"
              "     Ray 那种把 rST 源码直接拼起来的 llms-full.txt 就属于这类，"
              "无法可靠还原页面边界，建议改走 sitemap 或单页 .md。", file=sys.stderr)
        sys.exit(2)

    idx = sorted(os.path.relpath(os.path.join(r, f), a.out)
                 for r, _, fs in os.walk(a.out) for f in fs if f.endswith(".md") and f != "_index.md")
    with open(os.path.join(a.out, "_index.md"), "w", encoding="utf-8") as f:
        f.write("# 目录\n\n" + "\n".join(f"- [{p[:-3]}]({p})" for p in idx) + "\n")
    print(f"完成：拆出 {n} 页 -> {a.out}")


if __name__ == "__main__":
    main()
