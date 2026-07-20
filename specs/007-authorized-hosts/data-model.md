# Data Model: 已授权域名清单（新建文档免喂链接）

## 消息流图

### 链路一：授权时记录真实 origin（方案 A 的写入侧）

```text
用户在侧边栏点「授权该域名」（用户手势）
  │ chrome.permissions.request({origins:[pattern]}) 成功
  ▼
SidePanel.tsx ──MSG.REQUEST_PERMISSION {pattern, origin}──▶ SW(index.ts)
  │                                                          │
  │                                          recordTrusted(pattern)           → config.trustedDomains
  │                                          recordTrustedOrigin(base,origin) → config.trustedOrigins
  ▼
撤销：Options.tsx ──MSG.REVOKE_PERMISSION {pattern}──▶ SW
                                             revokePermission(pattern)
                                             + removeTrustedOrigin(baseFromPattern(pattern))
```

### 链路二：CLI 取清单 / new-doc 免链接（读取侧）

```text
CLI edit.mjs (hosts / new-doc 无链接)
  │ ensureDaemon() → GET /hosts?profile=<code>
  │   头: x-larksnap: 1
  │       x-larksnap-sig: makeSigHeader(secret, 'GET', '/hosts', '')
  ▼
daemon.mjs  验签 → resolveConn(profile) → 检查 conn._proto >= 4
  │ WS: { type:'list-domains', id }          （pendingHosts.set(id, {res, timer:10s}）
  ▼
扩展 bridge.ts onMessage
  │ buildDomainList():
  │   builtin = FEISHU_HOSTS
  │   trusted = listTrusted() 过 baseFromPattern() 过滤+剥基础域
  │   每项 sampleUrl: trustedOrigins[base] → chrome.tabs.query 命中标签 origin → null
  ▼ WS: { type:'domains-result', id, domains }
daemon  pendingHosts 取出 → HTTP 200 { ok:true, domains } → CLI
  │
  ▼ CLI new-doc 分支：选域名 → url = sampleUrl + '/drive/me/' → 走原有 POST /command kind='edit' op='new-doc'
```

## TypeScript 类型定义

### `src/shared/types.ts` — ExtensionConfig 增字段

```ts
export interface ExtensionConfig {
  // …现有字段不动…
  /** 已运行时授权的私有化域名 origin 列表（如 https://x.私有化租户.com） */
  trustedDomains: string[];
  /**
   * 授权时刻记下的真实租户 origin（新建文档定位用）。
   * 键 = 基础域（与 trustedDomains 的 pattern 对齐），值 = 'https://<真实租户 host>'。
   * 随授权写入、随撤销删除；老授权没有此记录 → 走已打开标签兜底。
   */
  trustedOrigins?: Record<string, string>;
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `trustedOrigins` | `Record<string, string>` | 可选（老配置无此字段） | 键：基础域；值：完整 origin（含协议，无路径） |

### `src/background/domain-list.ts` — 清单条目

```ts
/** 域名清单条目（扩展 → daemon → CLI 原样透传） */
export interface DomainEntry {
  /** 基础域（如 a.example.com），不是 pattern */
  host: string;
  /** builtin = manifest 内置公有云；trusted = 用户手势授权的私有域名 */
  kind: 'builtin' | 'trusted';
  /** 能建文档的真实租户 origin（https://tenant.a.example.com），解析不出为 null */
  sampleUrl: string | null;
}

/** 纯函数：'*://*.a.example.com/*' → 'a.example.com'；非此形状（AI 端点 'https://x/*' 等）→ null */
export function baseFromPattern(pattern: string): string | null;

/** builtin + trusted 归一化，逐项按 A→B→null 解析 sampleUrl */
export async function buildDomainList(): Promise<DomainEntry[]>;
```

## 消息契约表

### 扩展内部消息（`MSG`，无新增常量，只扩 payload）

| 消息 | 方向 | payload 变更 | response |
|---|---|---|---|
| `MSG.REQUEST_PERMISSION` | sidepanel/options → SW | `{ pattern: string, origin?: string }`（**新增可选 origin**；仅侧边栏飞书文档页分支传） | `{ success: true }`（不变） |
| `MSG.REVOKE_PERMISSION` | options → SW | 不变 `{ pattern }`；SW 内部多做一步 removeTrustedOrigin | 不变 |

### 桥接 WS 消息（daemon ⇄ 扩展，协议 v4 新增）

| 消息 | 方向 | 字段 | 说明 |
|---|---|---|---|
| `list-domains` | daemon → 扩展 | `{ type:'list-domains', id: string }` | 无 url，独立于 `type:'job'` |
| `domains-result` | 扩展 → daemon | `{ type:'domains-result', id: string, domains: DomainEntry[] }` | daemon 按 id 从 pendingHosts 取出回 HTTP |

### daemon HTTP 契约（新增端点）

| 项 | 值 |
|---|---|
| 请求 | `GET /hosts?profile=<code>`（profile 可选） |
| 头 | `x-larksnap: 1` + `x-larksnap-sig: makeSigHeader(secret,'GET','/hosts','')`（签名只覆盖 pathname，query 不参与——daemon 验签前已剥 query） |
| 成功响应 | `200 application/json`：`{ "ok": true, "domains": DomainEntry[] }` |
| 业务错误 | `200`：`{ "ok": false, "error": { "subtype": "...", "message": "..." } }`，subtype ∈ `extension_not_connected` / `profile_not_found` / `profile_ambiguous` / `extension_outdated` / `extension_timeout` |
| 鉴权失败 | 无 auth 头 `403`；验签失败 `401 { ok:false, error:'bad signature' }`（沿用非 /command 端点现行为） |

### CLI 契约（edit.mjs）

| 命令 | 行为 | stdout |
|---|---|---|
| `edit.mjs hosts [--profile <code>]` | 打印清单 | `{ "ok": true, "domains": [...] }` |
| `edit.mjs new-doc [<md文件>] --name "<标题>" [--host <域名>] [--profile <code>]` | 免链接建档：取清单 → 选域名 → `sampleUrl + '/drive/me/'` → 原有 new-doc 链路 | 不变（`{ ok:true, url, message }`） |
| `edit.mjs new-doc <URL> …`（旧用法） | 完全不变 | 不变 |

CLI 新增错误 subtype（stderr 最后一行 JSON，退出码沿用派生规则）：

| subtype | 触发 | 退出码 | hint 要点 |
|---|---|---|---|
| `host_ambiguous` | 多域名且未带 `--host` | 2 | 附完整 domains 清单，提示加 `--host` |
| `host_not_authorized` | `--host` 匹配不到清单（或后缀简写多义） | 4 | 附清单；提示改写法或去浏览器授权该域名 |
| `need_landing_url` | 选中域名 `sampleUrl: null` | 2 | 提示本次喂一个该域名下的链接，或先在浏览器打开一个该域名页面 |
| `extension_timeout` | daemon 等扩展回包超时 | 5 | 点扩展图标唤醒 SW 后重试 |

（现有 `extension_outdated` / `profile_ambiguous` / `profile_not_found` / `extension_not_connected` 沿用 `client.mjs` 的 ERROR_KINDS 与退出码。）

## chrome.storage schema

| 键 | 类别 | 变更 |
|---|---|---|
| `larksnap:config`（`STORAGE_KEYS.CONFIG`） | config | 值内新增可选 `trustedOrigins` 字段（见类型定义）。**不新增顶层键**，无迁移——老配置读到 `undefined` 按空 map 处理 |

## 权限 / manifest 变更

无。`tabs`（B 兜底 query 用）、`storage` 均已有；不新增 host 权限。

## 协议版本

| 常量 | 现值 | 新值 | 位置 |
|---|---|---|---|
| `PROTOCOL_VERSION`（扩展） | 3 | 4 | `src/background/bridge.ts:43` |
| `PROTOCOL_VERSION`（daemon） | 3 | 4 | `skills/larksnap-fetch/scripts/bridge/protocol.mjs:21` |
| `DAEMON_VERSION` | 1.5.2 | 1.6.0 | 同上文件（CLI 版本自愈会自动重启旧 daemon） |

v4 语义：daemon 可发 `list-domains`、扩展回 `domains-result`。daemon `/hosts` 对 `_proto < 4` 的连接回 `extension_outdated`。
