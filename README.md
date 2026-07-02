# larksnap · 飞书文档导出助手

**简体中文** | [English](README.en.md)

> Chrome MV3 浏览器扩展 · 在飞书 / Lark 文档页面一键导出 **Markdown / PDF / HTML**、批量下载附件、离线缓存文档；在任意网页上**一键转 Markdown**、解除复制限制、自动复制选中文字。

零配置、纯客户端、内容不外发，并且**兼容企业私有化自建域名**的飞书部署。

<p>
  <img alt="manifest" src="https://img.shields.io/badge/Manifest-V3-4285F4">
  <img alt="stack" src="https://img.shields.io/badge/React%2018%20%2B%20Vite%20%2B%20TypeScript-3178C6">
  <img alt="status" src="https://img.shields.io/badge/status-active%20development-orange">
  <img alt="license" src="https://img.shields.io/badge/license-Apache%202.0-green">

</p>

---

## 简介

飞书官方的「导出」按钮在很多企业租户里被组织管理员关闭，第三方导出工具又普遍要求你到飞书开放平台创建应用、申请权限、等待审批。本扩展换一条路：**直接复用浏览器里已登录的 Cookie 和飞书网页自身的内部接口**，在文档页打开侧边栏即可一键导出，无需任何后端、无需申请 API 权限。

它最初为 LLM 语料 / 知识库迁移场景而生 —— 把散落在飞书里的文档批量、高质量地转成 Markdown，连图片一起打包带走。现在这条 Markdown 流水线也向所有网页开放：任意页面整页 / 选中内容一键转 Markdown，顺带解决「页面禁止复制」的老问题。

## 核心特性

- **一键多格式导出**：Markdown（图片打包成 `.zip`）、PDF（高清渲染）、HTML（单文件内联资源）。
- **高质量 Markdown**：保留标题、列表、代码块、表格（含合并单元格）、公式、Callout、图片等结构。
- **双路取数 + 自动选路**：运行时按文档 host 探测，租户开启官方导出走 **P-official**（质量最高）；被关闭则自动回退 **P-decode**（`client_vars` + apool 自解码），用户始终只点一个「导出 Markdown」。
- **兼容私有化部署**：不依赖域名白名单。识别公有云（`feishu.cn` / `feishu.net` / `larksuite.com`）之外，也能识别企业自建域名（如 `*.corp.example.com` 私有化飞书）；host 权限按需运行时授权，已授权域名可查看 / 撤销。
- **批量下载附件**：解析文档中的 image / file token，经素材下载接口批量保存。
- **离线缓存**：把文档存为本地快照，支持离线浏览与管理。
- **任意网页 → Markdown**：非飞书页面走 Readability 正文提取 + Turndown（GFM）转换，侧边栏或页面右键菜单一键复制 / 下载 `.md`；正文不在 DOM 里的站点走内置适配器（已支持百度文库）。
- **解除复制限制**：一键解锁禁止选择 / 复制 / 右键的页面 —— 事件、样式、内联句柄三层拦截，全部可逆，关掉即恢复页面原状。
- **选中文字自动复制**：开启后选中即进剪贴板（纯文本或 Markdown 可选，设置页可调最小字数），会话级不常驻。
- **复制标签页链接**：一键复制当前页或全部标签页，支持 Markdown 链接 / 标题+URL / 仅标题 / 仅 URL 四种格式。
- **导出诊断**：一键导出脱敏的诊断包（DocInfo / 接口响应样本 / 选路结论 / 版本），用于定位私有化与公有云的字段差异 —— 已显式剔除 `editor_map` / `user_map` / `creator_id` 等 PII 字段。
- **CC 桥接（可选）**：通过本地 daemon 把 Claude Code 等命令行工具接到这个已登录的扩展上，无人值守地跑导出（详见 [CC 桥接技能](#cc-桥接技能feishu-doc-fetch)）。

## 工作原理

```
                          ┌──────────────────── Chrome 扩展 (MV3) ────────────────────┐
                          │                                                            │
  飞书文档页 ──侧边栏──▶  │  Side Panel (React)                                        │
                          │      │  消息                                               │
                          │      ▼                                                     │
                          │  Service Worker ──┬─ doc-detect  识别文档 / 按需授权        │
                          │   (导出引擎)       ├─ feishu-proxy 经 content 同源代发内部接口 │
                          │      │             ├─ capability  按 host 探测导出能力       │
                          │      │             └─ exporters   md / pdf / html / 附件      │
                          │      ▼                                                     │
                          │  content script ──同源 fetch──▶ 飞书内部 API（带登录 Cookie）│
                          └────────────────────────────────────────────────────────────┘
```

设计上有几条刻意为之的原则：

1. **内部接口由 content script 同源发起**，Service Worker 只做代理与编排 —— 规避跨域与风控。
2. **绝不硬编码具体飞书域名**作为唯一目标，媒体 / 导出下载域统一由当前页面 host 推导（公有云取已知后缀，私有化去掉最左侧租户子域）。
3. **不支持的块降级占位但尽量保留后代文本**，避免内容丢失。
4. **内容不外发、无后端**，全流程纯客户端。

> 路线设计与取舍的完整论证见 [`docs/技术方案.md`](docs/技术方案.md)，需求规格见 [`specs/`](specs/)。

## 安装（从源码加载）

> 👤 不想碰命令行？普通用户请看 **[安装与使用教程](docs/安装与使用教程.md)** —— 下载现成安装包、开发者模式加载、飞书导出与网页复制的图文步骤。

```bash
git clone https://github.com/AmbroseX/larksnap.git
cd larksnap
npm install
npm run build          # 生产构建 → dist/
```

1. 打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择项目下的 `dist/` 目录

## 使用

1. 在浏览器中正常登录飞书 / Lark（公有云或企业私有化域名均可）。
2. 打开任意飞书文档页面（`docx` / `wiki` / `sheet` 等）。
3. 点击扩展图标打开侧边栏，确认顶部正确识别出文档标题与类型。
   - 若是**私有化未授权域名**，侧边栏会提示授权，点击按钮完成 Chrome 运行时授权即可。
4. 在操作清单中点击所需动作：

   | 操作 | 说明 | 状态 |
   |---|---|---|
   | 导出为 Markdown | 转 Markdown，图片打包成 `.zip` | ✅ |
   | 导出为 PDF | 自动渲染生成高清 PDF | ✅ |
   | 导出为 HTML | 下载单文件 HTML（内联资源） | ✅ |
   | 导出附件 | 批量下载文档中的图片和文件 | ✅ |
   | 缓存到本地 / 查看缓存 | 离线快照与管理 | ✅ |
   | 导出诊断信息 | 定位私有化飞书的格式差异（脱敏） | ✅ |
   | 导出为 Word | — | 🚧 开发中 |
   | 任意网页 → Markdown | 非飞书页面走 Readability + Turndown 通用流水线 | ✅（[spec 002](specs/002-generic-page-markdown/)） |

> ⚠️ 当租户已关闭官方导出而扩展走 P-decode 时，会先提示「该文档官方导出已关闭，继续即绕过该限制」。**请仅在获得授权的前提下使用。**

### 网页复制（非飞书页面）

在**非飞书页面**打开侧边栏会自动切换到「网页复制」视图；不开侧边栏也可以直接用页面**右键菜单**：

| 操作 | 说明 |
|---|---|
| 整页转 Markdown（复制 / 下载 `.md`） | Readability 提取正文 → Turndown（GFM）转换；百度文库等正文渲染进 canvas 的站点走内置适配器直取数据 |
| 仅选中内容转 Markdown | 把选区 HTML 转成 Markdown 后复制 |
| 解除复制限制（开 / 关） | 解锁禁止选择 / 复制 / 右键的页面，关闭后完全恢复原状 |
| 选中文字自动复制 | 选中 ≥ N 字自动进剪贴板（字数阈值、纯文本 / Markdown 格式在设置页可调），本页会话级生效 |
| 复制标签页链接 | 当前页复制为 Markdown 链接；全部标签页支持 Markdown / 标题+URL / 仅标题 / 仅 URL |

权限说明：右键菜单靠 `activeTab` 手势授权，**不需要预授权任何域名**；侧边栏路径若注入失败，会在同一次点击里弹出该域名的授权请求，拒绝的话改用右键菜单即可。

## CC 桥接技能（feishu-doc-fetch）

`skills/feishu-doc-fetch/` 是一个**自包含的 Claude Code 技能**：在 CC 里贴一个飞书链接即可导出到本地目录。它内置一个零依赖的本地撮合 daemon，让命令行把链接交给**已登录的扩展**去导出，从而无需在 CLI 侧重新处理登录态。

```
  CLI  ──HTTP POST /command (流式 NDJSON)──▶  daemon (127.0.0.1:19925)  ──WS push──▶  扩展
  扩展 ──WS (progress / result)──────────────▶  daemon  ──写回 /command 流──▶  CLI
```

- 扩展是 WebSocket 客户端，**主动连出**到本地 daemon（仿 OpenCLI，去掉 native messaging）；`alarms` 保活 + 断线退避重连。
- daemon 只绑 `127.0.0.1`，并通过 Origin 校验 + 自定义请求头防御浏览器侧 CSRF。
- 收到导出任务后，扩展在后台新开标签页跑导出引擎，用 download sink 截获产物经 WS 回传；缺登录 / 缺授权时回 `need-*`。

协议常量见 [`skills/feishu-doc-fetch/scripts/bridge/protocol.mjs`](skills/feishu-doc-fetch/scripts/bridge/protocol.mjs)，daemon 实现见 [`skills/feishu-doc-fetch/scripts/bridge/daemon.mjs`](skills/feishu-doc-fetch/scripts/bridge/daemon.mjs)。

### 安装技能（一行命令）

技能通过 [`npx skills`](https://github.com/vercel-labs/skills) 从本仓库直接安装到全局，任何项目里都能用：

```bash
npx skills add AmbroseX/larksnap --skill feishu-doc-fetch -g -a claude-code
```

> ⚠️ 这行只装**技能文件**。技能要真正跑起来还需两个前提，缺一不可：
> 1. 本机装了 **Node.js**（技能靠它拉起 daemon）。
> 2. 本仓库的**扩展已构建并加载进 Chrome**（登录态与导出引擎在扩展里，无法打包进技能）：
>    在仓库根 `npm run build` → `chrome://extensions` 开发者模式 →「加载已解压的扩展程序」选 `dist/` → 点一下扩展图标唤醒后台。
>
> 装好后，在 CC 里直接贴飞书链接说「下载到某目录」即可；用法与退出码见 [`skills/feishu-doc-fetch/SKILL.md`](skills/feishu-doc-fetch/SKILL.md)。

### 用法示例

装好扩展 + 技能后，在 Claude Code 里直接说：

> 把 `https://your-company.feishu.cn/docx/xxxxxxxx` 下载到 `./docs`

技能会调用扩展导出，产物落到你指定目录下、以文档标题命名的子文件夹里（每篇独立成夹）：

```
docs/
└── 季度复盘/
    ├── 季度复盘.md
    └── images/           # 图片以相对路径内联引用
        └── xxx.png
```

也可以绕开 CC 直接命令行调用：

```bash
node ~/.claude/skills/feishu-doc-fetch/scripts/fetch.mjs \
  "https://your-company.feishu.cn/docx/xxxxxxxx" ./docs --format md
```

## 目录结构

```
manifest.json          # MV3 清单（side panel 为主入口）
vite.config.ts         # 构建：React 多入口 + content script 单独打 IIFE + 生产混淆
build.sh               # 构建 / 打包脚本
sidepanel.html         # 侧边栏入口（主 UI）
options.html           # 设置页
popup.html             # 后备弹窗入口
skills/                # 可 `npx skills add` 安装的 Claude Code 技能
  feishu-doc-fetch/    #   飞书链接 → 本地目录（自包含，内置桥接 daemon）
docs/                  # 技术方案、PRD
specs/                 # 功能规格（spec-driven）
src/
  background/          # Service Worker（导出引擎）
    index.ts           #   消息路由 + 打开侧边栏 + 启动桥接
    bridge.ts          #   CC 桥接（扩展侧 WS 客户端）
    doc-detect.ts      #   识别当前飞书文档
    capability.ts      #   按 host 探测 Markdown 导出能力（P-official / P-decode）
    feishu-proxy.ts    #   经 content 同源代发内部接口
    feishu-api.ts      #   飞书内部接口封装（client_vars / 素材等）
    progress.ts        #   统一进度上报
    convert/           #   apool 解码 + block 树 → Markdown
    exporters/         #   markdown / pdf / html / attachments / 导出任务
    cache-manager.ts   #   本地缓存读写
    diagnostic.ts      #   脱敏诊断信息
    permissions.ts     #   私有化域名运行时授权 / 已信任列表
    webcopy.ts         #   网页复制 SW 侧（右键菜单 / 注入调度 / 标签页链接）
    webcopy-adapters.ts#   站点专属适配器（百度文库等正文不在 DOM 的站点）
  content/             # 注入页面的脚本（同源发请求 / DOM 快照）
    webcopy/           #   网页复制（Readability + Turndown / 解锁 / 自动复制）
  sidepanel/           # 侧边栏 UI（React，飞书导出 + 网页复制两个视图）
  options/             # 设置页 UI
  popup/               # 弹窗 UI
  shared/              # 类型 / 常量 / storage / 消息 / host 推导
```

## 开发

```bash
npm install
npm run dev        # watch 构建到 dist/
npm run typecheck  # 仅类型检查
```

加载 `dist/` 后，修改源码会自动重建；在 `chrome://extensions` 点扩展的「刷新」即可重新载入。

## 构建发布

```bash
npm run build      # 生产构建 + 代码混淆 → dist/
./build.sh         # 等价于上面（带版本日志）
./build.sh --zip   # 额外打包成 release/*.zip（用于 Chrome Web Store 上传）
```

推送 `v*` 标签（如 `v0.2.4`）会触发 GitHub Actions 自动构建、打包 zip / crx 并创建 GitHub Release（见 [`.github/workflows/release.yml`](.github/workflows/release.yml)）。

## 技术栈

- **运行时**：Chrome Manifest V3（Service Worker + Side Panel + content script）
- **UI**：React 18 + TypeScript
- **构建**：Vite 5（React 多入口 + content script 单独打 IIFE）+ `javascript-obfuscator` 生产混淆
- **依赖**：`jszip`（打包）、`marked`（Markdown 渲染）、`@mozilla/readability` + `turndown`（网页转 Markdown）
- **桥接**：Node.js 零依赖 HTTP + 手搓 WebSocket daemon

## 隐私与合规

- **内容不外发**：文档内容、Cookie、登录态全程留在本地浏览器，扩展不向任何第三方服务器上报。
- **诊断脱敏**：诊断包在打包前显式剔除 `editor_map` / `user_map` / `creator_id` / `owner_id` 等 PII 字段。
- **权限最小化**：私有化域名走 `optional_host_permissions` + 用户手势触发的运行时授权，不预先索取全站权限。
- **尊重组织策略**：当官方导出被组织关闭时，P-decode 会明确提示其性质，请仅在被授权前提下使用。本工具仅供合法、获授权的文档导出与个人备份。

## 路线图

- [x] Markdown 双路导出（P-official / P-decode）+ 图片打包
- [x] PDF / HTML / 附件 / 离线缓存
- [x] 私有化部署兼容 + 诊断工具
- [x] CC ⇄ 扩展 本地桥接
- [x] 任意网页 → Markdown（Readability + Turndown 通用管线 + 站点适配器）
- [x] 解除复制限制 / 选中自动复制 / 标签页链接复制
- [ ] Word 导出
- [ ] 更多站点适配器（知乎、微信公众号等）
- [ ] 多文档 / 知识库批量导出

## 致谢

本项目代码为独立实现，设计过程中参考了以下开源项目的思路，在此致谢：

- [Wsine/feishu2md](https://github.com/Wsine/feishu2md) — OpenAPI 路线的块拼装思路
- [dtsola/xiaoyaosearch-feishu-export-md](https://github.com/dtsola/xiaoyaosearch-feishu-export-md) — 块类型 → Markdown 的映射设计
- [sancijun/feishu-doc-helper](https://github.com/sancijun/feishu-doc-helper) / [sancijun/doc-export-helper](https://github.com/sancijun/doc-export-helper) — Cookie 复用内部接口的路线验证
- [dicarne/feishu-backup](https://github.com/dicarne/feishu-backup)、[eternalfree/feishu-doc-export](https://github.com/eternalfree/feishu-doc-export) — 批量导出方案对比
- [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI) — 本地桥接 daemon 的架构思路

## 许可证

本项目以 [Apache License 2.0](LICENSE) 开源。你可以自由使用、修改、分发与商用，需保留版权声明与许可证文本；协议同时提供专利授权与商标保护条款。

## 免责声明

本工具仅供合法、获授权的文档导出与个人备份用途。使用者应自行确保对所导出的文档拥有相应权限，并遵守所在组织的数据管理策略与飞书 / Lark 的服务条款。因滥用本工具产生的任何后果由使用者自行承担，项目作者不承担任何责任。

