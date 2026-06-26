# Data Model: 飞书文档导出助手

> 本扩展无后端/数据库,"数据模型"= TypeScript 类型 + `chrome.storage.local` 键结构 + 内部接口响应形态。

## 实体关系(概念)

```text
DocInfo ──(识别)──► 决定 token 解析链 ──► client_vars(block_map) ──► Block[] ──(adapter+apool)──► Markdown
   │                                                          │
   │                                                          └─► MediaAsset[] ──► zip/assets
   ├─ host ──► MarkdownCapability(按 host 缓存选路)
   ├─ isPrivateDeploy ──► TrustedDomain(运行时授权)
   └─ 快照 ──► CachedDoc / HTML 单文件
ExportProgress ──► RuntimeState.lastProgress(落盘恢复)
DiagnosticBundle ◄── DocInfo + 脱敏 blocks + 接口样本 + 选路结论
```

## 类型定义(`src/shared/types.ts`)

### DocInfo(改)

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| isFeishuDoc | boolean | 必填 | 是否受支持的飞书文档页 |
| docType | FeishuDocType | 枚举 | docx/docs/wiki/sheets/base/file/unknown |
| token | string | 已识别时非空 | URL 中资源 ID |
| title | string | 可空 | 尽力提取 |
| url | string | 必填 | 页面 URL |
| host | string | 必填 | 域名,用于推导请求/下载域 |
| **isPrivateDeploy** | boolean | 新增 | 未知域名靠路径+token 命中=true |

### MarkdownCapability(新增)

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| host | string | 唯一键 | 按 host 维度缓存 |
| mdExportSupported | boolean | 必填 | 官方 md 导出是否可用 |
| checkedAt | number | ms | 探测时间 |

> 存储:`STORAGE_KEYS.MD_CAP` 下 `Record<host, MarkdownCapability>`。

### ExtensionConfig(改)

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| imageMode | 'download'\|'link' | 'download' | Markdown 图片处理 |
| feedbackUrl | string | (现值) | 反馈页 |
| diagnosticIncludeSnapshot | boolean | true | 诊断含快照 |
| **trustedDomains** | string[] | [] | 已运行时授权的 origin 列表 |

### Block(P-decode 内部中间结构,`convert/adapter.ts`)

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | block id |
| type | string | client_vars 的 `data.type`(字符串) |
| parentId | string\|null | 父块 |
| children | string[] | 子块顺序 |
| text | InlineNode[] | apool 解码后的"纯文本+行内标记" |
| extra | object | 块特有数据(image.token/code.language/table 结构等) |

### InlineNode(apool 解码输出,`convert/apool.ts`)

| 字段 | 类型 | 说明 |
|---|---|---|
| text | string | 文本片段 |
| bold/italic/strike/inlineCode | boolean? | 行内标记 |
| link | string? | 链接 URL |

### MediaAsset(新增)

| 字段 | 类型 | 说明 |
|---|---|---|
| token | string | box… ,去重键 |
| name | string | 原名/alt |
| mimeType | string | 定扩展名 |
| width/height | number? | 可选 |

### MarkdownResult(`convert/markdown.ts` 输出)

| 字段 | 类型 | 说明 |
|---|---|---|
| markdown | string | 含 `feishu-asset://{token}` 占位 |
| images | MediaAsset[] | 待下载素材 |

## storage 键结构(`STORAGE_KEYS`)

| 键 | 值类型 | 现状 |
|---|---|---|
| CONFIG | ExtensionConfig | 有 |
| RUNTIME_STATE | RuntimeState | 有 |
| CACHE_INDEX | CachedDoc[] | 有 |
| CACHE_DOC_PREFIX+token | snapshot | 有 |
| **MD_CAP** | Record<host,MarkdownCapability> | 新增 |

## 内部接口响应形态(取数依据)

| 接口 | 关键字段 |
|---|---|
| `wiki/v2/tree/get_info?wiki_token=` | nodes[](含 space_id) |
| `wiki/v2/tree/get_node?wiki_token=&space_id=` | obj_token / obj_type / title |
| `meta/?token=&type=22` | title / owner / create_time |
| `docx/pages/client_vars?...` | data.block_map / block_sequence / meta_map / (apool) |
| `export/create/` | code / ticket(或 1002 no permission) |
| `export/result/{ticket}` | result.{file_token,file_extension,status,(download_url?)} |
| `box/stream/download/all/{token}/?mount_node_token=` | 二进制 |

## 校验规则

- token 正则:`^[A-Za-z0-9]{16,}$`(未知域名识别门槛)。
- 能力缓存:命中 host 直接选路;P-official 运行期失败 → 删除该 host 缓存后重测。
- 诊断脱敏:打包前删除 `editor_map/user_map/creator_id/owner_id`(深度遍历);`diagnosticIncludeSnapshot=false` 时不含快照。
- 媒体并发 ≤ 3;失败退避重试 ≥ 1 次。

## 状态转换

**ExportProgress.status**: `idle → running →(success | error)`;error 后可重试回到 running。
**MarkdownCapability**: `未知 →(探测)→ supported | unsupported`;supported 运行期失败 → 失效(回未知)→ 重测。
**TrustedDomain**: `未授权 →(用户手势 request)→ 已授权 →(设置页 remove)→ 未授权`。
