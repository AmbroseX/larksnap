# Implementation Plan: 飞书转公众号排版

**Spec**: `specs/005-wechat-format/spec.md`
**Branch**: `005-wechat-format`
**Created**: 2026-07-09

## 1. 设计概述

把飞书文档变成公众号编辑器里排版好的文章,分两条投放路线。渲染核心是同一套「块树 → 全内联样式 HTML」渲染器(逆向 feishu2weixin crx 的公众号兼容规则 + 壹伴的模板/JSAPI 要点),两条路线共用。

```
[共用渲染管线(已实现)]
飞书文档页(侧边栏点「复制为公众号格式」,可选主题)
   ▼
[SW] resolveObjToken → fetchClientVars → buildBlockTree     (复用现有 P-decode 管线)
   ├─ collectImageAssets → downloadImageDataUrls            (content 同源下载 → dataURL)
   └─ renderWechatHtml(块树 + WechatTheme)                   (全内联 <section> HTML)
   ▼
[路线 A:剪贴板(已实现)]
侧边栏 copyHtmlToClipboard(text/html + text/plain)
   → 用户去公众号编辑器 Ctrl+V(dataURL 图片被微信自动转存图床)

[路线 B:JSAPI 直灌(待实现)]
SW 把 HTML 发给 mp.weixin.qq.com 编辑页 tab
   ▼
[mp 页 content script(隔离世界)]
   ├─ 图片:dataURL → blob → canvas 压到 5e6 像素内
   │        → POST /cgi-bin/filetransfer?action=upload_material...(借页面登录态抠签名)
   │        → 响应 cdn_url(mmbiz.qpic.cn)回填 <img src>
   └─ postMessage → 主世界脚本(带来源校验 + 超时)
   ▼
[mp 页主世界脚本]
   判编辑器:__MP_Editor_JSAPI__ + .ProseMirror ?
   ├─ 新版:mp_editor_get_isready → mp_editor_set_content / mp_editor_insert_html
   └─ 老版:#ueditor_0 iframe → execCommand("inserthtml") / 直接写 iframe body
```

**为什么不走「飞书 MD → markdown-it AST → 模板」**(壹伴的做法):larksnap 已有 client_vars 块树,直接块树 → 内联 HTML,省一次 Markdown 往返,且合并单元格/分栏/callout 等 MD 表达不了的结构不丢。壹伴那条管线是因为它的输入只有 MD;我们的输入是结构更全的块树,只抄它的「输出端规则」(内联模板/三属性/JSAPI/素材库),不抄它的输入端。

**为什么图片两种处理**:粘贴管线里微信会把 base64 图自动转存图床,所以路线 A 用 dataURL 就够;`set_content` 不走粘贴管线,没有自动转存,外链图又会被拦,所以路线 B 必须先传素材库换 `mmbiz.qpic.cn` 永久链接。

## 2. 现状与差距(对照实际代码)

### 已实现(路线 A 全链路,2026-07-09 落地)

| 环节 | 文件 | 状态 |
|---|---|---|
| SW 编排:拉全文→块树→下图→渲染→回传 | `src/background/exporters/wechat.ts` | ✅ 完成,含进度上报与错误处理 |
| 内联样式渲染器(398 行):heading/text/todo/列表合组续号/code 三类名/quote/callout 色盘+emoji/divider/image/grid flex 分栏/table 真 rowspan+colspan/占位降级 | `src/background/convert/wechat-html.ts` | ✅ 完成 |
| 行内渲染 `inlineToWechatHtml`(粗斜删下划线/颜色/高亮/链接/行内代码全内联 CSS) | `src/background/convert/inline-html.ts` | ✅ 完成 |
| InlineNode 扩展 color/background/underline + apool 解码透传(只认 CSS 形态色值)+ mergeAdjacent 同步 | `src/shared/types.ts`、`src/background/convert/apool.ts` | ✅ 完成 |
| 主题:WECHAT_THEMES 三主题(经典黑/商务蓝/微信绿),单一来源供 SW 与预览共用 | `src/shared/themes.ts` | ✅ 完成 |
| 图片下载共享管线(dataURL,失败占位) | `src/background/image-map.ts` | ✅ 完成(与小红书共用) |
| 剪贴板:侧边栏写 text/html + text/plain,execCommand 降级 | `src/sidepanel/copy-html.ts` | ✅ 完成 |
| UI:「复制为公众号格式」卡片 + 主题选择器 + 悬浮真配色预览 + localStorage 记忆 | `src/sidepanel/actions.ts`、`src/sidepanel/SidePanel.tsx` | ✅ 完成 |
| 消息与路由:`MSG.EXPORT_WECHAT` + themeId 透传 | `src/shared/constants.ts`、`src/background/index.ts` | ✅ 完成 |

### 待实现(路线 B 全部 + 若干校准)

| 环节 | 说明 |
|---|---|
| 公众号编辑器实测校准 | 复刻方案自记"待公众号编辑器实测校准":section 嵌套深度、grid flex 手机端表现、粘贴后各块样式留存,需真实编辑器过一遍 |
| mp 页注入(隔离世界 + 主世界) | 目前 `src/` 与 `manifest.json` 均无任何 `mp.weixin.qq.com` 相关代码(grep 确认为零) |
| `__MP_Editor_JSAPI__` 灌入 + 新旧编辑器判定 | 未实现 |
| 图片上传素材库(filetransfer) | 未实现 |
| 代码块 `<span leaf="">` 叶节点标记 | 当前 `renderCode` 每行是 `<code style="display:block">`,无 `<span leaf="">`;粘贴路线可用,`set_content` 路线需要补 |
| 块级三属性 `data-larksnap-key/content/action-id` | 当前渲染器不打任何 data-* 标记 |
| UEditor 兜底 | 未实现 |

## 3. 新增 / 改动文件

### 新增

| 文件 | 职责 |
|---|---|
| `src/content/mp/index.ts` | mp 编辑页 content 入口(独立 IIFE → `dist/mp.js`):接收 SW 的灌入请求,先跑图片上传替换 src,再经 postMessage 转交主世界;注入幂等标记 |
| `src/content/mp/upload.ts` | 素材库上传:页面 script 正则抠 `user_name`/`nick_name`/`ticket` + URL 取 `token`;dataURL→blob;canvas 压 5e6 像素;FormData POST filetransfer;返回 `cdn_url` |
| `src/content/mp/main-world.ts` | 主世界脚本(→ `dist/mp-main.js`):编辑器判定;新版 `__MP_Editor_JSAPI__.invoke`(isready/set_content/insert_html);老版 UEditor execCommand/写 iframe body;结果回传隔离世界 |

### 改动

| 文件 | 改动 |
|---|---|
| `manifest.json` | 增 `https://mp.weixin.qq.com/*` host 权限(或 optional + 手势申请,见开放问题);`web_accessible_resources` 暴露 `mp-main.js` 供主世界注入 |
| `vite.config.ts` | esbuild 增两个 IIFE 入口:`src/content/mp/index.ts` → `dist/mp.js`、`src/content/mp/main-world.ts` → `dist/mp-main.js`(与现有 content.js 同配置) |
| `src/shared/constants.ts` | `MSG` 增 `WECHAT_FILL`(侧边栏→SW,一键灌入);新增 `MP_MSG = { FILL, RESULT }`(SW↔mp content)与双世界 CustomEvent 名常量 |
| `src/shared/types.ts` | 增 `WechatFillRequest{ html, title, mode:'replace'\|'insert' }`、`WechatFillResult{ editor:'prosemirror'\|'ueditor', uploaded:number, failed:number }` |
| `src/background/index.ts` | 路由 `WECHAT_FILL`:查找/校验 mp 编辑页 tab → 注入 `mp.js` → 转发请求 |
| `src/background/convert/wechat-html.ts` | 块级元素打 `data-larksnap-key/content/action-id` 三属性;`renderCode` 代码行补 `<span leaf="">` |
| `src/sidepanel/SidePanel.tsx` + `actions.ts` | 公众号卡片增「灌入编辑器」入口:检测是否有已打开的 mp 图文编辑页 tab,有则可点,无则引导先复制粘贴;整篇替换前确认覆盖 |

## 4. 依赖

- **零新增 npm 依赖**。渲染是纯字符串拼接(SW 无 DOM);不需要 markdown-it(不走 MD 往返,见 §1);canvas 压缩用 mp 页原生 `OffscreenCanvas`/`<canvas>`;上传用原生 `fetch` + `FormData`。
- 已在用的既有模块:`convert/adapter.ts`(块树)、`convert/apool.ts`(行内解码)、`image-map.ts`(图片 dataURL)、`shared/themes.ts`(主题)。

## 5. 关键实现细节(踩坑点,均来自逆向核对)

1. **JSAPI 6 接口**(壹伴 `mpa-editor.js`):`mp_editor_get_isready`(就绪)/`mp_editor_get_content`(取正文)/`mp_editor_set_content`(整篇替换)/`mp_editor_insert_html`(光标插入)/`mp_editor_set_selection`(设光标)/`mp_editor_change_cover`(改封面)。本功能用前四个;灌入前必须 isready,整篇走 set_content,追加走 insert_html。
2. **编辑器判定**(壹伴 `initEditorContext` 同款):`window.__MP_Editor_JSAPI__` 存在且页面有 `.ProseMirror` → 新版;否则 `#ueditor_0` iframe 存在 → 老版;都没有 → 报"不是图文编辑页"。判定放主世界脚本里做(JSAPI 只在主世界可见)。
3. **双世界通信**:content script 用 `<script src=chrome.runtime.getURL('mp-main.js')>` 注入主世界(mp-main.js 须列进 `web_accessible_resources`);双向 CustomEvent/`postMessage`,消息体带扩展自定义标记 + 校验 `event.origin === 'https://mp.weixin.qq.com'`;请求带 id 与超时(编辑器一直不 ready 时 10s 报错),不静默挂起。
4. **内联模板 + 三属性**:每个块级 `<section>`/`<h*>`/`<pre>` 打 `data-larksnap-key`(块类型)、`data-larksnap-content`(正文容器标记)、`data-larksnap-action-id`(唯一 id)——壹伴 `data-mpa-md-*` 同构,灌入后可回查 DOM、为后续"换肤重排已灌入内容"留口。属性对粘贴路线无害(编辑器留不留都不影响样式)。
5. **styleStrMap 换肤**:主题完整定义在 `shared/themes.ts`(`WechatTheme`:headingColor/accentBar/quoteBorder),渲染器从主题对象取色拼样式,模板字符串里不写死主题色;加主题=加一条定义,渲染器零改动。当前三主题只动点缀,正文规则(15px/1.5/黑 90%)恒定。
6. **代码块微信 schema**:`<pre>` 挂 `code-snippet__js code-snippet code-snippet_nowrap` 三类名 + `data-lang`(已实现);JSAPI 路线每行代码再包 `<span leaf="">`(微信新版编辑器内部叶节点标记,壹伴踩坑点:没有它 set_content 后代码块退化成普通段落)。目标形态:`<section class="code-snippet__js"><pre class="..." data-lang="js"><code><span leaf="">...</span></code></pre></section>`,以真实编辑器实测为准微调。
7. **表格**:不输出 `<colgroup>`(壹伴 `cleanTableColgroup` 的等价前置:我们生成端就不产)、每个 td 样式全内联、真 `rowspan`/`colspan` + 覆盖格跳过(已实现,`covered` 矩阵 + `markSubtreeSeen` 防重复输出)。
8. **图片上传 filetransfer 参数**(壹伴 `uploadBlobImgToWxCdn`):POST `https://mp.weixin.qq.com/cgi-bin/filetransfer?action=upload_material&f=json&scene=8&writetype=doublewrite&groupid=1&ticket_id=${user_name}&ticket=${ticket}&svr_time=${now}&token=${token}&lang=zh_CN&seq=${now}`,body 为 `FormData.append("file", blob)`(不设 Content-Type,让浏览器带 boundary);`user_name`/`ticket` 从页面 `<script>` 正则抠,`token` 从编辑页 URL 取;响应 `cdn_url` 即 `mmbiz.qpic.cn` 永久链接。请求在 mp 页 content script 同源发起,自动带登录 Cookie——与宪法原则 I 的"借页面登录态"同构。
9. **大图压缩**:上传前若 `宽×高 > 5e6` 像素,canvas 等比缩放到阈值内再导出 blob(微信上传接口对超大图报错)。
10. **列表跨块续号**:client_vars 里每个列表项是独立块,渲染时连续同类块合并成一个 ol/ul、按嵌套深度轮换 type(1/a/i、disc/circle/square)——与 crx 的全局 ORDERED_START 等价(已实现)。
11. **剪贴板双口味 + 降级**:手势和焦点在侧边栏,由侧边栏写 `ClipboardItem({text/html, text/plain})`,失败降级 contenteditable + `execCommand('copy')`(这条老路天然产生 text/html 口味)(已实现)。
12. **覆盖确认**:`set_content` 是整篇替换,编辑器有既有内容时必须先确认(spec US1-4);`mp_editor_get_content` 可用来判断是否为空稿。

## 6. 宪法符合性检查

| 原则 | 评估 |
|---|---|
| I 零配置认证 | ✅ 符合精神:飞书侧复用现有 content 同源取数;公众号侧图片上传**借用 mp 页自身登录态**(页面抠 ticket/token),不要求用户申请任何 AppID/Secret;filetransfer 请求在 mp 页 content script 同源发起,SW 不直接请求。 |
| II 域名不写死 | ⚠️ 如实说明:飞书侧全部走现有 host 推导,零硬编码;**`mp.weixin.qq.com` 会硬编码**——它是用户的目标投放平台(微信官方唯一后台域),不是飞书域,不存在"私有化部署"变体,不属于本条约束对象(本条禁的是把飞书域写死)。代码注释说明这一点,manifest 权限精确到该域不扩大。 |
| III 导出可靠/可恢复 | ✅ 全程 `reportProgress`(拉取/下图 10-90/生成 95/完成);单图下载或上传失败占位不拖垮整篇;JSAPI 通信带超时与明确错误;非编辑页/未就绪给可读提示。 |
| IV 高质量 MD 双路 | ✅ 不触碰:本功能是导出后的「再排版投放」下游能力,取数完全复用现有 P-decode(`fetchClientVars`+apool),不新增取数路径、不动 host 能力探测(按 002 的边界声明写法)。 |
| V 隐私不外发 | ✅ 内容流转仅限:用户本机 ↔ 飞书接口(取数)↔ 用户自己的公众号后台(投放目标,用户主动触发)。`mp.weixin.qq.com` 是用户要发文章去的地方,不是第三方收集端;无任何自建/第三方服务器经手;匿名统计仅事件名(`export/wechat`),无内容无 URL。取证:grep 本功能代码,除飞书域推导与 mp.weixin.qq.com 外无外发请求(SC-006)。 |
| VI 合规告知 | ✅ 不新增取数能力,不涉及"绕过导出限制"的新场景;P-decode 的既有合规提示继续生效。 |

## 7. 验收与回归

- 跑 spec 的 SC-001~006。
- 基准对照:同一篇文档用 feishu2weixin crx 转一遍作对照,各块样式一致或更好(SC-001 配套)。
- 真机校准:公众号编辑器 PC 端粘贴/灌入 + 手机端预览(grid flex 是否挤压,必要时降级上下堆叠——复刻方案已列风险)。
- 飞书回归:markdown/word/pdf/html/xhs 各跑一篇确认零变化。
- `npm run typecheck` + `npm run build` 通过(宪法治理)。
- 取证 grep:SW 无飞书内部接口 fetch;本功能无第三方外发。

## 8. 分期

- **A 期(已完成)**:路线 A 剪贴板全链路——渲染器 + 行内扩展 + 三主题 + 悬浮预览 + 侧边栏剪贴板。已通过构建/类型检查/合成块树冒烟(13 断言),**待真实编辑器实测校准**。
- **B1 期(P0)**:US1 JSAPI 直灌——mp 页双世界注入、编辑器判定、set_content/insert_html、UI「灌入编辑器」入口 + 覆盖确认。
- **B2 期(P0,与 B1 联调)**:US2 图片素材库上传换 mmbiz + US4 补 `<span leaf="">` 与三属性。
- **B3 期(P2)**:US5 老版 UEditor 兜底。
- **持续**:US3 主题按需扩充(加主题=加一条 `WECHAT_THEMES` 定义)。

### 开放问题(需拍板)

1. **mp.weixin.qq.com 权限形态**:manifest 直接声明 `host_permissions`(安装即有,商店审核要说明用途)还是 `optional_host_permissions` + 首次使用手势申请(体验多一步,权限最小化)?倾向后者,与私有化域名的既有模式一致。
2. **「灌入编辑器」触发位置**:侧边栏(在飞书页导出后提示"检测到已打开的公众号编辑页,一键灌入")还是 mp 页内注入小按钮(壹伴模式,侵入页面)?倾向前者,零页面侵入。
3. **整篇替换 vs 光标插入的默认**:默认 `set_content`(带覆盖确认)还是默认 `insert_html`(更安全但排版可能受上下文影响)?倾向空稿 set_content、非空稿询问。
