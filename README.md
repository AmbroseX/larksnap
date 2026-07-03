# LarkSnap · 飞书文档导出助手

**简体中文** | [English](README.en.md)

> Chrome 扩展：在飞书 / Lark 文档页一键导出 **Markdown / PDF / HTML**、批量下载附件、离线缓存；在任意网页上**一键转 Markdown**、解除复制限制。

零配置、纯客户端、内容不外发，**兼容企业私有化自建域名**。不用去开放平台建应用、申请 API 权限 —— 直接复用浏览器里已登录的 Cookie 和飞书网页自身的内部接口。

<p>
  <img alt="manifest" src="https://img.shields.io/badge/Manifest-V3-4285F4">
  <img alt="stack" src="https://img.shields.io/badge/React%2018%20%2B%20Vite%20%2B%20TypeScript-3178C6">
  <img alt="license" src="https://img.shields.io/badge/license-Apache%202.0-green">
</p>

## 安装

到 [Releases](https://github.com/AmbroseX/larksnap/releases) 下载最新 zip 并解压，然后：

1. 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择解压出来的目录

图文步骤见 **[安装与使用教程](docs/安装与使用教程.md)**。想从源码构建的看文末[「开发」](#开发)一节。

## 使用

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

### 在 Claude Code 里用（larksnap-fetch 技能）

装好扩展后，再装一个技能，就能在 Claude Code 里贴飞书链接直接下载到本地：

```bash
npx skills add AmbroseX/larksnap --skill larksnap-fetch -g -a claude-code
```

然后在 Claude Code 里说：

> 把 `https://your-company.feishu.cn/docx/xxxxxxxx` 下载到 `./docs`

产物按文档标题独立成夹，图片以相对路径内联引用。前提：本机有 Node.js，且扩展已加载进 Chrome（登录态和导出引擎都在扩展里）。详见 [`skills/larksnap-fetch/SKILL.md`](skills/larksnap-fetch/SKILL.md)。

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
- **权限最小化**：私有化域名按需运行时授权，不预先索取全站权限；诊断包已剔除 PII 字段。
- 本工具仅供合法、获授权的文档导出与个人备份用途，请遵守所在组织的数据管理策略与飞书 / Lark 服务条款，滥用后果由使用者自行承担。

## 致谢

独立实现，设计中参考了这些开源项目的思路：[feishu2md](https://github.com/Wsine/feishu2md)、[xiaoyaosearch-feishu-export-md](https://github.com/dtsola/xiaoyaosearch-feishu-export-md)、[feishu-doc-helper](https://github.com/sancijun/feishu-doc-helper)、[feishu-backup](https://github.com/dicarne/feishu-backup)、[feishu-doc-export](https://github.com/eternalfree/feishu-doc-export)、[OpenCLI](https://github.com/jackwener/OpenCLI)。

## 许可证

[Apache License 2.0](LICENSE)
