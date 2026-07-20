# Research: 已授权域名清单（新建文档免喂链接）

> 大部分决策在 docs/plans/2026-07-16-已授权域名清单接口.md 的两轮评审中已定，此处记录结论 + 本次代码扫描补充发现的两个新决策点（决策 4、6）。

## 1. 域名清单的数据源

**问题**: 域名清单存哪——独立配置文件，还是复用扩展已有授权状态？

**研究结果**: 扩展已有两处现成数据：`listTrusted()`（`src/background/permissions.ts:48`）返回用户手势授权的 `*://*.{基础域}/*` pattern（持久化在 `config.trustedDomains`）；manifest `host_permissions` 写死了三个公有云域名，与常量 `FEISHU_HOSTS`（`src/shared/constants.ts:172`）一致。

**Decision**: 复用扩展授权状态，builtin 用 `FEISHU_HOSTS` 常量，trusted 从 `listTrusted()` 剥基础域。

**Rationale**: 零维护、永不失同步（授权/撤销自动反映）；不引入第二份会打架的数据。

**Alternatives considered**:
- 独立 config.json：要新增写入时机、UI、迁移，且会和真实授权状态失同步 → 违反 YAGNI，排除。

## 2. 光有基础域拼不出能建文档的页面 → sampleUrl 的 A/B 补齐

**问题**: `new-doc` 需要打开一个能加载编辑器、能注入脚本、能建文档的**真实租户页面**（`createEmptyDoc` 是真的 `chrome.tabs.create` 后在页面上下文里调建档接口，见 `src/background/editor.ts:283` 附近）。但 `permissionPattern()` 授权时主动剥掉了租户子域（`src/shared/feishu-host.ts:55`），存下的只有基础域——apex 上建不了文档。

**研究结果**: 授权手势发生在侧边栏，那一刻 `doc.url` 就在手上（`src/sidepanel/SidePanel.tsx:189` 的 `handleAuthorize`），真实 origin 唾手可得；另外 `chrome.tabs.query` 能拿到当前所有已打开标签的 URL（`tabs` 权限已有）。

**Decision**: A 为主 + B 兜底 + 显式降级。A：授权那一刻把 `originOf(doc.url)` 记进 `config.trustedOrigins[基础域]`；B：storage 没有时（老授权、builtin 域名），扩展当场 `chrome.tabs.query({})` 找 host 命中该基础域的已打开标签取 origin；都没有 → `sampleUrl: null`，CLI 报 `need_landing_url` 让用户本次喂一个链接。

**Rationale**: A 覆盖私有域名主场景（授权过就有）；B 覆盖老授权和"正开着飞书"的公有云；降级不静默。origin 的拼路径（`/drive/me/`）留在 CLI 侧，扩展只提供数据。

**Alternatives considered**:
- 拿基础域硬拼 `https://{基础域}/drive/me/`：公有云 apex 是营销站、私有化 apex 未必是网盘 host，打不开编辑器上下文 → 排除（这是整个方案的地基性否决）。
- 任意一次成功任务后都记 origin（扩大 A 的捕获点）：能让公有云也零链接，但捕获点变多、还有多租户覆盖语义要定义 → 留作后续增强（源计划 §七），本期不做。

## 3. daemon 侧走独立 GET /hosts 还是复用 POST /command

**问题**: `list-domains` 不带 URL，但 `/command` 整条链路有三层 url 校验：daemon 入口 `if (!job.url) 400`（`daemon.mjs:174`）、daemon 只发 `type:'job'`（`daemon.mjs:206`）、扩展 bridge 也卡 `msg.url`（`bridge.ts:400`）。

**Decision**: 新增独立只读端点 `GET /hosts?profile=`，鉴权/验签与 `/command` 同机制（`AUTH_HEADER` + `SIG_HEADER`，签名覆盖 `GET` + `/hosts` + 空 body）。

**Rationale**: 为一条只读消息把三层"带 URL 任务"的校验都开例外，不如新开一个小端点干净（评审二结论，采纳）。验签的 pathname 不含 query（`daemon.mjs:98` 先 split 掉了），所以 `?profile=` 不影响签名。

**Alternatives considered**:
- 复用 /command 加 url 豁免：三处改例外、语义混浊 → 排除。
- 不验签的公开端点：本机其他身份可枚举用户授权过哪些内网域名，泄露信息 → 排除。

## 4. trustedDomains 里混着非飞书 pattern，必须按形状过滤（本次扫描新发现）

**问题**: 设置页保存 AI 端点时也走 `MSG.REQUEST_PERMISSION` 持久化 pattern（`src/options/Options.tsx:113`），但它的形状是 `https://{origin}/*`（origin 全等），不是飞书授权的 `*://*.{基础域}/*` 通配形状。直接把 `listTrusted()` 全量当私有飞书域名，AI 端点会混进域名清单。

**研究结果**: 两种来源的 pattern 形状恰好不同——侧边栏飞书授权固定产出 `*://*.{基础域}/*`（`permissionPattern()`），AI 端点固定产出 `https?://host/*`。侧边栏的普通网页授权只 request 不记录（`SidePanel.tsx:206` 注释明确"普通网页只授权、不记录"），不会混入。

**Decision**: 新增纯函数 `baseFromPattern(pattern): string | null`——只认 `*://*.{基础域}/*` 形状，其余（AI 端点等）返回 null 被过滤。清单合成、撤销时清理 `trustedOrigins` 都用它。

**Rationale**: 形状即语义：通配形状只有飞书授权路径会产出。纯函数可单测，AI 端点混入这个坑必须有测试钉住。

**Alternatives considered**:
- 给 trustedDomains 里的条目加来源标记：要迁移存量数据 → 排除，形状过滤零迁移。

## 5. 协议版本与兼容策略

**问题**: 新消息 `list-domains`/`domains-result` 如何对旧扩展/旧 daemon 降级？

**研究结果**: `PROTOCOL_VERSION` 现值已是 3（v3 = 扩展主动发 video-job；`bridge.ts:43`、`protocol.mjs:21` 两处）。daemon 对连接存了 `_proto`（hello 时上报）。CLI 每次跑都 `ensureDaemon` 比对 `DAEMON_VERSION`，不一致自动重启到本技能这份（`client.mjs:177`）——daemon 侧天然自愈。

**Decision**: 两处 `PROTOCOL_VERSION` 一起 bump 到 4；`DAEMON_VERSION` bump 到 1.6.0。daemon `/hosts` 派发前检查 `_proto >= 4`，不满足回 `{ok:false, error:{subtype:'extension_outdated'}}`；CLI 拿到后提示"更新/重建扩展，或按旧用法喂一个链接"。

**Rationale**: daemon 靠版本自愈自动更新，唯一要人工动手的是重建/重载扩展——`extension_outdated` 的 hint 已有现成文案（`client.mjs` ERROR_KINDS）。`daemon.mjs:185` 的 `_proto < 2` 是 edit 专用老门槛，不复用。

**Alternatives considered**:
- 不 bump、靠消息类型探测（发了没人回就超时）：超时 10s 才能给出模糊错误，不如版本门槛一步到位 → 排除。

## 6. daemon 等 domains-result 的回包机制（本次扫描补充）

**问题**: daemon 现有回包路由是 `pending: Map<jobId, {res}>`，写的是 NDJSON 流、`result|error` 才 end（`daemon.mjs:304-321`）。`/hosts` 是一次性 JSON 响应，形状不同。

**Decision**: 独立小 map `pendingHosts: Map<id, {res, timer}>`；WS onMessage 里 `domains-result` 分支先于通用业务分支路由；10 秒超时回 `{ok:false, error:{subtype:'extension_timeout'}}`；扩展断线收尾时（`conn.on('close')`）该 map 里同 contextId 的条目也要收尾报错。

**Rationale**: 复用 pending 得在写流逻辑里塞"这条其实是 JSON 响应"的分支，两种响应形状纠缠；独立 map 各自干净，代码量相当。

**Alternatives considered**:
- 复用 pending + 特判：污染主任务回包路径 → 排除。

## 7. `/drive/me/` 落地路径（风险项，非决策）

`sampleUrl + '/drive/me/'` 这个拼法来自 SKILL.md 现有 new-doc 提示（"网盘首页 `/drive/me/`"），**能否在真实租户 origin 上稳定建文档是本计划最高风险项**，实现完成后第一个手测它（见 quickstart 手测清单第 1 条）。若实测失败，备选是改拼任意已知文档路径或引导用户喂链接——决策推迟到有实测数据再做。
