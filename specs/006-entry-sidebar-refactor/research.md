# Research: 交互入口与侧边栏布局重构

## 1. 工具栏图标直开侧边栏的实现方式

**问题**: 删除 popup 后，点图标开侧边栏用哪种机制。

**研究结果**: 现状 `index.ts:70` 显式 `setPanelBehavior({ openPanelOnActionClick: false })`，无 `action.onClicked` 监听，侧边栏由 popup 按钮 `chrome.sidePanel.open` 打开（`Popup.tsx:76`）。MV3 下 `openPanelOnActionClick: true` 时 Chrome 原生接管点击，`action.onClicked` 不再触发；自己监听 `onClicked` 再调 `sidePanel.open()` 也可行但依赖手势调用栈，且与 `default_popup` 互斥配置容易踩坑。

**Decision**: `setPanelBehavior({ openPanelOnActionClick: true })` + manifest 删 `action.default_popup`，不监听 `action.onClicked`。

**Rationale**: 浏览器原生行为，零竞态、零手势问题；星炼/Monica 均为此路线。

**Alternatives considered**:
- `action.onClicked` + `sidePanel.open()`：多一层自管逻辑无收益，排除。
- popup 改造成启动菜单（AI Chat for Search 形态）：spec 澄清已拍板彻底删除，排除。

## 2. 右键菜单的飞书域匹配与重建时机

**问题**: 飞书菜单项 `documentUrlPatterns` 如何覆盖官方域 + 私有化域，授权变更后如何刷新（宪法 II 禁止硬编码域名为唯一目标）。

**研究结果**: manifest `host_permissions` 已含 `*.feishu.cn/*.feishu.net/*.larksuite.com`；私有化域授权后写入 `config.trustedDomains`（`storage.ts:122`）。现无 `permissions.onAdded/onRemoved` 监听（全库 grep 零命中）；现有菜单重建时机为 `onInstalled`/`onStartup`/语言切换（`webcopy.ts:65-69`）。

**Decision**: 菜单 spec 生成函数 `buildMenuSpecs(lang, trustedDomains)` 纯函数化；`documentUrlPatterns` = 三个官方域 pattern（作为"公有云回退分支"注释标注）+ `trustedDomains` 映射的 `https://<domain>/*`。重建时机四个：`onInstalled` / `onStartup` / `onLanguageChanged` / `chrome.permissions.onAdded+onRemoved`（新增监听，同时兜底覆盖 UI 侧授权与用户在 chrome://extensions 手动改权限两条路径）。

**Rationale**: 纯函数可单测（spec 的 SC-008）；`permissions.onAdded` 是唯一能捕获"用户在浏览器设置页手动授权"的信号。

**Alternatives considered**:
- 只在 `REQUEST_PERMISSION` 消息处理点重建：漏掉浏览器设置页手动变更，排除。
- 每次 `onClicked` 时动态判断 URL 而菜单全域显示：飞书菜单项会污染所有网页右键，排除。

## 3. "AI 总结"导航意图的传递通道

**问题**: 右键/快捷键触发总结时侧边栏可能未打开或正在加载，意图如何不丢（评审意见 2）。

**研究结果**: `summarizePage()` 的结果只存在 `SummaryView` 组件状态里，`needsAck` 授权确认也依赖 UI（`SummaryView.tsx:53-92`）。若 background 直接执行，结果无承载。`chrome.storage.session` 在 MV3 SW 与扩展页间共享，浏览器关闭自动清空，默认访问级别 `TRUSTED_CONTEXTS`（sidepanel 属于），无需 `setAccessLevel`。

**Decision**: 定义 `NavigationIntent` 写入 `storage.session`（键 `larksnap:intent`），随后 `sidePanel.open({ tabId })`。侧边栏挂载时读取并消费（读到即删，一次性）；已打开的侧边栏靠 `storage.onChanged` 监听即时响应。总结本体仍由 SummaryView 调 `SUMMARIZE_PAGE` 执行，携带意图中的 `tabId/url`。

**Rationale**: storage 通道天然消除"侧边栏还没建立消息监听"的竞态；session 存储生命周期与会话对齐，不留脏数据。

**Alternatives considered**:
- `runtime.sendMessage` 广播：侧边栏加载完成前发出即丢失，正是要消除的竞态，排除。
- 后台直接跑总结再缓存结果：绕不开 needsAck 授权 UI，且结果承载复杂，评审已否决。

## 4. 角标与任务记录的实现

**问题**: badge 如何做到按 tab 隔离、清除时机、失败详情可查（spec FR-011）。

**研究结果**: 现有代码从未用过 `chrome.action.setBadgeText`（grep 零命中）。该 API 原生支持 `{ tabId }` 参数——badge 按标签页显示，标签页关闭自动消失，天然满足"按 tab 隔离"。

**Decision**: 新模块 `badge.ts`：任务结束时 `setBadgeText({ tabId, text: '✓'|'!' })` + `setBadgeBackgroundColor`（绿 `#22c55e` / 红 `#ef4444`）；任务记录 `TaskRecord[]` 按 tabId 分键写 `storage.session`（键 `larksnap:tasks:<tabId>`，每 tab 保留最近 10 条）。清除：侧边栏打开（`GET_STATUS` 时顺带清当前 tab badge）或 `tabs.onActivated` 切到该 tab 时清。同 tab 并发：badge 后写覆盖，记录追加各自保留。

**Rationale**: 原生 per-tab badge 把隔离和 tab 关闭清理都交给浏览器；`storage.session` 让 SW 休眠后记录仍在、浏览器重启自动清。

**Alternatives considered**:
- `chrome.notifications`：要新增权限、打扰性强，计划已定案排除。
- 记录存 `storage.local`：需要自己做过期清理，排除。

## 5. tabId 显式传递的改造范围

**问题**: 哪些底层函数在自查"当前活动页"，必须改为收参（评审意见 1，阻断项）。

**研究结果**: 自查点有四处——`exporters/screenshot.ts:22`（`tabs.query({active:true})`）、`summarize/index.ts:144`（`getActiveTab()`）、`doc-detect.ts:8-11`（`getActiveTab` → `detectActiveDoc`，飞书导出全链路依赖）、`webcopy.ts` 菜单 handler（本就有 `tab` 参数但转换函数内部另有查询）。飞书导出器内部取数走 `feishu-proxy.ts` 的 `_contentTabId`，由 `setContentTab` 维护。

**Decision**: 签名改造：`exportScreenshot(format, tabId)`、`summarizePage({ tabId, url })`、新增 `detectDocForTab(tabId)`（`detectActiveDoc()` 保留为"查活动页再调它"的壳，仅供侧边栏 GET_STATUS 等只读场景）、webcopy 转换函数统一收 `tabId`。`dispatchAction` 是唯一允许"tab 未知时查活动页"的地方（侧边栏按钮入口），右键/快捷键入口直接用事件携带的 `tab.id/url`。dispatch 成功识别飞书文档后调 `setContentTab(tabId)`，保证导出器内部取数同 tab。

**Rationale**: "查活动页"收敛到分发层一处，之下全部显式传参——这是分发层的第一验收标准，可用单测锁住（mock chrome.tabs.query 断言未被下层调用）。

**Alternatives considered**:
- 只改右键/快捷键新入口、侧边栏路径不动：同一函数两套取 tab 逻辑，回归风险更高，排除。

## 6. pageKind 模型扩展

**问题**: 方案单列"视频站点"上下文，但 `PageKind = 'feishu'|'youtube'|'generic'|'restricted'`（types.ts:387）没有此类型（评审意见 3）。

**研究结果**: 视频站点识别已有现成实现：`video.ts` 的 `matchSite(url)` 命中 `VIDEO_SITES`（constants.ts:145-150，bilibili/douyin/tiktok/youtube）。youtube 同时是"字幕页"和"视频站点"，需保持 youtube 优先级高于 video。

**Decision**: `PageKind` 增 `'video'`；`PageKindInfo` 扩展为 `{ kind, url?, title?, videoSite? }`。分类逻辑收敛到新纯函数 `classifyPage(url): PageKindInfo`（`src/shared/page-kind.ts`），判定顺序：restricted（非 http/https）→ feishu（现有双信号识别）→ youtube → video（matchSite 命中且非 youtube）→ generic。

**Rationale**: 保守扩展枚举而非重构结构，UI 按 kind switch 的现有代码改动最小；纯函数满足 SC-008 单测要求。

**Alternatives considered**:
- 改为 `{kind, videoSite?}` 复合结构、youtube 并入 video：youtube 上下文区（字幕卡）与一般视频站（仅下载卡）渲染差异大，合并后 UI 又要二次分支，无净收益，排除。

## 7. 快捷键 commands 设计

**问题**: 4 个 command 的键位与冲突。

**研究结果**: Chrome 每扩展最多 4 个 `suggested_key`。Cmd+Shift+S 在 macOS 与部分应用冲突但浏览器内可用；Chrome 遇系统级冲突会静默不绑定，用户可在 chrome://extensions/shortcuts 自调。

**Decision**: manifest `commands`：`open-panel`（Ctrl/Cmd+Shift+L）、`page-md`（Ctrl/Cmd+Shift+M）、`screenshot`（Ctrl/Cmd+Shift+S）、`summarize`（无默认键）。`commands.onCommand` 里取 `tabs.query({active:true,currentWindow:true})` 一次性捕获 tab 后进 dispatch（onCommand 回调本身带 tab 参数，优先用它）。`open-panel` 走 `_execute_action`？——不采用：`_execute_action` 名额之外仍要自管三个动作命令，统一自定义命令名更一致；`open-panel` 在 onCommand 中调 `sidePanel.open({ tabId })`（commands 事件属用户手势，允许调用）。

**Rationale**: 键位与计划文档一致；正好用满 3 个默认键 + 1 个留白。

**Alternatives considered**:
- `_execute_action` 承载开面板：行为随 panelBehavior 变化而隐式变化，语义不如显式命令清晰，排除。

## 8. 折叠态与界面偏好存储

**问题**: 通用工具分组折叠态存哪、结构如何。

**研究结果**: 现有 config 走 `STORAGE_KEYS.CONFIG`（storage.local），由 options/侧边栏共同读写；折叠态属 UI 偏好，塞进 config 会触发 config 的 storage.onChanged 联动（如语言重建菜单）造成无谓 churn。

**Decision**: 独立键 `larksnap:ui-prefs`（storage.local），结构 `{ collapsedGroups: Record<GroupId, boolean> }`，默认 `webcopy` 展开、`screenshot`/`summary`/`pageToggles` 折叠（澄清已拍板）。

**Rationale**: 与 config 解耦，写入频繁也不惊动其他监听者。

**Alternatives considered**:
- 并入 ExtensionConfig：见上，排除。
- storage.session：折叠偏好应跨会话保留，排除。

## 9. 单元测试策略

**问题**: SC-008 要求菜单生成、页面分类、动作分发三块有单测；SW 代码充满 chrome API 如何测。

**研究结果**: vitest 4 已配置（`src/**/*.test.ts`），现仅 i18n 一个测试文件，无 chrome mock 基建。

**Decision**: 不引入 `sinon-chrome` 等 mock 库；靠"纯逻辑与 chrome 调用分离"的模块设计——`buildMenuSpecs(lang, trustedDomains)` 返回菜单描述数组、`classifyPage(url)` 返回 PageKindInfo、`resolveAction(actionId)` 返回处理器路由描述，三者均为无 chrome 依赖的纯函数直接断言；dispatch 的 tabId 透传用最小手写 stub（`globalThis.chrome = {...}` 局部注入）验证"下层未调用 tabs.query"。

**Rationale**: 零新依赖（宪法技术栈约束）；纯函数测试稳定不脆。

**Alternatives considered**:
- 引入 chrome mock 库：新依赖 + 维护成本，测试价值集中在纯逻辑处，排除。
