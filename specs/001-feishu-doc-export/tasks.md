# Tasks: 飞书文档导出助手

**Input**: Design documents from `/specs/001-feishu-doc-export/`
**Prerequisites**: plan.md, spec.md, data-model.md, quickstart.md, constitution.md

**Tests**: 本功能规格说明未明确要求自动化测试,任务清单不含独立单测任务;验收以 `npm run typecheck` + `npm run build` + quickstart 手工验收为准。

**Organization**: 任务按用户故事分组,对齐 docs/技术方案.md 里程碑 M0-M5;每组尽量可独立交付与验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行(不同文件、无依赖)
- **[Story]**: 所属用户故事(US1-US8)

## Path Conventions

- UI: `src/sidepanel/` `src/options/` `src/popup/`
- 背景 SW: `src/background/` `src/background/exporters/` `src/background/convert/`
- content: `src/content/` `src/content/api/`
- 共享: `src/shared/`

---

## Phase 1: Setup(基础类型/常量/依赖)

**Purpose**: 打通后续所有 Story 的类型、消息、存储、域名工具与 zip 依赖。

- [X] T001 [P] 扩展 `src/shared/types.ts`:`DocInfo` 加 `isPrivateDeploy`;新增 `MarkdownCapability`/`InlineNode`/`Block`/`MediaAsset`/`MarkdownResult`;`ExtensionConfig` 加 `trustedDomains`
- [X] T002 [P] 扩展 `src/shared/constants.ts`:`MSG` 加 `GET_COOKIE`/`CHECK_PERMISSION`/`REQUEST_PERMISSION`/`REVOKE_PERMISSION`;`CONTENT_MSG` 加 `FEISHU_REQUEST`/`DOWNLOAD_MEDIA`/`SCROLL_LOAD`;`STORAGE_KEYS` 加 `MD_CAP`;`CSRF_COOKIE_NAMES`;`DEFAULT_CONFIG.trustedDomains=[]`
- [X] T003 [P] 新增 `src/shared/feishu-host.ts`:`baseDomain(host)`、`driveStreamHost(host)`(纯函数,SW/content 共用)
- [X] T004 [P] 扩展 `src/shared/storage.ts`:`getMarkdownCapability/setMarkdownCapability/clearMarkdownCapability`(按 host)、`getTrustedDomains/addTrustedDomain/removeTrustedDomain`
- [X] T005 安装 zip 依赖 `npm i jszip`;新增 `src/background/zip.ts` 封装 `createZip(files)`(JSZip 实现;离线失败则自研 store-zip,见 research §8)

**Checkpoint**: 类型/常量/存储/域名工具就绪,`npm run typecheck` 通过。

---

## Phase 2: Foundational(认证与请求骨架,跨 Story 共用)

**Purpose**: content 同源请求封装 + SW 读 Cookie,所有取数的根。

- [X] T006 [US3] 新增 `src/background/cookie.ts`:`getCookie(name,url)` via `chrome.cookies.get`;在 `src/background/index.ts` 路由 `MSG.GET_COOKIE`(用 `sender.tab.url`)
- [X] T007 [US3] 新增 `src/content/api/request.ts`:`feishuGet(path)`、`feishuPost(path,body)`(同源+referer+完整头+`x-csrftoken`),CSRF 经 `get_cookie` 取候选名失败重试;`Failed to fetch` 退避重试
- [X] T008 [US3] 在 `src/content/index.ts` 注册 `CONTENT_MSG.FEISHU_REQUEST` 分发到 `feishuGet/feishuPost`(供 SW 编排代发)

**Checkpoint**: SW 可经 content 同源命中一个内部 GET(如 `/space/api/user/`)返回 200。

---

## Phase 3: User Story 1 - 识别与按需授权(P0,M0)🎯 MVP 地基

**Goal**: 公私两端正确识别文档 + 私有化运行时授权。
**Independent Test**: 公有云 docx 与私有化 wiki 两类页面识别正确,私有化可完成授权。

- [X] T009 [US1] 升级 `src/content/feishu-detect.ts`:路径+token 双信号识别(`FEISHU_TOKEN_RE`),已知域名信任、未知域名靠模式,置 `isPrivateDeploy`
- [X] T010 [US1] 修改 `manifest.json`:`host_permissions` 保留三大公有云,新增 `optional_host_permissions:["*://*/*"]`,移除 `<all_urls>`
- [X] T011 [US1] 新增 `src/background/permissions.ts`:`hasPermission(origin)`/`requestPermission(origin)`/`revokePermission(origin)`(配合 `trustedDomains`);路由 `CHECK/REQUEST/REVOKE_PERMISSION`
- [X] T012 [US1] `src/background/doc-detect.ts`:私有化域名注入 content 前先校验权限,未授权则返回需授权信号
- [X] T013 [US1] `src/sidepanel/SidePanel.tsx`:私有化未授权时展示"需授权访问该域名"+ 授权按钮(用户手势触发 `REQUEST_PERMISSION`),授权后重试识别
- [X] T014 [P] [US1] `src/options/Options.tsx`:展示"已信任域名"列表,支持撤销

**Checkpoint**: 公私两端识别正确;私有化 2 次点击内完成授权可导出(SC-001/SC-002)。

---

## Phase 4: User Story 2 - 导出诊断信息(P0,M2 支撑)

**Goal**: 一键导出脱敏诊断包。
**Independent Test**: 诊断产物含 DocInfo/接口样本/选路结论且无 PII。

- [X] T015 [US2] 改写 `src/background/diagnostic.ts`:深度遍历剔除 `editor_map/user_map/creator_id/owner_id` 等 PII;纳入 DocInfo、接口响应样本、Markdown 选路结论、版本;遵循 `diagnosticIncludeSnapshot`
- [X] T016 [US2] 在 `src/background/index.ts` 诊断路由中拉取 `client_vars`/能力检测样本(经 content)供脱敏打包

**Checkpoint**: 诊断包 PII 字段出现 0 次(SC-006)。

---

## Phase 5: User Story 4 - 导出 PDF + 通用导出任务(P1,M2)

**Goal**: 官方导出任务链路跑通,先交付最确定的 PDF。
**Independent Test**: 官方导出可用环境导出高清 PDF。

- [X] T017 [US4] 新增 `src/content/api/doc.ts` 之导出任务部分:`createExportTask(token,type)`、`pollExportResult(ticket)`(经 feishuPost/Get)
- [X] T018 [US4] 新增 `src/background/exporters/export-task.ts`:通用流程 create→轮询(上限+超时)→按 result 响应取下载域(回退同源/公有云)→ `downloadMedia` 落盘
- [X] T019 [US4] 改写 `src/background/exporters/pdf.ts`:调用 export-task(type=pdf),进度上报;非 0/无 ticket 明确提示官方导出不可用
- [X] T020 [US4] `src/content/api/media.ts`:`downloadMedia(token,objToken)` 经 `driveStreamHost` 取二进制→base64 回传;并发 ≤3 + 退避

**Checkpoint**: PDF 在官方导出可用环境成功;超时可重试(US4 验收)。

---

## Phase 6: User Story 3 - 导出 Markdown 双路(P0,M2 P-official + M3 P-decode)🎯 核心

**Goal**: 运行时按 host 选路,公私两端均产带图 Markdown。
**Independent Test**: 公有云走 P-official、私有化走 P-decode 均得可读 .md/zip。

### 能力检测 + P-official(M2)

- [X] T021 [US3] 新增 `src/background/capability.ts`:`getMarkdownCapability(host)` 乐观探测 `export/create(md)`,区分未登录(403 文本)/被禁(code≠0),结论按 host 缓存
- [X] T022 [US3] `src/background/exporters/markdown.ts` 之 `runOfficialMd`:复用 export-task(file_extension=md)产 .md,按 imageMode 处理(官方产物图片随包)

### token 解析 + 取块(M3 前置)

- [X] T023 [US3] `src/content/api/doc.ts` 之取数部分:`resolveObjToken(docInfo)`(docx 直用/wiki 走 tree get_info→get_node)、`fetchClientVars(objToken,...)` 含 `mode=4` 翻页直到 `has_more=false`、`fetchMeta`

### P-decode 解码与转换(M3,核心工作量)

- [X] T024 [P] [US3] 新增 `src/background/convert/apool.ts`:changeset/apool 解码器,`initialAttributedTexts`+`apool.numToAttrib`→`InlineNode[]`(粗/斜/删/行内代码/链接)
- [X] T025 [P] [US3] 新增 `src/background/convert/adapter.ts`:`block_map`+`block_sequence`+`parent_id`→`Block[]` 树,字符串 `data.type` 归一,抽取 image/code/table 等 extra
- [X] T026 [US3] 新增 `src/background/convert/markdown.ts`:移植 `ref/xiaoyaosearch` 转换器"块类型→Markdown 结构"半部,吃 `Block[]`/`InlineNode[]`,图片写占位 `feishu-asset://{token}` 并收集 `images[]`;覆盖 Page/Text/Heading/Bullet/Ordered/Code/Quote/Equation/Todo/Divider/Image/Table(合并)/Callout/Grid/QuoteContainer,余者降级占位
- [X] T027 [US3] `src/background/exporters/markdown.ts` 之 `runDecodeMd`:取块→adapter→apool→convert→按 imageMode 下图(`downloadMedia`,失败降级)→替换占位→`zip.ts` 打包下载
- [X] T028 [US3] `src/background/exporters/markdown.ts` 编排:读能力缓存选 `runOfficialMd`/`runDecodeMd`;P-official 运行期失败(非未登录)→ 失效缓存 → 回退 P-decode;P-decode 前合规提示(FR-017)

**Checkpoint**: 公私两端导出 Markdown 成功率 ≥95%,结构正确率 ≥90%,单图失败不拖垮整篇(SC-003/004/005)。

---

## Phase 7: User Story 5 - 导出附件(P1,M3)

**Goal**: 批量下载图片+文件打包 zip。
**Independent Test**: 含多图多附件文档导出得完整 zip。

- [X] T029 [US5] 改写 `src/background/exporters/attachments.ts`:复用 `fetchClientVars` 收集 image/file token→`downloadMedia` 逐个下载→`zip.ts` 打包,文件名用原名(冲突加短哈希),失败跳过并记录

**Checkpoint**: 个别素材失败不阻断整体(US5 验收)。

---

## Phase 8: User Story 6 & 7 - HTML 导出 + 离线缓存(P1,M4)

**Goal**: 单文件 HTML + 真实离线快照缓存。
**Independent Test**: 导出 HTML 断网可读;缓存可离线打开/删除。

- [X] T030 [US6] 新增 `src/content/snapshot.ts`:滚动加载全文→clone document→移除脚本/交互→内联 `<style>`、图片转 dataURL/随包;在 `src/content/index.ts` 接 `GET_SNAPSHOT`/`SCROLL_LOAD`
- [X] T031 [US6] 改写 `src/background/exporters/html.ts`:取快照→组装单文件 HTML→下载
- [X] T032 [US7] `src/background/cache-manager.ts` + `src/background/index.ts`:接真实快照(替换占位),`CacheView.tsx` 打开/删除联通;`manifest` 视需要加 `unlimitedStorage`

**Checkpoint**: HTML 离线可读;缓存列表查看/打开/删除可用(US6/US7 验收)。

---

## Phase 9: User Story 8 + Polish(P2,M5)

- [X] T033 [P] [US8] `src/background/index.ts` Word 分支保持友好"开发中"文案(可注释后续走 export-task docx)
- [X] T034 [P] 并发/重试退避统一打磨(媒体下载 ≤3、`Failed to fetch` 降级)复核 across `media.ts`/`request.ts`
- [X] T035 [P] 文案与合规提示复核(私有化授权、P-decode 绕过提示),`src/sidepanel/SidePanel.tsx`
- [X] T036 校验 quickstart 验收检查点:`npm run typecheck` + `npm run build` 通过,`dist/` 可加载;grep 验证无 SW 直发内部接口、无硬编码域名、无第三方上报

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 (Setup) → Phase 2 (Foundational) → 各 User Story → Phase 9 (Polish)
- US2/US3/US4/US5 依赖 Phase 2(请求骨架)
- US3 P-decode(T024-T028)依赖 T023(取块)与 T020(下图)
- US5 依赖 T023/T020;US6 独立(快照);US7 依赖 US6

### Within Story

- content 取数(api/) → SW 编排(exporters/) → UI 联通
- T024、T025 可并行(不同文件),T026 依赖二者

### Parallel Opportunities

```bash
# Phase 1 可并行:
T001, T002, T003, T004
# Phase 6 解码层可并行:
T024, T025
# Phase 9 可并行:
T033, T034, T035
```

---

## Implementation Strategy

### MVP First

1. Phase 1 + 2 完成 → 认证/请求骨架就绪
2. US1(识别授权)+ US3 P-decode(核心导出)→ MVP 可演示(私有化也能导)
3. **STOP and VALIDATE**:公私两端导出 Markdown

### Incremental Delivery

1. Setup+Foundational → US1 → US2(诊断,辅助调试)
2. US4(PDF)→ US3(Markdown 双路)→ US5(附件)
3. US6/US7(HTML/缓存)→ US8+Polish

---

## Task Summary

| 阶段 | 任务数 | 可并行 |
|------|--------|--------|
| Phase 1 Setup | 5 | 4 |
| Phase 2 Foundational | 3 | 0 |
| Phase 3 US1 识别授权 | 6 | 1 |
| Phase 4 US2 诊断 | 2 | 0 |
| Phase 5 US4 PDF | 4 | 0 |
| Phase 6 US3 Markdown 双路 | 8 | 2 |
| Phase 7 US5 附件 | 1 | 0 |
| Phase 8 US6/US7 HTML/缓存 | 3 | 0 |
| Phase 9 US8/Polish | 4 | 3 |
| **Total** | **36** | **10** |

**MVP Scope**: Phase 1 + 2 + US1 + US3(共约 22 个任务)
**Parallel Efficiency**: 10 / 36 ≈ 28%

---

## Notes

- [P] 任务操作不同文件、无依赖,可并行
- 每完成一个 Phase 后跑 `npm run typecheck`;阶段性 `npm run build` 验证 `dist/`
- 遵守宪法:内部接口仅 content 代发、域名不写死、诊断脱敏、单资源失败不拖垮整篇
- 移植 ref 代码需复核是否违反宪法原则 I/II
