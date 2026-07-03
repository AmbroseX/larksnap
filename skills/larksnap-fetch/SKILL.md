---
name: larksnap-fetch
description: 把一个飞书/Lark 文档链接抓取并保存到本地目录（Markdown/PDF/HTML + 图片附件）。当用户在任意项目里贴出飞书文档 URL 并希望下载/保存/导出/拉取/抓取到本地某路径时,务必使用本技能,即使用户没明说"用 larksnap"或"用扩展"。底层通过本地 daemon 桥接到已登录的 larksnap 浏览器扩展,扩展持有登录态与导出引擎;遇到未登录/未授权域名时会按退出码提示用户去浏览器登录或授权。本技能自包含(daemon 随技能分发),可从任何项目调用,不依赖 larksnap 仓库。
---

# larksnap-fetch

在任意项目的 Claude Code 里「扔一个飞书链接 → 落到本地目录」。本技能不直接请求飞书,而是把任务
交给已登录的 **larksnap 浏览器扩展**(它持有 cookie 与导出引擎)。

```
CC ──fetch.mjs(一次性)──HTTP /command──▶ daemon ──WebSocket──▶ Chrome 扩展
                                          ▲ 127.0.0.1:19925     └ 后台开标签页跑导出
                                          └ 流式回传进度/产物 ──▶ 解包到 <输出目录>/<文档名>/
```

**本技能自包含**:`daemon` 与协议代码已随技能打包在 `scripts/bridge/` 里,`fetch.mjs` 拉起的是
技能内部那份 daemon,**不依赖 larksnap 仓库的目录结构**,因此可从任何项目调用。唯一的外部依赖是
那个装在 Chrome 里、已登录飞书的扩展(扩展无法塞进技能,只能在浏览器里加载一次,见「首次安装」)。

**每篇文档落到自己的子文件夹**(以文档标题命名),不和其它文件平铺混在一起:

```
<输出目录>/
└── 无监督数据修复/          ← 文档标题命名的文件夹
    ├── 无监督数据修复.md
    └── images/              ← 图片用相对路径内联引用
        └── xxx.png
```

- **扩展是 WS 客户端,主动连出**到本地 daemon —— 无 native messaging、无系统级安装。
- **daemon 由本技能按需自动拉起**、持久存活(空闲 30 分钟自退),只绑 `127.0.0.1`。
- **fetch.mjs 一次性**:跑完即退,不常驻。

## 用法

```bash
node ~/.claude/skills/larksnap-fetch/scripts/fetch.mjs <飞书链接> <输出目录> [--format md|pdf|html] [--profile <code>]
```

- `<输出目录>` 是**父目录**;产物会落到 `<输出目录>/<文档名>/` 子文件夹里(每篇文档独立成夹,互不混淆)。
- `--format` 缺省 `md`。`md`/`html` 会把图片下载并以相对路径内联到该子文件夹的 `images/`;`pdf` 视租户能力而定。
- 进度打到 stderr,结果路径打到 stdout(`✓ 已导出到` 后是该文档的子文件夹绝对路径)。
- `--profile <code>`:当有多个浏览器 profile 同时连到 daemon 时,指定用哪一个(code 见扩展弹窗的 Profile,可点 Copy 复制)。只有一个时无需指定。

退出码:`0` 成功 ｜ `1` 失败 ｜ `2` 用法错 ｜ `3` 需登录 ｜ `4` 需授权域名 ｜ `5` 桥接未就绪。

## 错误契约(AI 按此分支,不要解析散文)

**任何非 0 退出时,stderr 的最后一行是一行 JSON**,前面几行是给人读的散文:

```json
{"ok":false,"error":{"type":"authentication","subtype":"need_login","message":"需要登录：浏览器里没有该域名的飞书登录态。","hint":"让用户在 Chrome 中打开该文档域名并登录飞书，登录完成后重跑本命令。","retryable":false}}
```

- `message` = 哪里错了(给人读);`hint` = 下一步做什么(命令式,照着执行);
- `retryable: true` = 不用改任何东西,直接重跑本命令就可能成功;`false` = 先按 `hint` 行动(通常需要用户操作),再重跑。
- `type`/`subtype` 是闭合枚举,退出码由 subtype 派生:

| 退出码 | type | subtype | 处理 |
|---|---|---|---|
| 2 | usage | `bad_args` / `profile_not_found` / `profile_ambiguous` | 修正命令行参数(如加/改 `--profile`)后重跑 |
| 3 | authentication | `need_login` | 让用户在 Chrome 登录该域名的飞书,确认后重跑 |
| 4 | authentication | `need_domain_auth` | 让用户在扩展侧边栏点「授权该域名」,确认后重跑 |
| 5 | bridge | `daemon_missing` / `daemon_spawn_failed` / `daemon_timeout` / `bridge_request_failed` / `extension_not_connected` / `signature_invalid` | 按 hint 修桥接(多为唤醒扩展)后重跑 |
| 1 | export | `export_failed` / `write_failed` / `no_result` / `unexpected` | 按 hint 处理 |

## 示例输出

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

## 执行流程(CC 按此操作)

1. 直接运行上面的命令(用户给的链接 + 用户指定的本地目录;用户没指定目录时,默认落到当前工作目录)。daemon 会被自动拉起。
2. 非 0 退出 → 解析 stderr 最后一行 JSON,按 `hint` 执行,不要自行猜测:
   - `retryable: true` → 按 hint 做完(如点扩展图标唤醒)直接重跑同一条命令,同样的错误连续出现 2 次就停下问用户。
   - `retryable: false` → hint 里需要用户操作的(登录/授权域名),把 hint 转述给用户,等用户确认完成后重跑。
3. 退出码 0 → 把 stdout 里列出的写入文件告诉用户(路径形如 `<文档名>/<文档名>.md`)。
   产物在 `<输出目录>/<文档名>/` 子文件夹里(`md` 含 `images/` 子目录用相对路径引用),每篇文档独立成夹。

### 完整工作流示例(未登录 → 自愈 → 成功)

```
第 1 步  node .../fetch.mjs https://xxx.feishu.cn/docx/AbCd... ./notes
        → 退出码 3,JSON: {"subtype":"need_login","hint":"让用户在 Chrome 中打开该文档域名并登录飞书…"}
第 2 步  对用户说:「需要先在 Chrome 里登录 xxx.feishu.cn 的飞书,登录好了告诉我。」
第 3 步  用户确认后,原样重跑第 1 步命令
        → 退出码 0,stdout 列出写入文件 → 告诉用户产物路径,结束。
```

## 首次安装(仅一次,只需加载扩展,无系统级安装)

扩展来自 larksnap 仓库(本技能不含扩展本体,只含桥接 daemon):

1. 在 larksnap 仓库根 `npm run build`。
2. 到 `chrome://extensions` 开「开发者模式」→「加载已解压的扩展程序」选 `dist/`。
3. 点一下扩展图标唤醒后台 Service Worker —— 它会自动连本地 daemon(daemon 由首次 `fetch.mjs` 拉起)。

> 不需要绑扩展 ID、不写任何系统清单。换机器只要重复这三步(再把本技能目录拷到新机器的 `~/.claude/skills/`)。

## 排查

- `~/.larksnap/daemon.log` 看 daemon 是否在 listen、扩展是否连上、任务是否派发;`~/.larksnap/daemon.pid` 是在监听实例的 PID。
- 连不上:确认 Chrome 开着、扩展已加载;扩展后台休眠时第一条命令可能要等它经 `/ping` 重连(alarms ~24s),点一下扩展图标可立即唤醒。
- 端口冲突:daemon 默认 `127.0.0.1:19925`,可用环境变量 `LARKSNAP_PORT` 改(需与扩展 `src/background/bridge.ts` 里的 `PORT` 一致)。
- 图片缺失/某域名导出失败:多为未按「基础域通配」授权该域名(含图片 drive-stream 子域),在侧边栏重新授权。
- 版本漂移:fetch.mjs 发现在跑的 daemon 版本和本技能不一致时会**自动重启**到自己带的版本(装在多个项目的旧技能不会悄悄坏掉,但旧技能副本建议也更新);扩展和 daemon 的 WS 握手互报协议版本,不一致时 popup 会提示更新。
- 安全:daemon 只绑回环、校验 Origin(非 `chrome-extension://` 拒)+ 要求 `X-Larksnap` 头,挡掉网页 CSRF;CLI→daemon 的请求另有 **HMAC-SHA256 签名**(key 在 `~/.larksnap/secret`,0600,首次自动生成;签名覆盖时间戳/method/path/body 摘要,60s 防重放,无回落),挡掉本机其他身份的冒充。扩展侧 WS 读不了 key 文件,维持 Origin 校验(已知局限)。
