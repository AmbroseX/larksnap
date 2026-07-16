# Tasks: 任意网页 Markdown 化下载

**Plan**: `specs/002-generic-page-markdown/plan.md` · **Spec**: `./spec.md`

约定:`[P]` 可与同段其他 `[P]` 并行(改不同文件);顺序项有依赖。每个 phase 末尾跑 `npm run typecheck`。

> **实现偏差(2026-07-13,整体)**:本特性未按原计划新建 `src/content/generic/` 平行通道——
> 仓库已先行落地了同定位的 **webcopy** 通道(commit 6f0e9f0:`src/content/webcopy/` +
> `dist/webcopy.js` 独立入口 + 右键菜单 + 侧边栏 WebCopyView 复制/下载),Phase 0~5 的
> 用户价值(US1 一键下载 .md、US2 复制、US4 选区右键、不可注入页禁用)已由 webcopy 覆盖,
> 再建 generic 通道就是重复造轮子(DRY)。故 Phase 6~7 升级与 US3 frontmatter 直接做在
> webcopy 管线上:`src/content/webcopy/{extract,frontmatter}.ts` + `rules/{table,code,math,image}.ts`。
> 下文任务按"等价实现"口径勾选,文件路径以实际代码为准。

## Phase 0 — 脚手架与依赖

- [x] T001 安装依赖:`npm i @mozilla/readability turndown turndown-plugin-gfm` + `npm i -D @types/turndown`(`defuddle` 留待 T021/P2,见 plan §4.5)
- [x] T002 `vite.config.ts` esbuild 增第二入口 `src/content/generic/index.ts` → `dist/generic.js`(IIFE/target=chrome110,与 content.js 同配置)
  - **等价实现**:第二入口为 `src/content/webcopy/index.ts` → `dist/webcopy.js`,配置一致。
- [x] T003 `src/shared/constants.ts`:`MSG` 增 `EXPORT_GENERIC_MD`/`PREVIEW_GENERIC_MD`;新增 `GENERIC_MSG={EXTRACT:'generic_extract'}`
  - **等价实现**:`MSG.WEBCOPY_PAGE_MD/WEBCOPY_SELECTION_MD` + `CONTENT_MSG.WEBCOPY_PAGE_TO_MD` 等。
- [x] T004 `src/shared/types.ts`:增 `GenericMeta`、`GenericExtractResult{markdown,title,meta,degraded}`;`ExtensionConfig` 增 `genericFrontmatter:boolean`(默认 true)、`genericImageMode:'link'|'zip'`(默认 'link');`DEFAULT_CONFIG` 补默认值
  - **等价实现**:`WebCopyMdResult{markdown,title,source?,degraded?}`;config 落在 `webcopy.frontmatter:boolean`(默认 true)与 `webcopy.pageImageMode:'link'|'base64'`(默认 'link';zip 模式仍归 T019 未做,base64 见 T029)。

## Phase 1 — 通用通道核心(content 侧) [US1 P0]

- [x] T005 [P] `src/content/generic/to-markdown.ts`:Turndown 实例 + `use(gfm)`;规则:atx 标题、fenced 代码块(读 `language-*` class)、`bulletListMarker:'-'`、`remove(script/style/noscript/iframe)`;导出 `htmlToMarkdown(html, baseURI)`
  - **等价实现**:`src/content/webcopy/html2md.ts`,且已直接升级为 Phase 6 的精配置形态(T024)。
- [x] T006 [P] `src/content/generic/extract.ts`:…… 输出 `{contentHtml,meta,source,degraded}`
  - **等价实现**:`src/content/webcopy/extract.ts`,按 plan §9.6 开放问题 1 的建议**跳过 Readability 直接上 Defuddle**(T023),兜底选择器链原样保留;URL 绝对化由 Turndown 的 link/image 规则统一做。
- [x] T006b [P] 边界短路:① `document.contentType` 非 `text/html` → `source:'raw-text'`;② body 为单个 `<pre>` → `source:'pre'`;二者均跳过提取器(已实现于 `webcopy/extract.ts`)
- [x] T007 [P] `frontmatter.ts`:`buildFrontmatter(meta)` → YAML(title/source/author/published/description/clipped),缺字段省略(已实现于 `src/content/webcopy/frontmatter.ts`)
- [x] T008 content 入口:监听消息 → extract → to-markdown →(按 config)拼 frontmatter → 回传;幂等标记;异常 try-catch 回传 error
  - **等价实现**:`src/content/webcopy/index.ts`(标记 `window.__larksnap_webcopy`),frontmatter/图片模式从 `getConfig()` 读取。

## Phase 2 — SW 编排与路由 [US1 P0]

- [x] T009 SW 编排(注入幂等 / 落盘 / 友好错误)
  - **等价实现**:`src/background/webcopy.ts`(右键菜单 + 侧边栏注入调度 + needsPermission 兜底);落盘由侧边栏锚点下载完成(chrome.downloads 对 blob 会丢文件名,见 WebCopyView 注释)。
- [x] T010 预览/复制留口:`WEBCOPY_PAGE_MD` 返回 markdown 文本,复制/下载由 UI 决定(等价满足)
- [x] T011 `src/background/index.ts` 路由(WEBCOPY_* 消息,已上线)

## Phase 3 — UI 入口 [US1 P0 / US2 P1]

- [x] T012 侧边栏分流:飞书页走导出宫格,非飞书页 `WebCopyView`(复制/下载 Markdown、解锁、视频、截图);不可注入页禁用提示(`isRestrictedUrl`)
- [x] T013 复制入口已有;**实现偏差**:未做独立"预览面板 + 字数",复制到剪贴板即预览的等价物,预览面板列为后续增强(YAGNI)。
- [x] T014 设置项(options):frontmatter 开关 + 图片模式选择已加到「网页复制」区块(US3)

## Phase 4 — 验收与回归

- [ ] T015 抽样 10 个文章/博客/文档站验 SC-001/SC-002(正文完整度、代码块/表格/列表/链接保真)——**人工浏览器手测**
- [ ] T016 飞书回归:公有云 + 私有化各一篇,确认导出行为零变化(SC-003)——**人工浏览器手测**
- [x] T017 取证:`grep -rn "fetch(\|XMLHttpRequest\|sendBeacon" src/content/webcopy/` 无结果(SC-004 / 宪法 V;Defuddle 已显式 `useAsync:false` 禁用第三方 API 兜底);`npm run typecheck` + `npm run build` 通过

## Phase 5 — 增强(P2,可选)

- [x] ~~T021~~ (已具体化)提取器升级 Defuddle → 由 Phase 6(T022~T025)取代,不再依赖 T015 实测结论,直接升级(plan §9)
- [x] T018 US4 选区右键:`contextMenus` 注册"复制选区为 Markdown",转 `window.getSelection()` 的 HTML(webcopy 上线时已实现:「选中内容转 Markdown(复制)」)
- [ ] T019 图片 zip 模式:`genericImageMode:'zip'` 时下载图片打包(复用 `jszip`+`media-util`),跨域图走运行时授权(沿用 001 手势授权模式)
- [ ] T020 提取前自动滚动触发懒加载(可选开关,默认关)

## Phase 6 — 提质升级:提取引擎(002.1a) [US5 P1]

> 前置:Phase 1~3 完成。若开工时 Phase 1 尚未编码,可拍板直接按本 phase 形态实现(plan §9.6 开放问题 1)。**已按此路径执行:跳过 Readability 基线,直接 Defuddle。**

- [x] T022 安装依赖:`npm i defuddle`(0.19.1);只打进 `webcopy.js`,`content.js`(飞书路径)体积零变化
- [x] T023 `src/content/webcopy/extract.ts`:`extractArticle()` 内部 Defuddle(`new Defuddle(clone,{url,useAsync:false}).parse()`,`source:'defuddle'`);meta 取 title/author/published/description/site;兜底选择器链、整页 body 回退、边界短路(raw-text/pre)原样保留(FR-009)
  - **实现说明**:`useAsync:false` 显式关掉 Defuddle 的"提取失败请求第三方 API 兜底"(宪法 V);喂克隆文档防 parse() 剥实时页面的 script/style。
- [x] T024 `src/content/webcopy/html2md.ts`:换 plan §9.3 Turndown 精配置 —— atx/`hr:'---'`/fenced/`preformattedCode:true`、`escape` 直通、`keep([iframe,sub,sup,u,ins,small,big])`、gfm 只挂 highlightedCodeBlock/strikethrough/taskListItems 三插件、去掉 gfm 表格插件(FR-010)
  - **实现偏差**:keep 列表去掉 `del`(strikethrough 插件已把 del/s 转 `~~..~~`,keep 永远轮不到它)。
- [ ] T025 用 Phase 4 的 10 站点样本复跑验 SC-005 且不劣化;——**人工浏览器手测**(真实 Chromium 合成页冒烟 13 断言全过:frontmatter/表格 rowspan·管道·br/代码语言/行内+独立公式/懒加载图/任务列表/删除线/去噪/转义)
  - **冒烟发现并修复**:Defuddle 默认的 `removeContentPatterns` 会把正文里的短要点列表当样板误删,已在 `extract.ts` 显式关闭(丢内容比留噪音严重;页眉页脚仍由选择器+低分清理兜住)。

## Phase 7 — 提质升级:四类疑难内容(002.1b) [US6 P1]

- [x] T026 [P] `src/content/webcopy/rules/table.ts`:表格 addRule —— 每单元格 mini-Turndown 递归转换;rowspan/colspan 补齐占位不串列;cell 内换行输出 `<br>`;`isDataTable` 跳过布局表格(FR-011)
- [x] T027 [P] `src/content/webcopy/rules/code.ts`:代码块 addRule —— 三级语言检测(`language-xxx` class → `hljs.getLanguage()` 验证 → `hljs.highlightAuto()` 且 relevance≥2);内容含 ``` 时围栏自动加长;`highlight.js/lib/common` 子集控体积(FR-012)
- [x] T028 [P] `src/content/webcopy/rules/math.ts`:公式 addRule —— 优先 KaTeX `annotation[encoding="application/x-tex"]`/`data-latex`/`alttext`,兜底 `mathml-to-latex`;inline→`$..$`、block→`$$..$$`(FR-013)
  - **实现偏差**:不做"抓取前 await MathJax.startup.promise"——content script 在隔离世界读不到页面 window.MathJax;MathJax v3 渲染后 DOM 里有 mjx-container 即可提取,影响很小。
- [x] T029 [P] `src/content/webcopy/rules/image.ts`:图片 addRule —— 相对转绝对 + data-src/data-original/srcset 懒加载兜底;图片模式落地为 `webcopy.pageImageMode:'link'|'base64'` 两值,默认 `'link'`;base64 用"页面已加载同图画 canvas"实现(零网络请求,跨域污染自动回退外链),zip 实装归 T019(FR-014)
- [x] T030 `html2md.ts` 挂载四条规则;`npm run typecheck` 通过;含公式/合并单元格/多语言代码块的抽样验证(SC-005~007)——jsdom 冒烟已过,**真实站点抽样待人工**

## Phase 8 — 提质升级:多模板 + 触发器(002.1c) [US7 P2]

> 2026-07-13:按 plan §9.6 开放问题 2 暂缓——配置 UI 成本不低,当前用户以"落盘 .md"为主,
> 先停在默认 frontmatter 形态,等真实需求再启动本 phase。

- [ ] T031 [P] `src/content/generic/templates/types.ts` + `src/shared/types.ts`:`GenericTemplate{name,noteNameFormat,path,noteContentFormat,properties,triggers}`、`GenericTrigger`;config 增 `genericTemplates`(默认空数组)
- [ ] T032 [P] `src/content/generic/templates/triggers.ts`:三类触发器匹配 —— 纯字符串走 URL 前缀树、`/regex/` 走正则、`schema:@Type.prop` 走页面 JSON-LD;模板顺序=优先级,无命中→默认模板(FR-015)
- [ ] T033 [P] `src/content/generic/templates/variables.ts`:变量渲染 —— 基础变量(title/author/published/url/content/date:FMT)+ `{{schema:@Type.property}}`/`{{selector:css}}`/`{{meta:name}}` + `|split|wikilink|join|slugify` 过滤器管道;取不到值整键省略(FR-016)
- [ ] T034 `src/content/generic/templates/builtin.ts`:内置模板+触发器 —— mp.weixin.qq.com/知乎/掘金各一;飞书域模板只对未命中 `DocInfo` 的页面生效,文档页路由不变(FR-017;站点选择器思路参考 markClipper `metadata-extractor.js`)
- [ ] T035 `src/content/generic/index.ts` + `frontmatter.ts`:`EXTRACT` 消息携带模板配置;命中模板后 properties→YAML、noteNameFormat→文件名、noteContentFormat→正文;未配置模板时保持 US3 默认 frontmatter 行为;回传结果带命中模板名
- [ ] T036 options UI:模板管理最简形态(模板列表 + JSON 编辑),存 `chrome.storage.local`
- [ ] T037 验收:SC-008(3 个站点模板 100% 命中/未匹配落默认);复跑 SC-001~004(SC-009);`grep -rn "fetch(\|XMLHttpRequest\|sendBeacon" src/content/generic/` 扩到 rules/、templates/;`npm run typecheck` + `npm run build`

## 依赖图

```
T001─┬─T002
     ├─T003─┬─T008──T009──T011──T012──T013
     └─T004 │       T010──┘
   T005[P]──┤
   T006[P]─T006b┤
   T007[P]──┘
后置:T014 / Phase4 / Phase5(T021 已被 Phase6 取代)

Phase1~3 ──► Phase6: T022──T023──T024──T025
                     Phase7: T026[P]┬─T030
                             T027[P]┤
                             T028[P]┤
                             T029[P]┘
                     Phase8: T031[P]┬─T034──T035──T036──T037
                             T032[P]┤
                             T033[P]┘
Phase6 → Phase7 → Phase8 顺序执行(plan §9.6 落地顺序);Phase8 整体可裁剪(开放问题 2)
```
