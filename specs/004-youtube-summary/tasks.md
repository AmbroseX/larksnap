# Tasks: YouTube 字幕抓取 + AI 侧边栏总结

**Plan**: `specs/004-youtube-summary/plan.md` · **Spec**: `./spec.md`

约定:`[P]` 可与同段其他 `[P]` 并行(改不同文件);顺序项有依赖。每个 phase 末尾跑 `npm run typecheck`。零新增运行时依赖(plan §4)。

## Phase 0 — 脚手架与类型

- [x] T001 `src/shared/constants.ts`:`MSG` 增 `GET_PAGE_KIND`/`EXPORT_TRANSCRIPT`/`LIST_CAPTION_TRACKS`/`SUMMARIZE_PAGE`;新增 `YT_MSG={GET_TRANSCRIPT:'yt_get_transcript', LIST_TRACKS:'yt_list_tracks'}`
- [x] T002 `src/shared/types.ts`:增 `CaptionTrackInfo{languageCode,name,baseUrl?}`、`TranscriptResult{transcript?,degraded,title,description?,videoId,track?}`、`SummaryResult{markdown,chunks,partial?}`、`AiConfig{baseUrl,apiKey,model,targetLang,acknowledged}`;`ExtensionConfig` 增 `ai?: AiConfig`;`ExportAction` 增 `'transcript'|'summarize'`;`TrackEventName` 增 `'summarize'`;`DEFAULT_CONFIG` 不带 ai 默认值(未配置即无)
  - **实现偏差**:`TranscriptResult` 额外带 `segments?: TranscriptSegment[]`(保留 `tStartMs` 的结构化分段,plan §5.4 要求保留结构,P2 章节时间戳直接用);`SummaryResult` 额外带 `kind?: 'youtube'|'page'`(统计枚举用,不含内容);另增 `PageKind`/`PageKindInfo`(GET_PAGE_KIND 响应)与 `SummaryNeedsAck`(FR-004 引导响应)。
- [x] T003 `vite.config.ts`:esbuild 增第三入口 `src/content/youtube/index.ts` → `dist/youtube.js`(IIFE/chrome110,与 webcopy.js 同配置)

## Phase 1 — 字幕抓取 content 侧 [US1 P0]

- [x] T004 `src/content/youtube/transcript.ts`:`getPlayerResponse()` —— 遍历 `<script>` 正则 `var ytInitialPlayerResponse\s*=\s*({.+?});`(**不要**读 `window.ytInitialPlayerResponse`,隔离世界拿不到,plan §5.1);校验 `videoDetails.videoId` 与 URL `v` 参数,不一致同源 `fetch(location.href)` 重取 HTML 再正则(plan §5.2)
  - **实现偏差**:两条路都拿不到当前视频数据时返回 `null` 走降级链(标题退用 `document.title`),**不**退回 DOM 里的旧视频数据,避免 SPA 切视频后导出上一个视频的字幕(spec US1 场景 4)。
- [x] T005 `src/content/youtube/transcript.ts`:`listTracks()` 返回 `CaptionTrackInfo[]`;`getTranscript(lang)` —— 三级选轨(精确→前缀→首条,plan §5.3)→ `baseUrl+fmt=json3` fetch → 拼 `events[].segs[].utf8`(保留 `tStartMs` 结构,导出时拍平);无轨/fetch 失败/401 → `{degraded:true, title, description}`(取 `videoDetails.title/shortDescription`)(依赖 T004)
- [x] T006 `src/content/youtube/index.ts`:监听 `YT_MSG.GET_TRANSCRIPT`/`YT_MSG.LIST_TRACKS` 回传结果,try-catch 回传 error;末尾置 `window.__larksnap_yt__=true`(依赖 T005)
  - **实现偏差**:标记置于文件**开头**的挂载守卫里(同 webcopy 现有幂等模式,先查再置),效果一致。

## Phase 2 — SW 编排与 UI 入口 [US1 P0]

- [x] T007 `src/background/exporters/transcript.ts`:`exportTranscript(tabId, lang?, mode:'download'|'copy')` —— 幂等注入 `youtube.js` → `sendMessage(GET_TRANSCRIPT)` → 拼 Markdown(标题/URL/字幕正文;降级时标注)→ `safeName(标题).md` 落盘或回传文本;全程 `reportProgress('transcript',...)`;另出 `listCaptionTracks(tabId)`
  - **实现偏差**:签名不带 `tabId`,内部经 `getActiveTab()` 解析活跃标签页(与 screenshot/webcopy 现有编排一致,消息来自侧边栏时本就没有 sender.tab);youtube.com 不在默认 `host_permissions` 里,注入失败回 `needsPermission` 由侧边栏在用户手势里 `permissions.request` 后重试(同 webcopy 辅路径);另出 `fetchTranscriptFromTab(tabId, lang)` 供 T014 总结取材复用(DRY)。
- [x] T008 `src/background/index.ts`:路由 `EXPORT_TRANSCRIPT`/`LIST_CAPTION_TRACKS` → T007;`GET_PAGE_KIND` —— 依次判 feishu(`detectActiveDoc`)/youtube(`VIDEO_SITES` 的 youtube host + `/watch` 路径)/restricted(`chrome://` 等)/generic
  - **实现偏差**:feishu 判定用纯 URL 的 `detectDocFromUrl`(不注入、不弹授权),比 `detectActiveDoc` 轻;restricted 判定复用 webcopy 的 `isRestrictedUrl`。
- [x] T009 `src/sidepanel/SidePanel.tsx` + `actions.ts`:按 `GET_PAGE_KIND` 三态渲染 —— 飞书页现状不动;YouTube 页出「导出字幕」卡片(带语言轨选择,复用 themes 选择器交互 + 「复制」按钮);restricted 禁用提示
  - **实现偏差**:同 003 的结论,`actions.ts` 是飞书导出宫格专用,不动它;字幕卡片独立成 `src/sidepanel/TranscriptCard.tsx`,由 SidePanel 在非飞书分支按 `GET_PAGE_KIND` 渲染(权限兜底/剪贴板小工具提炼到 `src/sidepanel/permission-call.ts`);SidePanel 顺带补了 `tabs.onActivated/onUpdated` 监听,切标签页与 SPA 跳转时刷新三态(否则 YouTube 站内切视频入口不更新)。
- [ ] T010 验收 US1:带字幕/多语言轨/无字幕/SPA 切视频四类各手测(SC-001/002 抽样在 Phase 5);`npm run typecheck`

## Phase 3 — AI 总结引擎(SW 侧) [US2/US3 P1]

- [x] T011 [P] `src/background/summarize/splitter.ts`:`splitText(text, {chunkSize:1000, overlap:100})` 递归降切(段落→句子→字符),纯函数
- [x] T012 [P] `src/background/summarize/llm.ts`:`chatComplete(ai: AiConfig, messages)` fetch `{baseUrl}/v1/chat/completions`;错误分类(401=Key 无效/超时/网络);发请求前 `permissions.contains` 校验端点 origin,缺权限抛引导错误(plan §5.8)
  - **实现偏差**:用户填的 baseUrl 若已以 `/v1` 结尾则只拼 `/chat/completions`,避免拼重(常见填法兼容)。
- [x] T013 [P] `src/background/summarize/prompts.ts`:通用总结 prompt(照抄研究文档 §三,输出语言跟随 `targetLang`)+ refine prompt(当前总结+新块→更新总结)
- [x] T014 `src/background/summarize/index.ts`:`summarizePage(tabId)` —— ①无 `ai` 配置 → 返回引导错误;②`acknowledged=false` → 返回 `needsAck`;③取材:youtube 页走 T007 字幕(降级则用标题+简介),generic 页走现有 `webcopyPageMd()`(FR-008 复用,零新提取代码);④单块直调 / 多块 refine 循环,每块 `reportProgress('summarize','running','第 i/n 块',pct)`;⑤中途失败保留部分结果 `partial:true`(依赖 T011-T013)
  - **实现偏差**:同 T007,签名不带 `tabId`(内部取活跃标签页);`needsAck` 响应附带 `endpointOrigin` 供告知框展示域名(FR-004);webcopy 取材遇无权限时把 `needsPermission` 原样透传,侧边栏手势授权后重试。
- [x] T015 `src/background/index.ts`:路由 `SUMMARIZE_PAGE` → T014,包 `trackedExport` 形态统计 `{kind, ok, chunks, secs}`(不含内容/URL/端点,FR-006)
  - **实现偏差**:未套 `trackedExport`(那是 `export` 事件族),按同形态单独上报 `summarize` 事件 `{kind, ok, chunks, secs}`;`needsAck` 引导响应不算一次总结、不上报;`analytics.ts` 的 `EVENT_WHITELIST` 同步放行 `'summarize'`(否则事件被白名单丢弃)。
- [x] T016 `src/background/diagnostic.ts`:打包前显式删除 `config.ai.apiKey`(FR-006 取证点);`npm run typecheck`
  - **实现偏差**:现有诊断包原本不含 config,本次把「剔除 apiKey 后的配置副本」加进诊断包(排查有用,且让剔除逻辑真实生效而非空转)。

## Phase 4 — 设置页与总结视图 [US2/US3 P1]

- [x] T017 [P] options 设置页:新增「AI 总结」区块 —— baseURL/API Key/模型/目标语言表单;保存手势内 `chrome.permissions.request({origins:[端点 origin+'/*']})`,成功才落库并记 `trustedDomains`(沿用 001 模式)
  - **实现偏差**:AI 区块用独立的「保存 AI 配置」按钮(授权必须在用户手势里,与主表单保存分离;主表单保存时剔除 `ai` 字段避免旧值覆盖);换端点 origin 时自动把 `acknowledged` 重置为 false(告知里的域名变了,需重新确认);另加「清除 AI 配置」按钮。
- [x] T018 [P] `src/sidepanel/SummaryView.tsx`:进行中(块进度)/结果 Markdown 展示/「复制 Markdown」/错误态(Key 无效、未授权、部分结果标注)
- [x] T019 `src/sidepanel/SidePanel.tsx`:「AI 总结」卡片(YouTube 页与 generic 页均出)—— 未配置端点呈引导态跳设置页;收到 `needsAck` 弹一次性告知框(含端点域名),确认写回 `ai.acknowledged` 后重发(FR-004);接 SummaryView(依赖 T017/T018)
  - **实现偏差**:引导态/告知框/进度/结果全部内聚在 `SummaryView.tsx` 里(SidePanel 只按三态决定渲染与否,改动最小);告知是卡片内联确认区,不是弹窗,行为同规格(确认持久化后自动重发)。
- [x] T020 `npm run typecheck` + `npm run build`(均通过,`dist/youtube.js` 已产出)

## Phase 5 — 验收、取证与回归

- [ ] T021 SC-001/002 抽样:10 个带字幕视频(含 2 个多语言轨)+ 无字幕/401 各 1 个
- [ ] T022 SC-003/004 取证:未配置端点全程零 LLM 请求;`grep -rn "fetch(\|XMLHttpRequest" src/content/youtube/ src/background/summarize/` 无硬编码第三方域名;配置后网络面板外发仅用户 baseUrl
- [ ] T023 SC-005 长内容:1 小时以上视频字幕总结完成,块进度可见
- [ ] T024 SC-006 回归:飞书公有云+私有化各导一篇零变化;webcopy 整页/选区复制零变化;`grep -n "apiKey" src/background/diagnostic.ts src/background/analytics.ts` 确认剔除
- [ ] T025 **修宪前置**(US2/US3 发布门槛,FR-011):用户批准后按治理流程给 `.specify/memory/constitution.md` 原则 V 增补「用户自配 AI 端点例外」,升 v1.1.0 并写修订记录;**未批准则仅发布 US1**

## Phase 6 — 增强(P2,可选) [US4]

- [ ] T026 主世界拦截兜底:`src/content/youtube/inject-main.ts` hook `XMLHttpRequest.prototype.open` 记录 `/api/timedtext` 真实 URL,CustomEvent 递回隔离世界缓存;`manifest.json` 增 `web_accessible_resources:['yt-inject.js']`;`vite.config.ts` 加入口;json3 401 时改用截胡 URL(plan §5.12)
- [ ] T027 章节时间戳模式:transcript 保留的 `tStartMs` 分段注入 `[mm:ss]` 标记 + 章节版 prompt(`prompts.ts`),SummaryView 增模式开关
- [ ] T028 总结「一键写回飞书」入口:复用现有编辑引擎/bridge 能力(现阶段用户走复制 + larksnap-fetch,已可用)

## 依赖图

```
T001─┬─T003
     └─T002──T004──T005──T006──T007──T008──T009──T010
                    (US1 P0 可独立发布)
T011[P]─┐
T012[P]─┼─T014──T015──T016
T013[P]─┘         │
T017[P]─┐         │
T018[P]─┴─T019────┴─T020──Phase5(T021-T024)
T025(修宪,US2/US3 发布门槛,需用户拍板)
Phase6: T026-T028(P2)
```
