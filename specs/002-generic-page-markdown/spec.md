# Feature Specification: 任意网页 Markdown 化下载

**Feature Branch**: `002-generic-page-markdown`
**Created**: 2026-06-26
**Status**: Draft
**Input**: 在任意网页(非飞书页面)一键将当前页正文提取并转换为 Markdown 下载。技术路线与飞书逆向完全不同:走"DOM 正文提取(去噪) → HTML→Markdown"通用流水线,纯客户端、零第三方上报。作为独立于飞书 P-official/P-decode 的"第三条通道",与现有飞书导出解耦共存。

## Clarifications

> 依据 001 的既定架构与开源社区(MarkDownload / Obsidian Web Clipper)事实标准直接定夺,不阻塞实现。

- Q: 正文提取用什么? → A: **MVP 用 `@mozilla/readability`**(Firefox 阅读模式同款,`ref/OpenCLI/src/browser/article-extract.ts` 有生产级可抄实现:`isProbablyReaderable` 门控 + 深克隆 + 兜底选择器链 + 非HTML/单pre 边界短路);未命中走兜底链/整页 body。Defuddle(更新更全但较年轻)作 P2 可选升级,实现藏在 `extractArticle()` 接口后可替换。详见 plan §4.5。
- Q: HTML→Markdown 用什么? → A: **Turndown + turndown-plugin-gfm**(JS 生态事实标准),GFM 插件补齐表格/删除线/任务列表。
- Q: 提取在哪运行? → A: 必须在 **content script**(需访问真实 DOM)。按用户手势经 `chrome.scripting.executeScript` 注入到当前 tab,依赖 `activeTab`,**不申请常驻全站权限**。
- Q: 是否走 Jina Reader / ReaderLM 等服务端/AI 方案? → A: **禁止**。违背宪法原则 V(内容不外发、无后端)。全流程纯客户端。
- Q: 图片默认下载还是保留在线链接? → A: v1 默认**保留在线链接**(产纯 .md,把相对/懒加载 `data-src` 转绝对 URL,不扩权);"打包图片进 zip"作 P2 可选项(需对图片域运行时授权)。
- Q: 飞书页面会不会被这条通道劫持? → A: **不会**。路由优先级:命中飞书识别(`DocInfo`)→ 走现有飞书通道(飞书重度虚拟滚动,DOM 提取天生残缺,必须走逆向);否则才走通用通道。
- Q: 虚拟滚动/懒加载页面正文不全怎么办? → A: 通用通道接受"提取时 DOM 现状"。提供可选"提取前自动滚到底触发懒加载"开关(P2),默认关。
- Q(2026-07-09 补): 提取器 P2 升级现在是什么状态? → A: 已具体化为 **Defuddle 升级**,并连带补上 Turndown 精配置、四类疑难内容规则、多模板触发器,依据 `docs/research/2026-07-09-chrome扩展核心实现逆向.md` §二。见文末「升级:提取提质 + 多模板触发器(002.1)」一节。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 任意网页一键下载 Markdown(Priority: P0)

作为用户,在任意非飞书网页(文章/博客/文档站)打开扩展,点击"下载当前页为 Markdown",扩展提取正文、转成 Markdown 并落盘为 `.md` 文件。

**Why this priority**: 本功能的核心价值,独立可用。

**Independent Test**: 在一篇公开博客文章页点击下载,得到一个仅含正文(无导航/侧边栏/广告/页脚)的 `.md`,标题/段落/列表/代码块/表格/链接结构正确。

**Acceptance Scenarios**:

1. **Given** 打开任意非飞书文章页, **When** 点击"下载当前页为 Markdown", **Then** 下载一个 `.md`,正文结构完整、无页面噪声。
2. **Given** 文章含代码块/表格/有序无序列表/行内强调, **When** 转换, **Then** 这些结构在 MD 中正确保留(表格走 GFM)。
3. **Given** 文章含相对链接与懒加载图片, **When** 转换, **Then** 链接与 `<img>` src 被转为绝对 URL。
4. **Given** Defuddle 提取结果为空或正文过短, **When** 转换, **Then** 自动回退整页 body 转换,并在结果中标注"已降级"。

### User Story 2 - 预览与复制(Priority: P1)

作为用户,下载前我能在扩展面板预览渲染后的 Markdown,可直接复制到剪贴板而非必须落盘。

**Independent Test**: 点击"预览",面板显示 MD 文本;点"复制",剪贴板得到同样内容。

**Acceptance Scenarios**:

1. **Given** 任意网页, **When** 点击"预览 Markdown", **Then** 面板展示提取后的 MD 文本与字数。
2. **Given** 预览面板, **When** 点"复制", **Then** MD 文本写入剪贴板。

### User Story 3 - 元数据 frontmatter(Priority: P1)

作为知识管理用户,下载的 `.md` 顶部带 YAML frontmatter(标题、来源 URL、作者、发布时间、抓取时间),便于入库 Obsidian/Notion。

**Independent Test**: 下载文件首部含 `---` 包裹的 `title/source/author/published/clipped` 字段。

**Acceptance Scenarios**:

1. **Given** 可提取到元数据的文章页, **When** 下载, **Then** `.md` 顶部含 frontmatter,缺失字段省略而非留空报错。
2. **Given** frontmatter 开关关闭, **When** 下载, **Then** 产物为纯正文无 frontmatter。

### User Story 4 - 选区/右键片段(Priority: P2)

作为用户,我能在页面选中一段内容,右键将"选区转 Markdown"复制或下载。

**Acceptance Scenarios**:

1. **Given** 页面已选中文本, **When** 右键"复制为 Markdown", **Then** 仅选区 HTML 被转换并写入剪贴板。

## Requirements *(mandatory)*

- **FR-001**: 扩展 MUST 在非飞书页面提供"下载当前页为 Markdown"入口;飞书页面 MUST 仍走现有飞书通道(路由不被劫持)。
- **FR-002**: 提取 MUST 用 `@mozilla/readability` 主路 + 兜底选择器链/整页 body 兜底 + 非HTML/单pre 边界短路;转换 MUST 用 Turndown + GFM 插件。(提取器实现 MUST 藏在可替换接口后,便于 P2 升级 Defuddle)
- **FR-003**: 链接与图片 src MUST 转绝对 URL;`<script>/<style>/<noscript>` MUST 清除。
- **FR-004**: 全流程 MUST 纯客户端,MUST NOT 向任何第三方/自建服务器发送页面内容或 URL(宪法 V)。
- **FR-005**: 通用通道 MUST 仅依赖 `activeTab` + 用户手势注入,MUST NOT 申请常驻 `*://*/*` host 权限。
- **FR-006**: 失败(提取异常/页面受限/`chrome://` 等不可注入页)MUST 给出明确提示而非静默失败(宪法 III)。
- **FR-007**: frontmatter MUST 可开关;缺失元数据字段 MUST 省略。
- **FR-008**: 文件名 MUST 由页面标题安全化(去非法字符、限长)派生,冲突由 `chrome.downloads` 自动处理。

## Success Criteria *(mandatory)*

- **SC-001**: 主流文章/博客/文档站 10 个抽样,≥8 个产出正文完整、无明显噪声的 MD。
- **SC-002**: 代码块、GFM 表格、嵌套列表、链接四类结构在抽样中保留正确率 100%。
- **SC-003**: 飞书页面回归:既有 P-official/P-decode 通道行为零变化。
- **SC-004**: `grep` 取证:通用通道无任何指向第三方域名的 `fetch`/上报。

## 升级:提取提质 + 多模板触发器(002.1)

> 追加日期:2026-07-09。来源:`docs/research/2026-07-09-chrome扩展核心实现逆向.md` §二「网页转 Markdown 提质」与 §5.2 索引(MarkSnip / Obsidian Web Clipper 逆向结论)。本节把原 Clarifications 里"Defuddle 作 P2 可选升级"具体化,并补上研究新挖到的 Turndown 精配置、四类疑难内容规则与多模板触发器。原 US1~US4、FR-001~008、SC-001~004 **全部保留不动**,本节只做增量;编号接原有往下排。

### User Story 5 - Defuddle 提取提质(Priority: P1)

作为用户,在含代码块/表格/公式/callout 的技术页面下载 Markdown 时,这些结构不再被提取器裁掉;元数据(作者/发布时间/描述)也更全。

**Why this priority**: Readability 对代码块/表格偶有丢失(plan §4.5 已知短板)。Defuddle 是 Obsidian Web Clipper 同款提取器,对这几类结构保留更好、还附带 schema.org 元数据 —— 因为提取器已藏在 `extractArticle()` 接口后,这是一次"只换实现"的升级,UI/SW 零改动。

**Independent Test**: 在一篇含代码块与表格的技术博客页下载,产物 MD 中代码块与表格完整;在提供 schema.org JSON-LD 的新闻页下载,frontmatter 含 author/published。

**Acceptance Scenarios**:

1. **Given** 含代码块与表格的技术文章页, **When** 提取转换, **Then** 代码块与表格完整出现在 MD 中,不因提取器裁剪丢失。
2. **Given** 提供 schema.org JSON-LD 的页面, **When** 提取, **Then** 元数据含 title/author/published/description(取到几个算几个,缺失省略)。
3. **Given** Defuddle 解析失败或正文过短, **When** 转换, **Then** 沿用既有兜底选择器链/整页 body 回退并标注降级(与 US1 场景 4 行为一致)。
4. **Given** 非 HTML 文档或单 `<pre>` 页, **When** 提取, **Then** 既有边界短路行为不变(不进 Defuddle)。

### User Story 6 - 疑难内容保真(Priority: P1)

作为用户,页面里的复杂表格(合并单元格)、带语言的代码块、数学公式(KaTeX/MathJax)、各种写法的图片,转成 Markdown 后都能保住原意。

**Independent Test**: 在维基百科数学条目页下载,公式以 `$..$` / `$$..$$` 形式出现且能被 Obsidian/Typora 再渲染;在含合并单元格表格的页面下载,表格不塌不串列。

**Acceptance Scenarios**:

1. **表格**: **Given** 含 rowspan/colspan 或单元格内换行的数据表格, **When** 转换, **Then** 单元格内容不丢、不串列,单元格内换行保留;纯布局表格(无表头无数据语义)不进产物。
2. **代码块**: **Given** 带 `language-xxx` class 或高亮标记的代码块, **When** 转换, **Then** fenced 代码块带正确语言标注;代码内容含 ``` 时围栏自动加长不破格。
3. **公式**: **Given** KaTeX/MathJax 渲染的公式, **When** 转换, **Then** 行内式为 `$..$`、独立式为 `$$..$$`,TeX 源码优先取页面里的原始 annotation 而非从渲染结果反推。
4. **图片**: **Given** 相对路径/懒加载图片, **When** 转换, **Then** src 为绝对 URL(默认保留外链);用户可在设置里改为 base64 内联或下载打包模式。

### User Story 7 - 多模板 + 触发器(Priority: P2)

作为知识管理用户,我能为不同站点配置不同的剪藏模板(frontmatter 字段、文件名格式、正文格式),打开匹配站点时自动选中对应模板,不用每次手工调整。

**Why this priority**: Obsidian Web Clipper 的招牌能力,对每天固定剪几个站入库的用户价值大;但独立于提质主线,可最后做、也可裁剪。

**Independent Test**: 配置一个 URL 前缀触发器指向 `https://juejin.cn/post/` 的模板,在掘金文章页下载,产物用该模板的 frontmatter 与文件名;在未配置的站点下载,落默认模板。

**Acceptance Scenarios**:

1. **Given** 某模板配置了 URL 前缀触发器且当前页匹配, **When** 下载, **Then** 用该模板渲染 frontmatter/文件名/正文格式。
2. **Given** 多个模板同时匹配, **When** 选择, **Then** 按模板列表顺序取第一个命中者(顺序即优先级)。
3. **Given** 无任何模板命中, **When** 下载, **Then** 用默认模板,行为与 US3 现状完全一致。
4. **Given** 模板变量含 `{{schema:@Type.property}}` / `{{selector:css}}` / `{{meta:name}}` 及过滤器管道, **When** 渲染, **Then** 取值正确;取不到值的字段整键省略而非留空。
5. **Given** 内置站点模板(微信公众号/知乎/掘金), **When** 在对应站点下载, **Then** 无需用户配置即命中;飞书文档页仍走飞书通道不受影响(FR-001 不变)。

### 新增 Requirements(接原编号)

- **FR-009**: 提取器 MUST 升级为 Defuddle(`new Defuddle(document).parse()`),替换 MUST 发生在 `extractArticle()` 接口内部,UI/SW 不感知;既有兜底选择器链、整页 body 回退、非 HTML/单 pre 边界短路 MUST 原样保留。
- **FR-010**: Turndown MUST 采用逆向验证过的精配置:atx 标题、fenced 代码块、`escape` 直通(关过度转义)、`keep` 保留 iframe/sub/sup/u/ins/del/small/big,GFM 插件只挂 highlightedCodeBlock/strikethrough/taskListItems 三个(表格不用 gfm 插件,走 FR-011 自定义规则)。
- **FR-011**: 表格 MUST 走自定义规则:每个单元格用独立 mini-Turndown 递归转换;rowspan/colspan MUST 处理不串列;单元格内 `<br>` MUST 保留;MUST 用 isDataTable 判断跳过纯布局表格。
- **FR-012**: 代码块 MUST 输出 fenced 形式;语言检测 MUST 三级:`language-xxx` class → `hljs.getLanguage()` 验证 → `hljs.highlightAuto()` 且 relevance≥2 才采信;代码内容含 ``` 时围栏 MUST 自动加长。
- **FR-013**: 公式 MUST 优先取原始 TeX(KaTeX 的 `annotation[encoding="application/x-tex"]`、`data-latex` 属性),取不到再用 MathMLToLaTeX 从 MathML 现转;行内式输出 `$..$`、独立式输出 `$$..$$`;抓取 DOM 前 MUST 等 MathJax 渲染完成。
- **FR-014**: 图片 MUST 经 validateUri 相对转绝对;图片处理 MUST 提供三种模式:保留外链(默认)/base64 内联/下载打包;后两种 MUST NOT 默认扩权,跨域下载沿用运行时授权(FR-005 不变)。
- **FR-015**: 多模板 MUST 支持三类触发器:URL 前缀、`/regex/` 正则、`schema:@Type.prop`;多个命中 MUST 按模板列表顺序取第一个;无命中 MUST 落默认模板。
- **FR-016**: 模板变量 MUST 支持 `{{schema:@Type.property}}`/`{{selector:css}}`/`{{meta:name}}` 与 `|split|wikilink|join|slugify` 过滤器管道;渲染 MUST 全程纯客户端(宪法 V)。
- **FR-017**: MUST 内置微信公众号(mp.weixin.qq.com)、知乎、掘金站点模板+触发器;飞书文档页 MUST 仍优先命中飞书通道(FR-001 不变),飞书域内置模板仅对未命中 `DocInfo` 的页面(如帮助中心)生效。

### 新增 Success Criteria(接原编号)

- **SC-005**: 含代码块/表格的技术站 10 个抽样,升级后两类结构完整保留 ≥9 个(对比 Readability 基线不劣化)。
- **SC-006**: 合并单元格表格抽样 5 个,转换后单元格内容不丢不串列;布局表格 0 泄漏进产物。
- **SC-007**: KaTeX/MathJax 页面公式抽样 20 条,`$..$`/`$$..$$` 还原后可再渲染比例 ≥90%。
- **SC-008**: 配置 3 个站点模板后,匹配页命中预期模板 100%;未匹配页 100% 落默认模板。
- **SC-009**: 升级全程原 SC-001~004 复跑全部通过(尤其飞书回归零变化、无第三方外发)。
