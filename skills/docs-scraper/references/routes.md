# 七条路线的判定细节与实测清单

## 怎么判定一条路通不通

探测最容易翻车的地方是**软 404**：站点返回 200，但内容是一个 HTML 错误页。
所以每条路都要按类型校验，不能只看状态码。

| 路线 | 探测地址 | 校验方式 |
|---|---|---|
| `llms-full.txt` / `llms.txt` | `<各级前缀>/llms.txt` | 内容不能是 HTML |
| `.md` 兄弟文件 | `<页面路径>.md` | Content-Type 是 text/markdown，且开头不是 `<!doctype` |
| MkDocs 索引 | `<各级前缀>/search/search_index.json` | 首字符是 `{`，**不要整体解析**（文件常有几 MB） |
| Sphinx `objects.inv` | `<各级前缀>/objects.inv` | 开头必须是 `# Sphinx inventory` |
| Sphinx `_sources` | `<前缀>/_sources/<相对路径>.rst.txt` | 内容不能是 HTML |
| ReadTheDocs 整包 | `/_/downloads/en/latest/htmlzip/` | 开头必须是 `PK`（zip 魔数） |
| `__NEXT_DATA__` | 页面 HTML 内 | `props.pageProps` 下找长度 > 200 的字符串字段 |

**"各级前缀"很重要**：`/en/latest/` 这类带语言和版本号的站，索引文件挂在第二三层，
只试根目录必然漏。要把路径的每一级都当成候选文档根试一遍。

## 框架指纹

只能用不会出现在正文里的特征串。用 `docusaurus` / `mkdocs` 这种普通词做指纹会翻车——
docusaurus.io 的首页文案里提到了竞品名，一次命中 7 个框架。

| 框架 | 特征串 |
|---|---|
| Docusaurus | `__docusaurus`、`docusaurus.config` |
| VitePress | `__VP_HASH_MAP__`、`VPDoc` |
| Nextra | `__nextra`、`nextra-content` |
| Starlight | `sl-markdown-content`、`astro-island` |
| MkDocs Material | `data-md-color-scheme`、`md-header__` |
| Sphinx | `documentation_options.js`、`sphinx-highlight` |
| Mintlify | `mintlify.com`、`_mintlify` |
| GitBook | `gitbook.io`、`__GITBOOK` |
| Next.js | `__NEXT_DATA__`、`/_next/static` |

## 实测站点清单

| 站点 | 框架 | 走哪条 | 规模 |
|---|---|---|---|
| docs.vllm.ai | MkDocs Material | sitemap + HTML 转换 | sitemap 2451 页（索引只有 314 页） |
| docs.sglang.ai | Mintlify | `llms-full.txt` | 923KB，304 页 |
| docs.stripe.com | 自研 | `.md` 兄弟文件 | — |
| react.dev | Next.js | `.md` 兄弟文件 | 也有 `pageProps.content` |
| vite.dev | VitePress | `.md` 兄弟文件 | `llms-full.txt` 425KB |
| platform.claude.com | Mintlify | `.md` 兄弟文件 | `llms-full.txt` 190KB |
| huggingface.co/docs | 自研 | `.md` 兄弟文件 | — |
| docs.gitbook.com | GitBook | `llms-full.txt` | 416KB |
| docs.astral.sh/uv | MkDocs Material | 索引 or sitemap | 索引 1.1MB，84 页 |
| docs.pydantic.dev | Starlight | `llms-full.txt` | 1.1MB |
| docs.pytorch.org | 自研 | `/docs/stable/llms.txt` | 384KB，藏在二级目录 |
| docs.ray.io | Sphinx | sitemap（**不能用 llms-full**） | 见 pitfalls |
| docs.python.org | Sphinx | `_sources/*.rst.txt` | — |
| numpy.org | Sphinx | sitemap + `objects.inv` | — |
| Palantir docs | Next.js | `__NEXT_DATA__.markdown` | 侧边栏只覆盖当前分类 |
| starlight.astro.build | Starlight | `sitemap-index.xml` | 注意不是 sitemap.xml |
| docusaurus.io | Docusaurus | sitemap | — |
| kubernetes.io | Hugo | sitemap（索引式） | — |
| tailwindcss.com | 自研 | **BFS**（无 sitemap） | — |

## 正文容器选择器

`crawl_html.py` 按顺序试，命中且文本长度 > 120 字才算数：

```
.md-content__inner          MkDocs Material
.theme-doc-markdown         Docusaurus
.sl-markdown-content        Starlight
main .vp-doc                VitePress
div.document .body          Sphinx 经典主题
div[itemprop='articleBody'] Sphinx RTD 主题
article[role='main'] / main[role='main'] / [role='main'] / article / main
```

选中后要删掉噪音：`script`/`style`/`nav`/`footer`/`form`/`svg`、
`.headerlink`、`.md-source-file`、`.edit-this-page`、`.pagination-nav`、`[aria-hidden='true']`。
