# Quickstart: 交互入口与侧边栏布局重构

## 前置条件

- Node 环境，`npm install` 已执行
- Chrome 加载 `dist/` 为未打包扩展（chrome://extensions 开发者模式）
- 手测账号：能打开飞书文档页 + 任一 B 站/YouTube 视频页

## 开发环境

```bash
npm run dev        # vite watch 构建到 dist/（dev 模式带热重载轮询）
npm run typecheck  # tsc --noEmit
npm test           # vitest run（src/**/*.test.ts）
```

注意：改 background/manifest 后需到 chrome://extensions 手动重载扩展；涉及右键菜单、快捷键、图标行为的验证必须真机手测（单测只覆盖纯逻辑）。

## 开发顺序（严格按 1a → 1b → 1c → 2 → 3，每步独立提交）

### 1a. 动作分发层（零行为变化）

1. `src/shared/types.ts`：加 `ActionId` / `DispatchContext` / `TaskRecord` / `NavigationIntent` / `UiPrefs`；`PageKind` 加 `'video'`、`PageKindInfo` 扩展。
2. `src/shared/page-kind.ts`：`classifyPage(url, title?)` 纯函数 + 测试。
3. 底层签名改造：`exportScreenshot(format, tabId)`、`summarizePage({tabId,url})`、`detectDocForTab(tabId)`、webcopy 转换收 `tabId`。
4. `src/background/actions-dispatch.ts`：路由表 + `dispatchAction`。
5. `index.ts` 侧边栏消息 handler 改为"入口捕获 tabId → 调 dispatch/新签名"，行为不变。

关键骨架：

```ts
// src/background/actions-dispatch.ts
import type { ActionId, DispatchContext, Response } from '../shared/types';

type Handler = (ctx: DispatchContext) => Promise<Response>;

// 纯路由表（可单测）：actionId -> handler 名称与反馈策略
export function resolveAction(id: ActionId): { run: Handler; feedback: 'badge' | 'none' } { /* ... */ }

export async function dispatchAction(id: ActionId, ctx: DispatchContext): Promise<Response> {
  const { run, feedback } = resolveAction(id);
  if (ctx.source !== 'panel' && feedback === 'badge') return runTracked(id, ctx, run); // badge.ts 包装
  return run(ctx); // 侧边栏入口：结果走现有 progress/状态栏
}
// 不变式：本文件之下禁止 chrome.tabs.query({active:true})
```

### 1b. 右键菜单 + 快捷键 + 角标

1. `src/background/badge.ts`：`runTracked`（写 TaskRecord + setBadgeText({tabId})）、清除钩子（GET_STATUS / tabs.onActivated）。
2. `src/background/context-menus.ts`：`buildMenuSpecs(lang, trustedDomains)` 纯函数 + `registerMenus()`（removeAll+create）+ `onClicked` 进 dispatch；`webcopy.ts` 的菜单代码迁入删除。
3. 重建时机接线：`onInstalled` / `onStartup` / `onLanguageChanged` / `permissions.onAdded+onRemoved`。
4. `manifest.json` 加 `commands`（open-panel `Ctrl/Cmd+Shift+L`、page-md `Ctrl/Cmd+Shift+M`、screenshot `Ctrl/Cmd+Shift+S`、summarize 无默认键）；`index.ts` 加 `commands.onCommand` 进 dispatch。
5. summarize 动作：写 `NavigationIntent` 到 storage.session + `sidePanel.open({tabId})`；SummaryView 挂载/onChanged 消费意图自动开始。
6. i18n：`menu.*` 扩充（zh/en 同步）。

```ts
// context-menus.ts 菜单 spec（纯函数，单测断言各页面类型的集合）
export interface MenuSpec { id: ActionId; title: string; contexts: chrome.contextMenus.ContextType[]; parentId?: string; documentUrlPatterns?: string[]; }
export function buildMenuSpecs(t: Translate, trustedDomains: string[]): MenuSpec[] {
  const feishuPatterns = [...OFFICIAL_FEISHU_PATTERNS /* 公有云回退分支，见宪法 II */,
                          ...trustedDomains.map(d => `https://${d}/*`)];
  // 父菜单 LarkSnap → 通用组(page/selection) + 飞书组(documentUrlPatterns: feishuPatterns)
}
```

### 1c. 切图标行为 + 删 popup

1. `index.ts:70` 改 `setPanelBehavior({ openPanelOnActionClick: true })`。
2. `manifest.json` 删 `action.default_popup`；`vite.config.ts` 删 popup 入口；删 `popup.html`、`src/popup/`。
3. `src/sidepanel/HeaderStatus.tsx`：状态圆点（绿/灰/黄）+ 点击展开详情（daemonVersion、contextId 复制、protocolMismatch 提示），沿用 `MSG.GET_BRIDGE_STATUS` 2s 轮询（从 Popup.tsx 迁移）。

### 2. 侧边栏 home 重构

1. `SidePanel.tsx`：home 改为 Header（logo+状态点+设置+缓存库）→ ContextZone → ToolGroups → 状态栏 → Footer；删「免费」徽标（:284）与 quota-chip（:299-302）。
2. `ContextZone.tsx`：页面识别条 + 按 `classifyPage` 结果分支（feishu 四主按钮+StylePicker 行+缓存 / youtube 字幕卡+视频卡 / video 视频卡 / generic 识别条 / restricted 提示+置灰）。
3. `actions.ts`：加 `group` 字段，删 word/cacheList/diagnostic/feedback。
4. `ToolGroups.tsx`：WebCopyView 拆分为剪藏/截图/AI 总结/页面开关四个可折叠分组，折叠态读写 `larksnap:ui-prefs`。
5. `StylePicker.tsx`：小红书/公众号样式下拉直选（样式名+缩略预览，点选即发 `EXPORT_XHS`/`EXPORT_WECHAT`）。
6. `Footer.tsx`：反馈 · 诊断 · v{version}。
7. i18n 补齐分组/页脚/tooltip 文案。

### 3. 收尾

- 侧边栏未开时右键/快捷键反馈打磨（badge 时序、意图过期）；options 页加快捷键说明（指引 chrome://extensions/shortcuts）；README/store 描述更新。

## 测试步骤

```bash
npm test   # 三块纯逻辑：buildMenuSpecs 集合断言 / classifyPage / resolveAction 路由 + tabId 透传 stub
```

手测核心路径（每阶段构建后过一遍）：

1. **锁 tab 验收（第一标准）**：普通页右键"整页截图"后立刻切到另一个标签页 → 产物是原页面的截图。
2. 飞书页右键：MD/PDF/HTML 三项导出成功；"更多导出方式…"开侧边栏。
3. 快捷键三连：Cmd+Shift+L 开面板、Cmd+Shift+M 转 MD、Cmd+Shift+S 截图。
4. 侧边栏关闭时右键截图 → 绿"✓"角标 → 开侧边栏角标清除；构造失败（受限页触发）→ 红"!"→ 侧边栏可见失败原因。
5. 右键"AI 总结本页"（侧边栏未开）→ 侧边栏打开、定位总结卡、自动开始；未配置端点时显示引导。
6. 点工具栏图标直开侧边栏；状态点三色与详情正确。
7. 五类页面（飞书/YouTube/B站/普通/chrome://）上下文区各自正确、通用区常驻；折叠态跨会话保留。
8. 切换语言 → 右键菜单标题跟随；新授权私有化域 → 该域出现飞书菜单。

## 验收检查点

- [ ] `npm run typecheck` / `npm test` 全绿
- [ ] grep 确认 dispatch 之下无 `tabs.query({active:true})`（screenshot/summarize/webcopy/exporters）
- [ ] manifest 无 `default_popup`、有 4 个 commands；`src/popup/` 已删且构建通过
- [ ] 手测清单 1-8 全过（真机）
- [ ] 宪法自查：无新域名硬编码（`grep -rn "feishu.cn" src/` 仅公有云回退分支）、无新权限、无外发
- [ ] spec.md 的 SC-001~SC-008 逐条核对
