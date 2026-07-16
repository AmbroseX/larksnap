# Feature Specification: 飞书转公众号排版

**Feature Branch**: `005-wechat-format`
**Created**: 2026-07-09
**Status**: In Progress（已在开发）
**Input**: 把飞书文档一键变成微信公众号编辑器里排版好的文章。两条投放路线:路线 A「剪贴板复制」——侧边栏点一下,得到全内联样式 HTML,去公众号编辑器粘贴(**已实现**);路线 B「JSAPI 直灌」——在公众号编辑页直接调微信编辑器内部 JSAPI 把内容整篇灌进去,图片先传微信素材库换永久链接(**开发中**)。逆向来源:壹伴小插件(`ref/extracted/壹伴小插件/`)与 feishu2weixin crx,要点见 `docs/research/2026-07-09-chrome扩展核心实现逆向.md` §四、§5.4 与 `docs/plans/2026-07-09-飞书转公众号复刻.md`。

## Clarifications

> 依据两份逆向研究直接定夺,不阻塞实现。以下选型均已在参考扩展上验证可行。

- Q: 内容怎么进公众号编辑器? → A: **双路线并存**。路线 A 剪贴板(已实现,任何编辑器/任何平台都能粘);路线 B 在 `mp.weixin.qq.com` 编辑页**优先调微信新版编辑器(ProseMirror)在主世界暴露的内部 JSAPI `window.__MP_Editor_JSAPI__`**——整篇替换走 `mp_editor_set_content`,光标处插入走 `mp_editor_insert_html`。调官方内部接口比 hack contenteditable / 模拟粘贴事件稳得多。
- Q: 新旧编辑器怎么适配? → A: 判定规则(壹伴 `initEditorContext` 同款):页面有 `window.__MP_Editor_JSAPI__` + `.ProseMirror` 节点 → 新版走 JSAPI;否则有 `#ueditor_0` iframe → 老版 UEditor,走 `execCommand("inserthtml", html)` 或直接写 iframe body 兜底;两者都没有 → 明确提示"请先打开公众号图文编辑页"。
- Q: content script(隔离世界)能直接调 JSAPI 吗? → A: **不能**。`__MP_Editor_JSAPI__` 挂在页面主世界,必须再注入一个主世界脚本;两个世界之间用 `postMessage`/CustomEvent 通信,消息带来源校验。
- Q: 图片怎么处理? → A: 路线 A 用 **dataURL 内联**(公众号编辑器粘贴时会把 base64 图自动转存到微信图床,已实现);路线 B **必须先把图片上传微信素材库换 `mmbiz.qpic.cn` 永久链接**——`set_content` 灌入不走粘贴管线,不触发自动转存,而公众号会拦截外链图。上传借公众号后台页自身登录态:页面 `<script>` 里正则抠 `user_name`/`nick_name`/`ticket`,`token` 从 URL 取,大图先 canvas 压到 5e6 像素内,`FormData` POST 到 `/cgi-bin/filetransfer?action=upload_material...`,响应 `cdn_url` 回填 `<img src>`。零配置,不要求用户申请任何 AppID(与宪法原则 I 同精神)。
- Q: 源数据要走「飞书 MD → markdown-it AST」吗? → A: **不走**。larksnap 已有 `client_vars → buildBlockTree` 块树管线,直接「块树 → 内联样式 HTML」,省一次 Markdown 往返,且合并单元格/分栏/callout 这些 MD 表达不了的结构不丢。壹伴的「MD → AST」环节由块树等价替代,渲染规则(内联 `<section>` 模板、每块打 data-* 标记)照抄。
- Q: 样式怎么主题化? → A: 主题定义单一来源 `src/shared/themes.ts`(壹伴 `styleStrMap` 思路):渲染器按主题对象拼内联样式,**不把颜色写死在模板字符串里**;侧边栏悬浮预览与 SW 渲染器共用同一份定义。已内置经典黑/商务蓝/微信绿三主题。
- Q: 本功能受宪法原则 IV(飞书双路取数)约束吗? → A: 原则 IV 只约束飞书 Markdown 取数通道。本功能是取数之后的「再排版投放」下游能力,取数完全复用现有 P-decode 管线(`fetchClientVars` + apool 解码),不新增取数路径,不触碰 host 能力探测(按 002 的写法显式声明边界)。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 飞书文档一键进入公众号编辑器排版好(Priority: P0)

作为公众号作者,我在飞书写完文章后,不想手动一段段调格式:点一下扩展,内容带着排版进入公众号编辑器——路线 A 复制后粘贴即得排版(已实现);路线 B 在公众号编辑页一键把整篇灌进编辑器,连粘贴都省了。

**Why this priority**: 本功能的核心价值。没有它,后面素材库/主题都无从谈起。

**Independent Test**: 拿一篇含标题/加粗/列表/引用的飞书文档,路线 A 粘贴进公众号编辑器排版保持;路线 B 在新版编辑器页点"灌入",正文整篇出现且排版一致。

**Acceptance Scenarios**:

1. **Given** 飞书文档页 + 侧边栏, **When** 点「复制为公众号格式」, **Then** 剪贴板得到 text/html + text/plain 双口味,HTML 全内联样式、容器为 `<section>`,粘进公众号编辑器后标题/加粗/列表/引用样式保持。(已实现)
2. **Given** 已打开 `mp.weixin.qq.com` 新版图文编辑页(ProseMirror), **When** 触发「灌入编辑器」, **Then** 主世界脚本先 `mp_editor_get_isready` 确认就绪,再经 `mp_editor_set_content` 整篇替换,无需手动粘贴。
3. **Given** 编辑器未就绪或页面不是图文编辑页, **When** 触发灌入, **Then** 给出明确提示(如"请先打开公众号图文编辑页"),不静默失败。
4. **Given** 编辑器里已有草稿内容, **When** 整篇灌入前, **Then** 提示会覆盖现有内容,用户确认后才 `set_content`。

### User Story 2 - 图片自动传素材库换 mmbiz 链接(Priority: P0)

作为作者,文档里的图片我不想一张张手动上传:走 JSAPI 灌入时,扩展自动把图片传进我的公众号素材库,正文里的图全部变成 `mmbiz.qpic.cn` 永久链接,预览和群发都不丢图。

**Why this priority**: 公众号拦截外链图,`set_content` 又不触发粘贴自动转存——没有这条,路线 B 灌进去的文章图片全空,US1 的价值折半。

**Independent Test**: 含 3 张图的文档走 JSAPI 灌入,灌入后检查编辑器正文所有 `<img src>` 都以 `mmbiz.qpic.cn` 开头,公众号预览图片正常显示。

**Acceptance Scenarios**:

1. **Given** 转换结果含图片(dataURL)+ 已登录的公众号编辑页, **When** JSAPI 灌入前, **Then** 每张图经 `/cgi-bin/filetransfer?action=upload_material` 上传素材库,响应 `cdn_url` 回填 `<img src>`,签名参数(`ticket_id`/`ticket`/`token`)从页面登录态自动抠取,全程零配置。
2. **Given** 某张图超大, **When** 上传前, **Then** 先用 canvas 压缩到 5e6 像素以内再传。
3. **Given** 单张图上传失败, **When** 灌入, **Then** 该图渲染占位提示,其余内容正常灌入,不拖垮整篇(宪法原则 III 精神)。
4. **Given** 走路线 A 剪贴板, **Then** 图片以 dataURL 内联,粘贴时由微信自动转存,无需素材库上传。(已实现)

### User Story 3 - 排版主题换肤(Priority: P1)

作为作者,我希望能选不同风格的排版主题(标题颜色/色条/引用边条),并在选择前预览效果。

**Why this priority**: 提升产物质感,但默认主题已可用,不阻塞核心链路。

**Independent Test**: 侧边栏展开公众号卡片,可见 3 个主题胶囊;悬浮任一主题出现该配色的标题/正文/引用示例;选中后导出的 HTML 标题色与主题一致;重开侧边栏记住上次选择。

**Acceptance Scenarios**:

1. **Given** 侧边栏公众号卡片, **When** 展开样式选择器并悬浮某主题, **Then** 下方用该主题真实配色渲染"标题/正文/引用"示例。(已实现)
2. **Given** 选中「商务蓝」, **When** 导出, **Then** h1/h2 带蓝色左色条、标题文字为主题色、引用边条同色,正文规则不变。(已实现)
3. **Given** 用户上次选过某主题, **When** 重开侧边栏, **Then** 保持该选择(localStorage)。(已实现)

### User Story 4 - 代码块/表格贴微信 schema 正确渲染(Priority: P1)

作为技术号作者,文档里的代码块和合并单元格表格,进公众号编辑器后要被正确识别:代码块保持代码样式(而不是退化成普通段落),表格边框/表头/合并关系不乱。

**Why this priority**: 代码/表格是公众号编辑器过滤最狠的两类结构,是逆向踩坑的核心资产;技术内容作者的刚需。

**Independent Test**: 含多行代码块 + 合并单元格表格的文档转换后粘贴/灌入,编辑器里代码块以代码样式展示,表格合并关系正确。

**Acceptance Scenarios**:

1. **Given** 文档含代码块, **When** 转换, **Then** `<pre>` 挂 `code-snippet__js code-snippet code-snippet_nowrap` 三个类(微信编辑器内部识别标记)+ `data-lang`,粘贴后保持代码块外观。(已实现)
2. **Given** 走 JSAPI 灌入, **When** 渲染代码块, **Then** 每行代码包 `<span leaf="">`(微信新版编辑器内部叶节点标记),`set_content` 后被识别为代码块而非普通文本。
3. **Given** 文档含合并单元格表格, **When** 转换, **Then** 输出真 `rowspan`/`colspan`、无 `<colgroup>`、每个 td 样式全内联,首行表头灰底加粗,被合并覆盖的格子不重复输出。(已实现)
4. **Given** 表格结构无法识别, **Then** 降级为顺序文本并给占位说明,不吞内容。(已实现)

### User Story 5 - 老版 UEditor 编辑器兜底(Priority: P2)

作为还在用老版公众号编辑器的作者,一键灌入对我也可用:检测不到新版 JSAPI 时,自动降级走 UEditor 的插入方式。

**Why this priority**: 老版编辑器存量在收缩,属于兼容性兜底,不影响主流用户。

**Independent Test**: 在老版编辑器页(存在 `#ueditor_0` iframe)触发灌入,内容出现在编辑区。

**Acceptance Scenarios**:

1. **Given** 页面无 `__MP_Editor_JSAPI__` 但有 `#ueditor_0` iframe, **When** 触发灌入, **Then** 走 `execCommand("inserthtml", html)` 插入;失败再直接写 iframe body。
2. **Given** 两代编辑器特征都不存在, **When** 触发灌入, **Then** 明确提示不支持,引导用户改用路线 A 剪贴板。

## Requirements *(mandatory)*

- **FR-001**: 渲染产物 MUST 全内联样式、块容器用 `<section>`(不依赖任何 class 承载样式;代码块的 `code-snippet*` 类是微信编辑器识别标记,属例外);MUST 覆盖 heading1-6/text/todo/有序无序嵌套列表/code/quote/callout/divider/image/grid/table(含合并单元格);不支持的块 MUST 渲染灰字占位而非静默丢弃。
- **FR-002**: 路线 A MUST 由侧边栏在用户手势内写剪贴板(text/html + text/plain 双口味),`ClipboardItem` 失败 MUST 降级 contenteditable + `execCommand('copy')`;SW 只生成 HTML 不碰剪贴板。
- **FR-003**: 路线 B MUST 在 `mp.weixin.qq.com` 编辑页注入 content script(隔离世界)+ 主世界脚本;主世界脚本 MUST 优先经 `window.__MP_Editor_JSAPI__` 灌入(整篇 `mp_editor_set_content`,插入 `mp_editor_insert_html`),灌入前 MUST 用 `mp_editor_get_isready` 确认就绪。
- **FR-004**: 编辑器判定 MUST 按「`__MP_Editor_JSAPI__` + `.ProseMirror` → 新版;否则 `#ueditor_0` iframe → 老版 `execCommand("inserthtml")`/写 iframe body 兜底;都没有 → 明确报错」执行,MUST NOT 在未知页面盲目注入执行。
- **FR-005**: 双世界通信 MUST 用 `postMessage`/CustomEvent 且带来源校验(校验 `event.origin`/自定义标记),MUST NOT 处理来历不明的消息;通信 MUST 带超时,主世界无响应时给明确错误。
- **FR-006**: 路线 B 的图片 MUST 先上传微信素材库换 `mmbiz.qpic.cn` 链接再灌入,签名参数 MUST 从公众号页面登录态自动获取(页面 script 抠 `user_name`/`ticket`,URL 取 `token`),MUST NOT 要求用户配置 AppID/Secret;超过 5e6 像素的图 MUST 先 canvas 压缩;路线 A 的图片 MUST 以 dataURL 内联。
- **FR-007**: 单张图片下载或上传失败 MUST 渲染占位提示且 MUST NOT 使整篇转换/灌入失败(宪法原则 III)。
- **FR-008**: 代码块 MUST 挂 `code-snippet__js code-snippet code-snippet_nowrap` 三类名 + `data-lang`;JSAPI 灌入路线 MUST 给代码行包 `<span leaf="">`。表格 MUST 输出真 `rowspan`/`colspan`、MUST NOT 输出 `<colgroup>`、td 样式 MUST 全内联。
- **FR-009**: 主题 MUST 定义在 `src/shared/themes.ts` 单一来源(渲染器与侧边栏预览共用),渲染器 MUST 从主题对象取色,MUST NOT 把主题色硬编码进模板;主题只动点缀(标题色/色条/引用边条),正文规则不变。
- **FR-010**: JSAPI 灌入路线的块级元素 MUST 打 `data-larksnap-key`(元素类型)/`data-larksnap-content`(可编辑正文标记)/`data-larksnap-action-id`(唯一 id)三个属性,便于灌入后回查 DOM 与后续换肤重排。
- **FR-011**: 文档内容与 Cookie MUST 只在用户本机、飞书接口、用户自己的公众号后台(`mp.weixin.qq.com`)之间流转,MUST NOT 发往任何第三方/自建服务器(宪法原则 V;匿名统计仅事件名,不含内容)。
- **FR-012**: 取数 MUST 完全复用现有 `resolveObjToken → fetchClientVars → buildBlockTree` 管线,MUST NOT 新增飞书取数路径、MUST NOT 触碰 host 能力探测(宪法原则 IV 边界:本功能是导出后的再排版下游能力)。

## Success Criteria *(mandatory)*

- **SC-001**: 抽样 10 篇含代码块/合并单元格表格/图片/callout/嵌套列表的飞书文档,路线 A 粘贴进公众号编辑器后 ≥9 篇排版正确(标题层级、列表编号连续、引用/callout 样式保持)。
- **SC-002**: 同批文档走 JSAPI 灌入(新版编辑器),灌入后微信预览 **无外链图**——正文所有 `<img src>` 均为 `mmbiz.qpic.cn`;代码块被编辑器识别为代码样式;合并单元格表格结构正确。
- **SC-003**: 新版编辑器 `set_content` 灌入成功率 100%(就绪检测通过的前提下);老版 UEditor 页兜底插入可用;非编辑页触发时 100% 给出明确提示而非静默失败。
- **SC-004**: 单图失败注入占位、整篇不失败(构造一张下载必失败的图验证)。
- **SC-005**: 飞书导出回归:markdown/word/pdf/html/xhs 既有通道行为零变化;`npm run typecheck` + `npm run build` 通过。
- **SC-006**: `grep` 取证:除飞书域(动态推导)与 `mp.weixin.qq.com` 外,本功能代码无任何外发请求;SW 内无直接请求飞书内部接口的 fetch。
