# Feature Specification: 任意网页整页长图截图

**Feature Branch**: `003-fullpage-screenshot`
**Created**: 2026-07-09
**Status**: Draft
**Input**: 在任意网页一键把整个页面(含滚动后才能看到的部分)截成一张完整长图,导出 PNG 或多页 PDF。做法是"滚动页面 + 逐屏 `chrome.tabs.captureVisibleTab` + offscreen 里 canvas 拼接",纯本地完成,明确不用 `chrome.debugger`(会弹"正在调试此浏览器"黄条)。MVP 照抄 Screen Capture & Editor 干净版,进阶补丁抄 GoFullPage。

## Clarifications

> 依据逆向研究 `docs/research/2026-07-09-chrome扩展核心实现逆向.md` §一(整页长图截图)+ §5.1(文件索引)直接定夺,不阻塞实现。

- Q: 截图核心方案用什么? → A: **滚动页面 + 逐屏 `chrome.tabs.captureVisibleTab` + offscreen document 里用 DOM canvas 拼接**。**禁止**用 `chrome.debugger` / `Page.captureScreenshot`——那会在页面顶端弹出"正在调试此浏览器"黄条,体验差。头部两个截图扩展(Screen Capture & Editor / GoFullPage)都是这条路,方案已被市场验证。
- Q: 拼接为什么必须放 offscreen document? → A: MV3 Service Worker 里没有 DOM、`document`、`Image`——不能 `new Image()`、不能建 canvas。每屏 PNG dataURL 必须传进 offscreen 页,在那里用真 DOM canvas 拼。**复用现有 `withOffscreen()` 基建**(`src/background/offscreen.ts`,建页 reasons 为 `DOM_PARSER`),不另起炉灶。
- Q: 导出什么格式? → A: **PNG 为 P0**(`canvas.toDataURL('image/png')`);**PDF 为 P1**,用 jsPDF,且**一步到位按页高切成多页**(抄 GoFullPage `addPage` 写法),不做"整张长图塞进单个超长页"的中间态——超长单页在阅读器里难看,而且超过一定尺寸会渲染失败。
- Q: 需要申请新权限吗? → A: **不需要**。所需 `activeTab`、`scripting`、`offscreen`、`storage`、`unlimitedStorage` 全部已在 manifest 里。**不要** `debugger`(截图通道禁用),**不要**为此申请 `<all_urls>` 常驻权限。
- Q: 超长页面怎么办?(canvas 高超约 32767px、或面积超约 2.68 亿 px² 时 `toDataURL` 返回空白) → A: MVP 先**对高度封顶**:超限时截取到上限并明确提示"页面过长,仅截取前 N 屏";完整方案(**多块 canvas 平铺**,每块 ≤16384px,抄 GoFullPage MultiCanvas)列为 P2。任何情况下不允许产出空白文件。
- Q: iframe / 页面内部滚动区截不全怎么办? → A: 接受现状,逐屏截图只滚动主文档。此项收益低、实现重(GoFullPage `_findFrame`),优先级排在所有 P2 之后,本期默认不做。
- Q: 飞书文档页也能用吗? → A: 能。截图对任意 http/https 页面生效,不做域名区分(符合宪法 II)。但飞书文档要结构化产物仍推荐走现有 PDF/MD 导出通道,截图只是"所见即所得"的补充,**不改动飞书通道任何逻辑**。
- Q: 截图数据会不会外发? → A: 不会。抓屏、拼接、落盘全在本地完成,无任何网络请求(宪法 V)。匿名统计只上报 `format/ok/secs` 枚举(与现有 `trackedExport` 一致),不含页面内容和 URL。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 一键整页长图 PNG(Priority: P0)

作为用户,在任意长网页(文章/文档/后台报表)打开侧边栏,点击"整页截图",扩展自动滚动页面逐屏抓取、拼成一张完整长图,落盘为 `.png`,页面随后恢复原样。

**Why this priority**: 本功能的核心价值,独立可用;PNG 是最通用的产物。

**Independent Test**: 在一篇高度超过 5 屏的文章页点击"整页截图",得到一张从页首到页尾完整、无重复页头、无错位断缝的 PNG,页面滚动位置恢复到点击前。

**Acceptance Scenarios**:

1. **Given** 打开一个需滚动 5 屏以上的网页, **When** 点击"整页截图", **Then** 下载一张 PNG,内容覆盖整页,各屏衔接处无重叠、无空隙。
2. **Given** 页面有 `position:fixed`/`sticky` 的顶栏或悬浮按钮, **When** 截图, **Then** 这些元素只在首屏出现一次,不会每屏重复;截完后页面上它们恢复可见。
3. **Given** 高分屏(devicePixelRatio=2)或浏览器缩放 125%, **When** 截图, **Then** 长图清晰、坐标不错位。
4. **Given** 页面带滚动动画/渐入动效, **When** 截图, **Then** 产物无半透明残影、无动画中间态(截前已禁动画并等待稳定)。
5. **Given** 截图进行中, **When** 观察侧边栏, **Then** 能看到"正在截取第 N/M 屏"进度;完成或失败都有明确提示。
6. **Given** 当前页是 `chrome://`、扩展商店等不可注入页, **When** 尝试截图, **Then** 入口禁用或给出明确提示,不静默失败。
7. **Given** 截图全程, **When** 观察页面顶端, **Then** 不出现"正在调试此浏览器"黄条。

### User Story 2 - 导出多页 PDF(Priority: P1)

作为用户,我能选择把整页截图导出为 PDF,长图按页高自动切成多页,方便打印和在阅读器里翻阅。

**Why this priority**: 建立在 P0 的抓取+拼接之上,只是导出端多一种编码;打印/存档场景常用。

**Independent Test**: 对同一长页面分别导出 PNG 与 PDF,PDF 页数 ≈ 长图高度/单页高度,每页内容与长图对应纵向切片一致,常见阅读器打开正常。

**Acceptance Scenarios**:

1. **Given** 一个 10 屏长的页面, **When** 选择"导出 PDF", **Then** 得到一个多页 PDF,逐页拼起来等于完整长图,没有内容丢失或重复。
2. **Given** 导出的 PDF, **When** 在系统自带阅读器/浏览器中打开, **Then** 正常分页显示,不出现"单张超长页"。

### User Story 3 - 超长页完整导出(Priority: P2)

作为用户,截一个高度超过 canvas 尺寸上限(约 32767px)的超长页面时,扩展用多块 canvas 平铺的方式完整导出,而不是截断。

**Why this priority**: 属于工程加固,受众是少数超长页;P0 已保证"超限不出空白、有截断提示",本故事把截断升级为完整导出。

**Independent Test**: 构造或找到一个渲染高度超 40000px(×DPR 后)的页面,导出 PNG 完整不空白、不截断。

**Acceptance Scenarios**:

1. **Given** 整页高度 ×DPR 后超过 32767px, **When** 截图, **Then** 采用多块 canvas(每块 ≤16384px)分段编码再合成/分段产出,最终产物完整且非空白。
2. **Given** 同样的超长页导出 PDF, **When** 按页高切片, **Then** 切片直接从各分块取图,分页正常。

## Requirements *(mandatory)*

- **FR-001**: 扩展 MUST 在任意 http/https 页面提供"整页截图"入口;`chrome://` 等不可注入页 MUST 禁用入口或给出明确提示。
- **FR-002**: 截图 MUST 采用"滚动 + 逐屏 `chrome.tabs.captureVisibleTab` + offscreen canvas 拼接";截图通道 MUST NOT 调用 `chrome.debugger` / `Page.captureScreenshot`(取证:`grep -rn "chrome.debugger" src/background/screenshot/ src/background/exporters/screenshot.ts src/offscreen/` 无结果)。
- **FR-003**: `position:fixed`/`sticky` 元素 MUST 做去重处理——首屏保留,其余屏置 `opacity:0`;截图结束 MUST 恢复原样。
- **FR-004**: `captureVisibleTab` 调用 MUST 限流;撞到每秒配额错误(`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`)MUST 等待后重试,而不是直接失败。
- **FR-005**: 所有拼接坐标(y 偏移/宽/高)MUST 乘以 devicePixelRatio;且 MUST 用首屏抓到的真实像素宽与视口 CSS 宽之比动态校正缩放系数,兼容浏览器缩放。
- **FR-006**: 截图前 MUST 向页面注入禁动画 CSS(关掉 `transition`/`animation`/`scroll-behavior`)并等待约 800ms 稳定;结束后 MUST 恢复页面滚动位置并移除注入样式。
- **FR-007**: 拼接 MUST 在 offscreen document 内完成(复用 `withOffscreen()`);Service Worker MUST NOT 直接创建 canvas 或 Image。
- **FR-008**: PNG 产物 MUST 经 `canvas.toDataURL('image/png')` 生成,落盘 MUST 复用现有 `downloadDataUrl`/`safeName`(`src/background/download.ts`),文件名由页面标题安全化。
- **FR-009**: PDF 导出 MUST 用 jsPDF 并按页高切成多页(`addPage` 循环,每页画长图的一个纵向切片);MUST NOT 产出单张超长页 PDF。
- **FR-010**: 拼接高度或面积超过 canvas 安全上限时 MUST NOT 产出空白文件:MVP 封顶截断并提示"页面过长,仅截取前 N 屏";P2 用多块 canvas 平铺完整导出。
- **FR-011**: 全流程 MUST 纯本地,MUST NOT 向任何第三方/自建服务器发送截图数据、页面内容或 URL(宪法 V);匿名统计仅限 `format/ok/secs` 枚举。
- **FR-012**: 进度 MUST 经 `reportProgress` 推送("第 N/M 屏"、"拼接中"、"完成/失败"),失败 MUST 给出明确原因(宪法 III);失败或中断后页面状态 MUST 尽力恢复。
- **FR-013**: 本功能 MUST NOT 新增任何 manifest 权限或 host 权限(所需权限已具备);MUST NOT 改动飞书导出通道的任何文件逻辑。

## Success Criteria *(mandatory)*

- **SC-001**: 抽样 10 个不同结构的长页面(新闻/博客/文档站/后台页),≥9 个拼接正确:无重复页头、无错位、无空隙、无残缺。
- **SC-002**: 在 devicePixelRatio=2 的屏幕与浏览器缩放 100%/125% 三种组合下,产物清晰且坐标无错位。
- **SC-003**: 截图全程页面顶端不出现"正在调试此浏览器"黄条;`grep` 取证截图相关代码无 `chrome.debugger` 调用。
- **SC-004**: 截图结束(成功或失败)后 3 秒内,页面滚动位置与 fixed/sticky 元素可见性恢复原样。
- **SC-005**: 对高度 ×DPR 超 32767px 的页面,不产出空白文件——MVP 得到截断产物+明确提示;P2 得到完整产物。
- **SC-006**: 飞书文档导出回归:既有 P-official/P-decode/PDF/HTML 通道行为零变化。
- **SC-007**: PDF 产物在 Chrome 内置阅读器与系统预览中正常打开,页数与"长图高/单页高"吻合,无单张超长页。
- **SC-008**: 连续截取 20 屏以上页面时,`captureVisibleTab` 配额错误被自动重试消化,最终成功,不需要用户手动重来。
