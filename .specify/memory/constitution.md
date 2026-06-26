# 飞书文档导出助手 宪法

> 适用范围:`feishu2md-extension`(Chrome MV3 浏览器扩展)整个生命周期。
> 本宪法是 `/speckit-specify`、`/speckit-plan`、`/speckit-tasks`、`/speckit-implement` 的评判依据,任何规格、计划、任务、实现与之冲突时**以宪法为准**。
>
> Version: 1.0.0 · Ratified: 2026-06-26 · Last Amended: 2026-06-26

---

## 核心原则

### I. 零配置认证(MUST)

扩展**禁止**要求用户到飞书开放平台创建应用、申请 App ID/Secret 或等待权限审批。认证**必须**复用用户浏览器中已登录飞书页面的登录态(Cookie)。

- 所有飞书内部接口请求**必须**在 content script(飞书页面上下文)发起,满足:同源(`window.location.origin` 拼接)、带 `referer`、`credentials:'include'`、POST 带 `x-csrftoken`。
- Service Worker **禁止**直接 `fetch` 飞书内部接口(跨源会被拒);SW 只做 `chrome.cookies.get` 读 CSRF、编排流程、`chrome.downloads` 落盘、JSZip 打包。
- 取证:`grep` SW 代码不得出现指向飞书内部接口路径(`/space/api/`)的 `fetch`。

### II. 域名不写死 / 兼容私有化(MUST)

代码中**禁止**硬编码 `feishu.cn` / `larksuite.com` 等具体域名作为请求目标或下载域。所有请求域**必须**从当前文档的 `DocInfo.host` / `location.origin` 推导。

- 媒体/导出下载域按页面 host 推导基础域拼接(如 `internal-api-drive-stream.{基础域}`),**禁止**写死 `internal-api-drive-stream.feishu.cn`。
- 文档识别**禁止**仅依赖域名白名单:未知域名走"路径 `/<type>/<token>` + token 正则"双信号识别(`isPrivateDeploy`)。
- 私有化域名 host 权限走 `optional_host_permissions` + 用户手势触发的运行时申请。
- 取证:`grep -rn "feishu.cn\|larksuite.com\|internal-api-drive-stream.feishu" src/` 仅允许出现在"公有云回退分支"且有注释说明,不得作为唯一硬编码目标。

### III. 导出可靠 / 状态可恢复(MUST)

每个导出动作**必须**进度可见、失败可重试、Service Worker 休眠后状态可恢复。

- 进度**必须**经 `reportProgress` 写入 `RuntimeState.lastProgress` 并推送 UI;侧边栏重连用 `GET_STATUS` 恢复最后状态。
- 网络请求(内部接口、媒体下载)**必须**带重试退避;媒体下载并发上限 2~3。
- 对 `policy-sdk` 导致的 `Failed to fetch` **必须**有重试/降级处理。
- 单图/单附件失败**禁止**拖垮整篇导出,降级为占位/在线 URL 并在诊断中记录。

### IV. 高质量 Markdown / 双路取数(MUST)

Markdown 导出**必须**尽量保留标题、列表、代码块、表格(含合并单元格)、公式、Callout、图片等结构,且**必须**实现两条取数路径并运行时按 host 探测:

- **P-official**:`export/create(file_extension=md)`,租户支持时优先(质量最高、零解码)。
- **P-decode**:`client_vars` + apool/changeset 解码 + 自研转换器,用于关闭官方 md 导出的租户。**apool 解码器是必做项,非可选兜底。**
- 能力检测结论**必须**按 host 维度缓存(`md_export_supported`),避免每次重试;运行期失败再失效重测。
- 取证:存在 apool 解码器实现 + host 维度能力缓存读写。

### V. 隐私安全 / 不外发(MUST)

- Cookie 与文档内容**仅**用于请求飞书自身接口,**禁止**外发任何第三方服务器(本扩展无后端)。所有产物经 `chrome.downloads` 落本地。
- 诊断信息**必须**脱敏:显式剔除 `editor_map` / `user_map` / `creator_id` / `owner_id` 等含 PII 字段后才可打包。
- 取证:无任何指向非飞书域名的上报/上传请求;诊断打包代码含 PII 字段剔除逻辑。

### VI. 合规告知(MUST)

P-decode 通过抓 `client_vars` 可导出"官方已禁用导出"的文档,等于绕过组织下载限制。

- 产品层**必须**明确告知"仅在你被授权的前提下使用";P-decode 前**应**检测并提示"该文档官方导出已关闭,继续即绕过该限制"。
- **禁止**在文案/营销中将"绕过组织限制"作为无条件卖点而不附合规提醒。

---

## 技术栈与依赖

- **语言/构建**:TypeScript 5.5 + Vite 5 + `@vitejs/plugin-react`,产物为 Chrome MV3 扩展。
- **UI**:React 18(sidepanel / popup / options)。
- **平台**:Chrome Manifest V3 — background `service_worker`(module 类型)、content scripts、`side_panel`。
- **权限**:`cookies` / `scripting` / `storage` / `downloads` / `tabs` / `sidePanel` 等;host 用 `host_permissions`(公有云)+ `optional_host_permissions`(私有化按需)。
- **存储**:`chrome.storage.local`(config / runtime / cache 三类,键名集中在 `STORAGE_KEYS`);大文档缓存需 `unlimitedStorage`。
- **打包**:JSZip(导出 zip)。
- **参考实现**:`ref/`(feishu-doc-helper / xiaoyaosearch / feishu2md 等),仅作移植参照,移植代码须遵守本宪法(尤其原则 I / II)。

---

## 禁止事项

1. **禁止**新增 App ID/Secret 配置项作为主认证路径(违背原则 I;OpenAPI 仅可作可选高级增强)。
2. **禁止**在 Service Worker 内直接请求飞书内部接口。
3. **禁止**硬编码具体飞书域名作为唯一请求/下载目标。
4. **禁止**将 Cookie、文档内容、诊断原始数据发往任何第三方/自建后端。
5. **禁止**诊断包内含未脱敏的 `editor_map` / `user_map` 等 PII。
6. **禁止**因单个资源(图片/附件)失败而使整篇导出失败。
7. **禁止**跳过 §5.1 能力检测而全局写死单一 Markdown 取数路径。

---

## 治理规则

- **修订流程**:任何对核心原则的增删改,须先在本文件 `## 修订记录` 追加条目,并更新 `Version` 与 `Last Amended`。
- **版本号(semver)**:
  - **MAJOR**:删除或重新定义某条核心原则;
  - **MINOR**:新增原则或重大扩展;
  - **PATCH**:措辞修正、非语义调整。
- **冲突裁决**:spec / plan / tasks / 实现与宪法冲突时,以宪法为准;确需突破必须先修订宪法。
- **取证优先**:所有 MUST 条款须可在代码层用 `grep` / 静态检查取证;新增 MUST 必须给出取证方式。
- **验证**:修改源码后必须 `npm run typecheck`(`tsc --noEmit`)与 `npm run build` 通过。

---

## 修订记录

- v1.0.0 (2026-06-26): 首版。基于 `docs/技术方案.md` 确立六条核心原则(零配置认证 / 域名不写死 / 导出可靠 / 高质量 Markdown 双路取数 / 隐私安全 / 合规告知)、技术栈、禁止事项与治理规则。
