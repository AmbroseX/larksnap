# LarkSnap · 文档导出 · 网页剪藏 · 截图总结

**简体中文** | [English](README.en.md)

> Chrome 扩展：飞书 / Lark 文档一键导出 **Markdown / PDF / HTML**、批量下载附件、离线缓存，还能把 Markdown **写回文档**；任意网页（含小红书笔记）**一键转 Markdown**、整页截图、AI 总结、解除复制限制；下载 **B 站 / YouTube / 抖音 / TikTok** 视频。

零配置、纯客户端、内容不外发，**兼容企业私有化自建域名**。不用去开放平台建应用、申请 API 权限 —— 直接复用浏览器里已登录的 Cookie 和飞书网页自身的内部接口。

<p>
  <a href="https://chromewebstore.google.com/detail/larksnap-%C2%B7-%E9%A3%9E%E4%B9%A6%E6%96%87%E6%A1%A3%E5%AF%BC%E5%87%BA%E5%8A%A9%E6%89%8B/gepndmikbdjpdedkfiejchmhmhegjeal"><img alt="chrome web store" src="https://img.shields.io/chrome-web-store/v/gepndmikbdjpdedkfiejchmhmhegjeal?label=Chrome%20Web%20Store&color=blue"></a>
  <img alt="manifest" src="https://img.shields.io/badge/Manifest-V3-4285F4">
  <img alt="stack" src="https://img.shields.io/badge/React%2018%20%2B%20Vite%20%2B%20TypeScript-3178C6">
  <img alt="license" src="https://img.shields.io/badge/license-Apache%202.0-green">
</p>

## 安装

### 方式一：Chrome 商店（推荐，自动更新）

直接到 [Chrome 应用商店](https://chromewebstore.google.com/detail/larksnap-%C2%B7-%E9%A3%9E%E4%B9%A6%E6%96%87%E6%A1%A3%E5%AF%BC%E5%87%BA%E5%8A%A9%E6%89%8B/gepndmikbdjpdedkfiejchmhmhegjeal) 一键安装，后续版本自动更新。

### 方式二：手动加载

到 [Releases](https://github.com/AmbroseX/larksnap/releases) 下载最新 zip 并解压，然后：

1. 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择解压出来的目录

图文步骤见 **[安装与使用教程](docs/安装与使用教程.md)**。想从源码构建的看文末[「开发」](#开发)一节。

## 使用

### 入口与快捷键

- **工具栏图标**：点一下直接打开侧边栏（不再有中间弹窗）；与命令行桥接的连接状态看侧边栏顶部的状态圆点（绿=已连接 / 黄=连接中 / 灰=未连接，点开可复制 Profile）。
- **右键菜单**：所有动作收在 `LarkSnap` 父菜单下——普通网页有整页/选区转 Markdown、整页截图、AI 总结、解除复制限制；飞书文档页另有「导出为 Markdown / PDF / HTML」。
- **键盘快捷键**（可在 `chrome://extensions/shortcuts` 修改）：

| 动作 | 默认键 |
|---|---|
| 打开侧边栏 | `Ctrl/Cmd+Shift+L` |
| 当前页转 Markdown 并复制 | `Ctrl/Cmd+Shift+M` |
| 整页截图（PNG） | `Ctrl/Cmd+Shift+S` |
| AI 总结本页 | 默认未设键，可自行配置 |

右键/快捷键触发的动作结束后，扩展图标会出现绿 ✓ / 红 ! 角标；失败原因打开侧边栏即可查看。侧边栏本身是"当前页功能置顶 + 通用工具常驻"的布局：任何页面都能看到剪藏、截图、AI 总结、页面开关四组通用工具。

### 导出飞书文档

1. 浏览器里正常登录飞书 / Lark（公有云或私有化域名均可）。
2. 打开文档页（`docx` / `wiki` / `sheet` 等），点扩展图标打开侧边栏。
   - 私有化域名首次使用会提示授权，点一下按钮即可。
3. 在操作清单里点你要的动作：

| 操作 | 说明 |
|---|---|
| 导出为 Markdown | 保留标题 / 表格 / 代码块 / 公式等结构，图片打包成 `.zip` |
| 导出为 PDF / HTML | PDF 高清渲染；HTML 单文件内联资源 |
| 导出附件 | 批量下载文档中的图片和文件 |
| 缓存到本地 | 离线快照与管理 |
| 导出诊断信息 | 定位私有化格式差异（已脱敏） |

即使租户关闭了官方导出，扩展也会自动切换到自解码通道完成导出（会先提示，**请仅在获得授权的前提下使用**）。

### 网页复制（非飞书页面）

在任意网页打开侧边栏，或直接用页面右键菜单：

| 操作 | 说明 |
|---|---|
| 整页 / 选中内容转 Markdown | 复制或下载 `.md`，百度文库等站点有专属适配 |
| 解除复制限制 | 解锁禁止选择 / 复制 / 右键的页面，可随时关闭恢复原状 |
| 选中文字自动复制 | 选中即进剪贴板，阈值和格式可在设置页调 |
| 复制标签页链接 | 当前页或全部标签页，支持 Markdown 链接等四种格式 |

### 下载网页视频（B 站 / YouTube / 抖音 / TikTok）

在支持的视频页打开侧边栏，点「下载当前视频」：扩展把页面地址交给本地 daemon，由本机的
`yt-dlp` 下载合并，落到 `~/Downloads/larksnap-video/`，进度实时显示在侧边栏底部。

前提：装好 larksnap-fetch 技能（daemon 随技能分发，见下节）并跑过一次让 daemon 拉起，
本机装有 `yt-dlp` 和 `ffmpeg`（macOS：`brew install yt-dlp ffmpeg`）。

### 在 Claude Code 里用（larksnap-fetch 技能）

装好扩展后，再装一个技能，就能在 Claude Code 里贴飞书链接直接下载到本地：

```bash
npx skills add AmbroseX/larksnap --skill larksnap-fetch -g -a claude-code
```

然后在 Claude Code 里说：

> 把 `https://your-company.feishu.cn/docx/xxxxxxxx` 下载到 `./docs`

产物按文档标题独立成夹，图片以相对路径内联引用。前提：本机有 Node.js，且扩展已加载进 Chrome（登录态和导出引擎都在扩展里）。详见 [`skills/larksnap-fetch/SKILL.md`](skills/larksnap-fetch/SKILL.md)。

### 下载 arXiv 论文（PDF + HTML + Markdown）

技能里附带独立脚本，贴 arXiv 链接或裸 ID 就把三种格式一起下载，**不需要浏览器扩展，也不需要 pandoc**（转换器已打包在技能里）：

> 下载 `https://arxiv.org/abs/2601.18226` 到 `./papers`

也可以直接跑命令：

```bash
node ~/.claude/skills/larksnap-fetch/scripts/arxiv.mjs 2601.18226 ./papers
```

- 链接和 ID 全兼容：裸 ID、`arXiv:` 前缀、abs / pdf / html 三种链接、老式 ID（`math.GT/0309136`）。
- 产物落在 `./papers/2601.18226/` 下：`.pdf` + `.html`（本地打开不裂图）+ `.md`（公式还原为 `$...$`，图片为 arxiv.org 外链）。
- 部分论文没有 HTML 版属正常，此时只落 PDF 并在输出里提示。

## 开发

```bash
git clone https://github.com/AmbroseX/larksnap.git
cd larksnap
npm install
npm run build      # 生产构建 → dist/，按「安装」一节步骤加载 dist/ 目录
npm run dev        # 或 watch 构建，改代码自动重建
npm run typecheck  # 仅类型检查
```

工作原理、目录结构、CC 桥接协议、构建发布等技术细节见 **[docs/架构与技术细节.md](docs/架构与技术细节.md)**，需求规格见 [`specs/`](specs/)。

## 隐私与免责

- **内容不外发**：文档内容、Cookie、登录态全程留在本地浏览器，无后端、不上报任何第三方。
- **匿名使用统计（可关闭）**：默认向开发者自建的 Umami 上报功能使用次数与版本号，不含任何文档内容、地址或身份信息，可在设置页一键关闭，详见 [PRIVACY.md](PRIVACY.md)。
- **权限最小化**：私有化域名按需运行时授权，不预先索取全站权限；诊断包已剔除 PII 字段。
- 本工具仅供合法、获授权的文档导出与个人备份用途，请遵守所在组织的数据管理策略与飞书 / Lark 服务条款，滥用后果由使用者自行承担。

## 交流群

有问题、建议或想反馈 bug，欢迎扫码进群交流：

<p align="center">
  <img alt="交流群" src="docs/images/交流群.png" width="300">
</p>

## 致谢

独立实现，设计中参考了这些开源项目的思路：[feishu2md](https://github.com/Wsine/feishu2md)、[xiaoyaosearch-feishu-export-md](https://github.com/dtsola/xiaoyaosearch-feishu-export-md)、[feishu-doc-helper](https://github.com/sancijun/feishu-doc-helper)、[feishu-backup](https://github.com/dicarne/feishu-backup)、[feishu-doc-export](https://github.com/eternalfree/feishu-doc-export)、[OpenCLI](https://github.com/jackwener/OpenCLI)。

## 许可证

[Apache License 2.0](LICENSE)
