# Tasks: 已授权域名清单（新建文档免喂链接）

**Input**: Design documents from `/specs/007-authorized-hosts/`
**Prerequisites**: plan.md, spec.md, data-model.md, quickstart.md

**Tests**: 规格未强制要求测试；对可单测的纯逻辑（pattern 解析、清单合成优先级）补 vitest 用例，桥接链路与建文档真机手测。

**Organization**: 任务按用户故事分组。实现顺序上 US2（查看清单）先于 US1（免链接建档）——清单命令是验证整条 扩展→daemon→CLI 链路的最短观测点，US1 在它之上只加"选域名 + 合成 URL"。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行执行（不同文件，无依赖）
- **[Story]**: 所属用户故事（US1 免链接建档 / US2 查看清单 / US3 多域名选择 / US4 多 profile）

## Path Conventions

- 扩展共享层：`src/shared/`；SW 层：`src/background/`；UI 层：`src/sidepanel/`
- daemon / CLI（随技能分发）：`skills/larksnap-fetch/scripts/bridge/`、`skills/larksnap-fetch/scripts/edit.mjs`

---

## Phase 1: Setup

**Purpose**: 类型字段与协议版本就位（后续各层都依赖）

- [X] T001 在 `src/shared/types.ts` 的 `ExtensionConfig` 增可选字段 `trustedOrigins?: Record<string, string>`（键=基础域，值=origin，注释说明生命周期随授权）
- [X] T002 [P] 在 `skills/larksnap-fetch/scripts/bridge/protocol.mjs` bump `PROTOCOL_VERSION` 3→4（注释补 v4 语义：list-domains/domains-result）、`DAEMON_VERSION` 1.5.2→1.6.0
- [X] T003 [P] 在 `src/background/bridge.ts` bump `PROTOCOL_VERSION` 3→4（同步注释 v4 语义）

## Phase 2: Foundational

**Purpose**: 跨 Story 的整条只读链路——存储、清单合成、WS 消息、HTTP 端点、CLI 请求函数

- [X] T004 在 `src/shared/storage.ts` 增 `getTrustedOrigins()` / `recordTrustedOrigin(base, origin)` / `removeTrustedOrigin(base)`（读写 `config.trustedOrigins`，老配置缺字段按空 map）
- [X] T005 新增 `src/background/domain-list.ts`：纯函数 `baseFromPattern(pattern)`（只认 `*://*.{基础域}/*` 形状，AI 端点 `https://x/*` 等返回 null）+ `buildDomainList()`（FEISHU_HOSTS 内置 + listTrusted 剥基础域，逐项按 A trustedOrigins → B chrome.tabs.query → null 解析 sampleUrl）
- [X] T006 [US2] 新增 `src/background/domain-list.test.ts`：vitest 覆盖 pattern 解析（通配/AI 端点/`*://*/*` 边界）、sampleUrl 优先级（A 命中不看 tabs；B 命中取标签 origin；都空 null）、AI 端点不混入清单
- [X] T007 在 `src/background/bridge.ts` 的 onMessage 增 `list-domains` 分支（job 分支之前，不要求 url）：调 `buildDomainList()` 回 `{type:'domains-result', id, domains}`，异常回空 domains 不挂死 daemon
- [X] T008 在 `skills/larksnap-fetch/scripts/bridge/daemon.mjs` 增 `GET /hosts?profile=` 端点：验签（GET+/hosts+空 body）→ `resolveConn(profile)` → `_proto >= 4` 检查（否则 `extension_outdated`）→ 发 `list-domains`、`pendingHosts` 挂 10s 超时（`extension_timeout`）；WS onMessage 增 `domains-result` 路由（先于通用业务分支）；`conn.on('close')` 收尾同 contextId 的 pendingHosts 条目
- [X] T009 [P] 在 `skills/larksnap-fetch/scripts/bridge/client.mjs` 增 `getHosts(profile, failFn)`：GET `/hosts` 带 `AUTH_HEADER`+`SIG_HEADER`，聚合 JSON；`ok:false` 按 subtype 走 ERROR_KINDS 收口（`extension_timeout` 补进 ERROR_KINDS，退出码 5 补进 BASE_EXIT_CODES）

---

## Phase 3: User Story 2 - 查看已授权域名清单 (Priority: P1)

**Goal**: `edit.mjs hosts` 一条命令打印清单，链路首次端到端可观测

**Independent Test**: 重载扩展 → `node edit.mjs hosts` → stdout JSON 与侧边栏实际授权状态一致

- [X] T010 [US2] 在 `skills/larksnap-fetch/scripts/edit.mjs` 重构参数解析：`positionals[0]` 非 http(s) 时视为省略 URL（仅 `hosts` / `new-doc` 允许，其余操作维持必须 URL）；实现 `hosts` 命令（`ensureDaemon` → `getHosts(flags['--profile'])` → stdout 打 `{ok:true, domains}`）；USAGE_HINT 同步

**Checkpoint**: 重载扩展后 `node edit.mjs hosts` 打出 builtin 三域名 + 已授权私有域名；侧边栏新授权/撤销一个域名后再跑，清单同步变化。

---

## Phase 4: User Story 1 - 单域名免链接建档 (Priority: P1) 🎯 MVP 闭环

**Goal**: 授权过的私有域名，`new-doc 内容.md --name t` 零链接建出文档

**Independent Test**: 私有域名重新授权（写入 trustedOrigins）→ 不带链接 new-doc → 文档创建成功

- [X] T011 [P] [US1] 在 `src/sidepanel/SidePanel.tsx` 的 `handleAuthorize` 授权成功分支（仅 `doc.isFeishuDoc`）把 payload 扩为 `{ pattern, origin: originOf(doc.url) }`
- [X] T012 [US1] 在 `src/background/index.ts` 的 `MSG.REQUEST_PERMISSION` 分支：payload 增可选 `origin`，`baseFromPattern(pattern)` 命中（飞书通配形状）且 origin 有值时 `recordTrustedOrigin(base, origin)`（AI 端点形状自然跳过）
- [X] T013 [US1] 在 `src/background/permissions.ts` 的 `revokePermission(pattern)` 里 `baseFromPattern(pattern)` 命中时一并 `removeTrustedOrigin(base)`，撤销零残留
- [X] T014 [US1] 在 `skills/larksnap-fetch/scripts/edit.mjs` 实现 new-doc 免链接分支：无 URL 时取清单 → 单域名直接选，多域名报 `host_ambiguous`（附清单）→ `sampleUrl` 为 null 报 `need_landing_url` → 否则 `url = sampleUrl + '/drive/me/'` 前插，走原有 new-doc 链路；新 subtype 的退出码与 hint 按 data-model.md 契约表

**Checkpoint**: 手测 quickstart 第 1/3 条——重新授权后免链接建档成功；无记录无标签时报 need_landing_url 不静默。旧用法（喂 URL）回归不变。

---

## Phase 5: User Story 3 - 多域名显式选择 (Priority: P2)

**Goal**: `--host <域名或唯一后缀>` 在多域名间选择

**Independent Test**: 授权 ≥2 域名后分别用完整域名、唯一后缀、不存在的域名执行，行为符合契约

- [X] T015 [US3] 在 `skills/larksnap-fetch/scripts/edit.mjs`：`--host` 进 FLAGS_WITH_VALUE；匹配逻辑抽小函数（精确 → 唯一后缀 → `host_not_authorized`/`host_ambiguous` 附可选清单）；非 new-doc 操作或 new-doc 已带 URL 时携带 `--host` 直接 usage 拒绝

**Checkpoint**: 多域名 `--host a.example.com` 与 `--host feishu.cn` 均建对位置；后缀多义与未授权域名报错附清单。

---

## Phase 6: User Story 4 - 多浏览器 profile (Priority: P3)

**Goal**: 多 profile 时清单与建档路由到指定身份

**Independent Test**: 两个 profile 各授权不同域名，`--profile` 分别查询互不混淆

- [X] T016 [US4] 验证并补全 `--profile` 透传：`hosts` / new-doc 免链接分支把 `flags['--profile']` 传给 `getHosts`（daemon `resolveConn` 已支持多 profile 路由与 `profile_ambiguous`，此任务以真机验证为主，缺口才补代码）

**Checkpoint**: 双 profile 下不带 `--profile` 报 `profile_ambiguous`；带上后各回各的清单。

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T017 [P] 更新 `skills/larksnap-fetch/SKILL.md`：new-doc 免链接用法（三种形态）、`hosts` 命令、私有域名比公有云稳（sampleUrl 命中率）与 need_landing_url 应对、`my.feishu.cn` 已知限制、协议 v4 需重建扩展提示
- [X] T018 运行 `npm run typecheck` + `npm run test` + `npm run build` 全绿（宪法治理规则）
- [ ] T019 按 quickstart.md 手测清单逐项验收（8 项，合成 URL 建档最先测）；**用户真机验证通过并明确要求后才 commit**

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 → Phase 2 → Phase 3（US2）→ Phase 4（US1）→ Phase 5（US3）→ Phase 6（US4）→ Phase 7
- T005 依赖 T001（类型）；T006/T007 依赖 T005；T008 依赖 T002；T009 依赖 T002；T010 依赖 T008+T009；T012/T013 依赖 T004+T005；T014 依赖 T010
- US3/US4 只动 edit.mjs 与验证，依赖 US1 的免链接分支存在

### Parallel Opportunities

```text
# Phase 1 可并行：T002, T003（T001 也独立，三者可同启）
# Phase 2 可并行：T005 与 T004；T008 与 T009
# Phase 4 可并行：T011 与 T012/T013 不同文件（T012 依赖 T005 的 baseFromPattern）
# Phase 7 可并行：T017 与 T018
```

---

## Implementation Strategy

### MVP First

1. Phase 1 + 2 → 链路基础就绪
2. Phase 3（US2 hosts 命令）→ **STOP and VALIDATE**：重载扩展，`edit.mjs hosts` 打出正确清单
3. Phase 4（US1 免链接建档）→ **STOP and VALIDATE**：真机建档（quickstart 手测第 1 条，最高风险项 `/drive/me/` 拼法在此验证）
4. US3 / US4 增量追加，各自回归

### Incremental Delivery

每个 Checkpoint 都是可演示状态；`/drive/me/` 拼法若实测失败，按 research.md 决策 7 回到备选方案，不影响已交付的 hosts 命令。

---

## Task Summary

| 阶段 | 任务数 | 可并行任务数 |
|------|--------|-------------|
| Phase 1: Setup | 3 | 2 |
| Phase 2: Foundational | 6 | 2 |
| Phase 3: US2 | 1 | 0 |
| Phase 4: US1 | 4 | 1 |
| Phase 5: US3 | 1 | 0 |
| Phase 6: US4 | 1 | 0 |
| Phase 7: Polish | 3 | 2 |
| **Total** | **19** | **7** |

**MVP Scope**: Phase 1 + 2 + 3 + 4 = 14 tasks（US2 与 US1 均为 P1，合并为 MVP 闭环）

**Parallel Efficiency**: 7 / 19 ≈ 37%

---

## Notes

- 手测依赖真实私有化域名与登录态，代理环境注意 memory 里的坑（代理会破坏部分站点验证）
- 改扩展代码后必须重新构建 + chrome://extensions 重载 + 点图标唤醒 SW，daemon 由 CLI 版本自愈自动重启
- 每完成一组任务先真机验收再谈提交（CLAUDE.md：等用户真机验证并明确要求后再 commit）
- 避免：动 `createEmptyDoc` 建档逻辑、新增 STORAGE_KEYS 顶层键、把 AI 端点域名放进清单
