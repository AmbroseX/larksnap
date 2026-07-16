# Implementation Plan: 交互入口与侧边栏布局重构

**Branch**: `006-entry-sidebar-refactor` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

## Summary

把扩展的三大入口（工具栏图标、右键菜单、键盘快捷键）收敛到一个统一的动作分发层 `dispatchAction(actionId, { tabId, url, source })`，触发瞬间锁定目标标签页并全链路显式传递；删除 popup、点图标直开侧边栏；侧边栏 home 重构为"上下文区置顶 + 通用工具常驻"的单列分组布局。按 1a（分发层，零行为变化）→ 1b（右键/快捷键/角标接入）→ 1c（切图标行为、删 popup）→ 2（侧边栏重构）→ 3（收尾）五步实施，每步可独立提交、验证、回滚。

## Technical Context

**Language/Version**: TypeScript 5.5（strict）
**Primary Dependencies**: React 18.3（sidepanel/options UI）、Vite 5.4 多页构建 + esbuild IIFE 内容脚本、Chrome MV3 API（`sidePanel` / `contextMenus` / `commands` / `action` badge / `storage.session`）
**Storage**: `chrome.storage.local`（config / ui-prefs，键名集中 `STORAGE_KEYS`）+ `chrome.storage.session`（任务记录、导航意图等会话级数据）
**Testing**: vitest 4（现有 `vitest.config.ts`，`src/**/*.test.ts`；新增纯逻辑测试：菜单生成、页面分类、动作分发）
**Target Platform**: Chrome MV3 扩展（Service Worker 随时休眠，所有跨入口状态必须落 storage）
**Project Type**: 浏览器扩展（background SW + sidepanel/options 页 + 按需注入内容脚本）
**Performance Goals**: 右键菜单重建（removeAll+create）幂等且 <100ms；badge 更新即时；侧边栏首屏渲染不因分组重构变慢
**Constraints**: manifest `commands` 至多 4 个 `suggested_key`；`contextMenus` 为静态注册模型（视频下载等运行时探测项不进右键）；`sidePanel.open()` 必须在用户手势调用栈内

## Constitution Check

对照 `.specify/memory/constitution.md`（v1.0.0）逐条核查：

| 原则 | 本计划遵循方式 | 结果 |
|------|---------------|------|
| I. 零配置认证 | 不触碰认证链路；右键/快捷键触发的飞书导出仍走现有 content script 同源取数 | ✅ |
| II. 域名不写死 / 兼容私有化 | 右键菜单 `documentUrlPatterns` = manifest 已有官方域 + 运行时从 `trustedDomains` 读私有化域动态拼接，不新增硬编码域名；授权增删时重建菜单 | ✅ |
| III. 导出可靠 / 状态可恢复 | 后台触发的任务结果写 `storage.session` 任务记录（SW 休眠不丢）；badge 按 tab 隔离；侧边栏 `GET_STATUS` 恢复机制不变 | ✅ |
| IV. 高质量 Markdown / 双路取数 | 不触碰导出管线，仅改触发入口（传 tabId 而非查活动页） | ✅ |
| V. 隐私安全 / 不外发 | 无新增网络请求；不引入 `notifications` 权限；任务记录仅存本地 | ✅ |
| VI. 合规告知 | 不触碰 P-decode 提示逻辑 | ✅ |
| 技术栈约束 | 无新依赖；manifest 仅新增 `commands` 段（不是权限）；复用已声明的 `contextMenus` 权限 | ✅ |

**Constitution Check Result**: ✅ 通过

## Project Structure

### Documentation (this feature)

```text
specs/006-entry-sidebar-refactor/
├── spec.md          # 功能规格（已完成）
├── plan.md          # 本文件
├── research.md      # 9 项技术决策
├── data-model.md    # 类型/存储模型与状态机
├── quickstart.md    # 分阶段开发指引
└── tasks.md         # /speckit-tasks 生成
```

### Source Code (repository root)

```text
manifest.json                     # [改] 删 action.default_popup；新增 commands（4 个）
vite.config.ts                    # [改] 删 popup 构建入口
popup.html                        # [删]
src/popup/                        # [删] main.tsx / Popup.tsx / popup.css

src/background/
├── actions-dispatch.ts           # [新] 统一动作分发层 dispatchAction(actionId, ctx)
├── actions-dispatch.test.ts      # [新] 分发路由/tabId 透传单测
├── context-menus.ts              # [新] 全部右键菜单注册（webcopy.ts 的 registerMenus 迁入）
├── context-menus.test.ts         # [新] 各页面类型下菜单项集合单测（纯 spec 生成函数）
├── badge.ts                      # [新] 角标 + 任务记录（storage.session，按 tab 隔离）
├── index.ts                      # [改] setPanelBehavior(true)、commands.onCommand、
│                                 #      消息 handler 改走 dispatch、意图消费接口
├── webcopy.ts                    # [改] 菜单注册移出；webcopyPageMd/SelectionMd 收 tabId
├── doc-detect.ts                 # [改] 新增 detectDocForTab(tabId)；detectActiveDoc 保留为壳
├── exporters/screenshot.ts       # [改] exportScreenshot(format, tabId)
└── summarize/index.ts            # [改] summarizePage({ tabId, url })

src/shared/
├── types.ts                      # [改] PageKind 增 'video'；PageKindInfo 扩展；
│                                 #      新增 ActionId/DispatchContext/TaskRecord/NavigationIntent/UiPrefs
├── constants.ts                  # [改] STORAGE_KEYS 增 TASKS/INTENT/UI_PREFS；MSG 增量
├── page-kind.ts                  # [新] classifyPage(url) 纯函数（从散落判断收敛）
├── page-kind.test.ts             # [新] 页面分类单测
└── i18n/{zh,en}.ts               # [改] menu 组扩充、sidepanel 分组/页脚/状态点文案

src/sidepanel/
├── SidePanel.tsx                 # [改] home 重构：header/上下文区/通用区/页脚
├── actions.ts                    # [改] ACTIONS 加 group 字段，删 word/cacheList/diagnostic/feedback 卡
├── HeaderStatus.tsx              # [新] daemon 状态点 + 详情展开（替代 popup）
├── ContextZone.tsx               # [新] 页面识别条 + 按 pageKind 的动作区
├── ToolGroups.tsx                # [新] 通用工具折叠分组（WebCopyView 拆分重组）
├── StylePicker.tsx               # [新] 小红书/公众号样式下拉直选
├── Footer.tsx                    # [新] 反馈 · 诊断 · 版本
└── WebCopyView.tsx               # [改] 拆出的部分并入 ToolGroups，保留剪藏管线交互
```

**Structure Decision**: 入口层新逻辑全部放独立新模块（dispatch / context-menus / badge），不塞进已 360 行的 `index.ts`；纯逻辑（菜单 spec 生成、页面分类、动作路由表）与 chrome API 调用分离，前者可被 vitest 直接测试，后者薄封装。

## 实施阶段（与提交边界对齐）

| 阶段 | 内容 | 行为变化 | 验证 |
|---|---|---|---|
| 1a | `actions-dispatch.ts` + 底层函数改收 `tabId/url` + `page-kind.ts` + 单测 | 零（侧边栏消息 handler 在入口处捕获 tabId 后传入，行为不变） | `npm test` + 手测侧边栏各导出 |
| 1b | `context-menus.ts` + manifest `commands` + `badge.ts`，全走 1a 的 dispatch | 新增右键/快捷键入口 | 单测 + 手测右键/快捷键/角标 |
| 1c | `setPanelBehavior(true)`、删 `default_popup`/`src/popup/`/vite 入口、`HeaderStatus.tsx` 迁入侧边栏 | 点图标直开侧边栏 | 手测点图标、状态点详情 |
| 2 | 侧边栏 home 重构（ContextZone / ToolGroups / StylePicker / Footer、actions 分组、pageKind `video`） | 侧边栏全新布局 | 单测（分类）+ 5 类页面手测 |
| 3 | 收尾：意图打磨、options 页快捷键指引、文档/store 描述 | 微调 | 手测 |

## Complexity Tracking

无。不引入新依赖、新权限；`commands` 为 manifest 声明段非权限项。已声明未使用的 `contextMenus` 权限本次对齐实现（消化存量，而非新增）。
