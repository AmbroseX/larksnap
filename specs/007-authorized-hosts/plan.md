# Implementation Plan: 已授权域名清单（新建文档免喂链接）

**Branch**: `007-authorized-hosts` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

> 技术方案以 docs/plans/2026-07-16-已授权域名清单接口.md（已两轮评审）为准，本 plan 把它落到具体文件与契约。

## Summary

让 `new-doc` 不用每次喂一个"该域名下的链接"。数据源复用扩展已有的授权状态（`trustedDomains` + manifest 内置域名），新增一条**扩展 → daemon → CLI 的只读链路**：扩展加 `list-domains` 消息分支拼域名清单，daemon 加 `GET /hosts` 只读端点，CLI 加 `hosts` 命令并放宽 `new-doc` 的 URL 参数。关键地基：授权那一刻顺手把用户所在页面的真实租户 origin 记进存储（方案 A），拼不出时用当前已打开标签兜底（方案 B），都没有就让用户本次喂一个链接（优雅降级）。

## Technical Context

**语言/构建**: TypeScript 5.5 + Vite 5 + @vitejs/plugin-react（扩展侧）；Node.js 零依赖 ESM（daemon / CLI 侧）
**运行上下文**: Service Worker（bridge / permissions / storage）、sidepanel（授权手势时补传 origin）、daemon（本机 HTTP+WS 撮合器）、CLI（edit.mjs）。**不涉及** content script / offscreen——不碰 `createEmptyDoc` 的建文档逻辑。
**通道归属**: 桥接通道（CC ⇄ daemon ⇄ 扩展），与飞书导出通道、通用网页通道解耦；只新增只读消息，不改任何导出/编辑引擎。
**新增依赖**: 无，仅用现有依赖。
**存储**: `chrome.storage.local` 的 config 类——`ExtensionConfig` 新增可选字段 `trustedOrigins: Record<基础域, origin>`，与 `trustedDomains` 同生命周期（授权时写、撤销时删），不新增 `STORAGE_KEYS` 键。
**权限/域名**: 不新增任何 manifest 权限（`tabs` 已有，B 兜底的 `chrome.tabs.query` 够用）。内置域名来自现有常量 `FEISHU_HOSTS`（`src/shared/constants.ts:172`），不新增硬编码。
**测试**: vitest 单测覆盖纯函数——pattern 解析基础域（`*://*.x.com/*` → `x.com`，非此形状返回 null）、清单合成与 sampleUrl 优先级、CLI 侧 `--host` 匹配（精确 → 唯一后缀）。桥接链路、真实建文档只能真机手测（见 quickstart 手测清单）。
**性能/约束**: `list-domains` 是一次性只读查询，无并发/重试需求；daemon 侧等扩展回包设 10s 超时防挂死。协议版本 v3 → v4，旧扩展/旧 daemon 按 `extension_outdated` / 版本自愈降级。

## Constitution Check

| 原则 | 本计划遵循方式 | 结果 |
|------|---------------|------|
| I. 零配置认证 | 不新增任何认证路径；建文档仍在页面上下文跑（`createEmptyDoc` 原样不动），SW 不 fetch 飞书内部接口 | ✅ |
| II. 域名不写死 | 内置域名引用现有常量 `FEISHU_HOSTS`；私有域名从 `listTrusted()` 的 pattern 动态剥出；landing URL 用真实 origin，不硬拼 | ✅ |
| III. 导出可靠/状态可恢复 | 本功能是一次性只读查询，无长任务状态；所有失败路径有明确 subtype，不静默失败 | ✅ |
| IV. 高质量 Markdown 双路取数 | 不涉及取数路径，无影响 | ✅ |
| V. 隐私不外发 | 域名清单只在本机流转（扩展 → 127.0.0.1 daemon → 本机 CLI），不经任何第三方；trustedOrigins 只存 origin 字符串，无 PII | ✅ |
| VI. 合规告知 | 不涉及 P-decode/绕过导出限制 | ✅ |

**Constitution Check Result**: ✅ 通过

## Project Structure

### Documentation (this feature)

```text
specs/007-authorized-hosts/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
└── quickstart.md
```

### Source Code (repository root)

**新增**

| 文件 | 职责 |
|---|---|
| `src/background/domain-list.ts` | 纯逻辑 + 编排：`baseFromPattern()`（pattern → 基础域，纯函数）、`buildDomainList()`（builtin + trusted 归一化，按 A→B→null 解析每项 sampleUrl，B 用 `chrome.tabs.query`） |
| `src/background/domain-list.test.ts` | vitest：pattern 解析（含 AI 端点 `https://x/*` 形状要被过滤）、清单合成与 sampleUrl 优先级（tabs/storage 注入 mock） |

**改动**

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `ExtensionConfig` 增可选字段 `trustedOrigins?: Record<string, string>` |
| `src/shared/storage.ts` | 增 `getTrustedOrigins` / `recordTrustedOrigin(base, origin)` / `removeTrustedOrigin(base)`（读写 config.trustedOrigins） |
| `src/background/permissions.ts` | `recordTrusted` 旁支持顺手记 origin；`revokePermission` 里按 pattern 剥基础域一并删 `trustedOrigins` 对应 key |
| `src/background/index.ts` | `MSG.REQUEST_PERMISSION` 分支：payload 增可选 `origin`，有值且 pattern 为飞书通配形状时 `recordTrustedOrigin` |
| `src/sidepanel/SidePanel.tsx` | 授权成功后 `sendToBackground(MSG.REQUEST_PERMISSION, { pattern, origin: originOf(doc.url) })`（仅飞书文档页分支） |
| `src/background/bridge.ts` | onMessage 增 `list-domains` 分支（job 分支之前）：调 `buildDomainList` 回 `domains-result`；`PROTOCOL_VERSION` 3 → 4 |
| `skills/larksnap-fetch/scripts/bridge/protocol.mjs` | `PROTOCOL_VERSION` 3 → 4；`DAEMON_VERSION` 1.5.2 → 1.6.0（触发 CLI 版本自愈重启旧 daemon） |
| `skills/larksnap-fetch/scripts/bridge/daemon.mjs` | 新增 `GET /hosts?profile=` 只读端点：验签（GET + `/hosts` + 空 body）→ `resolveConn(profile)` → 检查 `_proto >= 4` → 发 `list-domains` → 等 `domains-result`（10s 超时）→ 回 JSON。WS onMessage 增 `domains-result` 路由（走独立 pendingHosts，不进 NDJSON 流） |
| `skills/larksnap-fetch/scripts/bridge/client.mjs` | 增 `getHosts(profile, failFn)`：GET `/hosts` 带 `AUTH_HEADER` + `SIG_HEADER`（method=GET、body 空），解析 JSON、错误按 ERROR_KINDS 收口 |
| `skills/larksnap-fetch/scripts/edit.mjs` | ① 新增 `hosts` 命令（无 URL，只读打印清单）；② `new-doc` 放宽第一参数：非 URL 时走"取清单 → 选域名 → sampleUrl 拼 `/drive/me/`"逻辑；③ 新旗标 `--host`（仅 new-doc 可用，其他操作显式拒绝）；④ 新错误 subtype：`host_not_authorized` / `host_ambiguous` / `need_landing_url` |
| `skills/larksnap-fetch/SKILL.md` | new-doc 免链接用法、私有域名比公有云稳的说明、`my.feishu.cn` 已知限制、bump 后需重建扩展提示 |

**Structure Decision**: 清单合成逻辑独立成 `domain-list.ts` 而不塞进 `bridge.ts`——bridge.ts 已 637 行且职责是连接管理/任务分发，纯逻辑抽出后才能被 vitest 覆盖（pattern 解析、优先级排序都是纯函数）。daemon 侧走独立只读端点而非复用 `/command`，是评审已定结论（`/command` 三层 url 校验都是为带 URL 任务设计的）。

## Complexity Tracking

无。零新依赖、零新 manifest 权限、零新 STORAGE_KEYS 键；不做别名/默认域名/独立配置文件（见 spec 非目标）。
