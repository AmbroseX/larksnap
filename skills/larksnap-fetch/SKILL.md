---
name: larksnap-fetch
description: 把飞书/Lark 文档或普通网页抓取并保存到本地，也能编辑用户有权限的飞书文档，并用已登录浏览器执行一次网页搜索。用户要求下载、导出、抓取、写入飞书文档，或联网搜索资料/参考链接时使用本技能，即使没有提到 larksnap。底层通过技能自带 daemon 桥接已登录的 larksnap 浏览器扩展；arXiv 使用独立脚本。
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
那个装在 Chrome 里、已登录飞书的扩展(扩展无法塞进技能,只能在浏览器里加载一次,见 references/setup.md)。

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

## 网页搜索

需要搜索资料、找参考链接或从搜索结果继续抓正文时，读取 [references/search.md](references/search.md)。
搜索与 fetch 共用本技能的 daemon 和 bridge，脚本入口是 `scripts/search.mjs`。

## 编辑飞书文档(写入 Markdown 内容)

需要新建、追加、插入、替换、删除或检索飞书文档块时，读取 [references/edit.md](references/edit.md)。
编辑与 fetch 共用本技能的 daemon 和 bridge，脚本入口是 `scripts/edit.mjs`。

## 普通网页与小红书

链接不是飞书文档时,`fetch.mjs` **自动**走普通网页管线(整页转 Markdown),命令不变,**只支持 `md`**,
图片保留外链。小红书有专属适配器,要求登录 + 带 `xsec_token` 的完整分享链接,图片会本地化。
抓普通网页失败、或要抓小红书时,读取 [references/webpage.md](references/webpage.md)。

## arXiv 论文

arXiv 链接或裸 ID **不走 daemon/扩展**,用独立脚本一次下载 PDF + HTML + Markdown:

```bash
node ~/.claude/skills/larksnap-fetch/scripts/arxiv.mjs <arXiv链接或ID> <输出目录> [--pdf-only|--html-only]
```

细节(ID 格式兼容、没有 HTML 版属正常不要重试)见 [references/arxiv.md](references/arxiv.md)。

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

## 错误契约(AI 按此分支,不要解析散文)

**任何非 0 退出时,stderr 的最后一行是一行 JSON**,前面几行是给人读的散文:

```json
{"ok":false,"error":{"type":"authentication","subtype":"need_login","message":"…","hint":"让用户在 Chrome 中打开该文档域名并登录飞书，登录完成后重跑本命令。","retryable":false}}
```

- `hint` = 下一步做什么(命令式,照着执行),**不要自行猜测**;
- `retryable: true` = 直接重跑本命令就可能成功;`false` = 先按 `hint` 行动(通常需要用户操作)再重跑。
- 退出码:`0` 成功 ｜ `1` 失败 ｜ `2` 用法错 ｜ `3` 需登录 ｜ `4` 需授权域名 ｜ `5` 桥接未就绪。

完整的 type/subtype 枚举表与各类错误的真实输出样例,见 [references/errors.md](references/errors.md)。

## 安装与排查

首次装扩展、daemon 连不上、端口冲突、图片缺失、以及扩展侧边栏发起的网页视频下载(需 yt-dlp),
见 [references/setup.md](references/setup.md)。
