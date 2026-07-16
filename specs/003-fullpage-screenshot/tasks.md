# Tasks: 任意网页整页长图截图

**Plan**: `specs/003-fullpage-screenshot/plan.md` · **Spec**: `./spec.md`

约定:`[P]` 可与同段其他 `[P]` 并行(改不同文件);顺序项有依赖。每个 phase 末尾跑 `npm run typecheck`。参考源码统一在 `ref/extracted/ScreenCapture&EditorGoFullPage/`(干净版)与 `ref/extracted/GoFullPageFullPageScreenCapture/`(进阶),行号见研究文档 §5.1。

## Phase 0 — 脚手架与依赖

- [x] T001 安装依赖:`npm i jspdf`(P1 的 PDF 用,先装上;`stitch.ts` 里动态 import,不拖累 PNG 路径)
- [x] T002 [P] `src/shared/constants.ts`:`MSG` 增 `EXPORT_SCREENSHOT: 'export_screenshot'`;`OFFSCREEN_MSG` 增 `SHOT_STITCH: 'offscreen_shot_stitch'`、`SHOT_PROGRESS: 'offscreen_shot_progress'`(注释风格对齐现有 `XHS_RENDER`/`XHS_PROGRESS`)
- [x] T003 [P] `src/shared/types.ts`:增 `ScreenshotFormat = 'png' | 'pdf'`、`CaptureShot { dataUrl: string; yPos: number }`(yPos 已 ×dpr)、`ShotStitchRequest { shots: CaptureShot[]; width: number; totalHeight: number; format: ScreenshotFormat; pageHeightPx?: number }`、`ShotStitchResult { dataUrl: string; truncated?: boolean }`
- [x] Phase 0 末尾:`npm run typecheck`

## Phase 1 — 页面端函数与逐屏抓取(SW 侧) [US1 P0]

- [x] T004 [P] `src/background/screenshot/page.ts`:被 `chrome.scripting.executeScript({ func })` 注入的页面端纯函数(注意:注入函数不能引用模块外变量,参数全走 args):
  - `preparePage()`:注入禁动画 CSS(`*{transition:none!important;animation:none!important} html{scroll-behavior:auto!important}`,style 节点打专属 id 便于移除),记录原 scrollY,返回测量值 `{scrollHeight, innerHeight, innerWidth, scrollY, dpr}`(抄干净版 `background/background.js:85-108`)
  - `scrollToY(y)`:滚动并重新测量,返回 `{scrollY, scrollHeight, isLast}`(每屏重测,懒加载导致高度变化也能收敛,见 plan 细节 10)
  - `hideFixed()` / `restoreFixed()`:收集 `position:fixed|sticky` 元素,首屏后统一 `opacity:0`,截完恢复原值(抄 `background.js:91-104`,plan 细节 1)
  - `restorePage(scrollY)`:移除禁动画 style + 滚回原位
- [x] T005 `src/background/screenshot/capture.ts`(依赖 T004):
  - `safeCaptureVisibleTab(windowId)`:调 `chrome.tabs.captureVisibleTab`,捕获 `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` 配额错误 → sleep 50ms 重试,上限 20 次(抄 `background.js:38-60` + GoFullPage 的 50ms 轮询,plan 细节 2)
  - `captureFullPage(tabId)` 主循环(抄 `background.js:62-157`):preparePage → 等 800ms → 首屏抓取 → hideFixed → 循环 scrollToY(每屏间隔等渲染稳定)+ 抓屏压 `CaptureShot[]`(yPos ×dpr)→ 直到 isLast;每屏发 `reportProgress('screenshot','running','正在截取第 N 屏...')`;返回 `{ shots, viewportCssWidth, dpr, totalHeight }`
  - 权限错误(activeTab 失效)单独识别,抛"请重新点击扩展图标后再试"(plan 细节 6)
- [x] Phase 1 末尾:`npm run typecheck`

## Phase 2 — offscreen 拼接 [US1 P0]

- [x] T006 `src/offscreen/stitch.ts`:
  - `stitch(req: ShotStitchRequest): Promise<ShotStitchResult>`:建 canvas(宽=首屏真实像素宽,高=totalHeight×缩放系数),逐屏 `new Image()` → onload → `drawImage(img, 0, yPos)`(核心抄干净版 `offscreen/offscreen.js:7-32`)
  - DPR 动态校正:首屏图片解码后用"真实像素宽 ÷ viewportCssWidth"得实际缩放系数,替代盲信 dpr(抄 GoFullPage MultiCanvas 思路,plan 细节 3)
  - 尺寸保护(MVP 封顶):拼接前若高 > 32000 或面积 > 2.6e8 → 高度封顶到安全值、结果带 `truncated: true`(plan 细节 8;完整平铺见 T014)
  - PNG 分支:`canvas.toDataURL('image/png')`;逐屏拼接进度发 `OFFSCREEN_MSG.SHOT_PROGRESS`(fire-and-forget,对齐 `reportCardProgress` 写法)
- [x] T007 `src/offscreen/main.ts`(依赖 T006):消息监听增 `SHOT_STITCH` 分支 → `stitch()` → `sendResponse`;保持"其余消息一律放行给别的监听者"的现有约定(现在只认 `XHS_RENDER`,改成两个 type 的 switch/并列 if)
- [x] Phase 2 末尾:`npm run typecheck`

## Phase 3 — SW 编排、路由与 UI 入口 [US1 P0]

- [x] T008 `src/background/exporters/screenshot.ts`(依赖 T005/T007):`exportScreenshot(format: ScreenshotFormat)`——取当前 tab(复用 `tab-util`)→ URL 协议预检(非 http/https 直接友好报错)→ `captureFullPage` → `withOffscreen()` 内 `chrome.runtime.sendMessage(SHOT_STITCH)` 拿 dataUrl → `finally` 里 restoreFixed + restorePage(失败也恢复现场,SC-004)→ `safeName(tab.title) + '.png'` → `downloadDataUrl`(复用 `src/background/download.ts`);`truncated` 时进度消息带"页面过长,仅截取前 N 屏"
- [x] T009 `src/background/index.ts`(依赖 T008):路由增 `case MSG.EXPORT_SCREENSHOT` → 读 `message.data.format`(默认 'png')→ `trackedExport('screenshot', () => exportScreenshot(format))`;增 `case OFFSCREEN_MSG.SHOT_PROGRESS` → 转 `reportProgress`(对齐 `XHS_PROGRESS` 分支写法)
- [x] T010 [P] `src/sidepanel/actions.ts`:增"整页截图"动作定义,发 `MSG.EXPORT_SCREENSHOT { format }`
  - **实现偏差**:`actions.ts` 是飞书导出宫格专用,截图不走那条网关(会被 `requireReady` 飞书就绪判定挡住)。改为像「下载视频」一样,直接在 `WebCopyView` 里发 `MSG.EXPORT_SCREENSHOT`,不动 `actions.ts`——更贴合现有 UI 结构,也保证飞书宫格零改动(SC-006)。
- [x] T011 `src/sidepanel/WebCopyView.tsx`:网页工具区(非飞书页)增"整页截图"卡片(PNG 主按钮 + PDF 次选);逐屏/拼接进度经订阅 `MSG.PROGRESS`(action==='screenshot')展示;非 http/https 页由 SW 端预检友好报错
  - **实现偏差**:入口目前只在非飞书页的 `WebCopyView` 出现;飞书页(走导出宫格)本期不加截图入口,飞书文档推荐用结构化 PDF/MD 通道(见 spec Q)。FR-001「任意 http/https 页面提供入口」对普通网页已满足,飞书页入口列为后续增强。
- [x] Phase 3 末尾:`npm run typecheck`;手动冒烟:长文章页截 PNG,验证无重复页头/现场恢复/无调试黄条

## Phase 4 — PDF 多页导出 [US2 P1]

- [x] T012 `src/offscreen/stitch.ts`:增 PDF 分支——动态 `import('jspdf')`;A4 竖版,算"单页可容纳的像素高"(按图宽等比映射到 A4 宽),用临时 canvas 把长图裁纵向切片,循环 `pdf.addPage()` + `addImage`,末页按剩余高度收尾;输出 dataURI(抄 GoFullPage `editor.e1596743.js` 搜 `addPage`,plan 细节 7;**不做单张超长页**)
- [x] T013 `src/sidepanel/WebCopyView.tsx` + `actions.ts`(依赖 T012):截图按钮增 PNG/PDF 二选一(PNG 为默认主按钮);`exportScreenshot('pdf')` 落盘 `.pdf`
- [x] Phase 4 末尾:`npm run typecheck`;手动验证 PDF 页数≈长图高/页高、阅读器打开正常

## Phase 5 — 验收与回归

- [ ] T015 抽样 10 个长页面(新闻/博客/文档站/后台页)验 SC-001;其中含 fixed 顶栏页、动画页各 ≥2 个
- [ ] T016 DPR/缩放矩阵:dpr=2 屏 + 浏览器缩放 100%/125% 验 SC-002;20 屏以上页面验配额重试 SC-008
- [ ] T017 超长页:高 ×dpr 超 32767px 的页面验 SC-005(MVP 得到截断产物 + 提示,非空白)
- [ ] T018 飞书回归:公有云 + 私有化各一篇 MD/PDF 导出行为零变化(SC-006)
- [x] T019 取证:`grep chrome.debugger`(截图相关代码)与 `grep fetch/XMLHttpRequest/sendBeacon`(screenshot/stitch)均无结果;`manifest.json` 权限零变化(git 未改动);`npm run typecheck` + `npm run build` 均通过

## Phase 6 — 增强(P2,可选)

- [ ] T014 (可选)多块 canvas 平铺(US3):`stitch.ts` 把单块大 canvas 换成分块(每块 ≤16384px)分别 `drawImage`/编码再合成或分段产出;PDF 切片改从对应分块取图 → 超长页完整导出,替换 T006 的封顶截断(抄 GoFullPage `popup.3cca83ac.js` 搜 `MultiCanvas`)
- [ ] T020 (明确不做,记录备查)iframe/内部滚动区截取(GoFullPage `_findFrame`)、二维滚动网格(超宽页):收益低、实现重,等真实用户反馈再评估

## 依赖图

```
T001─┐
T002[P]┼─T004[P]──T005──┐
T003[P]┘  T006──T007────┼─T008──T009──T011
                        │        T010[P]┘
P1:T012──T013(依赖 T008 链路跑通)
后置:Phase5(T015~T019) / Phase6(T014 替换 T006 封顶,T020 默认不做)
```
