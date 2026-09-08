# 任务定义：修复 larksnap 对「wiki 节点承载表格」的导出

## 一句话
larksnap 扩展在知识库（wiki）链接下打开电子表格 / 多维表格时，导出走错了管线，产出空文件。要一份可直接照着写代码的修复方案。

## 方案类型与读者
- 类型：技术实施方案（浏览器扩展 bugfix + 小幅能力扩展）
- 读者：本项目维护者（熟悉这份代码库），拿到方案后直接照着改代码
- 用途：确定改动范围、分支逻辑、验证步骤

## 背景：这个 bug 是什么

复现链接（讯飞私有化部署的飞书底座）：
```
https://yf2ljykclb.xfchat.iflytek.com/wiki/JwUOwuU9KiUJYnkcb35r5aJkzsb?sheet=fakwBh
```
这是一个 **wiki 节点，里面包的是电子表格**。用 larksnap 导出 Markdown/HTML，**导出"成功"，但产出的文件只有一个换行符**（另有一次 html 导出产物只有标题、1KB）。

## 根因（已定位，不需要方案再论证一遍）

1. `src/content/feishu-detect.ts` 的 `PATH_TYPE_MAP` **只按 URL 路径第一段判类型**：
   `docx|docs|wiki|sheets|base|file` → 同名 docType。
   所以 `/wiki/<token>?sheet=fakwBh` 被判成 `docType: 'wiki'`，**URL 里的 `?sheet=fakwBh` 参数完全没被看过**。
2. `src/background/actions-dispatch.ts:216` 的分流是 `const isSheet = doc.docType === 'sheets'`，
   只认 `/sheets/` 路径。于是 wiki 包的表格走进了 **docx 的 client_vars 块导出管线**（`exportMarkdown`）。
3. 表格的内容不在 client_vars 里（表格数据走协同 WebSocket 进页面内存、画在 canvas 上），
   块是空的 → 导出流程一路成功 → 落地一个空文件。

已实测确认的识别结果（vitest 跑 `detectDocFromUrl`）：
```
/wiki/JwUOwuU9KiUJYnkcb35r5aJkzsb?sheet=fakwBh   → {docType:"wiki",  token:"JwUOwuU9...", isPrivateDeploy:true}
/sheets/JwUOwuU9KiUJYnkcb35r5aJkzsb?sheet=fakwBh → {docType:"sheets", token:"JwUOwuU9...", isPrivateDeploy:true}
```

## 已做的验证（结论已定，方案不要推翻，可以在此基础上继续推理）

**验证一**：手动把 URL 路径从 `/wiki/` 改成 `/sheets/`（token 不变）→ 确实进了表格分支，
但报错「未找到表格应用实例（spreadApp）」。**重复两次结果一致，排除加载慢**。

**验证一的正确解读**（重要，评审时请以此为准）：
`exportSheet` 通过 `chrome.scripting.executeScript` 注入到**当前标签页**读 `window.spreadApp`，
**它从头到尾不使用 token**。改 URL 等于开了一个新页面，而 wiki token 不是表格的 obj_token，
那个新页面根本没渲染出表格，所以没有 spreadApp。
→ 这说明的是「换 URL 这条路不该走」，**不是**「wiki 里的表格读不到」。

## 现有代码结构（方案必须复用，不要另起炉灶）

- `src/content/feishu-detect.ts` — `detectDocFromUrl(url)` 纯 URL 识别，返回 `DocInfo`
  （字段：`isFeishuDoc/docType/token/title/url/host/isPrivateDeploy/needsAuth`）。
  另有 `detectCurrentDoc()` = URL 识别 + DOM 取标题，由 content script 响应 `DETECT_DOC` 消息。
- `src/background/doc-detect.ts` — `detectDocForTab(tabId)`：先纯 URL 识别（未授权私有化域名也能判），
  未授权则 `needsAuth:true`，已授权则注入 content.js 取完整 DocInfo。
- `src/background/actions-dispatch.ts`
  - `runFeishuExport(ctx, kind)`：`detectDocForTab` → `requireReady` → `blockBaseOnly` →
    `withContentTab(...)` 内按 kind 分流；`kind==='markdown'` 时 `isSheet ? exportSheet : exportMarkdown`。
  - `runExcelExport(ctx)`：只放行 `docType === 'base'` → `exportBitable`。
  - `blockSheetOnly(doc)`：`docType==='sheets'` 时挡掉 pdf/html。
  - `blockBaseOnly(doc)`：`docType==='base'` 时挡掉 md/pdf/html。
- `src/background/exporters/sheet.ts`
  - `exportSheet(doc)` → 注入 MAIN world 跑 `extractWorkbookInPage()`：读 **`window.spreadApp`**，
    经 `app.collaborativeSpread` / `app.shell.viewModelManager.spread` 拿 sheet 列表，
    **合成指针事件点 tab 逐张切换**取数（`setActiveSheetById` 不触发加载），轮询等数据，
    `getText(r,c)` 读全表、裁空尾行尾列。产出 zip（1 个 Markdown + 每张表 1 个 CSV）。
  - `extractEmbeddedSheets(refs)` → 读 **`window.spread`**（注意：docx 内嵌表格块是这个全局，不是 spreadApp），
    按**子表 id** 在 `spread.sheets[]` 里定位（`s.id()`），找不到就滚到 `[data-record-id=<blockId>]` 触发懒挂载再轮询。
- `src/background/exporters/bitable.ts` — `exportBitable(doc)` 读 **`window.bitableStore`**，
  用飞书自己的 `cellValueToString` / `cellValueToStdValue` 序列化单元格，出多 sheet 的 .xlsx。
  受首屏 recordLimit（约 2000 行）限制，不足时照出但提示「N/M 行」，不静默截断。
- `src/background/feishu-api.ts` — `resolveDoc(doc)`：wiki 类型时调
  `/space/api/wiki/v2/tree/get_info/?wiki_token=` 取 space_id，再 `/space/api/wiki/v2/tree/get_node/` 取 `obj_token`。
  **目前只取了 `obj_token`，没有读 `obj_type`**（响应里是否有该字段、字段名叫什么，未经验证）。

## 关键未知（方案必须正面处理，不许假设掉）

**在 wiki 外壳页面上，表格模型挂在哪个全局变量上？**
代码里已有两套先例：独立表格页是 `window.spreadApp`，docx 内嵌表格块是 `window.spread`，多维表格是 `window.bitableStore`。
wiki 壳里是哪一套，**尚未验证**。待跑的探测（在那个 wiki 页面控制台）：
```js
[typeof window.spreadApp, typeof window.spread, typeof window.bitableStore]
```

方案必须给出**三种探测结果各自对应的实现路径**，并明确哪条是主路径、哪条是回退：
- `spreadApp` 存在 → 最省事：识别到「wiki 包表格」后直接在当前页复用 `exportSheet`，不解析 obj_token、不换 URL
- 只有 `spread` → 复用 `extractEmbeddedSheets` 的按子表 id 定位思路（`?sheet=fakwBh` 里的 `fakwBh` 很可能就是子表 id）
- 三者皆无 → 才需要走 `feishu-api.ts` 解析 `obj_type` 判断这个 wiki 节点到底包的是什么

## 硬约束（逐字遵守）

1. **不要引入新依赖**，不要重写现有 exporter，改动尽量集中在类型识别 + dispatch 分流两处。
2. **不能破坏现有行为**：`/docx/`、`/sheets/`、`/base/` 直链，以及 wiki 包普通文档（正常 docx 内容）的现有导出必须原样工作。
3. wiki 包的**多维表格**（形如 `/wiki/<token>?table=tbl...&view=vew...`）要一并考虑——
   现状是点「导出 Excel」会被 `runExcelExport` 的 `docType!=='base'` 判定直接拒掉。
4. **不许静默失败**。当前 bug 最恶劣的一点就是"导出成功但文件是空的"。方案必须包含
   「导出内容为空时报错而不是报成功」这一层兜底，覆盖面不限于本 bug。
5. 私有化部署域名（本例 `yf2ljykclb.xfchat.iflytek.com`）的授权流程不能改动。
6. 代码风格跟随现有仓库：中文注释、简洁直白、不堆抽象。遵循 YAGNI / KISS。
7. 方案里所有代码片段必须能对上真实的现有函数签名和变量名（上面已给出）。
   **不确定的地方要显式标注「待验证」，不许编造 API**。

## 方案必须回答的问题

1. 怎么判断一个 `/wiki/` 链接包的是表格 / 多维表格 / 普通文档？
   （URL 参数？页面 DOM？全局变量探测？wiki API 的 obj_type？各自代价与可靠性）
2. 判断出来之后，`DocInfo` 怎么表达这个信息？改 `docType` 还是加字段？对现有 `blockSheetOnly` /
   `blockBaseOnly` / `requireReady` / `runExcelExport` 的连锁影响是什么？
3. 具体改哪些文件、哪些函数、加什么分支（给可落地的代码片段）
4. 空导出兜底加在哪一层最合适（exporter 内？trackedExport？还是各自 exporter 自查）
5. 验证步骤：怎么确认修好了，以及怎么确认没弄坏 docx/sheets/base 直链
6. 单元测试加在哪（现有 `feishu-detect` 和 `actions-dispatch` 都有 `.test.ts`）

## 评审设置

- 评审引擎：**codex CLI（gpt-5.6-sol）跨模型评审**（用户明确要求）
- 评审视角：可行性为主（这个改法在真实代码里跑得通吗、有没有假设错的地方），
  兼顾完整性（分支覆盖全不全、有没有漏掉的连锁影响）
- 收敛标准：critical=0 且 major=0 且 score ≥ 8/10
- 最大轮数：3 轮评审-修订

## 备注（不影响方案，供上下文）

`data/ontology/智能营销/安徽中行数据表字段/` 下有上次失败导出留下的残留文件（1KB 的 html + 空 md），
用户会在拿到真数据后自行清理，方案不要涉及。
