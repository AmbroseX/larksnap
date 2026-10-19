---
name: docs-scraper
description: 把整个文档网站批量抓成本地 Markdown。适用于侧边栏层级很深、页数成百上千的技术文档站（Palantir/vLLM/Stripe/react.dev/VitePress/MkDocs/Docusaurus/Sphinx/GitBook/Mintlify 等）。当用户说要抓文档站、下载整站文档、把某个 docs 站离线保存、导出某个框架的全部文档、爬文档做知识库或喂 RAG 时使用本技能，即使没有提到 docs-scraper。核心是先探测站点暴露了哪条捷径再选工具，不要一上来就写爬虫。
---

# docs-scraper

抓文档站的关键不是写爬虫，是**先探路**。现代文档站为了喂 AI，大多主动提供了原始
Markdown 入口，能直接拿到源码就别去解析 HTML。

**第一步永远是探测，不要跳过。**

```bash
python3 scripts/probe_docs.py https://目标站/某个文档页
```

它会认框架、把下面 7 条路挨个试一遍，告诉你哪条通。

## 选路阶梯（越靠前越省事）

| # | 捷径 | 一次拿到 | 用哪个脚本 |
|---|---|---|---|
| 1 | `llms-full.txt` | 整站全文，1 次请求 | `split_bundle.py` |
| 2 | 页面地址加 `.md` | 单页原始 Markdown | `crawl_md.py` |
| 3 | MkDocs `search/search_index.json` | 整站纯文本，1 次请求 | `split_bundle.py` |
| 4 | Sphinx `_sources/*.rst.txt` | 单页原始 rST | `crawl_html.py`（走 sitemap） |
| 5 | `__NEXT_DATA__` 里的正文字段 | 单页 Markdown | `crawl_next.py` |
| 6 | `sitemap.xml` 出 URL 清单 | 只有清单 | `crawl_html.py --sitemap` |
| 7 | 顺着链接 BFS | 兜底 | `crawl_html.py --seed` |

**第 3 条有坑**：MkDocs 索引存的是剥掉标签的纯文本，代码块、链接、表格全丢。
实测 uv 84 个页面 0 个代码块，vLLM 同页面对比 25 个代码块 → 0 个。
**只在明确"仅做全文检索"时用它，要存档一律走第 6 条。**

## 四个抓取脚本

所有脚本都是并发 BFS + 落盘带 YAML 头的 Markdown，另外生成 `_manifest.json` 和 `_index.md`。

```bash
# 第 1/3 条：整包拆单页（先自己 curl 下来）
python3 scripts/split_bundle.py --in bundle.txt --out ./out

# 第 2 条：抓 .md 兄弟文件（Stripe/react.dev/vite/HuggingFace/GitBook/Mintlify）
python3 scripts/crawl_md.py --seed https://docs.stripe.com/payments \
    --scope /payments --out ./out --concurrency 8

# 第 5 条：解析 __NEXT_DATA__（Palantir 这类多语言 Next.js 站）
python3 scripts/crawl_next.py --seed https://www.palantir.com/docs/zh/foundry/xxx/ \
    --scope /zh/foundry/ --out ./out --resume

# 第 6/7 条：HTML 转 Markdown（兜底，覆盖其余全部）
~/miniconda3/bin/python3 scripts/crawl_html.py \
    --sitemap https://docs.vllm.ai/sitemap.xml --scope /en/latest/ --out ./out
# 没有 sitemap 的站（比如 Tailwind）改用 --seed 顺着链接爬
~/miniconda3/bin/python3 scripts/crawl_html.py \
    --seed https://tailwindcss.com/docs/flex --scope /docs --out ./out
```

公共参数：`--concurrency`（默认 8）、`--limit`（先小跑几页验证选路对不对）、
`--delay`（每线程每页间隔，默认 0.15 秒，别把人家服务器打疼）。
`crawl_next.py` 还有 `--resume` 断点续抓。

## 依赖

前五个脚本**纯标准库**，任何 python3 都能跑。

`crawl_html.py` 需要 `bs4` + `lxml`。本机走 `~/miniconda3/bin/python3`（已装）。
换环境可用 `DOCS_SCRAPER_PY3` 环境变量指定解释器。

## 动手前必读

- **先 `--limit 10` 小跑一遍**，确认标题提出来了、正文不空、代码块还在，再放开全量。
- 抓之前看一眼 `robots.txt`，并发别超过 10。
- 选路踩过的坑（尾斜杠、跳转换域名、文档根深度等）见
  [references/pitfalls.md](references/pitfalls.md)，换个站大概率还会遇到。
- 各条路线的判定细节和实测站点清单见 [references/routes.md](references/routes.md)。

## 回归测试

```bash
python3 scripts/run_tests.py            # 11 个真实站点，每站抓 10 页
python3 scripts/run_tests.py vite.dev   # 只跑某一个
```

判据是抓够页数、零空页、标题全部提取成功。改完脚本跑一遍再提交。
