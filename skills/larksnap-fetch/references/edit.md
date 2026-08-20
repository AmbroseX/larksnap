# 编辑飞书文档

`edit.mjs` 与 fetch 共用 daemon 和扩展。扩展在后台标签页中通过可信剪贴板、鼠标和按键操作飞书编辑器，由飞书前端完成协同保存。用户必须拥有文档编辑权限。

执行前告知用户：编辑期间会覆盖系统剪贴板；任务执行的几秒内，浏览器顶部会出现“正在调试此浏览器”横幅。

## 命令

```bash
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> new-doc [<md文件>] --name "<标题>"
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs new-doc [<md文件>] --name "<标题>" [--host <已授权域名>]
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs hosts [--profile <code>]
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> append <md文件>
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> insert-after "<标题文本>" <md文件>
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> list-blocks
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> find-blocks "<关键词>" [--regex] [--type <类型前缀>] [--limit N]
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> replace-block <块ID> <md文件> --expect "<内容摘要>"
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> delete-block <块ID> --expect "<内容摘要>"
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> insert-after-block <块ID> <md文件>
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> replace-all <md文件> --expect-first "<首块内容摘要>"
```

写入内容必须先保存为本地 Markdown 文件，再传文件路径；不要把正文放进命令行参数。内容上限为 2MB。仅支持 docx/wiki，不能编辑电子表格或多维表格。

## 新建文档与域名

- `new-doc` 在“我的空间”根目录新建 docx。提供链接时，链接只用于定位租户；Markdown 文件可选。成功输出 `{ok:true,url}`。
- 不提供链接时，从扩展的已授权域名清单定位租户。只有一个域名时自动选择；多个域名必须用 `--host` 指定完整域名或唯一简写。
- `host_ambiguous` 表示简写不唯一；`host_not_authorized` 表示域名未授权；`need_landing_url` 表示缺少租户入口，此时提供该域名下的链接，或让用户先在浏览器打开该域名页面。
- 私有化域名通常有稳定的 `sampleUrl`。公有云 `*.feishu.cn` 可能要求浏览器当前打开对应页面；`my.feishu.cn` 失败时改为显式提供链接。
- `hosts` 输出 `{ok:true,domains:[{host,kind,sampleUrl}]}`。多 profile 时使用 `--profile <code>`。

## 块级操作

先定位再修改。已知关键词时优先使用 `find-blocks`；需要整体结构时使用 `list-blocks`。清单包含 `{id,parentId,type,depth,childCount,summary}`。

- `replace-block` 和 `delete-block` 必须把目标块的 `summary` 原样传给 `--expect`。不要使用 `snippet`。摘要不匹配会报 `block_changed`。
- 删除容器块会连同子块一起删除。执行前检查 `parentId`、`depth` 和 `childCount`。
- `find-blocks` 默认按去空白、忽略大小写的子串匹配完整纯文本；`--regex` 使用 JS `iu` 正则；`--type` 按块类型前缀过滤；`--limit` 默认 20。
- `find-blocks` 返回的 `summary` 可直接用于 `--expect`，`snippet` 只用于确认上下文。零命中退出码仍为 0。
- `insert-after` 精确匹配标题文本。`anchor_ambiguous` 时改用 `insert-after-block`。
- 修改成功后继续进行块操作前，重新运行 `list-blocks`。`replace-block` 会生成新块 ID，新写入内容也没有可复用的旧 ID。

## 整篇替换

`replace-all` 会替换整篇正文，是最危险的编辑操作。必须依次执行：

1. 用 `fetch.mjs` 导出原文档作为本地备份。
2. 用 `list-blocks` 获取第一个块的 `summary`。
3. 将该摘要原样传给 `--expect-first`。

没有备份时不要执行。若报 `block_changed`，重新备份并获取最新块清单。

## 图片与校验

- 图片支持本地路径、HTTP(S) 外链和 data URI；格式支持 png/jpg/jpeg/gif/webp/bmp，不支持 svg/ico。
- 本地相对路径以 Markdown 文件目录为基准。常见错误为 `image_not_found`、`image_fetch_failed`、`image_unsupported`、`image_too_large`。
- 含图片时自动使用 HTML 粘贴，可能把同次写入的 Markdown 表格变成内嵌电子表格。图片和表格尽量分两次写入。
- 成功结果经过回读校验。`save_unconfirmed` 表示内容可能已经写入，不要盲目重试；让用户打开文档人工确认，避免重复写入。

## 错误处理

- 退出码 `6` / `need_edit_permission`：用户只有只读权限，申请或确认编辑权限后重跑。
- 退出码 `7` / `need_edit_grant`：扩展缺少调试权限，更新或重载扩展。
- 退出码 `5` / `extension_outdated`：扩展版本过旧，更新或重新构建扩展。
- `anchor_not_found` / `anchor_ambiguous` / `block_not_found` / `block_changed`：重新定位目标后再操作。
- `save_unconfirmed`：人工确认，不要自动重跑。
- `inject_failed`：按命令输出的 `hint` 排查。
