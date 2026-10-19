#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端测试：每条路线挑一个真实站点小跑一段，量化产出质量。"""
import glob, json, os, re, subprocess, sys, time

SYS = "python3"
CONDA = os.environ.get("DOCS_SCRAPER_PY3") or os.path.expanduser("~/miniconda3/bin/python3")
N = "10"          # 每个站只抓 10 页，别打扰人家

CASES = [
    ("Palantir/zh", "__NEXT_DATA__", SYS, ["crawl_next.py",
        "--seed", "https://www.palantir.com/docs/zh/foundry/transforms-python/getting-started/",
        "--scope", "/zh/foundry/transforms-python/", "--out", "t_palantir", "--limit", N]),
    ("Stripe", ".md兄弟文件", SYS, ["crawl_md.py",
        "--seed", "https://docs.stripe.com/payments", "--scope", "/payments",
        "--out", "t_stripe", "--limit", N]),
    ("react.dev", ".md兄弟文件", SYS, ["crawl_md.py",
        "--seed", "https://react.dev/learn", "--scope", "/learn",
        "--out", "t_react", "--limit", N]),
    ("vite.dev", ".md兄弟文件", SYS, ["crawl_md.py",
        "--seed", "https://vite.dev/guide/", "--scope", "/guide",
        "--out", "t_vite", "--limit", N]),
    ("docs.claude.com", ".md兄弟文件", SYS, ["crawl_md.py",
        "--seed", "https://platform.claude.com/docs/en/intro", "--scope", "/docs/en",
        "--out", "t_claude", "--limit", N]),
    ("HuggingFace", ".md兄弟文件", SYS, ["crawl_md.py",
        "--seed", "https://huggingface.co/docs/transformers/index",
        "--scope", "/docs/transformers", "--out", "t_hf", "--limit", N]),
    ("vLLM", "sitemap+HTML转换", CONDA, ["crawl_html.py",
        "--sitemap", "https://docs.vllm.ai/sitemap.xml", "--scope", "/en/latest/design/",
        "--out", "t_vllm", "--limit", N]),
    ("Starlight", "sitemap+HTML转换", CONDA, ["crawl_html.py",
        "--sitemap", "https://starlight.astro.build/sitemap-index.xml", "--scope", "/",
        "--out", "t_starlight", "--limit", N]),
    ("Docusaurus", "sitemap+HTML转换", CONDA, ["crawl_html.py",
        "--sitemap", "https://docusaurus.io/sitemap.xml", "--scope", "/docs",
        "--out", "t_docusaurus", "--limit", N]),
    ("Tailwind", "BFS+HTML转换", CONDA, ["crawl_html.py",
        "--seed", "https://tailwindcss.com/docs/flex", "--scope", "/docs",
        "--out", "t_tailwind", "--limit", N]),
    ("Kubernetes", "sitemap+HTML转换", CONDA, ["crawl_html.py",
        "--sitemap", "https://kubernetes.io/sitemap.xml", "--scope", "/docs/concepts",
        "--out", "t_k8s", "--limit", N]),
]


def body_of(p):
    t = open(p, encoding="utf-8", errors="replace").read()
    return t.split("\n---\n", 1)[1] if t.startswith("---\n") and "\n---\n" in t else t


def measure(d):
    fs = [f for f in glob.glob(f"{d}/**/*.md", recursive=True)
          if os.path.basename(f) != "_index.md"]
    if not fs:
        return None
    bodies = [body_of(f) for f in fs]
    heads = [open(f, encoding="utf-8", errors="replace").read()[:400] for f in fs]
    return {
        "页数": len(fs),
        "空页": sum(1 for b in bodies if len(b.strip()) < 40),
        "有标题": sum(1 for h in heads if re.search(r'^title:\s*"[^"]+"', h, re.M)),
        "有代码块": sum(1 for b in bodies if "```" in b),
        "有链接": sum(1 for b in bodies if re.search(r'\]\(', b)),
        "平均字节": int(sum(len(b) for b in bodies) / len(fs)),
    }


def main():
    only = sys.argv[1:] 
    rows = []
    for name, route, py, args in CASES:
        if only and name not in only:
            continue
        out = args[args.index("--out") + 1]
        subprocess.run(["rm", "-rf", out])
        t0 = time.time()
        r = subprocess.run([py] + args, capture_output=True, text=True, timeout=600)
        dt = time.time() - t0
        m = measure(out)
        err = ""
        if m is None:
            err = (r.stderr or r.stdout or "").strip().splitlines()[-1][:70] if (r.stderr or r.stdout) else "无输出"
        fails = re.findall(r'失败: (\S+)', r.stdout or "")
        rows.append((name, route, m, dt, err, len(fails)))

    print(f"\n{'站点':<17}{'路线':<17}{'页':>4}{'空':>4}{'标题':>5}{'代码块':>6}{'链接':>5}{'均字节':>8}{'秒':>6}  结果")
    print("-" * 92)
    ok = 0
    for name, route, m, dt, err, nf in rows:
        if m is None:
            print(f"{name:<17}{route:<17}{'—':>4}{'':>4}{'':>5}{'':>6}{'':>5}{'':>8}{dt:>6.0f}  ✗ {err}")
            continue
        good = m["空页"] == 0 and m["页数"] >= 5 and m["有标题"] == m["页数"]
        ok += good
        mark = "✓" if good else "△"
        note = "" if good else f"(空页{m['空页']} 缺标题{m['页数']-m['有标题']})"
        print(f"{name:<17}{route:<17}{m['页数']:>4}{m['空页']:>4}{m['有标题']:>5}"
              f"{m['有代码块']:>6}{m['有链接']:>5}{m['平均字节']:>8}{dt:>6.0f}  {mark} {note}")
    print("-" * 92)
    print(f"通过 {ok}/{len(rows)}")


if __name__ == "__main__":
    main()
