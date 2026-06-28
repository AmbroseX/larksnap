# Research: 飞书文档导出助手

> 多数取数/接口决策已由 `docs/技术方案.md`(2026-06-26 Playwright 抓包实测)坐实,此处汇总成可执行决策。

## 1. 飞书内部接口请求的执行位置

**问题**: 内部接口放 SW 还是 content?

**研究结果**: ref `feishu-doc-helper` 所有内部调用均满足同源 + referer + CSRF;SW 发起会变跨源、无 referer、`sec-fetch-site: cross-site`,极大概率被拒。实测页面上下文 `fetch(credentials:'include')` 探测返回 200。

**Decision**: 内部接口一律 content 代发(`content/api/`),SW 仅 `chrome.cookies.get`+编排+下载+打包。

**Rationale**: 宪法原则 I 的硬约束;唯一被实测验证可行的路径。

**Alternatives considered**: SW 直发 — 被 §4.1 否决;`declarativeNetRequest` 改头 — 复杂且不解决 referer/同源本质。

## 2. CSRF token 来源与请求头

**问题**: POST 用哪个 cookie 做 CSRF?需要哪些头?

**研究结果**: 实测公私两端 POST 校验用 `_csrf_token`(`swp_csrf_token` 报 `csrf token error`)。ref POST 带 13 个头;最小可用子集见 §4.2。HttpOnly cookie 需 SW `chrome.cookies.get` 读。

**Decision**: 候选名 `['_csrf_token','swp_csrf_token']`,SW `get_cookie` 读;放入头 `x-csrftoken`;收到 csrf 错误换名重试。请求头用 §4.2 最小子集(`accept/content-type/doc-biz/request-id/x-request-id/x-tt-trace-id/x-csrftoken`),不足再据诊断补。

**Rationale**: 实测结论 + 失败兜底。

## 3. Markdown 取数:单路还是双路

**问题**: 走官方导出还是自解码?

**研究结果**: 官方 md 导出是**租户级开关**。公有云 `my.feishu.cn` `export/create(md)` → `code:0` 产真 .md;私有化示例 pdf/docx/md 全 `1002 no permission`(整体禁用)。

**Decision**: **双路 + 运行时按 host 探测**。P-official 优先;非 0/无 ticket 回退 P-decode。结论按 host 缓存 `md_export_supported`。apool 解码器为**必做**。

**Rationale**: 单路无法同时覆盖两类租户;宪法原则 IV。

**Alternatives considered**: 仅官方(私有化失效)、仅自解码(放弃公有云最高质量)、docx→md 前端转(格式丢失)、OpenAPI(违背零配置)— 均不作主路。

## 4. 能力检测策略

**问题**: 如何判定当前 host 是否支持官方 md 导出?

**研究结果**: 乐观探测最可靠;setting 接口(`obj_setting/get`)可预读格式列表但未坐实。

**Decision**: 乐观探测 `export/create({file_extension:'md'})` → 接受=支持/拒绝=回退;按 host 缓存;P-official 运行期再失败则失效重测。区分失败:纯文本 `403 csrf token error`=未登录(等待);JSON `code≠0`(含 1002)=导出被禁(回退)。

**Rationale**: §5.1 能力检测;不引入未验证接口。

## 5. client_vars 块结构与 apool 解码

**问题**: 自解码路径的数据形态?

**研究结果**: `GET /space/api/docx/pages/client_vars?id={obj_token}&mode=1&limit=239[&container_type=wiki2.0&wiki_space_id=&container_id=]` 返回 `block_map`+`block_sequence`+`meta_map`。`data.type` 为字符串("text"/"code"/"heading1");正文为 `initialAttributedTexts.{text,attribs}`+`apool.numToAttrib`,`attribs` 形如 `"*0+h"`;树靠 `parent_id/children`+`block_sequence`。翻页 `mode=4`+`block_id`+`cursor`,`has_more=false` 结束。公私两端 schema 一致。

**Decision**: 三件套 —— (a) apool 解码器:`attribs` → 纯文本+行内标记(粗/斜/链接/行内代码);(b) adapter:字符串 type + 树重建 → 转换器期望结构;(c) 复用 `ref/xiaoyaosearch` 转换器"块类型→Markdown 结构"半部。

**Rationale**: §5.1 实测;只有结构半部可移植,文本抽取半部必须自研。

## 6. token 解析链(按文档类型)

**Decision**:
- 直链 docx(`/docx/{token}`):token 即 obj_token,直接 `client_vars?id={token}&mode=1&limit=239`;标题取响应 `meta_map`,公有云亦可 `/space/api/meta/?token=&type=22`。
- wiki(`/wiki/{wiki_token}`):`tree/get_info?wiki_token=` 取 space_id → `tree/get_node?wiki_token=&space_id=` 取 obj_token/obj_type/title → `client_vars?id={obj_token}&container_type=wiki2.0&container_id={wiki_token}&wiki_space_id={space_id}`。

**Rationale**: §7 token 解析链,公私一致,差异仅元数据"前门"。

## 7. 媒体下载域与图片处理

**问题**: 下载域如何取?不写死。

**研究结果**: 实测 `driveStreamHost = internal-api-drive-stream.{基础域}`(私有化 `corp.example.com`,公有云 `feishu.cn`)。原图 `GET {driveStreamHost}/space/api/box/stream/download/all/{box_token}/?mount_node_token={obj_token}`;`cover` 为缩略图。导出任务下载域优先取 `export/result` 响应,回退同源,公有云再回退。

**Decision**: `feishu-host.ts` 由页面 host 推导基础域 → 拼 driveStreamHost。图片转换器先写占位 `![name](feishu-asset://{box_token})` 收集 `images[]`,`download` 模式下载替换为 `assets/{token}.{ext}`(token 命名去重),失败降级在线 URL/占位 + 诊断记录。默认 `download`。

**Rationale**: 宪法原则 II;§5.1 图片小节。

## 8. zip 打包依赖

**问题**: JSZip 未安装,如何打包?

**Decision**: 优先 `npm i jszip`(+ `@types/jszip` 或自带类型);若离线装不上,自研最小 **store-zip**(无压缩 + CRC32 + 本地文件头/中央目录),足够导出场景。封装在 `background/zip.ts`,对外仅暴露 `createZip(files): Blob/Uint8Array`,实现可替换。

**Rationale**: 导出物以文本+图片为主,store 模式够用;封装隔离依赖风险。

**Alternatives considered**: `CompressionStream` 自拼 zip — 也可,但 store 模式更简单可靠。

## 9. content→SW 二进制传输

**问题**: content fetch 到图片二进制,如何交给 SW 打包?

**Decision**: content 侧 `fetch→arrayBuffer→base64` 回传(消息只能传可序列化数据);SW base64 解码写入 zip。单条消息体过大时分块或逐图请求(媒体下载本就并发 ≤3 逐个进行)。

**Rationale**: chrome 消息传输限制;并发上限天然分批。

## 10. 私有化域名 host 权限

**Decision**: `manifest` 用 `host_permissions`(三大公有云)+ `optional_host_permissions`(`*://*/*`);移除 `<all_urls>`。识别为 `isPrivateDeploy` 且未授权 → 侧边栏按钮(用户手势)调 `chrome.permissions.request({origins:[origin+'/*']})`;授权后注入 content。已授权域记入 `config.trustedDomains`,设置页可撤销(`chrome.permissions.remove`)。

**Rationale**: §4.4;宪法原则 II;上架审核更干净。
