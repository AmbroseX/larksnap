# Quickstart: 已授权域名清单（新建文档免喂链接）

## 前置条件

- 无新增 npm 依赖、无 manifest 权限变更——`npm install` 现状即可。
- 真机手测需要：Chrome 里已加载 dist/ 扩展；至少一个**私有化飞书域名**可授权（核心场景），公有云账号用于对照。
- daemon / CLI 是零依赖 Node ESM，改完即生效（CLI 每次跑会按 `DAEMON_VERSION` 自愈重启 daemon）。

## 开发环境

```bash
npm run dev          # vite watch 构建到 dist/
# Chrome → chrome://extensions → 开发者模式 → 加载 dist/
# 每次改扩展代码后：chrome://extensions 点「重新加载」，再点一下扩展图标唤醒 SW
npm run typecheck && npm run test    # 提交前必过（宪法治理规则）
```

⚠️ 本次 bump 协议版本到 v4：改完 `bridge.ts` 后**必须重新构建并重载扩展**，否则 daemon 会对旧扩展回 `extension_outdated`（这正是预期降级行为，也是手测项之一）。

## 开发顺序（与 tasks.md 对齐）

1. **类型与存储**：`types.ts` 加 `trustedOrigins` → `storage.ts` 三个函数 → `permissions.ts` / `index.ts` / `SidePanel.tsx` 接上写入与清理
2. **扩展清单合成**：`domain-list.ts`（纯函数先行，配单测）→ `bridge.ts` 加 `list-domains` 分支 + PROTOCOL_VERSION=4
3. **daemon**：`protocol.mjs` bump 两个版本号 → `daemon.mjs` 加 `GET /hosts`
4. **CLI**：`client.mjs` 加 `getHosts` → `edit.mjs` 加 `hosts` 命令 + new-doc 免链接分支
5. **SKILL.md** 文档 → 手测

## 关键代码骨架

### 1) `src/background/domain-list.ts`

```ts
import { FEISHU_HOSTS } from '../shared/constants';
import { getTrustedOrigins } from '../shared/storage';
import { listTrusted } from './permissions';

export interface DomainEntry {
  host: string;
  kind: 'builtin' | 'trusted';
  sampleUrl: string | null;
}

/** '*://*.a.example.com/*' → 'a.example.com'；其他形状（AI 端点 'https://x/*'）→ null */
export function baseFromPattern(pattern: string): string | null {
  const m = /^\*:\/\/\*\.([^/*]+)\/\*$/.exec(pattern);
  return m ? m[1] : null;
}

export async function buildDomainList(): Promise<DomainEntry[]> {
  const origins = await getTrustedOrigins();
  const trustedBases = (await listTrusted())
    .map(baseFromPattern)
    .filter((b): b is string => !!b);
  const tabs = await chrome.tabs.query({});
  const resolve = (base: string): string | null => {
    if (origins[base]) return origins[base]; // A：授权时记的真实 origin
    for (const t of tabs) {                  // B：已打开标签兜底
      try {
        const u = new URL(t.url || '');
        if (u.host === base || u.host.endsWith(`.${base}`)) return u.origin;
      } catch { /* 忽略坏 URL */ }
    }
    return null;
  };
  return [
    ...FEISHU_HOSTS.map((h) => ({ host: h, kind: 'builtin' as const, sampleUrl: resolve(h) })),
    ...trustedBases.map((h) => ({ host: h, kind: 'trusted' as const, sampleUrl: resolve(h) })),
  ];
}
```

### 2) `src/background/bridge.ts` — onMessage 里 job 分支之前

```ts
if (msg.type === 'list-domains' && msg.id) {
  const id = msg.id;
  try {
    reply(id, { type: 'domains-result', domains: await buildDomainList() });
  } catch (err) {
    reply(id, { type: 'domains-result', domains: [], error: err instanceof Error ? err.message : String(err) });
  }
  return;
}
```

### 3) `daemon.mjs` — GET /hosts（验签之后、/status 旁边）

```js
const pendingHosts = new Map(); // id -> { res, timer, contextId }

if (req.method === 'GET' && pathname === '/hosts') {
  const profile = new URL(req.url, 'http://x').searchParams.get('profile') || undefined;
  const routed = resolveConn(profile);
  const jsonErr = (subtype, message) =>
    res.writeHead(200, { 'content-type': 'application/json' })
       .end(JSON.stringify({ ok: false, error: { subtype, message } }));
  if (routed.error) return jsonErr(routed.subtype, routed.error);
  if ((routed.conn._proto ?? 0) < 4)
    return jsonErr('extension_outdated', `扩展协议版本过旧（v${routed.conn._proto ?? '?'}），不支持域名清单。`);
  const id = `h${++jobSeq}`;
  const timer = setTimeout(() => {
    pendingHosts.delete(id);
    jsonErr('extension_timeout', '等待扩展回包超时（Service Worker 休眠？点图标唤醒后重试）。');
  }, 10_000);
  pendingHosts.set(id, { res, timer, contextId: routed.conn._contextId });
  routed.conn.send(JSON.stringify({ type: 'list-domains', id }));
  return;
}

// WS onMessage 里，通用业务分支之前：
if (msg.type === 'domains-result') {
  const entry = pendingHosts.get(msg.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingHosts.delete(msg.id);
  entry.res.writeHead(200, { 'content-type': 'application/json' })
       .end(JSON.stringify({ ok: true, domains: msg.domains || [] }));
  return;
}
// conn.on('close') 里同 contextId 的 pendingHosts 条目也要收尾（回 extension_not_connected）
```

### 4) `client.mjs` — GET 签名调用

```js
export function getHosts(profile, failFn) {
  return new Promise((resolve) => {
    const qs = profile ? `?profile=${encodeURIComponent(profile)}` : '';
    const req = http.get(
      {
        host: HOST, port: PORT, path: `/hosts${qs}`,
        headers: {
          [AUTH_HEADER]: '1',
          // 签名只覆盖 pathname（daemon 验签前剥 query），method=GET、body 空
          [SIG_HEADER]: makeSigHeader(getSecret(), 'GET', '/hosts', ''),
        },
      },
      (res) => { /* 聚合 body → JSON.parse → resolve；非 JSON / ok:false 走 failFn 按 subtype 收口 */ }
    );
    req.on('error', (e) => failFn({ type: 'bridge', subtype: 'bridge_request_failed', message: `请求 daemon 失败: ${e.message}`, retryable: true }));
  });
}
```

### 5) `edit.mjs` — new-doc 免链接分支（参数解析后、main 里）

```js
// 参数放宽：positionals[0] 不是 http(s) → 视为省略了 URL（仅 new-doc 允许）
// hosts 命令：node edit.mjs hosts [--profile <code>]
if (op === 'new-doc' && !url) {
  await ensureDaemon(DAEMON_PATH, fail);
  const { domains } = await getHosts(flags['--profile'], fail);
  let picked;
  if (flags['--host']) {
    const exact = domains.filter((d) => d.host === flags['--host']);
    const suffix = exact.length ? exact : domains.filter((d) => d.host.endsWith(flags['--host']) || d.host === flags['--host']);
    if (suffix.length !== 1)
      fail({ type: 'usage', subtype: suffix.length ? 'host_ambiguous' : 'host_not_authorized',
             message: `--host ${flags['--host']} ${suffix.length ? '匹配到多个域名' : '不在已授权清单中'}`,
             hint: `可选: ${domains.map((d) => d.host).join(', ')}；未授权的域名请先在浏览器侧边栏授权。` });
    picked = suffix[0];
  } else if (domains.length === 1) {
    picked = domains[0];
  } else {
    fail({ type: 'usage', subtype: 'host_ambiguous',
           message: `有 ${domains.length} 个已授权域名，请用 --host 指定其一`,
           hint: `可选: ${domains.map((d) => d.host).join(', ')}` });
  }
  if (!picked.sampleUrl)
    fail({ type: 'edit', subtype: 'need_landing_url',
           message: `域名 ${picked.host} 下没有已记录的租户入口，也没开着相关标签页。`,
           hint: '这一次请喂一个该域名下的文档/网盘链接（旧用法），或先在浏览器打开一个该域名页面后重试。' });
  url = `${picked.sampleUrl}/drive/me/`;
}
```

## 测试

### 单测（vitest，`npm run test`）

- `baseFromPattern`：`*://*.a.example.com/*` → `a.example.com`；`https://api.x.com/*` → null；`*://*/*` → null
- `buildDomainList` 优先级（mock storage/tabs）：A 命中不查 tabs；A 空 B 命中取标签 origin；都空 → null；AI 端点 pattern 被过滤
- CLI `--host` 匹配逻辑若抽成纯函数一并覆盖：精确 > 唯一后缀 > 多义报错

### 真机手测清单（按风险排序，源计划 §五 第 6 条）

1. **【最高风险先测】合成 URL 能建文档**：私有域名重新授权一次（写入 trustedOrigins）→ `edit.mjs new-doc 内容.md --name t --host <域名>` → 真能开页、注入、建出文档
2. **B 兜底**：清掉该域名 trustedOrigins（设置页撤销再仅 `chrome.permissions.request` 或直接改 storage）、只开一个该域名标签 → `hosts` 仍给出 sampleUrl 且建档成功
3. **降级**：无记录无标签 → 报 `need_landing_url`（不静默）
4. 单域名免 `--host` 一次；多域名带 `--host`（含后缀简写）一次；多域名不带 → `host_ambiguous`
5. 多 profile：带 `--profile` 一次；不带 → `profile_ambiguous`
6. 撤销授权 → `hosts` 清单消失 + `trustedOrigins` 无残留（chrome.storage 里看）
7. 旧扩展（不重载、daemon 已新）→ `extension_outdated`；旧用法喂 URL → 行为不变
8. AI 端点已配置的浏览器 → `hosts` 清单里**不出现** AI 端点域名

## 验收检查点（对齐 spec Success Criteria）

- [ ] SC-001 私有域名授权后建档零链接（手测 1）
- [ ] SC-002 多域名仅需 `--host`（手测 4）
- [ ] SC-003 授权/撤销与清单 100% 同步、零残留（手测 6）
- [ ] SC-004 六类失败路径全部有明确提示（手测 3/4/5/7）
- [ ] SC-005 旧用法回归无变化（手测 7）
- [ ] `npm run typecheck` + `npm run test` + `npm run build` 全绿（宪法治理规则）
- [ ] **用户真机验证通过并明确要求后才 commit**（CLAUDE.md / memory 规矩）
