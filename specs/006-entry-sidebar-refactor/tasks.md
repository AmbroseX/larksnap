# Tasks: 交互入口与侧边栏布局重构

**Input**: Design documents from `/specs/006-entry-sidebar-refactor/`
**Prerequisites**: plan.md, spec.md, data-model.md, quickstart.md

**Tests**: spec SC-008 明确要求菜单生成、页面分类、动作分发三块纯逻辑具备单元测试，对应任务已列入（vitest，零新依赖）。

**Organization**: 按 plan.md 的实施阶段 1a → 1b → 1c → 2 → 3 组织（每阶段一次独立提交、可独立验证回滚）；每条任务用 [USx] 映射回 spec 的用户故事。阶段与故事的对应：1a=跨故事基础设施，1b=US2+US4+US5，1c=US1，2=US3，3=收尾。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行执行（不同文件，无依赖）
- **[Story]**: 所属用户故事（US1~US5；基础设施标 [Base]）
- 所有路径相对仓库根

## Path Conventions

- 后台（MV3 Service Worker）：`src/background/`
- 侧边栏 UI（React）：`src/sidepanel/`
- 共享类型/常量/i18n：`src/shared/`
- 构建与声明：`manifest.json`、`vite.config.ts`
- 测试：与被测模块同目录 `*.test.ts`（vitest，`npm test`）

---

## Phase 1a: 动作分发层（Foundational，零行为变化）

**Purpose**: 建立统一分发层与"触发瞬间锁定 tabId"协议，为所有新入口打地基。此阶段不改任何用户可见行为。

**⚠️ 关键约束（评审阻断项）**: dispatch 之下所有实现禁止调用 `chrome.tabs.query({active:true})`，必须使用传入的 `tabId/url`。

- [X] T001 [P] [Base] `src/shared/types.ts`：新增 `ActionId`、`DispatchContext`、`TaskRecord`、`NavigationIntent`、`UiPrefs`；`PageKind` 增 `'video'`；`PageKindInfo` 扩展 `title?/videoSite?`（字段定义见 data-model.md）
- [X] T002 [P] [Base] `src/shared/constants.ts`：`STORAGE_KEYS` 新增 `TASKS_PREFIX='larksnap:tasks:'`、`INTENT='larksnap:intent'`、`UI_PREFS='larksnap:ui-prefs'`
- [X] T003 [Base] `src/shared/page-kind.ts`：新建 `classifyPage(url, title?): PageKindInfo` 纯函数（判定顺序 restricted→feishu→youtube→video→generic，复用 `video.ts` 的 `matchSite` 逻辑抽取）
- [X] T004 [P] [Base] `src/shared/page-kind.test.ts`：五类 URL 分类断言（含私有化飞书域双信号、youtube 优先于 video、chrome:// 受限）
- [X] T005 [P] [Base] `src/background/exporters/screenshot.ts`：`exportScreenshot(format, tabId)` 签名改造，删除 `:22` 的 `tabs.query`
- [X] T006 [P] [Base] `src/background/summarize/index.ts`：`summarizePage({ tabId, url })` 签名改造，`collectSource` 删除 `:144` 的 `getActiveTab()`
- [X] T007 [P] [Base] `src/background/doc-detect.ts`：新增 `detectDocForTab(tabId)`；`detectActiveDoc()` 改为"查活动页→调它"的壳（仅限侧边栏只读场景使用）
- [X] T008 [P] [Base] `src/background/webcopy.ts`：`webcopyPageMd`/`webcopySelectionMd` 等转换函数统一收 `tabId` 参数
- [X] T009 [Base] `src/background/actions-dispatch.ts`：新建 `resolveAction(id)` 纯路由表 + `dispatchAction(id, ctx)`；飞书动作内调 `detectDocForTab(tabId)` + `setContentTab(tabId)`
- [X] T010 [Base] `src/background/actions-dispatch.test.ts`：路由表断言 + tabId 透传验证（局部 stub `globalThis.chrome`，断言下层未调 `tabs.query`）
- [X] T011 [Base] `src/background/index.ts`：侧边栏消息 handler（EXPORT_SCREENSHOT / SUMMARIZE_PAGE / 各飞书 EXPORT_*）改为入口处捕获 tabId 后走 dispatch / 新签名
- [X] T012 [Base] 验证提交：`npm run typecheck` + `npm test` 全绿；手测侧边栏全部导出路径行为与改造前一致；git 提交

**Checkpoint**: 分发层就绪，所有既有功能行为不变；grep 确认 screenshot/summarize/exporters 下无 `tabs.query({active:true})`。

---

## Phase 1b: 右键菜单 + 快捷键 + 角标 (US2 / US4 / US5)

**Goal**: 新入口全部接入 1a 的 dispatch；后台触发的动作有 badge + 任务记录反馈。

**Independent Test**: 普通页/飞书页/选区右键菜单集合正确且可触发；三个默认快捷键可用；侧边栏关闭时触发动作出现角标、失败原因可在侧边栏查看。

- [X] T013 [US5] `src/background/badge.ts`：新建 `runTracked(actionId, ctx, run)`（写 TaskRecord 到 `storage.session` 键 `larksnap:tasks:<tabId>`、上限 10 条、`setBadgeText({tabId})` 绿✓/红!）+ 清除钩子（`tabs.onActivated`、GET_STATUS 时清当前 tab）
- [X] T014 [US2] `src/background/context-menus.ts`：新建 `buildMenuSpecs(t, trustedDomains)` 纯函数（父菜单 LarkSnap；通用组 page-md/selection-md/screenshot/summarize/unlock/open-panel；飞书组 feishu-md/pdf/html/open-panel，`documentUrlPatterns`=官方三域+trustedDomains）+ `registerMenus()`（removeAll+create 幂等）+ `onClicked` 捕获 `tab.id/url` 进 dispatch
- [X] T015 [P] [US2] `src/background/context-menus.test.ts`：断言各页面类型下菜单项集合（含 trustedDomains 注入 documentUrlPatterns、语言切换标题变化）
- [X] T016 [US2] `src/background/webcopy.ts`：删除 `registerMenus`/`onClicked` 菜单代码（迁入 context-menus.ts），只留剪藏管线
- [X] T017 [US2] `src/background/index.ts` + `context-menus.ts`：重建时机接线——`onInstalled`/`onStartup`/`onLanguageChanged`/`chrome.permissions.onAdded+onRemoved`（后者为新增监听）
- [X] T018 [P] [US4] `manifest.json`：新增 `commands` 段——`open-panel`(Ctrl/Cmd+Shift+L)、`page-md`(Ctrl/Cmd+Shift+M)、`screenshot`(Ctrl/Cmd+Shift+S)、`summarize`(无默认键)
- [X] T019 [US4] `src/background/index.ts`：`chrome.commands.onCommand` 监听，捕获 tab 后进 dispatch；`open-panel` 调 `sidePanel.open({tabId})`
- [X] T020 [US2] `src/background/actions-dispatch.ts`：`summarize` 动作实现为"写 `NavigationIntent` 到 storage.session + `sidePanel.open({tabId})`"（不后台执行总结）
- [X] T021 [US2] `src/sidepanel/SummaryView.tsx`：挂载时读取+消费导航意图（读到即删、30s 过期丢弃）、`storage.onChanged` 监听即时响应，自动开始时携带意图中的 `tabId/url`
- [X] T022 [P] [US2] `src/shared/i18n/zh.ts` + `en.ts`：`menu.*` 扩充（截图/总结/开面板/飞书三导出/更多导出方式）
- [X] T023 [US2] 验证提交：`npm test` 全绿；手测 quickstart 清单 1-5（锁 tab 验收、飞书右键、快捷键三连、角标链路、总结意图）；git 提交

**Checkpoint**: 右键/快捷键全量可用且全走 dispatch；badge 反馈闭环；侧边栏行为仍未变。

---

## Phase 1c: 工具栏直开侧边栏 + 删除 popup (US1) 🎯 MVP 完成点

**Goal**: 点图标一步进侧边栏；popup 信息等价迁入侧边栏 header。

**Independent Test**: 点击工具栏图标直接打开侧边栏；状态圆点三色正确、详情可展开、contextId 可复制。

- [X] T024 [US1] `src/sidepanel/HeaderStatus.tsx`：新建 daemon 状态圆点（绿=connected/灰=disconnected/黄=connecting）+ 点击展开详情行（daemonVersion、contextId 复制按钮、protocolMismatch 提示、未连接时 `/larksnap-fetch` 引导），逻辑自 `src/popup/Popup.tsx` 迁移（`MSG.GET_BRIDGE_STATUS` 2s 轮询）
- [X] T025 [US1] `src/sidepanel/SidePanel.tsx`：header 挂载 HeaderStatus（本阶段仅加状态点，不动其余布局）
- [X] T026 [US1] `src/background/index.ts:70`：`setPanelBehavior({ openPanelOnActionClick: true })`
- [X] T027 [P] [US1] `manifest.json`：删除 `action.default_popup`
- [X] T028 [P] [US1] `vite.config.ts`：删除 popup 构建入口（rollup input `popup`）
- [X] T029 [US1] 删除 `popup.html`、`src/popup/`（main.tsx / Popup.tsx / popup.css）
- [X] T030 [US1] 验证提交：构建通过、点图标直开侧边栏、状态点手测（daemon 开/关两态）、升级安装无残留报错；git 提交

**Checkpoint**: MVP 达成——一次点击到达功能 + 全部新入口可用；`dist/` 无 popup 产物。

---

## Phase 2: 侧边栏 home 重构 (US3)

**Goal**: "上下文区置顶 + 通用工具常驻"的单列分组布局；任何页面可见全部能力。

**Independent Test**: 五类页面（飞书/YouTube/B站/普通/chrome://）上下文区各自正确、通用区四分组常驻；样式下拉一次点击直选；折叠态跨会话保留。

- [X] T031 [US3] `src/background/index.ts` + `doc-detect.ts`：pageKind 推导链路改用 `classifyPage`，向侧边栏返回扩展后的 `PageKindInfo`（含 title/videoSite；video 站点合并 `GET_VIDEO_STATE` 的 bridgeReady）
- [X] T032 [P] [US3] `src/sidepanel/actions.ts`：`ActionItem` 增 `group: 'export'|'publish'|'misc'`；删除 `word`、`cacheList`、`diagnostic`、`feedback` 四卡
- [X] T033 [P] [US3] `src/sidepanel/StylePicker.tsx`：新建小红书/公众号样式下拉直选（样式名+缩略预览，点选即发 `EXPORT_XHS`/`EXPORT_WECHAT`，复用 `XHS_THEME_OPTIONS`/`WECHAT_THEME_OPTIONS`）
- [X] T034 [US3] `src/sidepanel/ContextZone.tsx`：新建页面识别条 + 按 kind 分支渲染（feishu：4 主按钮+StylePicker 行+缓存到本地；youtube：TranscriptCard+视频下载卡；video：视频下载卡；generic：仅识别条；restricted：不可操作提示）
- [X] T035 [US3] `src/sidepanel/ToolGroups.tsx`：新建通用工具折叠分组（剪藏/截图/AI 总结/页面开关），从 `WebCopyView.tsx` 拆分重组；折叠态读写 `larksnap:ui-prefs`（默认剪藏展开其余折叠）；restricted 页整体置灰
- [X] T036 [US3] `src/sidepanel/WebCopyView.tsx`：配合 T035 瘦身——剪藏/截图/开关区块迁出，视频卡迁入 ContextZone，遗留导出预览与任务列表逻辑妥善安置
- [X] T037 [P] [US3] `src/sidepanel/Footer.tsx`：新建页脚（反馈 · 诊断 · v{manifest version} 小字链接，行为复用原 diagnostic/feedback 动作）
- [X] T038 [US3] `src/sidepanel/SidePanel.tsx`：home 重构总装——header（logo+HeaderStatus+设置+缓存库图标，删 `:284` 免费徽标与 `:299-302` quota-chip）→ ContextZone → ToolGroups → 底部状态栏 → Footer；view 状态机 `home|cache|xhsPreview` 保持不变
- [X] T039 [P] [US3] `src/shared/i18n/zh.ts` + `en.ts`：分组标题、页面识别条、页脚、header tooltip、restricted 提示等全部文案
- [X] T040 [US3] 侧边栏样式：分组卡片/折叠动效/主按钮网格/下拉样式（`src/sidepanel/` 相应 css）
- [X] T041 [US3] 验证提交：`npm test` 全绿；手测 quickstart 清单 6-8（五类页面、折叠态、语言/授权联动）；git 提交

**Checkpoint**: 侧边栏新布局完整可用；US3 验收场景 1-10 全过。

---

## Phase 3: Polish & Cross-Cutting

- [X] T042 [P] 意图与角标边界打磨：意图 30s 过期、同 tab 并发覆盖、目标 tab 关闭时任务记失败（`src/background/badge.ts`、`actions-dispatch.ts`）
- [X] T043 [P] `src/options/`：新增快捷键说明区（指引 chrome://extensions/shortcuts）+ i18n
- [X] T044 [P] 文档更新：README 入口说明、store 描述草稿（docs/ 下合适位置）
- [X] T045 验收总检：quickstart.md 全部检查点 + spec.md SC-001~SC-008 逐条核对；宪法自查（域名 grep、无新权限、无外发）；git 提交

---

## Dependencies & Execution Order

### Phase Dependencies

- **1a → 1b → 1c → 2 → 3 严格顺序**（每阶段一次提交，可独立回滚）
- 1b 依赖 1a 的 dispatch 与签名改造；1c 依赖 1b（角标清除钩子挂在 GET_STATUS 上）；2 依赖 1a 的 `classifyPage` 与 1c 的 HeaderStatus
- US 映射：US2/US4/US5 由 1b 交付，US1 由 1c 交付，US3 由 2 交付

### Within Each Phase

- 1a：T001+T002 先行 → T003/T005~T008 并行 → T009 → T010/T011 → T012
- 1b：T013/T014/T018 可并行起 → T016/T017/T019/T020 → T021 → T023
- 2：T031 与 T032/T033/T037/T039 并行 → T034/T035 → T036 → T038 → T041

### Parallel Opportunities

```bash
# 1a: T001, T002 → 然后 T004, T005, T006, T007, T008 并行
# 1b: T013, T015, T018, T022 并行
# 2:  T032, T033, T037, T039 并行
# 3:  T042, T043, T044 并行
```

---

## Implementation Strategy

### MVP First

1. Phase 1a 完成 → 地基就绪（行为零变化，随时可停）
2. Phase 1b 完成 → 右键/快捷键/角标可演示
3. Phase 1c 完成 → **MVP：US1+US2+US4+US5 全部交付，STOP and VALIDATE**
4. Phase 2 → 侧边栏重构（主体工作量，独立提交）
5. Phase 3 → 收尾

### Incremental Delivery

每个 Phase 结束即提交（遵循 CLAUDE.md），扩展在任意 Phase 边界都处于可发布状态。

---

## Task Summary

| 阶段 | 任务数 | 可并行任务数 |
|------|--------|-------------|
| Phase 1a: 分发层 | 12 | 7 |
| Phase 1b: 新入口 | 11 | 4 |
| Phase 1c: 直开侧边栏 | 7 | 2 |
| Phase 2: 侧边栏重构 | 11 | 5 |
| Phase 3: 收尾 | 4 | 3 |
| **Total** | **45** | **21** |

**MVP Scope**: Phase 1a + 1b + 1c = 30 tasks（交付 US1/US2/US4/US5）

**Parallel Efficiency**: 21 / 45 ≈ 47%

---

## Notes

- 手测任务（T012/T023/T030/T041）不可省：右键菜单、快捷键、badge、扩展重载均为 Chrome 真实行为，单测覆盖不到（按项目既有经验，重载扩展后需刷新目标页面再测）
- 每阶段提交信息按仓库惯例中文书写（feat:/fix: 前缀）
- 避免：跨阶段混改（1c 之前不动侧边栏布局）、在 dispatch 之下新增活动页查询
