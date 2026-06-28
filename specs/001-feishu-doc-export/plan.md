# Implementation Plan: 飞书文档导出助手

**Branch**: `001-feishu-doc-export` | **Date**: 2026-06-26 | **Spec**: [spec.md](./spec.md)

## Summary

在现有 Chrome MV3 扩展骨架上,逐项实现飞书文档导出能力。认证复用浏览器登录态:**所有飞书内部接口由 content script 同源代发**,Service Worker 仅读 Cookie(CSRF)、编排流程、打包与下载。Markdown 采用**双路 + 运行时按 host 探测**(P-official 官方导出 / P-decode `client_vars`+apool 自解码),PDF/Word 走官方导出任务,HTML/缓存共用 DOM 快照,诊断工具脱敏后打包。按 §9 里程碑 M0→M5 推进。

## Technical Context

**Language/Version**: TypeScript 5.5(`tsconfig` `strict`),ES2022 / Chrome 110+ target
**Primary Dependencies**: React 18(UI)、Vite 5 + `@vitejs/plugin-react`(构建)、esbuild(content IIFE)、JavaScript-Obfuscator(生产混淆);新增 zip 能力(见 research:JSZip 或自研最小 store-zip)
**Storage**: `chrome.storage.local`(config / runtime / cache / 能力缓存 / 已信任域名),大文档需 `unlimitedStorage`
**Testing**: `npm run typecheck`(`tsc --noEmit`)+ `npm run build` 必过;手工验收(公有云 + 私有化示例两类页面)
**Target Platform**: Chrome MV3 扩展(Service Worker + content scripts + side panel + React UI)
**Project Type**: 浏览器扩展(三层:UI / 背景 SW / content)
**Performance Goals**: 媒体下载并发 ≤ 3 + 退避重试;大文档分页拉块 + 流式写 zip;识别/选路结论缓存避免重复探测
**Constraints**: 内部接口必须 content 同源代发;域名不写死;单资源失败不拖垮整篇;诊断脱敏

## Constitution Check

| 原则 | 本计划遵循方式 | 结果 |
|------|---------------|------|
| I. 零配置认证 | content 侧 `feishuGet/feishuPost`(同源+referer+CSRF);SW 仅 `get_cookie`+编排;无 App ID/Secret | ✅ |
| II. 域名不写死 | `location.origin` 拼接;`driveStreamHost=internal-api-drive-stream.{基础域}` 由 host 推导;识别走路径+token 双信号 | ✅ |
| III. 导出可靠/可恢复 | 统一 `reportProgress` 落盘 + `GET_STATUS` 恢复;媒体下载退避重试;`Failed to fetch` 降级 | ✅ |
| IV. 高质量 MD/双路 | P-official + P-decode 全实现;apool 解码器为必做;`md_export_supported` 按 host 缓存 | ✅ |
| V. 隐私安全 | 无第三方上报;诊断剔除 `editor_map/user_map/creator_id/owner_id` | ✅ |
| VI. 合规告知 | P-decode 前提示"官方导出已关闭,继续即绕过";文案附"仅在被授权前提下使用" | ✅ |

**Constitution Check Result**: ✅ 通过。新增 zip 依赖若选 JSZip 属常规前端库、不触碰宪法禁止项;若离线不可装则自研 store-zip(见 research),同样合规。

## Project Structure

### Documentation (this feature)

```text
specs/001-feishu-doc-export/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks.md          # 由 /speckit-tasks 生成
```

### Source Code (repository root)

```text
src/
├── shared/
│   ├── types.ts            # 改:DocInfo 加 isPrivateDeploy;新增 MarkdownCapability/TrustedDomain;ExtensionConfig 加 trustedDomains
│   ├── constants.ts        # 改:MSG 加 GET_COOKIE/REQUEST_PERMISSION/...;CONTENT_MSG 加内部接口代发类型;STORAGE_KEYS 加 MD_CAP
│   ├── storage.ts          # 改:能力缓存(按 host)、已信任域名读写
│   └── feishu-host.ts      # 新增:基础域推导 + driveStreamHost 拼接(纯函数,SW/content 共用)
│
├── background/
│   ├── index.ts            # 改:路由加 get_cookie、权限申请、按需注入私有化域名
│   ├── cookie.ts           # 新增:chrome.cookies.get 读 _csrf_token(候选名)
│   ├── permissions.ts      # 新增:optional_host_permissions 运行时申请/查询/撤销
│   ├── doc-detect.ts       # 改:私有化域名注入前先校验权限
│   ├── zip.ts              # 新增:zip 打包封装(JSZip 或自研 store-zip)
│   ├── exporters/
│   │   ├── markdown.ts     # 改:编排双路(能力检测→P-official/P-decode→下图→zip)
│   │   ├── pdf.ts          # 改:官方导出任务(create→poll→download)
│   │   ├── html.ts         # 改:取快照→内联→单文件 HTML
│   │   ├── attachments.ts  # 改:复用块 token + 媒体下载→zip
│   │   └── export-task.ts  # 新增:通用导出任务流程(create/poll/download),PDF/Word/官方 md 共用
│   ├── convert/
│   │   ├── apool.ts        # 新增:apool/changeset 解码器(P-decode 核心)
│   │   ├── adapter.ts      # 新增:client_vars block_map → 转换器期望结构
│   │   └── markdown.ts     # 新增:block → Markdown(移植 ref/xiaoyaosearch 结构那半)
│   ├── capability.ts       # 新增:Markdown 导出能力检测 + 按 host 缓存
│   ├── progress.ts         # 不变
│   ├── cache-manager.ts    # 基本不变(接真实快照)
│   └── diagnostic.ts       # 改:脱敏 + 选路结论 + 接口样本
│
└── content/
    ├── index.ts            # 改:消息分发加内部接口代发 / 快照 / 滚动加载
    ├── feishu-detect.ts    # 改:路径+token 双信号识别 + isPrivateDeploy
    ├── api/
    │   ├── request.ts      # 新增:feishuGet/feishuPost(同源+完整头+CSRF+重试)
    │   ├── doc.ts          # 新增:token 解析链(wiki/docx)、client_vars 分页、export 任务、媒体下载
    │   └── media.ts        # 新增:downloadMedia(token,objToken) 返回二进制(base64 回传 SW)
    └── snapshot.ts         # 新增:滚动加载 + DOM clone + 资源内联(HTML/缓存共用)
```

**Structure Decision**: 严格遵循宪法原则 I —— 飞书内部请求集中在 `content/api/`(同源代发),SW 的 `exporters/`/`convert/` 只做编排与纯数据转换(可在 SW 跑)。content 子模块由 esbuild bundle 进单一 `content.js`,故可自由 import。

## Complexity Tracking

| 超标项 | 原因 | 补救措施 |
|--------|------|----------|
| apool/changeset 解码器 | `client_vars` 正文为 Etherpad changeset 编码,非字段重命名,工作量大 | 在 M3 单列任务;移植 ref 仅复用"块类型→结构"半部,文本抽取半部自研;以诊断样本驱动调试 |
| zip 依赖 | JSZip 未安装,离线环境可能装不上 | research 决策:优先 `npm i jszip`,失败则自研最小 store-zip(无压缩,够用) |
| 媒体二进制跨 content→SW 传输 | content fetch 得到二进制,需回传 SW 打包 | content 侧 fetch→ArrayBuffer→base64 回传,SW 解码写入 zip;大图分块避免消息体超限 |
