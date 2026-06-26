# Quickstart: 飞书文档导出助手开发

## 前置条件

- Node 18+,Chrome 110+
- 依赖已装(`npm i`);本特性新增 zip 能力:`npm i jszip`(离线装不上则用 `background/zip.ts` 的自研 store-zip,见 research §8)
- 加载扩展:`chrome://extensions` → 开发者模式 → 加载已解压的 `dist/`

## 开发环境

```bash
npm run dev        # vite 监听构建到 dist/(含热重载)
npm run typecheck  # tsc --noEmit,提交前必过
npm run build      # 生产构建(含混淆)
```

> content script 由 vite.config 的 esbuild 单独打成 IIFE `content.js`(入口 `src/content/index.ts`),其 import 的 `content/api/*`、`content/snapshot.ts` 会被 bundle 进去——可放心拆模块。

## 实现顺序(对齐里程碑 M0→M5)

1. **M0 地基**:`feishu-detect.ts` 双信号识别 + `isPrivateDeploy` → `manifest` 改 `optional_host_permissions` → `background/permissions.ts` 运行时授权 → 侧边栏私有化授权 UI。
2. **M2 已验证路径**:`background/cookie.ts`(get_cookie)→ `content/api/request.ts`(feishuGet/Post)→ `content/api/doc.ts`(token 解析 + export 任务)→ `exporters/export-task.ts` + `pdf.ts` → `capability.ts` 探 P-official → `diagnostic.ts` 脱敏。
3. **M3 P-decode**:`convert/apool.ts`(解码器,核心)→ `convert/adapter.ts` → `convert/markdown.ts`(移植结构半部)→ `content/api/media.ts` 下图 → `exporters/markdown.ts` 编排双路 + `zip.ts` → `attachments.ts`。
4. **M4 快照**:`content/snapshot.ts`(滚动+内联)→ `exporters/html.ts` + 真实缓存。
5. **M5 完善**:Word 占位说明、并发/重试打磨、host 权限收敛。

## 关键代码骨架

### content 侧请求(`content/api/request.ts`)

```ts
export async function feishuGet(path: string) {
  const res = await fetch(`${location.origin}${path}`, {
    method: 'GET', credentials: 'include',
    headers: { accept: 'application/json, text/plain, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
// feishuPost:加 referrer/x-csrftoken(候选名失败重试)/trace 头,见 §4.2
```

### SW 读 CSRF(`background/cookie.ts`)

```ts
export async function getCookie(name: string, url: string): Promise<string|null> {
  const c = await chrome.cookies.get({ name, url });
  return c?.value ?? null;
}
// 路由:case MSG.GET_COOKIE → getCookie(data.name, sender.tab.url)
```

### 基础域推导(`shared/feishu-host.ts`)

```ts
// example-tenant.corp.example.com → internal-api-drive-stream.corp.example.com
export function driveStreamHost(host: string): string {
  const base = baseDomain(host);            // 去租户子域
  return `internal-api-drive-stream.${base}`;
}
```

### Markdown 编排(`exporters/markdown.ts`)

```ts
const cap = await getMarkdownCapability(doc.host);   // capability.ts
if (cap.mdExportSupported) return runOfficialMd(doc); // P-official
return runDecodeMd(doc);                              // P-decode:client_vars→apool→md→下图→zip
// runOfficialMd 失败(非未登录)→ 失效缓存 → 回退 runDecodeMd
```

## 测试步骤

- **识别**:打开公有云 `*.feishu.cn/docx/<token>` 与私有化 `*.corp.example.com/wiki/<token>`,侧边栏显示标题/类型;私有化出现授权提示。
- **授权**:点授权 → Chrome 弹窗同意 → 状态转可导出。
- **Markdown(公有云)**:点导出 → 走 P-official → 得 .md/zip。
- **Markdown(私有化)**:点导出 → 自动 P-decode → 得带图 zip;抽检粗/斜/链接/代码/表格/图片。
- **PDF(公有云)**:点导出 → 任务轮询 → 高清 PDF。
- **附件/HTML/缓存/诊断**:各点一次,验证产物与脱敏。
- **可靠性**:导出中重开侧边栏,进度恢复;断网单图,整篇仍成功。

## 验收检查点

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过,`dist/` 可加载
- [ ] 公有云 + 私有化均能识别 + 导出 Markdown
- [ ] PDF 在官方导出可用环境成功
- [ ] 诊断产物无 `editor_map/user_map/creator_id/owner_id`
- [ ] 无任何指向非飞书域名的网络请求
- [ ] SW 代码无飞书内部接口直发
- [ ] 无硬编码 `feishu.cn` 作为唯一请求/下载目标
