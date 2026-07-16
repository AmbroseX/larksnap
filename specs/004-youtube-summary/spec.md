# Feature Specification: YouTube 字幕抓取 + AI 侧边栏总结

**Feature Branch**: `004-youtube-summary`
**Created**: 2026-07-09
**Status**: Draft
**Input**: 在 YouTube 视频页一键抓取字幕并导出为文本/Markdown(纯本地);在侧边栏对 YouTube 视频与普通网页发起 AI 总结(内容发往**用户自己配置**的 OpenAI 兼容端点)。技术路线借鉴 Glarity 逆向结论(见 `docs/research/2026-07-09-chrome扩展核心实现逆向.md` §三):解析 `ytInitialPlayerResponse` 拿 captionTracks + `fmt=json3` 抓字幕,普通网页复用现有 webcopy 的 Readability 提取,长文切块后逐块累进精炼(refine)。字幕抓取与 AI 总结拆成独立优先级,前者不触碰宪法原则 V,可先落地。

## Clarifications

> 依据研究文档 §三 与宪法审读直接定夺,不阻塞实现。

- Q: AI 总结要把内容发给 LLM,与宪法原则 V「内容不外发、无后端」冲突吗? → A: **拆开处理**。①字幕抓取/导出(US1)全程纯本地,零外发,不触碰原则 V,作 P0 先行;②AI 总结(US2/US3)是**用户显式开启、端点由用户自己配置**(OpenAI 兼容 baseURL + API Key)的可选能力——默认不配置即不发送任何内容,扩展**不内置任何默认第三方中转**、不做隐式上报,首次使用前必须明确告知「内容将发送到你配置的 AI 端点」并经用户确认。按宪法治理规则「确需突破必须先修订宪法」,US2/US3 上线前需给原则 V 增补一条例外(MINOR 修订,见 plan §6);US1 不受此约束。
- Q: YouTube 字幕怎么抓? → A: **MVP 不自己拼 timedtext URL,也不上 XHR 拦截器**。content script 里解析 `ytInitialPlayerResponse`(页面 `<script>` 正则/兜底同源 refetch 页面 HTML)拿 `captions.playerCaptionsTracklistRenderer.captionTracks`(每条含 `baseUrl`+`languageCode`),选好语言后 `baseUrl` 追加 `fmt=json3` 直接 fetch(content script 同源无 CORS),解析 `{events:[{segs:[{utf8}]}]}` 拼出全文。研究文档 §三有可直接照抄的 `getTranscript()` 实现。少数视频该 URL 会 401——**主世界 XHR 拦截截胡播放器真实字幕 URL** 作 P2 兜底(US4),MVP 遇 401 与无字幕统一退化为「标题 + 简介」。
- Q: LLM 后端接什么? → A: **OpenAI 兼容 `/v1/chat/completions`**,由用户在设置页填 baseURL / API Key / 模型名。不学 Glarity 走自家中转,不新建任何后端。
- Q: 长文/长字幕超过上下文怎么办? → A: 自实现轻量**递归字符切块**(chunkSize≈1000、overlap≈100,按段落→句子→字符逐级降切)+ **refine 逐块累进精炼**(首块直接总结,后续块拿「已有总结 + 新块」更新总结,不是简单 map-reduce)。不引入 langchain 全家桶(KISS/YAGNI)。
- Q: 普通网页正文从哪来? → A: **复用现有 webcopy 管线**(`src/content/webcopy/html2md.ts`,Readability 提取 + 降级整页 body),即 002 落地的通用提取能力,不重复造轮子。
- Q: 总结跑在哪个 UI? → A: **复用现有 SidePanel**,新增总结视图;不做 Glarity 的页面注入面板(YAGNI)。
- Q: API Key 怎么存? → A: `chrome.storage.local`(与现有 config 同仓)。Key 绝不进诊断包、绝不进匿名统计;统计只报枚举事件(成败/耗时/块数),不含内容、URL、端点地址。
- Q: 用户端点是任意域名,SW 怎么合法 fetch? → A: 沿用 001 已有的**运行时授权模式**(`optional_host_permissions: *://*/*` + 用户手势 `permissions.request`):保存端点设置时对该 origin 发起授权,不默认扩权。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - YouTube 字幕抓取并导出/写回(Priority: P0,纯本地)

作为用户,在 YouTube 视频页打开侧边栏,点击「导出字幕」,扩展抓取该视频字幕(自动选语言,可切换),导出为 `.md` 文件落盘或复制到剪贴板;也可经现有编辑引擎写回我的飞书文档。

**Why this priority**: 字幕抓取是本功能里最有价值、又完全不触碰宪法原则 V 的部分——零外发、零配置,独立可用,是 US2 的取材地基。

**Independent Test**: 打开一个带字幕的公开 YouTube 视频,点「导出字幕」,得到一个含视频标题、来源 URL 与完整字幕文本的 `.md`;全程网络面板无任何非 YouTube/非飞书域名请求。

**Acceptance Scenarios**:

1. **Given** 一个带多语言字幕的 YouTube 视频页, **When** 点击「导出字幕」, **Then** 按目标语言(默认中文,退而求其次前缀匹配/首条)选轨并下载 `.md`,字幕文本完整无 HTML 标签。
2. **Given** 字幕轨列表可用, **When** 用户在入口上切换语言, **Then** 按所选语言轨重新抓取。
3. **Given** 无字幕视频, **When** 点击「导出字幕」, **Then** 明确提示「该视频无字幕」,并提供「导出标题+简介」的降级产物,不静默失败。
4. **Given** 在站内点击切换过视频(SPA 导航,页面未整刷), **When** 导出, **Then** 抓到的是**当前**视频的字幕,不是上一个视频的(视频 ID 校验 + 同源 refetch 兜底)。
5. **Given** 已抓到字幕文本, **When** 点「复制」, **Then** 剪贴板得到同样内容(便于粘去任何地方,包括经 larksnap-fetch 写回飞书)。

### User Story 2 - YouTube 视频 AI 总结(Priority: P1,用户配置端点)

作为用户,我在设置页配置好自己的 OpenAI 兼容端点(baseURL + API Key + 模型),在 YouTube 视频页侧边栏点「AI 总结」,扩展把字幕喂给我配置的 LLM,在侧边栏展示要点式总结,可复制为 Markdown。

**Why this priority**: 核心增值能力,但依赖 US1 取材,且需要用户先完成端点配置与宪法例外修订,故次于 US1。

**Independent Test**: 配好端点后在带字幕视频页点「AI 总结」,侧边栏出现分块进度,最终展示「简述 + emoji 要点列表」形态的总结;网络面板确认除 YouTube 字幕请求外,唯一外发目标是用户填的 baseURL。

**Acceptance Scenarios**:

1. **Given** 未配置 AI 端点, **When** 打开侧边栏, **Then** 「AI 总结」入口呈未配置态,点击引导去设置页,**不发出任何网络请求**。
2. **Given** 已配置端点但首次使用, **When** 点「AI 总结」, **Then** 弹出一次性告知「页面/字幕内容将发送到你配置的 AI 端点(显示端点域名)」,用户确认后才继续,且确认状态持久化。
3. **Given** 字幕超长(如 1 小时视频), **When** 总结, **Then** 自动切块并逐块精炼,进度按「第 i/n 块」推送,最终产出单份总结。
4. **Given** 端点返回 401/超时, **When** 总结, **Then** 给出可读错误(区分 Key 无效/网络失败),不静默失败。
5. **Given** 总结完成, **When** 点「复制 Markdown」, **Then** 剪贴板得到总结全文。

### User Story 3 - 普通网页正文 AI 总结(Priority: P1)

作为用户,在任意非飞书、非 YouTube 的文章页,侧边栏点「AI 总结」,扩展用现有 Readability 提取正文,走与 US2 相同的切块精炼与展示流程。

**Independent Test**: 配好端点,在一篇长博客页点「AI 总结」,得到要点式总结;正文提取复用 webcopy,无新增提取代码路径。

**Acceptance Scenarios**:

1. **Given** 任意可读文章页, **When** 点「AI 总结」, **Then** 正文经 Readability 提取(失败降级整页 body)后总结展示。
2. **Given** 页面正文极短(如 <200 字), **When** 总结, **Then** 不切块直接单次调用。
3. **Given** 飞书文档页, **When** 打开侧边栏, **Then** 仍是现有飞书导出界面,本功能入口不出现(路由不劫持)。

### User Story 4 - XHR 拦截兜底 + 视频章节时间戳(Priority: P2)

作为用户,遇到 `fmt=json3` 直连 401 的视频,扩展经主世界脚本截胡播放器自己发出的带鉴权字幕 URL 完成抓取;总结时可选「章节模式」,产出带 `[mm:ss]` 时间戳的分章节要点。

**Why this priority**: 401 是少数情况;主世界注入增加 `web_accessible_resources` 面积,按 YAGNI 后置,MVP 有降级路径兜着。

**Independent Test**: 找一个 json3 直连 401 的视频,开启兜底后播放几秒再导出字幕,成功取到;章节模式总结产物含时间戳。

**Acceptance Scenarios**:

1. **Given** json3 直连返回 401 的视频, **When** 播放器加载字幕后再导出, **Then** 复用截胡到的真实 URL 抓取成功。
2. **Given** 章节模式开启, **When** 总结视频, **Then** 产物按时间段分节,每节带起始时间戳。

## Requirements *(mandatory)*

- **FR-001**: 字幕抓取(US1)MUST 全程纯本地:仅请求 YouTube 同源字幕接口,产物经剪贴板/`chrome.downloads` 落地,MUST NOT 向任何第三方发送内容(宪法 V)。
- **FR-002**: 字幕抓取 MUST 走「解析 `ytInitialPlayerResponse` → captionTracks 选轨 → `baseUrl+fmt=json3` 同源 fetch → 拼 `segs[].utf8`」主路;MUST 处理 SPA 导航后数据过期(视频 ID 校验 + 同源 refetch 当前页 HTML 兜底);无字幕/401 MUST 降级为「标题+简介」并明确提示,MUST NOT 静默失败(宪法 III)。
- **FR-003**: AI 端点 MUST 由用户在设置页自行配置(OpenAI 兼容 baseURL + API Key + 模型名);扩展 MUST NOT 内置任何默认第三方端点或中转;未配置时 MUST NOT 发出任何 LLM 请求,总结入口呈未配置引导态。
- **FR-004**: 首次发起 AI 总结 MUST 展示一次性告知(内容将发送到用户配置的端点,含端点域名),经用户确认后方可继续;确认状态 MUST 持久化。
- **FR-005**: LLM 请求 MUST 仅指向用户配置的 baseURL;对该 origin 的 host 权限 MUST 走用户手势运行时授权(沿用 001 模式),MUST NOT 默认申请常驻全站权限。
- **FR-006**: API Key MUST 只存 `chrome.storage.local`;MUST NOT 出现在诊断包、匿名统计、日志输出中;统计事件 MUST 仅含枚举/布尔/整数(不含内容、URL、端点地址)。
- **FR-007**: 超长内容 MUST 自动切块(递归字符切块,chunkSize≈1000/overlap≈100)并逐块 refine 精炼;进度 MUST 经 `reportProgress` 推送 UI(宪法 III);短内容 MUST 单次直调不切块。
- **FR-008**: 普通网页总结取材 MUST 复用现有 webcopy 提取管线(Readability + 整页 body 兜底),MUST NOT 新增第二套通用提取实现(DRY)。
- **FR-009**: 路由 MUST 保持:飞书页走现有飞书通道不受影响;YouTube 视频页展示字幕/总结入口;其他网页展示总结入口;不可注入页(`chrome://` 等)入口禁用并提示。
- **FR-010**: 总结产物 MUST 可复制为 Markdown;写回飞书复用现有编辑引擎能力(larksnap-fetch / bridge),不为此新建接口。
- **FR-011**: US2/US3 上线(对外发布)前 MUST 完成宪法原则 V 的例外修订(用户自配 AI 端点、显式确认后的内容发送);修订前 US1 可独立发布。

## Success Criteria *(mandatory)*

- **SC-001**: 抽样 10 个带字幕的公开 YouTube 视频,≥9 个成功导出完整字幕文本;其中含至少 2 个多语言轨视频验证语言选择正确。
- **SC-002**: 无字幕视频与 json3 401 视频各抽 1 个,均得到明确提示 + 「标题+简介」降级产物,零静默失败。
- **SC-003**: 未配置 AI 端点时,网络面板全程零 LLM 请求;`grep` 取证:总结模块无任何硬编码第三方端点域名。
- **SC-004**: 配置端点后发起总结,网络面板确认外发目标仅为用户填的 baseURL(字幕请求仅 YouTube 同源)。
- **SC-005**: 1 小时以上视频字幕(约 1 万字以上)总结可完成,分块进度可见,产物为单份要点式总结。
- **SC-006**: 飞书通道回归:现有导出行为零变化;webcopy 现有复制行为零变化。
- **SC-007**: `npm run typecheck` + `npm run build` 通过(宪法治理)。
