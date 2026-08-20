# 错误契约与示例输出

**任何非 0 退出时,stderr 的最后一行是一行 JSON**,前面几行是给人读的散文:

```json
{"ok":false,"error":{"type":"authentication","subtype":"need_login","message":"需要登录：浏览器里没有该域名的飞书登录态。","hint":"让用户在 Chrome 中打开该文档域名并登录飞书，登录完成后重跑本命令。","retryable":false}}
```

- `message` = 哪里错了(给人读);`hint` = 下一步做什么(命令式,照着执行);
- `retryable: true` = 不用改任何东西,直接重跑本命令就可能成功;`false` = 先按 `hint` 行动(通常需要用户操作),再重跑。
- `type`/`subtype` 是闭合枚举,退出码由 subtype 派生:

| 退出码 | type | subtype | 处理 |
|---|---|---|---|
| 2 | usage | `bad_args` / `profile_not_found` / `profile_ambiguous` / `host_ambiguous` | 修正命令行参数(如加/改 `--profile`、`--host`)后重跑 |
| 2 | edit | `need_landing_url` | 该域名暂无可用租户入口:这一次喂个该域名下的链接,或让用户打开一个该域名页面后重跑 |
| 3 | authentication | `need_login` | 让用户在 Chrome 登录该域名的飞书,确认后重跑 |
| 4 | authentication | `need_domain_auth` | 让用户在扩展侧边栏点「授权该域名」,确认后重跑 |
| 4 | usage | `host_not_authorized` | `--host` 不在已授权清单:换清单里的域名,或让用户先授权该域名 |
| 5 | bridge | `daemon_missing` / `daemon_spawn_failed` / `daemon_timeout` / `bridge_request_failed` / `extension_not_connected` / `extension_outdated` / `extension_timeout` / `signature_invalid` | 按 hint 修桥接(多为唤醒/更新扩展)后重跑 |
| 1 | export | `export_failed` / `write_failed` / `no_result` / `unexpected` | 按 hint 处理 |

# 示例输出

成功(退出码 0,stdout):

```
✓ 已导出到 /Users/me/notes/无监督数据修复
   - 无监督数据修复/无监督数据修复.md
   - 无监督数据修复/images/boxcnAbc123.png
```

需登录(退出码 3,stderr):

```
✗ 需要登录：浏览器里没有该域名的飞书登录态。
  → 让用户在 Chrome 中打开该文档域名并登录飞书，登录完成后重跑本命令。
{"ok":false,"error":{"type":"authentication","subtype":"need_login","message":"需要登录：浏览器里没有该域名的飞书登录态。","hint":"让用户在 Chrome 中打开该文档域名并登录飞书，登录完成后重跑本命令。","retryable":false}}
```

扩展未连接(退出码 5,stderr):

```
✗ 扩展未连接：请确认 Chrome 已打开并加载 larksnap 扩展，点一下图标唤醒后台后重试。
  → 确认 Chrome 已打开并加载 larksnap 扩展，点一下扩展图标唤醒后台，然后重跑本命令。
{"ok":false,"error":{"type":"bridge","subtype":"extension_not_connected","message":"...","hint":"...","retryable":true}}
```

多 profile 需指定(退出码 2,stderr):

```
✗ 检测到多个浏览器 profile（a1b2c3, d4e5f6），请用 --profile <code> 指定其一。
  → 加 --profile <code> 指定用哪个浏览器 profile（code 见扩展弹窗，可点 Copy 复制），然后重跑本命令。
{"ok":false,"error":{"type":"usage","subtype":"profile_ambiguous","message":"...","hint":"...","retryable":false}}
```
