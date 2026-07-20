---
name: larksnap-fetch
description: 把一个飞书/Lark 文档链接或普通网页链接抓取并保存到本地目录（飞书文档支持 Markdown/PDF/HTML + 图片附件;普通网页只支持 Markdown,图片保留外链）,也能在用户的飞书空间里新建文档,或把 Markdown 内容写进用户有编辑权限的飞书文档（新建/追加/按标题或块插入/替换块/删除块,先 list-blocks 看清块结构再动手）。arXiv 论文（贴链接或裸 ID 均可）走独立脚本,把 PDF、HTML 和转好的 Markdown 一起下载,不依赖浏览器扩展。当用户在任意项目里贴出飞书文档或任意网页 URL 并希望下载/保存/导出/拉取/抓取到本地某路径,或希望把内容写入/追加/更新到某篇飞书文档时,务必使用本技能,即使用户没明说"用 larksnap"或"用扩展"。底层通过本地 daemon 桥接到已登录的 larksnap 浏览器扩展,扩展持有登录态与导出/编辑引擎;遇到未登录/未授权域名时会按退出码提示用户去浏览器登录或授权。本技能自包含(daemon 随技能分发),可从任何项目调用,不依赖 larksnap 仓库。
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

## 编辑飞书文档(写入 Markdown 内容)

`edit.mjs` 是 fetch 的姊妹动作,共用同一个 daemon 与扩展:扩展在后台标签页里**像用户一样把内容
粘贴进飞书编辑器**(CDP 可信输入:真实剪贴板 + 可信鼠标点击/按键),协同保存由飞书前端自己完成。
前提:用户在浏览器里对该文档有**编辑权限**。两个副作用要让用户知道:**编辑期间会占用系统剪贴板**
(写入内容会覆盖用户当前复制的东西);任务执行的几秒内浏览器顶部会出现"正在调试此浏览器"横幅,结束即消失。

```bash
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> new-doc [<md文件>] --name "<标题>"
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs new-doc [<md文件>] --name "<标题>" [--host <已授权域名>]  # 免链接
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs hosts [--profile <code>]   # 已授权域名清单(只读)
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> append <md文件>
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> insert-after "<标题文本>" <md文件>
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> list-blocks
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> find-blocks "<关键词>" [--regex] [--type <类型前缀>] [--limit N]
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> replace-block <块ID> <md文件> --expect "<内容摘要>"
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> delete-block <块ID> --expect "<内容摘要>"
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> insert-after-block <块ID> <md文件>
node ~/.claude/skills/larksnap-fetch/scripts/edit.mjs <链接> replace-all <md文件> --expect-first "<首块内容摘要>"
```

- **写入内容一律先写进本地 md 文件**再把文件路径传给命令(不走命令行参数,避免转义和长度问题);上限 2MB。
- **`new-doc` 新建文档**:在**我的空间根目录**建一篇 docx。这里的 `<链接>` 只用来定位"在哪个租户/
  域名下建"——传该租户的网盘首页(`/drive/me/`)或任意一篇文档链接都行。`<md文件>` 可选:给了就
  建完自动把内容写进去(复用 append),不给就建一篇空文档。`--name` 设标题(不给为未命名)。成功
  输出 `{ok:true, url}`,`url` 是新文档地址,可直接接着 `fetch` 或继续编辑。只建 docx(公私云通用)。
- **`new-doc` 可以不喂链接**:省略 `<链接>` 时自动用扩展的「已授权域名清单」定位在哪建——
  只有一个已授权域名直接用它;多个则必须 `--host <域名>` 指定(收完整基础域或**唯一**简写,
  多义报 `host_ambiguous`、不在清单报 `host_not_authorized`,错误里都附完整可选清单)。
  `--host` 只配合免链接的 new-doc;其他操作(append/insert-after/…)仍必须提供文档链接。
  **私有化域名比公有云稳**:用户在侧边栏授权私有域名的那一刻,扩展会记下真实租户入口;公有云
  (feishu.cn 等)没有授权动作可捕获,只有正开着某个 `*.feishu.cn` 标签时才能兜底定位。报
  `need_landing_url` 时按提示办:这一次按旧用法喂个该域名下的链接,或让用户先在浏览器打开
  一个该域名页面(或重新授权一次)再重跑。个人版 `my.feishu.cn` 接口有差异,`--host my.feishu.cn`
  不保证一次成功,失败按提示走旧用法。
- **`hosts` 查看已授权域名清单**(只读):输出 `{ok:true, domains:[{host,kind,sampleUrl}]}`——
  `kind` 是 builtin(公有云内置)/trusted(用户授权的私有域名),`sampleUrl` 非空表示该域名
  可免链接建档。多浏览器 profile 时加 `--profile <code>`。若报 `extension_outdated`,是浏览器
  里的扩展版本太旧(桥接协议 <v4),让用户重新构建/更新并在 chrome://extensions 重载扩展。
- 只支持 docx / wiki 文档;电子表格、多维表格不支持编辑。
- **块级操作先定位再动手**:知道要找什么内容(尤其长文档)优先 `find-blocks`,只回命中的块;
  需要看整体结构才用 `list-blocks` 全量输出 `{blocks:[{id,parentId,type,depth,childCount,summary}]}`,
  `summary` 是块内容前 80 字。`replace-block`/`delete-block` 必须带 `--expect "<摘要>"`(原样复制
  list-blocks / find-blocks 输出里目标块的 `summary`)——扩展执行前比对该块当前内容,对不上报
  `block_changed`,防止文档被并发修改后改错/删错块。删除容器块(列表/引用等)会连同其子块一起删,
  动手前用 `parentId`/`depth`/`childCount` 确认不会误删一整节。
- **`find-blocks` 按内容检索块**(只读):在块的**完整纯文本**上匹配(不受 summary 80 字限制),
  默认「去空白+忽略大小写」子串,`--regex` 按 JS 正则(`iu` 旗标)原文匹配;`--type <前缀>` 按块
  类型过滤(如 `--type heading` 只搜标题);`--limit N` 控制最多返回条数(默认 20)。输出
  `{total,shown,blocks:[{...,summary,snippet}]}`:`total > shown` 说明命中被截断,换更具体的
  关键词;`summary` 与 list-blocks 逐字一致**可直接当 `--expect` 用**,`snippet` 是命中处
  前后各 40 字上下文(命中词用【】标出)只用于确认块找对了,**不要拿去填 `--expect`**。
  零命中返回 `total: 0`,退出码 0,不算错误。要搜以 `--` 开头的内容,用 `--regex` 加转义。
  若报「未知编辑操作」,是浏览器里的扩展版本太旧,让用户重载/更新扩展。
- `insert-after` 按标题文本**精确匹配**:找不到报 `anchor_not_found`,多于一个报 `anchor_ambiguous`
  (此时改用 `insert-after-block` 以块 ID 定位)。
- **`replace-all` 是最危险的操作(整篇正文替换,文档标题保留)**,流程必须是:
  ① 先 `fetch.mjs` 把原文档导出到本地做备份;② `list-blocks` 取输出**第一个块**的 `summary`;
  ③ 原样作为 `--expect-first` 传入。扩展执行前比对当前文档首块,对不上报 `block_changed`
  (说明文档已被改过,重新走 ①②)。没有备份就不要执行 replace-all。
- **图片写入**:md 里的 `![](图片)` 支持三种来源——本地路径(相对路径以 md 文件所在目录为
  基准)、外链 http(s)(自动下载后内嵌)、data URI。格式只收 png/jpg/jpeg/gif/webp/bmp
  (svg/ico 飞书会静默丢弃,CLI 直接报 `image_unsupported`)。图片内嵌后整体超 2MB 报
  `image_too_large`(压缩图片或拆分写入);外链下载失败报 `image_fetch_failed`;本地文件
  缺失报 `image_not_found`。**含图片的写入自动切换为 HTML 粘贴口味**(飞书只认 HTML 粘贴
  里的 data URI 图片),副作用:同一次写入里的 md 表格会贴成内嵌电子表格而非原生表格——
  图片和表格尽量分两次写入。纯图片写入(没有文字)的回读校验用 image 块数量净增判定。
- 写入成功的判定是**回读校验**:编辑后重新导出全文,确认新内容已落地才回成功。报
  `save_unconfirmed` 时内容可能已进文档,**不要盲目重跑**(可能写两次),让用户打开文档人工确认。
- **编辑成功后想继续做块级操作,先重新 `list-blocks`**。飞书的块按 ID 寻址,没被动过的块
  ID 编辑后依然有效,但有两类引用一定作废:① `replace-block` 会换块 ID(飞书按"删旧块+
  插新块"处理),旧 ID 直接失效;② 刚写入的内容你手里没有它的块 ID。拿旧清单硬做会撞上
  `block_not_found` / `block_changed`,重跑一次 `list-blocks` 最省事。
- 编辑专属退出码:`6` = 已登录但对该文档只读(`need_edit_permission`),让用户在浏览器里确认/申请
  编辑权限后重跑;`7` = 扩展缺少调试权限(`need_edit_grant`,一般是装了不带编辑功能的旧版扩展),
  让用户更新/重载扩展。其余退出码与 fetch.mjs 相同。
- 编辑专属错误 subtype(退出码 1):`anchor_not_found` / `anchor_ambiguous` / `block_not_found` /
  `block_changed`(重新 list-blocks 后重试) / `save_unconfirmed`(人工确认) / `inject_failed`。
- `extension_outdated`(退出码 5):扩展版本太旧不支持编辑,让用户更新/重新构建扩展。

## 普通网页转 Markdown

链接不是飞书文档时,自动走「普通网页」管线:后台开标签页 → 整页正文提取(Readability)→ 转 Markdown。

- **只支持 `md`**:请求 `--format pdf/html` 会直接报错,不会开标签页。
- 产物是**单个 `.md` 文件**,落到 `<输出目录>/<页面标题>/<页面标题>.md`;
  **图片保留为外链绝对 URL**(`https://...`),不下载到本地(与飞书文档不同,没有 `images/` 目录;例外:小红书的图片会本地化,见下节)。
- 未授权域名时退出码 `4`,提示用户在该网页的扩展侧边栏点「授权访问该域名」后重跑。
- 前端渲染型页面(SPA)可能因页面加载策略抓到不完整正文,属已知局限;静态文章页效果最好。

### 小红书笔记(xiaohongshu.com)

小红书走专属适配器(通用管线在小红书页面只能抓到导航壳),额外要求:

- **用户需先在 Chrome 登录小红书**(笔记详情页必须持登录态),未登录退出码 `3`,提示会带上 `xiaohongshu.com`;
- 需授权 `xiaohongshu.com` 域名(首次退出码 `4` 按提示授权);
- **必须用带 `xsec_token` 的完整分享链接**(App/网页版「分享」复制出来的链接自带;裸 `/explore/<id>` 链接已不可达);`xhslink.com` 短链可直接用,会自动跳到完整链接;
- 产物 Markdown 含标题、作者、发布时间、互动数、正文、图片、标签;**图片会下载到本地** `images/` 并改写为相对路径(小红书 CDN 链接有时效签名,放着会过期;单张下载失败会保留外链不影响整体);**视频保留外链**不下载,直链签名可能过期,需尽快另存。

## arXiv 论文下载(PDF + HTML + Markdown 一起落地)

链接或 ID 指向 arXiv 论文时,**不走 daemon/扩展**(arXiv 完全公开,不需要登录态),改用独立脚本直接下载:

```bash
node ~/.claude/skills/larksnap-fetch/scripts/arxiv.mjs <arXiv链接或ID> <输出目录> [--pdf-only|--html-only]
```

- 链接和 ID 全兼容:裸 ID(`2601.18226`)、`arXiv:` 前缀、`arxiv.org` 的 abs/pdf/html 三种链接(含 `.pdf` 后缀、`v2` 版本号)、老式 ID(`math.GT/0309136`,做目录名时斜杠替换为下划线)。
- 产物同样独立成夹,文件夹用 ID 命名:`<输出目录>/2601.18226/2601.18226.pdf` + `.html` + `.md`。
- HTML 里注入了 `<base>`,图片/样式解析回 arxiv.org 绝对地址,本地打开不裂图(图片本身不下载到本地)。
- Markdown 由 HTML 就地转换,**零外部依赖**(turndown 打包在 `scripts/vendor/` 里,不需要 pandoc):公式用 LaTeXML 自带的 alttext 还原成 `$...$`/`$$...$$`,图片/引用链接为 arxiv.org 绝对地址;复杂表格以内嵌 HTML 保留。转换失败只影响 `.md`,PDF/HTML 照常落地。
- **部分论文没有 HTML 版属正常**(arXiv 只为有 LaTeX 源且转换成功的论文提供 HTML,老论文也可能已被回补):此时只落 PDF,退出码仍为 0,stderr 有 `ℹ` 提示——**不要当成失败重试**。
- 退出码:`0` 成功 ｜ `1` 失败 ｜ `2` 用法错;错误契约与 fetch.mjs 相同(非 0 退出时 stderr 最后一行是一行 JSON,按 `hint` 分支)。

## 网页视频下载(daemon 顺带承载,不走 CLI)

daemon(v1.4.0 / 协议 v3 起)还承载一条**扩展发起**的反向任务:用户在视频站点(B 站/YouTube/
抖音/TikTok)的扩展侧边栏点「下载视频」,扩展把页面 URL 经 WS 交给 daemon,daemon 在本机跑
`yt-dlp` 下载合并,落到 `~/Downloads/larksnap-video/`,进度推回侧边栏显示。

- **本功能没有 CLI 入口**,触发点只在扩展侧边栏;本技能的职责是把新版 daemon 分发出去。
- **额外依赖 `yt-dlp` 和 `ffmpeg`**(仅视频下载用到,抓取/编辑飞书文档不需要):
  macOS `brew install yt-dlp ffmpeg`;Windows `winget install yt-dlp.yt-dlp Gyan.FFmpeg`。
  缺失时侧边栏会收到明确的安装提示,不影响其他功能。
- daemon 是旧版时,侧边栏的下载按钮会提示更新本技能;更新技能文件后杀掉旧 daemon
  (`pkill -f bridge/daemon.mjs` 或等它空闲自退)即可。

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
| 2 | usage | `bad_args` / `profile_not_found` / `profile_ambiguous` / `host_ambiguous` | 修正命令行参数(如加/改 `--profile`、`--host`)后重跑 |
| 2 | edit | `need_landing_url` | 该域名暂无可用租户入口:这一次喂个该域名下的链接,或让用户打开一个该域名页面后重跑 |
| 3 | authentication | `need_login` | 让用户在 Chrome 登录该域名的飞书,确认后重跑 |
| 4 | authentication | `need_domain_auth` | 让用户在扩展侧边栏点「授权该域名」,确认后重跑 |
| 4 | usage | `host_not_authorized` | `--host` 不在已授权清单:换清单里的域名,或让用户先授权该域名 |
| 5 | bridge | `daemon_missing` / `daemon_spawn_failed` / `daemon_timeout` / `bridge_request_failed` / `extension_not_connected` / `extension_outdated` / `extension_timeout` / `signature_invalid` | 按 hint 修桥接(多为唤醒/更新扩展)后重跑 |
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
