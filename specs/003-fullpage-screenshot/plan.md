# Implementation Plan: 任意网页整页长图截图

**Spec**: `specs/003-fullpage-screenshot/spec.md`
**Branch**: `003-fullpage-screenshot`
**Created**: 2026-07-09

## 1. 设计概述

新增一条**与飞书导出完全解耦的"整页截图"能力**:SW 编排滚动逐屏抓取,offscreen 拼接,本地落盘。核心路线是市场验证过的"滚动 + 逐屏 `captureVisibleTab` + canvas 拼接",**不用 `chrome.debugger`**(弹调试黄条)。MVP 1:1 照抄 Screen Capture & Editor 干净版(`ref/extracted/ScreenCapture&EditorGoFullPage/`),进阶补丁抄 GoFullPage。

```
[侧边栏] 点击「整页截图」(PNG / PDF)
   │  MSG.EXPORT_SCREENSHOT { format }
   ▼
[SW: exporters/screenshot.ts 编排]
   ├─ 1. scripting.executeScript 注入页面端函数(screenshot/page.ts)
   │      ① 注入禁动画 CSS(transition/animation/scroll-behavior) 等 800ms
   │      ② 测量 scrollHeight / innerHeight / scrollY / devicePixelRatio
   │      ③ 逐屏 scrollTo;fixed/sticky 元素首屏保留、其余屏 opacity:0
   ├─ 2. 每屏 safeCaptureVisibleTab(screenshot/capture.ts)
   │      限流:撞每秒配额错误 → sleep 重试;进度经 reportProgress
   │      → shots: [{ dataUrl, yPos×dpr }, ...]  + 首屏真实像素宽校正缩放系数
   ├─ 3. withOffscreen() → OFFSCREEN_MSG.SHOT_STITCH { shots, 整页高, format }
   ▼
[offscreen: stitch.ts 拼接]
   ├─ canvas(视口宽×dpr, 整页高×dpr) 逐屏 drawImage(img, 0, yPos)
   ├─ 尺寸保护:高/面积超限 → MVP 封顶+告知截断(P2 换多块 canvas 平铺)
   ├─ PNG: canvas.toDataURL          PDF: jsPDF 按页高切片循环 addPage
   ▼  返回 dataUrl(+截断标记)
[SW] 恢复页面(滚动位置/样式) → safeName(标题).png|.pdf → downloadDataUrl 落盘
```

**为什么必须 offscreen**:MV3 Service Worker 没有 DOM——不能 `new Image()`、不能建 canvas,拼图只能在 offscreen document 里做。项目已有完整 offscreen 基建(`withOffscreen()` 串行调度、用完即关),直接复用,不新建第二套。

**为什么不用 debugger 协议**:`Page.captureScreenshot` 一条命令能出整页图,但 attach 时页面顶端会常驻"正在调试此浏览器"黄条,且需要 `debugger` 权限语义(商店审核敏感)。两个头部截图扩展都没走这条路。

## 2. 路由与优先级

- 截图对**任意 http/https 页面**生效(含飞书页),不做域名判断——天然符合宪法 II(域名不写死)。
- **不触碰飞书通道**:飞书文档的结构化导出(MD/PDF/HTML)仍走现有通道;截图是并列的独立入口,不参与 `detectActiveDoc` 分流逻辑,只新增文件 + 在 UI/SW 路由挂新分支。保证 SC-006 飞书回归零变化。
- `chrome://`、`chrome-extension://`、扩展商店等不可注入页 → `executeScript` 抛错被捕获,给明确提示(FR-001/FR-012);UI 侧可按 URL 协议预判禁用入口。
- 入口放在侧边栏**网页工具区**(`WebCopyView.tsx`,与"网页转 Markdown"、"视频下载"并列),飞书页与通用页都可见。

## 3. 新增 / 改动文件

### 新增

| 文件 | 职责 |
|---|---|
| `src/background/screenshot/page.ts` | 被 `chrome.scripting.executeScript({ func })` 注入页面的纯函数集:测量页面尺寸(scrollHeight/innerHeight/scrollY/dpr/isLast)、滚动到指定 y、fixed/sticky 收集与显隐、注入/移除禁动画 CSS、恢复现场。抄干净版 `background/background.js:85-108`(测量)与 `:91-104`(fixed 去重) |
| `src/background/screenshot/capture.ts` | `safeCaptureVisibleTab`(限流+配额错误重试,抄 `background.js:38-60`)+ 逐屏主循环(抄 `:62-157`):滚动→等稳定→抓屏→压 shots 栈;输出 `CaptureShot[]` 与校正后的缩放系数 |
| `src/background/exporters/screenshot.ts` | SW 编排入口 `exportScreenshot(format)`:取当前 tab → 注入准备 → 跑 capture → `withOffscreen()` 发 `SHOT_STITCH` → 恢复页面 → `safeName(标题)` + `downloadDataUrl` 落盘;全程 `reportProgress`,finally 里保证恢复现场 |
| `src/offscreen/stitch.ts` | offscreen 侧拼接:canvas 逐屏 `drawImage` → 尺寸保护(MVP 封顶)→ PNG `toDataURL`;PDF 分支动态 `import('jspdf')`,按页高循环 `addPage` 画纵向切片(抄 GoFullPage `editor.e1596743.js` 搜 `addPage`) |

### 改动

| 文件 | 改动 |
|---|---|
| `src/shared/constants.ts` | `MSG` 增 `EXPORT_SCREENSHOT: 'export_screenshot'`;`OFFSCREEN_MSG` 增 `SHOT_STITCH: 'offscreen_shot_stitch'`、`SHOT_PROGRESS: 'offscreen_shot_progress'`(风格对齐现有 `XHS_RENDER`/`XHS_PROGRESS`) |
| `src/shared/types.ts` | 增 `ScreenshotFormat = 'png' \| 'pdf'`、`CaptureShot { dataUrl; yPos }`、`ShotStitchRequest { shots; width; totalHeight; format; pageHeight }`、`ShotStitchResult { dataUrl; truncated?: boolean }` |
| `src/offscreen/main.ts` | 消息监听增 `SHOT_STITCH` 分支 → 调 `stitch.ts`(现在只认 `XHS_RENDER`,新分支同样"其余消息一律放行") |
| `src/background/index.ts` | 路由增 `case MSG.EXPORT_SCREENSHOT` → `trackedExport('screenshot', () => exportScreenshot(format))`;`SHOT_PROGRESS` 转 `reportProgress`(对齐 `XHS_PROGRESS` 的写法) |
| `src/sidepanel/WebCopyView.tsx` + `actions.ts` | 网页工具区增"整页截图"按钮(PNG 主按钮 + PDF 次选);发 `EXPORT_SCREENSHOT`,展示进度与截断提示 |
| `package.json` | 加依赖 `jspdf`(P1 才用到,可与 P0 同批装上) |

### 明确不动

| 文件 | 原因 |
|---|---|
| `manifest.json` | 所需权限(`activeTab`/`scripting`/`offscreen`/`storage`/`unlimitedStorage`)全部已声明,零新增(FR-013) |
| `vite.config.ts` | `offscreen.html` 已是 Vite 多入口之一,`stitch.ts` 被 `src/offscreen/main.ts` import 后自动打进 offscreen 包;SW 侧新文件被 `background` 入口收编——**无需新增打包入口** |
| `src/background/offscreen.ts`、`offscreen.html` | `withOffscreen()` 与 offscreen 页外壳原样复用 |
| 飞书通道全部文件 | 截图与飞书导出解耦,零改动(SC-006) |

## 4. 依赖

- `jspdf` —— PDF 编码(P1)。打进 offscreen 包,且在 `stitch.ts` 里**动态 import**,PNG 路径不加载它,offscreen 页首屏体积不变。
- 其余零新依赖:抓屏是 Chrome 原生 API,拼接是原生 canvas,落盘复用 `download.ts`。
- **不引入**任何服务端/上传依赖(宪法 V);**不引入** html2canvas 做整页渲染——html2canvas 是"重绘式"截图,对复杂页面还原度差,只适合现有小红书卡片那种自建 DOM 的场景;整页截图必须用真实渲染结果(captureVisibleTab)。

## 5. 关键实现细节(踩坑点)

1. **sticky/fixed 头部去重**(FR-003):逐屏截图时页面上 `position:fixed`/`sticky` 的元素每屏都会入镜。做法:首屏抓取前遍历收集这些元素(`getComputedStyle`),首屏保留;从第二屏起统一置 `opacity:0`(不用 `display:none`,避免回流改变页面高度);全部截完(含异常路径)恢复原值。抄干净版 `background/background.js:91-104`。
2. **captureVisibleTab 每秒限流**(FR-004):该 API 有每秒调用配额,超了抛 `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` 错误。做法:`safeCaptureVisibleTab` 捕获该错误 → sleep 后重试(GoFullPage 只等 50ms 再试,比死等 1 秒快;重试上限约 20 次防死循环)。抄 `background.js:38-60` + GoFullPage `popup.faa992e0.js` 搜 `MAX_CAPTURE_VISIBLE_TAB`。
3. **高分屏 DPR 校正**(FR-005):所有拼接坐标(yPos/宽/高)先 ×devicePixelRatio;再抄 GoFullPage 的动态校正——首屏图片解码后拿"真实像素宽 ÷ 视口 CSS 宽"得实际缩放系数,替代盲信 dpr,浏览器缩放(如 125%)下也不错位。校正在 offscreen 里做(那里才有 Image 能量真实像素宽)。
4. **截前禁动画**(FR-006):注入一段 CSS 把 `*` 的 `transition`/`animation` 时长清零、`scroll-behavior:auto`,等约 800ms 让页面稳定再开抓,避免渐入动效被截成半透明残影;结束后移除该 style 节点并 `scrollTo` 回原位。恢复逻辑放 `finally`,失败也要恢复(FR-012/SC-004)。
5. **为什么必须 offscreen**(FR-007):SW 无 DOM/canvas/Image,拼接只能进 offscreen。建页复用 `withOffscreen()`(reasons: `DOM_PARSER`,借这个 reason 用 DOM canvas;串行队列天然避免"同一时刻只允许一个 offscreen 页"的冲突)。拼接核心就是干净版 `offscreen/offscreen.js` 那 32 行:`canvas.width=首屏宽; canvas.height=整页高; 逐屏 img.onload → drawImage(img, 0, yPos)`。
6. **activeTab 授予时机**(实战风险):`captureVisibleTab` 需要 `activeTab` 或 host 权限,而 `activeTab` 只在用户点扩展图标/右键菜单等手势时授予当前 tab。本扩展侧边栏从 popup 打开,点图标那一刻已授予;但若用户切换过 tab 再回来,授权可能失效 → 抓屏抛权限错误时给出"请重新点击扩展图标后再试"的明确提示,不静默失败。已授权域名(飞书/受信私有化)走既有 host 权限,无此问题。
7. **PDF 按页高切多页**(FR-009,P1):jsPDF 建 A4 竖版文档,把长图按"单页可容纳的像素高"切纵向切片,循环 `pdf.addPage()` 逐页 `addImage` 对应切片;最后一页按剩余高度收尾。**不做单张超长页**(干净版的做法,阅读器难看且超长渲染失败)。切片直接在 offscreen 用临时 canvas `drawImage` 裁切。抄 GoFullPage `editor.e1596743.js` 搜 `addPage`。
8. **【P2 补丁①】超长页 canvas 尺寸保护**(FR-010):canvas 高超约 32767px 或面积超约 2.68 亿 px² 时 `toDataURL` 静默返回空白。MVP:拼接前检查,超限则把高度封顶到安全值,产物带 `truncated` 标记,UI 提示"页面过长,仅截取前 N 屏"。P2 完整方案:抄 GoFullPage MultiCanvas(`popup.3cca83ac.js`)——多块 canvas 平铺,每块 ≤16384px 分别编码(`toBlob`)再合成或分段产出;PDF 路径天然受益(切片改从对应分块取图)。
9. **【P2 补丁②】超长页 PDF**(FR-010):PDF 分页机制 P1 已就位,P2 只需把"切片来源"从单块大 canvas 换成多块平铺,超长页 PDF 即完整。iframe/内部滚动区(GoFullPage `_findFrame`)收益最低,排在所有 P2 之后,本期不做。
10. **页面动态高度**:滚动可能触发懒加载使 `scrollHeight` 变化。干净版的处理:每屏滚动后重新测量,以"当前 scrollY + innerHeight ≥ scrollHeight"判定最后一屏(`isLast`),而非开头一次性定死总屏数;进度条按当前已知总高估算即可。

## 6. 宪法符合性检查

| 原则 | 评估 |
|---|---|
| I 零配置认证 | ✅ N/A:截图不碰飞书接口、不读 Cookie、无任何认证需求。 |
| II 域名不写死 | ✅ 截图对任意网页生效,本就不绑定域名;不新增任何域名判断,也不劫持飞书通道路由(§2)。 |
| III 导出可靠/可恢复 | ✅ 每屏进度经 `reportProgress` 推送;配额错误自动重试(细节 2);不可注入页/权限失效给明确错误(细节 6);`finally` 保证页面现场恢复。单次截图是短流程,SW 休眠恢复场景不适用,失败重试即可。 |
| IV 高质量 MD 双路 | ✅ N/A,显式声明边界:该原则只约束**飞书文档 Markdown 通道**(P-official/P-decode 与 §5.1 能力探测)。整页截图是独立能力域,不产 Markdown、不触碰飞书取数路径,故不受约束也不违反"禁止跳过能力检测"(那条仅限飞书)。与 002 plan 的边界声明写法一致。 |
| V 隐私不外发 | ✅ **硬要求**:抓屏、拼接、编码、落盘全程本地,零网络请求;截图内容/页面 URL 不进匿名统计(仅 `format/ok/secs` 枚举,走现有 `trackedExport`)。取证:`grep -rn "fetch(\|XMLHttpRequest\|sendBeacon" src/background/screenshot/ src/offscreen/stitch.ts` 无结果。 |
| VI 合规告知 | ✅ N/A:截取的是用户自己正在浏览的公开渲染结果,无"绕过组织限制"语义,无需额外合规弹窗。 |
| 禁止事项 | ✅ 不新增权限(FR-013);截图通道不用 `chrome.debugger`(FR-002 取证);不在 SW 里建 canvas(FR-007)。 |

## 7. 验收与回归

- 跑 spec 的 SC-001~SC-008(抽样长页/DPR 与缩放组合/无调试黄条/现场恢复/超长页不空白/飞书回归/PDF 分页正确/配额重试)。
- 取证三连:
  - `grep -rn "chrome.debugger" src/background/screenshot/ src/background/exporters/screenshot.ts src/offscreen/` → 无结果(SC-003)。
  - `grep -rn "fetch(\|XMLHttpRequest\|sendBeacon" src/background/screenshot/ src/offscreen/stitch.ts` → 无结果(宪法 V)。
  - `git diff manifest.json` → 权限零变化(FR-013)。
- 飞书回归:公有云 + 私有化各导一篇 MD/PDF,行为零变化(SC-006)。
- `npm run typecheck` + `npm run build` 通过(宪法治理:改源码后必跑)。

## 8. 分期

- **P0(MVP)**:US1 整页 PNG——页面端函数 + 限流抓屏 + offscreen 拼接 + 尺寸封顶保护 + SW 编排落盘 + UI 入口。1:1 抄干净版,预期 2~3 天跑通。
- **P1**:US2 PDF 导出(jsPDF 按页高分页,一步到位不做单超长页;若排期紧可整体顺延,但不做单页中间态)。
- **P2**:US3 多块 canvas 平铺(超长页完整导出,PNG/PDF 同时受益)。
- **P2 之后(默认不做)**:iframe/内部滚动区截取、二维滚动网格(超宽页)。
