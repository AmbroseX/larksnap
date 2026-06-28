# Tasks: 任意网页 Markdown 化下载

**Plan**: `specs/002-generic-page-markdown/plan.md` · **Spec**: `./spec.md`

约定:`[P]` 可与同段其他 `[P]` 并行(改不同文件);顺序项有依赖。每个 phase 末尾跑 `npm run typecheck`。

## Phase 0 — 脚手架与依赖

- [ ] T001 安装依赖:`npm i @mozilla/readability turndown turndown-plugin-gfm` + `npm i -D @types/turndown`(`defuddle` 留待 T021/P2,见 plan §4.5)
- [ ] T002 `vite.config.ts` esbuild 增第二入口 `src/content/generic/index.ts` → `dist/generic.js`(IIFE/target=chrome110,与 content.js 同配置)
- [ ] T003 `src/shared/constants.ts`:`MSG` 增 `EXPORT_GENERIC_MD`/`PREVIEW_GENERIC_MD`;新增 `GENERIC_MSG={EXTRACT:'generic_extract'}`
- [ ] T004 `src/shared/types.ts`:增 `GenericMeta`、`GenericExtractResult{markdown,title,meta,degraded}`;`ExtensionConfig` 增 `genericFrontmatter:boolean`(默认 true)、`genericImageMode:'link'|'zip'`(默认 'link');`DEFAULT_CONFIG` 补默认值

## Phase 1 — 通用通道核心(content 侧) [US1 P0]

- [ ] T005 [P] `src/content/generic/to-markdown.ts`:Turndown 实例 + `use(gfm)`;规则:atx 标题、fenced 代码块(读 `language-*` class)、`bulletListMarker:'-'`、`remove(script/style/noscript/iframe)`;导出 `htmlToMarkdown(html, baseURI)`
- [ ] T006 [P] `src/content/generic/extract.ts`:移植 OpenCLI `ref/OpenCLI/src/browser/article-extract.ts` —— `extractArticle()` 抽象接口(可换提取器),内部:`isProbablyReaderable` 门控 → 深克隆 document → Readability 解析(`source:'readability'`);未命中走兜底选择器链 `main→[role=main]→#main-content→#main→article→body` 取首个 >80 字根(`source:'fallback'`,`degraded:true`);提取前把 `a[href]`/`img[src|data-src|data-original|srcset]` 经 `new URL(raw,document.baseURI)` 绝对化。输出 `{contentHtml,meta,source,degraded}`
- [ ] T006b [P] `src/content/generic/extract.ts` 边界短路(OpenCLI 实战坑):① `document.contentType` 非 `text/html` → 取原始文本(`source:'raw-text'`);② body 为单个 `<pre>`(.txt/.md raw 页)→ 取 `textContent`(`source:'pre'`);二者均跳过提取器
- [ ] T007 [P] `src/content/generic/frontmatter.ts`:`buildFrontmatter(meta)` → YAML(title/source/author/published/clipped),缺字段省略;`clipped` 时间戳由 SW 传入(content 无需 Date 也可,用 `new Date().toISOString()`)
- [ ] T008 `src/content/generic/index.ts`:监听 `GENERIC_MSG.EXTRACT` → extract → to-markdown →(按 config)拼 frontmatter → 回传 `GenericExtractResult`;末尾置 `window.__feishu2md_generic__=true`;不可注入/异常走 try-catch 回传 error(依赖 T005-T007)

## Phase 2 — SW 编排与路由 [US1 P0]

- [ ] T009 `src/background/exporters/generic-md.ts`:`exportGenericMarkdown(tabId)` —— 注入 `generic.js`(幂等)→ `chrome.tabs.sendMessage(EXTRACT)` → `safeName(title)+'.md'` → `downloadDataUrl`(复用 `download.ts`);全程 `reportProgress`;注入失败给友好错误(FR-006)
- [ ] T010 `src/background/exporters/generic-md.ts`:增 `previewGenericMarkdown(tabId)` 返回 markdown 文本(不落盘)给 UI 预览(US2 复用,提前留口)
- [ ] T011 `src/background/index.ts`:路由 `EXPORT_GENERIC_MD`/`PREVIEW_GENERIC_MD` → 上述函数

## Phase 3 — UI 入口 [US1 P0 / US2 P1]

- [ ] T012 `src/sidepanel/SidePanel.tsx`:依 `DocInfo` 是否命中飞书分流 —— 飞书页显示现有 ACTIONS;非飞书页显示通用卡片("下载当前页为 Markdown" + "预览/复制");不可注入页禁用 + 提示
- [ ] T013 `src/sidepanel/actions.ts` 或新组件:接 `EXPORT_GENERIC_MD`/`PREVIEW_GENERIC_MD`;预览面板展示 MD 文本 + 字数 + 复制按钮(US2)
- [ ] T014 设置项(options):`genericFrontmatter` 开关(US3)

## Phase 4 — 验收与回归

- [ ] T015 抽样 10 个文章/博客/文档站验 SC-001/SC-002(正文完整度、代码块/表格/列表/链接保真)
- [ ] T016 飞书回归:公有云 + 私有化各一篇,确认导出行为零变化(SC-003)
- [ ] T017 取证:`grep -rn "fetch(\|XMLHttpRequest\|sendBeacon" src/content/generic/` 确认无外域请求(SC-004 / 宪法 V);`npm run typecheck` + `npm run build` 通过

## Phase 5 — 增强(P2,可选)

- [ ] T021 (可选)提取器升级 Defuddle:`npm i defuddle`,在 `extractArticle()` 接口后替换/并存 Readability;仅当 T015 实测 Readability 在代码块/表格/中文站点丢结构明显时启用(plan §4.5)
- [ ] T018 US4 选区右键:`contextMenus` 注册"复制选区为 Markdown",转 `window.getSelection()` 的 HTML
- [ ] T019 图片 zip 模式:`genericImageMode:'zip'` 时下载图片打包(复用 `jszip`+`media-util`),跨域图走运行时授权(沿用 001 手势授权模式)
- [ ] T020 提取前自动滚动触发懒加载(可选开关,默认关)

## 依赖图

```
T001─┬─T002
     ├─T003─┬─T008──T009──T011──T012──T013
     └─T004 │       T010──┘
   T005[P]──┤
   T006[P]─T006b┤
   T007[P]──┘
后置:T014 / Phase4 / Phase5(含 T021 Defuddle 升级,依赖 T015 实测结论)
```
