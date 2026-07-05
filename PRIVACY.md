# 隐私政策 / Privacy Policy

*生效日期 / Effective date: 2026-07-04*

---

## 简体中文

**larksnap · 飞书文档导出助手**(以下简称"本扩展")是一个纯客户端的浏览器扩展。我们高度重视你的隐私。核心原则一句话:**你的文档、Cookie 和身份数据都不会离开你的设备**;唯一的例外是一份可关闭的匿名使用统计,详见下文。

### 本扩展会访问什么

- **Cookie**:仅读取你当前所访问的飞书 / Lark 域名下的登录 Cookie,用于以你的身份、同源地调用飞书网页自身的内部接口来完成导出。
- **文档内容**:你主动点击导出时,当前文档页面的内容。
- **网页内容**:你在普通网页上主动触发「转 Markdown / 解除复制限制 / 自动复制」时,当前标签页的页面内容;转换在本地完成,结果只进你的剪贴板或本地下载。
- **剪贴板**:仅**写入**转换结果(Markdown / 链接文本),从不读取你剪贴板中的既有内容。
- **网站访问权限(host permissions)**:用于在飞书文档页面注入脚本、下载图片与附件。私有化 / 自建域名及普通网页采用可选权限或 activeTab,由你在需要时手势授权。

### 这些数据如何被使用

- 全部处理**只发生在你本地的浏览器中**,用于生成导出文件(Markdown / PDF / HTML)、下载附件、或(可选)通过本地回环 daemon 交给你自己的命令行工具。
- 导出产物通过 Chrome 的下载功能保存到**你自己选择的本地位置**;离线缓存保存在**浏览器本地存储**中。

### 匿名使用统计(可关闭)

为了解功能被使用的情况、决定后续开发方向,本扩展默认会向开发者自建的 [Umami](https://umami.is)(开源统计系统)实例上报**匿名**使用事件:

- **上报什么**:功能事件名(如"导出"、"网页复制")、导出格式(markdown/pdf 等)、成功与否、耗时秒数、扩展版本号。
- **绝不上报**:文档内容、文档标题、文档链接、所在域名、Cookie、登录态、用户名、邮箱、文件名——任何能识别你或你的文档的信息都不会离开设备。
- **无追踪标识**:不生成、不存储任何设备 ID 或 Cookie;Umami 仅按"IP + 浏览器类型"做当日去重,次日即无法关联。
- **如何关闭**:扩展设置页取消勾选「匿名使用统计」,立即生效。

### 我们不会做什么

- **不**将你的文档内容、Cookie、登录态发送到开发者或任何第三方的服务器。
- 除上述匿名使用统计外,**不**做任何埋点、追踪或广告。
- **不**出售或分享任何数据。

### 可选的本地桥接

若你启用命令行桥接功能,会有一个仅绑定 `127.0.0.1`(本机回环)的本地 daemon,用于把导出任务从你的命令行工具转交给扩展。它不监听外部网络,数据不出本机。

### 联系方式

问题或反馈请提交 issue:<https://github.com/AmbroseX/larksnap/issues>

---

## English

**larksnap** (the "Extension") is a fully client-side browser extension. We take your privacy seriously. In one sentence: **your documents, cookies and identity never leave your device**; the only exception is an anonymous, opt-out usage statistic described below.

### What the Extension accesses

- **Cookies**: only the login cookies of the Feishu / Lark domain you are currently visiting, used to call Feishu's own internal web APIs same-origin, as you, to perform the export.
- **Document content**: the content of the current document page, only when you explicitly click export.
- **Web page content**: the content of the current tab, only when you explicitly trigger "→ Markdown / unlock copy protection / auto-copy" on an ordinary page; conversion happens locally and the result only goes to your clipboard or a local download.
- **Clipboard**: **write-only** — the extension writes conversion results (Markdown / link text) and never reads what's already on your clipboard.
- **Host permissions**: used to inject scripts on Feishu doc pages and download images/attachments. Private / self-hosted domains and ordinary pages use optional permissions or activeTab, granted by you on demand.

### How the data is used

- All processing happens **entirely in your local browser**, to produce export files (Markdown / PDF / HTML), download attachments, or (optionally) hand the job to your own command-line tool via a local loopback daemon.
- Exports are saved via Chrome's downloads to **a local location you choose**; offline cache is stored in **browser local storage**.

### Anonymous usage statistics (opt-out)

To understand which features are used and prioritize development, the Extension by default reports **anonymous** usage events to a self-hosted instance of [Umami](https://umami.is) (an open-source analytics system) operated by the developer:

- **What is reported**: feature event names (e.g. "export", "webcopy"), export format (markdown/pdf, …), success or failure, duration in seconds, and the extension version.
- **Never reported**: document content, titles, URLs, hostnames, cookies, login state, usernames, emails, file names — nothing that could identify you or your documents ever leaves your device.
- **No tracking identifier**: no device ID or cookie is generated or stored; Umami deduplicates visitors per day by IP + browser type only, so events cannot be linked across days.
- **How to opt out**: uncheck "Anonymous usage statistics" on the extension's options page; it takes effect immediately.

### What we do NOT do

- We do **not** send your document content, cookies, or login state to the developer's or any third party's servers.
- Apart from the anonymous usage statistics above, we do **not** perform any tracking or advertising.
- We do **not** sell or share any data.

### Optional local bridge

If you enable the command-line bridge, a local daemon bound to `127.0.0.1` (loopback only) relays export jobs from your CLI tool to the extension. It does not listen on any external network; data never leaves your machine.

### Contact

For questions or feedback, please open an issue: <https://github.com/AmbroseX/larksnap/issues>
