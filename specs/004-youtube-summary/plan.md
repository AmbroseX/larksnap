# Implementation Plan: YouTube 字幕抓取 + AI 侧边栏总结

**Spec**: `specs/004-youtube-summary/spec.md`
**Branch**: `004-youtube-summary`
**Created**: 2026-07-09

## 1. 设计概述

两条能力,一条数据流:**取材(纯本地)→ 可选总结(用户自配端点)**。取材分两路——YouTube 页抓字幕、普通网页复用 webcopy 的 Readability 提取;总结在 SW 里切块后逐块精炼,结果推回 SidePanel 展示。

```
┌ YouTube 视频页 ──────────────────────┐   ┌ 普通网页 ────────────────┐
│ [youtube.js / content]               │   │ [webcopy.js / content]   │
│  1. 解析 ytInitialPlayerResponse     │   │  Readability 提取正文    │
│     (script 正则;SPA 过期→同源      │   │  (现有管线,零改动)       │
│      refetch 页面 HTML 再正则)       │   └──────────┬───────────────┘
│  2. captionTracks 选语言轨           │              │
│  3. baseUrl + fmt=json3 同源 fetch   │              │
│  4. 拼 segs[].utf8 → transcript      │              │
│  (无字幕/401 → 标题+简介降级)        │              │
└───────────────┬──────────────────────┘              │
                ▼                                     ▼
[SW]  US1: safeName(标题).md → downloadDataUrl / 剪贴板   ←── 到此为止零外发
                │
                ▼ (US2/US3,用户已配置端点 + 首次告知已确认)
[SW / summarize] 切块(≈1000/overlap 100) → 逐块 refine 调
                 用户配置的 OpenAI 兼容 /v1/chat/completions
                │  进度: 第 i/n 块 → reportProgress
                ▼
[SidePanel] SummaryView 展示 → 复制 Markdown(写回飞书复用现有编辑引擎)
```

**为什么字幕不拼 timedtext URL、不上拦截器**:`/api/timedtext` 要 pot/签名参数,自己拼易 401;而 `ytInitialPlayerResponse` 里的 `baseUrl` 是现成带参 URL,加 `fmt=json3` 大多数视频直接可用(研究文档 §三,Glarity 逆向结论,含可照抄的 `getTranscript()`)。主世界 XHR 截胡是更稳但侵入更大的方案,按 YAGNI 留作 P2 兜底(US4)。

**为什么总结逻辑放 SW 而不是 content**:内容跨页面类型(字幕/正文)统一汇到 SW;LLM 请求目标是用户端点,与页面无关,放 SW 配合运行时授权;SidePanel 关闭后任务可继续,进度经 `RuntimeState.lastProgress` 恢复(宪法 III)。

## 2. 路由与入口

复用现有 `doc-detect.detectActiveDoc()` + 新增站点判断,SidePanel 分三态:

- 命中飞书 `DocInfo` → **现有飞书导出界面,本功能不出现**(FR-009,零劫持)。
- 非飞书且 host 命中 `youtube.com/watch` → 显示「导出字幕」(US1)+「AI 总结」(US2)卡片。判定复用 `VIDEO_SITES` 里已有的 youtube host 列表,但仅 `/watch` 路径亮字幕入口。
- 其他普通网页 → 显示「AI 总结」卡片(US3,取材走 webcopy)。
- `chrome://` 等不可注入页 → 入口禁用 + 提示。

「AI 总结」在未配置端点时呈引导态(点击跳设置页),不发任何请求(FR-003)。

## 3. 新增 / 改动文件

### 新增

| 文件 | 职责 |
|---|---|
| `src/content/youtube/transcript.ts` | `getPlayerResponse()`(script 正则 + 视频 ID 校验 + 同源 refetch 兜底)、`listTracks()`、`getTranscript(lang)`(json3 抓取拼接);无字幕/401 返回降级信号与「标题+简介」 |
| `src/content/youtube/index.ts` | content 入口(独立 IIFE → `dist/youtube.js`):监听 `YT_MSG.GET_TRANSCRIPT` / `YT_MSG.LIST_TRACKS`,回传 `TranscriptResult`;末尾置注入标记 |
| `src/background/exporters/transcript.ts` | US1 SW 编排:注入 `youtube.js`(幂等)→ 取字幕 → 拼 Markdown(标题/URL/正文)→ 落盘或回传文本给 UI 复制;进度经 `reportProgress` |
| `src/background/summarize/splitter.ts` | 递归字符切块:段落→句子→字符逐级降切,chunkSize 1000 / overlap 100,纯函数无依赖 |
| `src/background/summarize/llm.ts` | OpenAI 兼容客户端:`chatComplete(cfg, messages)`,超时/401/网络错误分类;仅 fetch 用户配置 baseURL |
| `src/background/summarize/prompts.ts` | 通用总结 prompt(照抄研究文档:简述+emoji 要点列表)、refine prompt(已有总结+新块→更新)、视频章节时间戳 prompt(P2) |
| `src/background/summarize/index.ts` | US2/US3 编排:校验配置与告知确认 → 取材(YouTube 字幕 / webcopy 正文)→ 切块 → refine 循环 → 结果写 RuntimeState + 推 UI |
| `src/sidepanel/SummaryView.tsx` | 总结视图:进行中(第 i/n 块)、结果 Markdown 展示、复制按钮、错误态 |
| `src/content/youtube/inject-main.ts`(P2) | 主世界脚本 → `dist/yt-inject.js`:hook `XMLHttpRequest` 截胡 timedtext 真实 URL,经 CustomEvent 递回隔离世界 |

### 改动

| 文件 | 改动 |
|---|---|
| `vite.config.ts` | esbuild 增第三入口 `src/content/youtube/index.ts` → `dist/youtube.js`(IIFE/chrome110,与 webcopy.js 同配置;P2 再加 `yt-inject.js`) |
| `src/shared/constants.ts` | `MSG` 增 `GET_PAGE_KIND`、`EXPORT_TRANSCRIPT`、`LIST_CAPTION_TRACKS`、`SUMMARIZE_PAGE`;新增 `YT_MSG={GET_TRANSCRIPT, LIST_TRACKS}` |
| `src/shared/types.ts` | 增 `CaptionTrackInfo`、`TranscriptResult`、`SummaryResult`、`AiConfig{baseUrl,apiKey,model,targetLang,acknowledged}`;`ExtensionConfig` 增 `ai?: AiConfig`;`ExportAction` 增 `'transcript' \| 'summarize'`;`TrackEventName` 增 `'summarize'` |
| `src/background/index.ts` | 路由新消息 → `exporters/transcript.ts` / `summarize/index.ts`;`GET_PAGE_KIND` 判 feishu/youtube/generic/restricted |
| `src/sidepanel/SidePanel.tsx` + `actions.ts` | 按 `GET_PAGE_KIND` 三态渲染;新增字幕语言选择(复用 themes 选择器交互模式)与 SummaryView 切换 |
| `src/options/`(现有设置页) | 新增「AI 总结」区块:baseURL/API Key/模型/目标语言,保存时手势发起端点 origin 的 `permissions.request`(沿用 001 模式) |
| `src/background/diagnostic.ts` | 打包前剔除 `ai.apiKey`(FR-006 取证点) |
| `.specify/memory/constitution.md` | US2/US3 发布前:原则 V 增补「用户自配 AI 端点例外」条款(MINOR → v1.1.0,走修订记录流程;需用户拍板,见 §6) |

## 4. 依赖

- **零新增运行时依赖**。字幕解析、切块、refine、OpenAI 兼容请求全部自实现(均为百行内纯逻辑,引 langchain 违背 KISS/YAGNI)。
- 普通网页提取复用已装的 `@mozilla/readability`(webcopy 在用),不重复引入。
- 写回飞书:复用现有编辑引擎与桥接(`skills/larksnap-fetch` + `src/background/bridge.ts` 的 new-doc/编辑能力),本 feature 只需保证总结产物是标准 Markdown,一句话打通,不新建接口(FR-010)。

## 5. 关键实现细节(踩坑点)

1. **content script 读不到页面 `window`**:隔离世界拿不到 `window.ytInitialPlayerResponse`,MVP 统一走「遍历 `<script>` 正则 `var ytInitialPlayerResponse\s*=\s*({.+?});`」(DOM 两个世界共享)。研究文档示例里的 `window.` 直读只在主世界成立,别照抄那半句。
2. **SPA 导航导致数据过期**(Glarity 用主世界解决,MVP 用轻量法):站内点击切视频不整刷,`<script>` 里还是旧视频数据。解法:解析后校验 `playerResponse.videoDetails.videoId === new URL(location.href).searchParams.get('v')`;不一致则同源 `fetch(location.href)` 拿当前页 HTML 再正则一次(content script 同源无 CORS)。
3. **语言选轨三级兜底**:精确匹配用户目标语言 → `languageCode` 前缀匹配(`zh-Hans` 命中 `zh`)→ `captionTracks[0]`;UI 提供轨列表让用户手动切(`LIST_TRACKS` 消息)。
4. **json3 解析**:`data.events.map(e => e.segs?.map(s => s.utf8).join('') || '').join(' ')`,过滤空段、合并空白;`tStartMs` 先保留在结构里(P2 章节时间戳直接用),US1 导出时才拍平成纯文本。
5. **降级链**:无 captionTracks / fetch 失败 / 401 → 返回 `{degraded:true, title, description}`(`videoDetails.title` + `shortDescription`),UI 明示「无字幕,已降级为标题+简介」(FR-002,宪法 III)。
6. **切块 refine 循环**:块数 1 → 直接用总结 prompt 单调;块数 n → 第 1 块总结,第 2..n 块用 refine prompt(传「当前总结 + 新块」);每块完成 `reportProgress('summarize','running',第 i/n 块, percent)`。失败在第 k 块 → 保留前 k-1 块的中间总结展示并标注不完整,不整体丢弃(宪法 III 精神)。
7. **prompt 照抄研究文档**:通用版 "Summarize the following CONTENT into brief sentences of key points, then provide complete highlighted information in a list, choosing an appropriate emoji for each highlight."(输出语言跟随 `targetLang`);视频章节带时间戳另一版留 P2。
8. **端点授权**:保存 AI 设置时在 options 页用户手势里 `chrome.permissions.request({origins:[new URL(baseUrl).origin+'/*']})`,成功才落库;SW 发请求前 `permissions.contains` 校验,缺权限给引导错误。完全复用 001 的运行时授权与 `trustedDomains` 记录模式。
9. **API Key 红线**:`diagnostic.ts` 打包前显式删除 `config.ai.apiKey`;`analytics` 白名单事件 `summarize` 只带 `{kind:'youtube'|'page', ok, chunks, secs}`(FR-006)。
10. **首次告知**:`ai.acknowledged` 默认 false;`SUMMARIZE_PAGE` 处理器发现未确认 → 返回 `needsAck` 信号,SidePanel 弹确认框(含端点域名),确认后写回配置再重发(FR-004)。
11. **注入幂等**:`youtube.js` 末尾置 `window.__larksnap_yt__=true`,SW 注入前查标记,同 webcopy 现有模式。
12. **P2 主世界拦截**(US4):`manifest.json` 增 `web_accessible_resources:['yt-inject.js']`,content script 建 `<script src=chrome.runtime.getURL('yt-inject.js')>` 注入;hook `XMLHttpRequest.prototype.open` 记录含 `/api/timedtext` 的完整 URL,`document.dispatchEvent(CustomEvent)` 递回隔离世界缓存;导出时 json3 直连 401 → 改用截胡 URL(替换其 `fmt` 参数)。只在 YouTube 域注入,不扩大面积。

## 6. 宪法符合性检查

| 原则 | 评估 |
|---|---|
| I 零配置认证 | ✅ 不新增任何飞书认证要求;AI 端点配置是**非飞书**的可选第三方凭据,不构成"App ID/Secret 主认证路径"(禁止事项 1 针对的是飞书认证)。 |
| II 域名不写死 | ✅ 不涉及飞书域;YouTube host 判定复用 `VIDEO_SITES` 常量(站点能力表,非飞书请求目标,与 webcopy/视频下载同性质);LLM 端点完全由用户输入,零硬编码。 |
| III 导出可靠/可恢复 | ✅ 字幕与总结全程 `reportProgress`;refine 中途失败保留部分结果;无字幕/401 有降级产物;SidePanel 重开经 `GET_STATUS` 恢复。 |
| IV 高质量 MD 双路 | ✅ N/A:该原则特指飞书文档取数,本功能不触碰飞书管线(002 已声明过同样边界)。 |
| V 隐私不外发 | ⚠️ **分两段论证**。US1(字幕导出):✅ 完全符合,仅 YouTube 同源请求 + 本地落盘,取证 `grep` 无第三方 fetch(SC-003)。US2/US3(AI 总结):**与现行条文冲突**——"内容禁止外发任何第三方服务器"字面上禁止发给任何 LLM。处理:①能力默认关闭,未配置端点时行为与现状完全一致;②端点由用户自填,无内置中转,无隐式上报;③首次使用显式告知+确认;④按治理规则「确需突破必须先修订宪法」,**US2/US3 对外发布前须先修宪**:原则 V 增补例外条款(建议文案:"例外:用户在设置页显式配置自有 AI 端点并经一次性告知确认后,页面正文/字幕可发往该端点用于总结;扩展禁止内置默认端点或未经确认发送"),MINOR 升 v1.1.0。**是否修宪由用户拍板;不批准则 US2/US3 不发布,US1 独立成活。** |
| VI 合规告知 | ✅ 无"绕过组织限制"语义;YouTube 字幕为用户可见内容的本地保存。AI 告知见 FR-004。 |

## 7. 验收与回归

- 跑 spec 的 SC-001~007。
- 取证:`grep -rn "fetch(\|XMLHttpRequest" src/content/youtube/ src/background/summarize/` 确认仅有 YouTube 同源与用户 baseUrl 两类目标,无硬编码第三方域名(SC-003/004)。
- 取证:`grep -n "apiKey" src/background/diagnostic.ts src/background/analytics.ts` 确认剔除逻辑存在、统计不含 Key(FR-006)。
- 飞书回归:公有云 + 私有化各导一篇,行为零变化(SC-006);webcopy 整页/选区复制回归。
- `npm run typecheck` + `npm run build` 通过。

## 8. 分期

- **P0(MVP)**:US1 字幕抓取导出/复制(transcript 解析 + SPA 兜底 + 语言选轨 + 降级链 + SW 落盘 + UI 入口)。**可独立发布,不依赖修宪。**
- **P1**:US2 视频 AI 总结 + US3 网页正文总结(AI 设置页 + 端点授权 + 首次告知 + splitter/refine/llm + SummaryView)。**发布前置条件:宪法 v1.1.0 例外修订获批。**
- **P2**:US4 主世界 XHR 拦截兜底、章节时间戳模式;总结「一键写回飞书」入口化(现阶段走复制 + larksnap-fetch)。
