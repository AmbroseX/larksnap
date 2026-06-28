# Implementation Plan: 任意网页 Markdown 化下载

**Spec**: `specs/002-generic-page-markdown/spec.md`
**Branch**: `002-generic-page-markdown`
**Created**: 2026-06-26

## 1. 设计概述

新增一条**与飞书逆向完全解耦的「通用通道」**:在任意非飞书网页提取正文 → 转 Markdown → 落盘。技术路线为开源社区(MarkDownload / Obsidian Web Clipper)事实标准的两步流水线,纯客户端、零第三方上报。

```
当前 tab DOM
   │  (用户点击 → SW 经 activeTab 注入 generic.js)
   ▼
[generic.js / content 上下文]
   ├─ 1. Readability 提取正文(去噪 + 抽元数据)  ── 未命中 → 兜底选择器链/整页 body
   ├─ 2. 规范化:相对链接&img src → 绝对 URL;清 script/style
   ├─ 3. Turndown + GFM 插件:HTML → Markdown
   └─ 4. 拼 frontmatter
   ▼  返回 { markdown, title, meta }
[SW]  safeName(title).md → downloadDataUrl   (复用现有 download.ts)
```

**为什么是第三条通道,而非复用飞书路径**:飞书重度虚拟滚动,屏外块被卸载,DOM 提取天生残缺 —— 这正是 001 放弃 DOM 快照改走 client_vars 逆向的原因(见 [[feishu-export-architecture]])。通用网页没有内部接口可逆向,只能 DOM 提取。两者前提相反,必须分流。

## 2. 路由与优先级

复用现有 `doc-detect.detectActiveDoc()`:

- 命中飞书 `DocInfo`(已知 host 或 `/<type>/<token>` 双信号)→ **走现有飞书通道,本功能完全不介入**。
- 未命中 → 当前 tab 视为「通用网页」,展示「下载当前页为 Markdown」入口,走通用通道。
- `chrome://`、`chrome-extension://`、扩展商店等不可注入页 → 入口禁用 + 提示。

保证 **SC-003 飞书回归零变化**:通用通道不改飞书任何文件,仅新增文件 + 在 UI/SW 路由上挂新分支。

## 3. 新增 / 改动文件

### 新增

| 文件 | 职责 |
|---|---|
| `src/content/generic/index.ts` | 通用通道 content 入口(独立 IIFE → `generic.js`);监听 `GENERIC_EXTRACT`,跑提取+转换,回传结果 |
| `src/content/generic/extract.ts` | Readability 封装(移植 OpenCLI `article-extract.ts`:门控/深克隆/兜底链/边界短路)+ 整页 body 兜底;输出 `{ contentHtml, meta, source, degraded }`。提取器实现藏在 `extractArticle()` 接口后,可替换为 Defuddle |
| `src/content/generic/to-markdown.ts` | Turndown 实例 + GFM 插件 + 自定义规则(绝对化 URL、清噪、代码块语言) |
| `src/content/generic/frontmatter.ts` | 由 meta 生成 YAML frontmatter(可开关、缺字段省略) |
| `src/background/exporters/generic-md.ts` | SW 侧编排:注入 `generic.js` → 发 `GENERIC_EXTRACT` → `safeName().md` 落盘;进度经 `reportProgress` |

### 改动

| 文件 | 改动 |
|---|---|
| `vite.config.ts` | esbuild 增加第二入口 `src/content/generic/index.ts` → `dist/generic.js`(与 content.js 同样 IIFE/target) |
| `src/shared/constants.ts` | `MSG` 增 `EXPORT_GENERIC_MD`、`PREVIEW_GENERIC_MD`;新增 `GENERIC_MSG = { EXTRACT }`(SW→generic content) |
| `src/shared/types.ts` | 增 `GenericExtractResult`、config 增 `genericFrontmatter:boolean`、`genericImageMode:'link'\|'zip'` |
| `src/background/index.ts` | 路由增 `EXPORT_GENERIC_MD` / `PREVIEW_GENERIC_MD` → `generic-md.ts` |
| `src/sidepanel/SidePanel.tsx` + `actions.ts` | 非飞书页渲染"下载当前页为 Markdown" + "预览"入口(飞书页隐藏) |
| `package.json` | 加依赖 `@mozilla/readability`、`turndown`、`turndown-plugin-gfm`、`@types/turndown`(`defuddle` 留待 P2) |

## 4. 依赖

- `@mozilla/readability` —— 正文提取(主,MVP)。纯 JS,在页面 window 上下文运行(需真实 DOM API)。
- `turndown` + `turndown-plugin-gfm` —— HTML→MD。
- `@types/turndown`(dev)。
- `defuddle` —— P2 可选升级提取器,MVP 不引入(见 §4.5)。
- **不引入** 任何服务端/AI/网络依赖(Jina、ReaderLM、markitdown)—— 违背宪法 V。

这些库打进 `generic.js`,**仅在通用通道注入时加载**,不进 `content.js`(飞书页),保持飞书路径与体积不变。

## 4.5 提取器选型:Readability vs Defuddle

`ref/OpenCLI/src/browser/article-extract.ts` 给了一份**生产级、可直接抄**的通用 web→markdown 实现,选型为 `@mozilla/readability` + `turndown` + `turndown-plugin-gfm`,与本 plan 仅在"提取器"一项不同。两条路对比:

| | `@mozilla/readability` | `defuddle` |
|---|---|---|
| 成熟度 | Firefox 阅读模式同款,十年验证;ref 里有完整可抄实现(含 `isProbablyReaderable` 门控、源码注入、兜底链、边界短路) | Obsidian Web Clipper 同款,2025 新标准,较年轻 |
| 结构保留 | 文章类好;代码块/表格偶有丢失 | 更全(代码块/表格/脚注),且附带元数据 |
| 元数据 | `title/byline/publishedTime/siteName` | `title/author/published/description` 更丰富 |
| 风险 | 低(可抄 ref) | 中(需自行验证边界) |

**决策**:**用 Readability 起步**(MVP 直接移植 OpenCLI 的 `article-extract.ts` 思路,风险最低、有现成可抄代码),把 Defuddle 作为 P2 可选升级项(若实测 Readability 在代码块/表格/中文站点上丢结构明显,再切 Defuddle)。`extract.ts` 内部抽象出 `extractArticle(): {contentHtml, meta, source}` 接口,提取器实现可替换,UI/SW 不感知。

> 据此调整:Phase 0 依赖由 `defuddle` 改为 `@mozilla/readability`(Defuddle 移到 P2);`extract.ts` 移植 OpenCLI 的 `isProbablyReaderable` 门控 + 兜底选择器链 + 边界短路(见 §5.2~5.5)。

## 5. 关键实现细节(踩坑点)

1. **注入去重**:`generic.js` 末尾置 `window.__feishu2md_generic__=true`;SW 注入前 `executeScript` 查标记或直接幂等重注(参考现有 `ensureContentInjected` 模式)。
2. **提取流程(移植 OpenCLI `article-extract.ts`)**:① `isProbablyReaderable` 门控,不像文章页且非 `force` 则跳过 Readability;② **深克隆** document 再在克隆上跑提取(不污染实时页面,保后续可重试);③ Readability 命中即用,`source:'readability'`。
3. **降级兜底链**:Readability 未命中 → 走 `main → [role="main"] → #main-content → #main → article → body` 选择器链,取首个文本 >80 字的根,`source:'fallback'`、`degraded:true`,UI 提示"正文识别可能不全"。
4. **边界短路①——非 HTML 文档**(OpenCLI 实战坑):`text/plain`/JSON/XML 等被浏览器渲染器包成 DOM,会污染提取。检测 `document.contentType` 非 `text/html` → 直接取原始文本当正文,`source:'raw-text'`,不跑提取器。
5. **边界短路②——body 是单个 `<pre>`**(OpenCLI 实战坑):浏览器加载 `*.txt`/`*.md`(file:// 或 `raw.githubusercontent.com`)时正文是单个 `<pre>` → 直接取其 `textContent` 当正文,`source:'pre'`。
6. **URL 绝对化**:转换前遍历克隆里的 `a[href]`/`img[src|data-src|data-original|srcset]`,`new URL(raw, document.baseURI)` 解析为绝对。
7. **Turndown 配置**:`headingStyle:'atx'`、`codeBlockStyle:'fenced'`、`bulletListMarker:'-'`;`fence` 内识别 `language-xxx` class 写代码块语言;`use(gfm)` 挂表格/删除线/任务列表;`remove(['script','style','noscript','iframe'])`。
8. **元数据**:取提取器返回的 `title/byline(author)/publishedTime/siteName` + `document.title`/`<meta property="og:*">` 兜底;frontmatter 字段缺失则省略键。
9. **不可注入页**:`executeScript` 抛错 → 捕获 → 返回友好错误(FR-006)。
10. **图片 v1=link**:默认不下载图片(纯 .md + 绝对 URL);P2 zip 模式才下载,届时图片跨域下载需对图片域运行时授权(沿用 001 的 `optional_host_permissions` + 手势模式),不默认扩权(FR-005)。

## 6. 宪法符合性检查

| 原则 | 评估 |
|---|---|
| I 零配置认证 | ✅ N/A 且兼容:通用页无需任何认证/App ID。 |
| II 域名不写死 | ✅ 通用通道本就不绑定任何域名;且**不得劫持飞书 host**(§2 路由优先飞书)。 |
| III 导出可靠/可恢复 | ✅ 经 `reportProgress` 报进度;注入失败/受限页给明确错误。单页提取为同步单发,无长流程恢复需求。 |
| IV 高质量 MD 双路 | ⚠️ 该原则**特指飞书** P-official/P-decode,不约束通用通道。通用通道是独立第三路,**不触碰** §5.1 飞书能力探测,故不违反"禁止跳过能力检测"(那条仅限飞书)。plan 在此显式声明边界。 |
| V 隐私不外发 | ✅ **硬要求**:全流程客户端,无任何第三方 fetch/上报。取证:`grep` 通用通道无外域请求(SC-004)。明确拒绝 Jina/ReaderLM 服务端方案。 |
| VI 合规告知 | ✅ 公开网页用户主动保存,无"绕过组织限制"语义;无需额外合规弹窗。 |

> 治理提示:本特性新增的是与飞书并列的能力域。建议在宪法 §适用范围/原则 IV 附注一句"原则 IV 仅约束飞书文档通道;通用网页通道遵循 I/II/III/V"。是否修宪由你决定 —— 不修也不冲突(已在上表说明边界)。

## 7. 验收与回归

- 跑 spec 的 SC-001~004。
- 飞书回归:在公有云 + 私有化各一篇文档确认导出行为不变(SC-003)。
- `npm run typecheck` + `npm run build` 通过(宪法治理:改源码后必跑)。
- `grep -rn "fetch(" src/content/generic/` 确认无外域请求(SC-004 取证)。

## 8. 分期

- **P0(MVP)**:US1 一键下载(Readability+Turndown+GFM+兜底链+边界短路+路由+SW 落盘+UI 入口)。
- **P1**:US2 预览/复制、US3 frontmatter。
- **P2**:US4 选区右键、图片 zip 打包(复用 jszip + 运行时授权)、提取前自动滚动加载。
