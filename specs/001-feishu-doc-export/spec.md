# Feature Specification: 飞书文档导出助手

**Feature Branch**: `001-feishu-doc-export`
**Created**: 2026-06-26
**Status**: Draft
**Input**: 飞书文档导出助手 Chrome MV3 扩展。在飞书文档页面(公有云+私有化自建域名)侧边栏一键导出为 Markdown(P0)/PDF(P1)/HTML(P1),批量下载附件(P1),离线缓存(P1),导出诊断信息(P0支撑)。Markdown 双路:官方导出(P-official)与 client_vars+apool 解码(P-decode)运行时按host探测。详见 docs/技术方案.md。当前为骨架占位需逐项实现。

## Clarifications

> 以下问题依据 `docs/技术方案.md` 的实测结论与既定设计直接定夺,不阻塞实现。

- Q: Markdown 取数走官方导出还是自解码? → A: **两条都要**。运行时按当前文档 host 探测:租户支持官方 md 导出走 P-official(质量最高);不支持(如部分私有化返回 `1002 no permission`)自动回退 P-decode(`client_vars`+apool 自解码)。用户始终只点"导出 Markdown",内部自动选路。
- Q: 私有化/企业自建域名(非 feishu.cn)如何识别? → A: 不依赖域名白名单。已知公有云域名直接信任;未知域名看路径是否形如 `/<type>/<token>` 且 token 匹配正则 `^[A-Za-z0-9]{16,}$`,命中则判定"疑似飞书私有化文档"(`isPrivateDeploy=true`)。
- Q: 私有化域名无法预先声明 host 权限怎么办? → A: 用 `optional_host_permissions` + 用户手势(点击按钮)触发的运行时授权;已授权域名记入"已信任域名"列表,可查看/撤销。
- Q: Markdown 图片默认下载还是保留在线链接? → A: 默认 `download`(打包进 zip,离线可读);`link` 模式产出纯 .md 但私有化在线图在无登录态环境打不开,仅作可选项。
- Q: 导出被组织关闭时 P-decode 绕过限制是否允许? → A: 技术上支持,但**必须明确告知"仅在被授权前提下使用"**,P-decode 前提示"该文档官方导出已关闭,继续即绕过该限制"(宪法原则 VI)。
- Q: 诊断信息是否包含原始用户数据? → A: 必须脱敏,显式剔除 `editor_map`/`user_map`/`creator_id`/`owner_id` 等 PII 字段后才可打包。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 识别文档与按需授权(Priority: P0)

作为飞书用户,我在任意飞书文档页面(公有云或企业私有化自建域名)打开扩展侧边栏时,扩展能正确识别"这是一篇飞书文档"并展示其标题/类型;若是私有化未授权域名,引导我一键授权访问该域名,以便后续导出能调用内部接口。

**Why this priority**: 一切导出能力的前置地基。识别失败或无权限,后续所有功能都无法触发。覆盖私有化是本产品差异化核心。

**Independent Test**: 在公有云 `*.feishu.cn/docx/<token>` 与私有化 `example-tenant.corp.example.com/wiki/<token>` 两类页面分别打开侧边栏,验证识别正确、私有化能完成运行时授权。

**Acceptance Scenarios**:

1. **Given** 打开公有云飞书 docx 页面, **When** 打开侧边栏, **Then** 显示文档标题、类型 `docx`、token,功能列表可用。
2. **Given** 打开私有化飞书 wiki 页面且未授权该域名, **When** 打开侧边栏, **Then** 提示"检测到私有化飞书,需授权访问该域名",显示授权按钮。
3. **Given** 私有化文档授权提示, **When** 点击授权按钮, **Then** 弹出 Chrome 权限申请并在用户同意后转为正常导出状态。
4. **Given** 打开非飞书网站(无 `/<type>/<token>` 路径), **When** 打开侧边栏, **Then** 提示"请在飞书文档页面操作",不误判。

### User Story 2 - 导出诊断信息(Priority: P0)

作为开发者/高级用户,在私有化部署导出异常时,我能一键导出一份诊断信息(脱敏的原始 blocks、接口响应样本、DocInfo、选路结果、扩展版本),以便定位私有化与公有云的字段差异。

**Why this priority**: 私有化字段差异不可预测,诊断是兼容私有化的支撑工具,P-decode 调试强依赖它,需与早期实现并行落地。

**Independent Test**: 在一篇私有化文档点"导出诊断信息",检查下载文件含 DocInfo/接口样本/选路结果,且不含任何员工姓名/部门等 PII。

**Acceptance Scenarios**:

1. **Given** 任意飞书文档页, **When** 点击"导出诊断信息", **Then** 下载一个诊断包,内含 DocInfo、接口响应样本、Markdown 选路结论、扩展版本。
2. **Given** `client_vars` 响应含 `editor_map`/`user_map`, **When** 生成诊断, **Then** 这些 PII 字段已被显式剔除,不出现在产物中。
3. **Given** 配置 `diagnosticIncludeSnapshot=false`, **When** 生成诊断, **Then** 产物不含页面快照。

### User Story 3 - 导出为 Markdown(Priority: P0)

作为飞书用户,我点击"导出为 Markdown",无论当前租户是否开启官方导出,扩展都自动选路产出一份带图片的 Markdown(默认打包为 zip),尽量保留标题/列表/代码/表格/公式/Callout/图片结构。

**Why this priority**: 产品核心价值(P0)。其中 P-decode 对"关闭官方导出的私有化租户"是唯一可行路径,属刚需。

**Independent Test**: 在公有云(官方导出可用)与私有化(官方导出被禁)两类文档分别点"导出 Markdown",均得到可读的 .md/zip,图片本地可见。

**Acceptance Scenarios**:

1. **Given** 租户支持官方 md 导出, **When** 点击导出 Markdown, **Then** 走 P-official,产物为官方 .md(随图片打包 zip)。
2. **Given** 租户官方导出返回非 0(如 `1002 no permission`), **When** 点击导出 Markdown, **Then** 自动回退 P-decode,用户无感,仍产出可读 Markdown。
3. **Given** 一篇含加粗/斜体/链接/行内代码/表格(合并单元格)/代码块/图片的文档走 P-decode, **When** 导出完成, **Then** 这些结构在 Markdown 中正确呈现(apool 行内标记被正确解码)。
4. **Given** `imageMode=download`, **When** 导出完成, **Then** 正文图片引用为相对路径 `assets/{token}.{ext}`,zip 内含对应图片文件。
5. **Given** 某张图片下载失败, **When** 导出完成, **Then** 该图降级为占位/在线 URL 并在诊断记录,其余内容与导出不受影响。
6. **Given** wiki 节点文档, **When** 导出, **Then** 先解析 wiki_token→obj_token 再取块内容,正确导出。
7. **Given** 本 host 能力检测已缓存, **When** 再次导出, **Then** 直接按缓存选路,不重复探测。

### User Story 4 - 导出为 PDF(Priority: P1)

作为飞书用户,我点击"导出为 PDF",扩展通过飞书服务端渲染生成高清 PDF 下载到本地。

**Why this priority**: 高价值且实现最确定(ref 已验证官方导出任务链路),但依赖租户开启官方导出,故 P1。

**Independent Test**: 在官方导出可用的文档点"导出 PDF",得到与页面一致的高清 PDF。

**Acceptance Scenarios**:

1. **Given** 租户支持官方导出, **When** 点击导出 PDF, **Then** 创建导出任务→轮询结果→按响应取下载域下载 PDF。
2. **Given** 轮询超过上限仍未完成, **When** 超时, **Then** 报"导出超时,请重试",状态可重试。
3. **Given** 租户禁用官方导出(返回非 0), **When** 点击导出 PDF, **Then** 明确提示该租户官方 PDF 导出不可用。

### User Story 5 - 导出附件(Priority: P1)

作为飞书用户,我点击"导出附件",扩展批量下载文档中的图片与文件,打包为 zip。

**Why this priority**: 高频辅助需求,复用 Markdown 已抓取的块与媒体下载实现。

**Independent Test**: 在含多张图片与若干附件的文档点"导出附件",得到含全部素材的 zip,文件名可读。

**Acceptance Scenarios**:

1. **Given** 文档含 image/file 块, **When** 点击导出附件, **Then** 收集所有素材 token,逐个下载并打包 zip,文件名用素材原名(冲突加短哈希)。
2. **Given** 个别素材下载失败, **When** 导出完成, **Then** 跳过失败项并记录,不阻断整体。

### User Story 6 - 导出为 HTML(Priority: P1)

作为飞书用户,我点击"导出为 HTML",得到一个资源内联的单文件 HTML,离线可打开浏览。

**Why this priority**: 完整保真的离线浏览需求,与离线缓存复用同一份快照逻辑。

**Independent Test**: 导出 HTML 后断网用浏览器打开,排版与图片可正常显示。

**Acceptance Scenarios**:

1. **Given** 文档含懒加载内容, **When** 导出 HTML, **Then** 先滚动加载全文再快照,内容完整。
2. **Given** 文档含图片与样式, **When** 导出 HTML, **Then** 图片转 dataURL 或随包内联、样式内联,单文件离线可读。

### User Story 7 - 缓存到本地 / 查看缓存(Priority: P1)

作为飞书用户,我可把当前文档缓存到本地生成离线快照,并在缓存列表中查看/打开/删除。

**Why this priority**: 离线浏览能力;缓存管理 UI 已就绪,仅差真实快照。

**Independent Test**: 缓存一篇文档后,在缓存列表看到它,可离线打开,可删除。

**Acceptance Scenarios**:

1. **Given** 当前飞书文档, **When** 点击"缓存到本地", **Then** 保存 DOM 快照+DocInfo 到本地,缓存列表新增一条。
2. **Given** 缓存列表有条目, **When** 点击删除, **Then** 该缓存被移除,占用空间释放。
3. **Given** 大文档缓存超出默认配额, **When** 缓存, **Then** 通过 `unlimitedStorage` 容纳或给出明确容量提示。

### User Story 8 - 导出为 Word(Priority: P2)

作为飞书用户,我看到"导出为 Word"为"开发中"占位,后续可复用官方导出任务产出 docx。

**Why this priority**: 低优先,占位即可。

**Independent Test**: 点击"导出 Word"显示"功能开发中"且不报错崩溃。

**Acceptance Scenarios**:

1. **Given** 任意文档, **When** 点击导出 Word, **Then** 提示"Word 导出功能开发中",界面状态正常。

### Edge Cases

- 未登录飞书:内部接口返回纯文本 `403 csrf token error`,应提示"请先登录飞书",继续等待登录而非当作导出禁用。
- 已登录但导出被禁:官方导出返回 JSON `code:1002`,判为 P-official 不可用并回退/提示,而非误判未登录。
- `policy-sdk` 拦截编程式 fetch 报 `Failed to fetch`:请求贴合页面调用形态并重试/降级。
- Service Worker 休眠:长任务进度落盘,UI 重连用最后状态恢复。
- 未知域名误判为飞书:路径+token 正则 + 运行时页面特征二次确认降低误判。
- 私有化在线图片 URL 挂企业子域,无登录态环境打不开:故默认 `download` 模式。
- CSRF cookie 名差异:优先 `_csrf_token`,失败用候选名 `swp_csrf_token` 重试。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统必须能在公有云与私有化自建域名两类飞书文档页识别文档类型(docx/docs/wiki/sheets/base/file)、token、标题,并标记 `isPrivateDeploy`。
- **FR-002**: 系统对未知域名必须用"路径 `/<type>/<token>` + token 正则 `^[A-Za-z0-9]{16,}$`"双信号识别,不依赖域名白名单。
- **FR-003**: 系统对未授权的私有化域名必须提供用户手势触发的运行时 host 权限申请,并维护"已信任域名"可查看/撤销列表。
- **FR-004**: 所有飞书内部接口请求必须在 content script 以同源+referer+CSRF 发起;SW 仅读 Cookie、编排、下载、打包。
- **FR-005**: 系统必须实现 Markdown 双路取数(P-official / P-decode),并在运行时按 host 探测能力、缓存结论(`md_export_supported`)、失败自动回退,用户始终单一入口。
- **FR-006**: P-decode 必须含 apool/changeset 解码器,将 `initialAttributedTexts`+`apool.numToAttrib` 解为纯文本+行内标记(粗/斜/链接/行内代码)。
- **FR-007**: Markdown 转换必须覆盖 Page/Text/Heading1-9/Bullet/Ordered/Code/Quote/Equation/Todo/Divider/Image/Table(含 rowspan/colspan)/Callout/Grid/QuoteContainer;不支持的块降级占位。
- **FR-008**: 图片处理必须支持 `download`(默认,打包相对路径)与 `link`(在线 URL)两种模式;媒体下载域按页面 host 推导,不写死。
- **FR-009**: 单个图片/附件失败不得阻断整篇导出,须降级并在诊断记录。
- **FR-010**: PDF 导出必须走官方导出任务(create→轮询 result→按响应下载域下载),轮询有上限与超时提示。
- **FR-011**: 附件导出必须复用块中的 image/file token 与统一媒体下载实现,打包 zip,文件名用原名(冲突加短哈希)。
- **FR-012**: HTML 导出必须产出资源内联的单文件 HTML,导出前滚动加载懒加载内容。
- **FR-013**: 缓存必须保存 DOM 快照+DocInfo 到本地,支持列表查看/打开/删除;大文档通过 `unlimitedStorage` 容纳。
- **FR-014**: 诊断必须收集 DocInfo/接口样本/选路结论/版本并打包下载,且显式剔除 `editor_map`/`user_map`/`creator_id`/`owner_id` 等 PII。
- **FR-015**: 每个导出动作必须经统一进度上报(running/success/error+百分比),进度落盘且 UI 重连可恢复。
- **FR-016**: 所有内部接口与媒体下载必须带重试退避;媒体下载并发上限 2~3;对 `Failed to fetch` 有重试/降级。
- **FR-017**: P-decode 在官方导出被禁的文档执行前,必须提示"该文档官方导出已关闭,继续即绕过该限制",并告知仅在被授权前提下使用。
- **FR-018**: Cookie 与文档内容、诊断原始数据不得发往任何第三方/自建后端;产物仅经 `chrome.downloads` 落本地。
- **FR-019**: Word 导出当前为占位,点击提示"功能开发中"且不崩溃。
- **FR-020**: token 解析必须按文档类型分支:直链 docx 直接 `client_vars?id={token}`;wiki 先 `tree/get_info`→`tree/get_node` 得 obj_token 再取块;块翻页用 `mode=4`+cursor 直到 `has_more=false`。

### Key Entities

- **DocInfo**: 当前页识别出的文档信息。字段:`isFeishuDoc`(bool)、`docType`(枚举)、`token`(string,非空表示已识别)、`title`(string)、`url`、`host`、`isPrivateDeploy`(bool,新增)。
- **ExportProgress**: 单次导出进度。字段:`action`(枚举)、`status`(idle/running/success/error)、`percent`(0-100,可空)、`message`。
- **MarkdownCapability**: 某 host 的 Markdown 导出能力。字段:`host`(唯一键)、`mdExportSupported`(bool)、探测时间;按 host 维度缓存。
- **TrustedDomain**: 已运行时授权的私有化域名。字段:`origin`(唯一)、授权时间;可撤销。
- **CachedDoc**: 离线缓存条目。字段:`token`、`docType`、`title`、`url`、`cachedAt`、`size`。
- **MediaAsset**: 导出中收集的素材。字段:`token`(box…,去重键)、`name`(原名/alt)、`mimeType`、(可选)宽高。
- **DiagnosticBundle**: 诊断产物。字段:DocInfo、脱敏 blocks 样本、接口响应样本、选路结论、扩展版本、(可选)页面快照摘要。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 在公有云与至少 1 个私有化自建域名(如 私有化租户)上,文档识别准确率 100%(已识别的真飞书文档不漏判、典型非飞书页不误判)。
- **SC-002**: 私有化未授权域名从"打开侧边栏"到"完成授权可导出"的操作不超过 2 次点击。
- **SC-003**: Markdown 导出在官方导出可用(公有云)与被禁(私有化)两类环境均能产出可读 .md/zip,成功率 ≥ 95%(网络正常)。
- **SC-004**: P-decode 导出的文档,标题/列表/代码块/表格/图片/行内粗斜链接 6 类结构呈现正确率 ≥ 90%(以人工抽检篇章为准)。
- **SC-005**: 单张图片下载失败时,整篇导出仍成功完成(0 次因单图失败导致整体失败)。
- **SC-006**: 诊断产物中 PII 字段(`editor_map`/`user_map`/`creator_id`/`owner_id`)出现次数为 0。
- **SC-007**: Service Worker 休眠后重开侧边栏,能恢复到最后一次进度状态(不丢失"运行中/已完成"信息)。
- **SC-008**: 媒体下载并发不超过 3,失败请求按退避重试至少 1 次。
