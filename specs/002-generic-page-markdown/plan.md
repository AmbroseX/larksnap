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

## 9. 升级方案:Defuddle 提质 + 多模板触发器(002.1)

> 追加日期 2026-07-09。来源:`docs/research/2026-07-09-chrome扩展核心实现逆向.md` §二与 §5.2 索引。兑现 §4.5 埋的伏笔:把"Defuddle 作 P2 可选升级"落成具体方案。对应 spec 升级节 US5~US7 / FR-009~017 / SC-005~009。

### 9.1 与现状的关系

- §4.5 的决策框架不变:提取器藏在 `extractArticle()` 接口后。本节就是那扇门后的**换实现**:接口签名 `{contentHtml, meta, source, degraded}` 不动,兜底选择器链、整页 body 回退、非 HTML/单 pre 边界短路(§5.3~5.5)原样保留,UI/SW 零改动。
- **若坚持 Readability 不换**(备选路):必须抄 MarkSnip 的两遍提取+恢复(`ref/extracted/MarkSnip网页转Markdown剪藏/shared/readability-recovery.js`,1041 行)和提取前 DOM 预处理(`offscreen/offscreen.js:1843-2015`:给公式打标记、`pre br` 换占位、代码块补 `language-` class,否则这些会被 Readability 顺手删掉)。工作量不小,且本质是给旧引擎打补丁。
- **推荐直接换 Defuddle**:Obsidian Web Clipper 同款(作者 kepano 写的 Readability 继任者),代码块/表格/公式/callout 保留天生更好,`parse()` 直接返回 title/author/published/description 元数据,还能抽 schema.org —— 省掉自己抠 meta 的活。风险(§4.5 标"中")用"保留全部兜底链 + SC-009 全量回归"兜住。
- 架构不变:剪藏总是从当前 tab 触发,继续在 content script 里跑(有真实 DOM),**不需要** MarkSnip 的 offscreen 方案(那是给"SW 主动发起批量转换"用的)。

### 9.2 新增 / 改动文件

**新增**:

| 文件 | 职责 |
|---|---|
| `src/content/generic/rules/table.ts` | 表格 addRule(单元格 mini-Turndown 递归 / rowspan、colspan / isDataTable 跳过布局表格) |
| `src/content/generic/rules/code.ts` | 代码块 addRule(三级语言检测 / 围栏自动加长) |
| `src/content/generic/rules/math.ts` | 公式 addRule(原始 TeX 优先 / MathMLToLaTeX 兜底)+ 等 MathJax 渲染完 |
| `src/content/generic/rules/image.ts` | 图片 validateUri 绝对化 + 三模式(外链/base64/打包) |
| `src/content/generic/templates/types.ts` | 模板与触发器类型定义 |
| `src/content/generic/templates/triggers.ts` | 三类触发器匹配(URL 前缀树 / 正则 / schema.org) |
| `src/content/generic/templates/variables.ts` | 模板变量渲染 + 过滤器管道 |
| `src/content/generic/templates/builtin.ts` | 内置站点模板(公众号 / 知乎 / 掘金 / 飞书非文档页) |

**改动**:

| 文件 | 改动 |
|---|---|
| `src/content/generic/extract.ts` | `extractArticle()` 内部 Readability → Defuddle;meta 增 description 与 schema.org 抽取;兜底链/边界短路不动 |
| `src/content/generic/to-markdown.ts` | 换 §9.3 精配置;挂 `rules/` 四条规则;去掉 gfm 表格插件 |
| `src/content/generic/frontmatter.ts` | 改造成"默认模板"的 properties 渲染;未配置模板时行为与 US3 完全一致 |
| `src/content/generic/index.ts` | `EXTRACT` 消息带模板配置进来;抓取前等 MathJax;回传结果带命中的模板名 |
| `src/shared/types.ts` | 增 `GenericTemplate`/`GenericTrigger`;`genericImageMode` 扩为 `'link'\|'base64'\|'zip'`;config 增 `genericTemplates` |
| `src/sidepanel`(options) | 模板管理入口(最简形态:模板列表 + JSON 编辑) |
| `package.json` | + `defuddle`、`mathml-to-latex`、`highlight.js`(全部只打进 `generic.js`,不进 `content.js`;hljs 用 common 子集控体积) |

> **前置**:本升级建立在 Phase 1~3(T005~T014)完成之上。若开工时 MVP 尚未编码,可拍板直接按升级后形态一次做成,省一遍 Readability 返工(开放问题,见 §9.6)。

### 9.3 Turndown 精配置(三个扩展验证过,直接抄)

```js
const service = new TurndownService({
  headingStyle: 'atx', hr: '---', bulletListMarker: '-',
  codeBlockStyle: 'fenced', fence: '```',
  emDelimiter: '*', strongDelimiter: '**',
  linkStyle: 'inlined', preformattedCode: true,
});
service.use([   // 只挂这三个,表格自己写规则
  turndownPluginGfm.highlightedCodeBlock,
  turndownPluginGfm.strikethrough,
  turndownPluginGfm.taskListItems,
]);
service.keep(['iframe', 'sub', 'sup', 'u', 'ins', 'del', 'small', 'big']);
service.escape = s => s;   // 关掉过度转义,否则代码/表格里下划线全变 \_
```

要点:
- `escape` 直通是三个扩展共同的选择:Turndown 默认转义太狠,`snake_case`、`a*b` 这类正文会被转成 `snake\_case`。副作用(正文里恰好长得像 MD 语法的字符不再转义)实测远小于收益。
- **表格不用 gfm 插件**:它对 rowspan/colspan、单元格内换行、嵌套结构全都处理不了,走 §9.4 自定义规则。
- `preformattedCode: true` 防止 `<pre>` 里的内容被行内规则二次处理。
- 相比原 §5.7 配置的变化:新增 `hr`/`emDelimiter`/`strongDelimiter`/`linkStyle`/`preformattedCode` 显式值、`escape` 直通、`keep` 列表;`use(gfm)` 整包挂载改为只挂三个插件。

### 9.4 四类疑难内容 addRule(每类一条规则,参考 MarkSnip)

1. **表格**(`rules/table.ts`,参考 `offscreen.js:1162-1378`):
   - 每个单元格开一个 **mini-Turndown 实例**递归转换单元格内 HTML(粗体/链接/代码都能保住),结果作为该 cell 的文本。
   - rowspan/colspan:按跨度补齐占位单元格,保证每行列数一致不串列。
   - 单元格内 `<br>` 保留为 HTML `<br>`(GFM 表格里换行只能这么表达)。
   - `isDataTable` 判断(有 `<th>`/`<caption>`/多行多列数据语义才算数据表),纯布局表格直接按普通块级内容展开,不产表格语法。
2. **代码块**(`rules/code.ts`,参考 `offscreen.js:1552-1674`):
   - fenced 输出;语言检测三级:① `class="language-xxx"` 直接取;② 取到的名字过 `hljs.getLanguage()` 验证是真语言;③ 都没有再 `hljs.highlightAuto()`,且 `relevance >= 2` 才采信,否则不标语言。
   - 代码内容里含 ``` 时,围栏自动加长(````)防破格。
3. **公式**(`rules/math.ts`,参考 `offscreen.js:1501-1520` + `contentScript.js:130-268/279`):
   - 优先取页面里的**原始 TeX**:KaTeX 的 `annotation[encoding="application/x-tex"]`、MathJax/通用的 `data-latex` 属性。
   - 取不到再用 `mathml-to-latex` 库把 MathML 现转。
   - 行内式 → `$..$`,独立式 → `$$\n..\n$$`(按容器 display 样式/`display="block"` 判断)。
   - `index.ts` 抓 DOM 前**等 MathJax 渲染完**(`MathJax.startup?.promise` 存在就 await),否则拿到的是半成品 DOM。
4. **图片**(`rules/image.ts`,参考 `offscreen.js:2472-2530`):
   - `validateUri(src, baseURI)` 相对转绝对(与 §5.6 的预处理互为兜底)。
   - 三模式做成 `genericImageMode` 选项:`'link'` 保留外链(默认,零权限)/`'base64'` 内联(单文件自包含,体积大)/`'zip'` 下载打包(归 T019,跨域走运行时授权)。

### 9.5 多模板 + 触发器(Obsidian Web Clipper 招牌)

**模板对象**(存 `chrome.storage.local`,由 SW 随 `EXTRACT` 消息带给 content script):

```ts
interface GenericTemplate {
  name: string;               // 模板名,也用于结果标注
  noteNameFormat: string;     // 文件名模板,如 '{{title|slugify}}'
  path?: string;              // 预留:入库路径(落盘场景仅作 frontmatter 字段)
  noteContentFormat: string;  // 正文模板,默认 '{{content}}'
  properties: { name: string; value: string }[];  // 渲染成 YAML frontmatter
  triggers: string[];         // 触发器,见下
}
```

**触发器三类**,按「模板列表顺序 = 优先级」取第一个命中(参考 `popup.js` 的 `initializeTriggers`):
- 纯字符串 → **URL 前缀**匹配,多模板多前缀时组织成前缀树(Trie)加速;
- `/.../ ` 形式 → 对完整 URL 跑**正则**;
- `schema:@Type.prop` 形式 → 页面 JSON-LD 里存在该 `@type` 及属性即命中(如 `schema:@Recipe.name`)。
- 全部不命中 → 默认模板(行为等于现在的 frontmatter 开关)。

**变量与过滤器**(`variables.ts`):
- `{{title}}`/`{{author}}`/`{{published}}`/`{{url}}`/`{{content}}`/`{{date:FMT}}` 基础变量来自 `extractArticle()` 的 meta;
- `{{schema:@Type.property}}` 从页面 JSON-LD 抽任意字段;`{{selector:css}}` 用 CSS 选择器抓页面文本(**必须在 content script 渲染**,这也是模板渲染放 content 侧的原因);`{{meta:name}}` 读 `<meta>` 标签;
- 过滤器管道:`|split|wikilink|join|slugify`,从左到右依次套用;
- 取不到值的 property 整键省略(与 FR-007 同一口径)。

**内置模板**(`builtin.ts`,站点作者/时间选择器参考 markClipper `metadata-extractor.js` 的按域名选择器表思路):
- `mp.weixin.qq.com` → 公众号名/作者/发文时间走站点选择器;
- 知乎(`zhuanlan.zhihu.com` 等)、掘金(`juejin.cn/post/`) → 各配 URL 前缀触发器 + 站点化 frontmatter;
- 飞书域:**文档页仍走飞书通道(§2 路由不变)**,内置飞书模板只对未命中 `DocInfo` 的页面(帮助中心、公告页等)生效。

### 9.6 分期与开放问题

落地顺序(研究结论,收益从大到小):

- **002.1a 引擎升级**:换 Defuddle + §9.3 Turndown 精配置 —— 正文质量立刻上台阶,改动最小。
- **002.1b 疑难内容**:表格/代码/公式三条 addRule + 图片规则(先只做绝对化 + 模式选项,zip 实装仍归 T019)。
- **002.1c 多模板触发器**:独立可裁剪,做不做不影响前两期。

开放问题(留给评审拍板):

1. **MVP 还要不要先走一遍 Readability?** 002 尚未开工(`src/content/generic/` 还不存在)。按原计划先 Readability 再切 Defuddle 有基线对比、风险最低;直接按 Defuddle 形态实现 Phase 1 则省一次返工。建议:直接 Defuddle,用 Phase 4 抽样当验收,不做双引擎。
2. **多模板触发器值不值得做?** 配置 UI 成本不低;若用户以"落盘 .md"为主而非 Obsidian 入库,可以长期停在"内置模板 + 默认模板",不开放自定义。
3. **highlight.js 体积**:common 子集 min 后约百 KB,只进 `generic.js` 不影响飞书路径;若仍嫌大,语言检测降为两级(class → 语言名白名单),砍掉 highlightAuto。

### 9.7 宪法符合性(增量)

| 原则 | 评估 |
|---|---|
| II 域名不写死 | ✅ 内置模板的触发器是"站点适配数据",不是请求/下载目标域名,不触碰原则 II 管辖范围;飞书路由优先级不变(§2)。 |
| V 隐私不外发 | ✅ `defuddle`/`mathml-to-latex`/`highlight.js` 均为纯 JS 本地库,零网络;模板渲染全程 content script 本地完成。SC-004 的 grep 取证范围扩到 `rules/`、`templates/`。 |
| 其余原则 | 同 §6 评估,无变化;升级不触碰任何飞书文件(SC-003/SC-009 复跑兜底)。 |
