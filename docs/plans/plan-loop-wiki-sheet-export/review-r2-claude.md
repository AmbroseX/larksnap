VERDICT: score=7 critical=0 major=4 minor=9

# r2 评审（Claude）—— v2.md

评审方式：把方案里点名的每一处文件:行号、函数签名、变量名、分支逻辑都打开真实源码核对了一遍。
下面先给核对结论，再给问题清单。

---

## 一、事实核对：方案说的和代码长的一样吗

**结论：几乎全对。** 这是 v2 相对 v1 最大的进步，也是本次没有出现 critical 的主要原因。
逐条核对结果：

| 方案里的断言 | 核对结果 |
|---|---|
| `PATH_TYPE_MAP`（feishu-detect.ts:5）只看路径第一段 | ✅ 属实，第 44-46 行 `segments[0]` |
| `detectDocFromUrl` 的填充块在第 52-57 行 | ✅ 属实，`if (docType && (known \|\| looksLikeFeishu))` |
| `actions-dispatch.ts:216` 是 `const isSheet = doc!.docType === 'sheets'` | ✅ 一字不差 |
| `runFeishuExport` 在第 203-227 行 / `runExcelExport` 在第 149-159 行 | ✅ 属实 |
| `index.ts:219 / 233 / 291` 三个入口绕开 dispatch | ✅ 属实（XHS 219、微信 233、附件 291，各自第 222/236/294 行调 `detectDocForTab`） |
| `bridge.ts:505` 是 `if (doc.docType === 'sheets')` | ✅ 属实；`let doc: DocInfo = info` 在 484 行、`if (tabId == null) throw` 在 470 行也都对 |
| brief 说的 `resolveDoc` 真名是 `resolveObjToken`（feishu-api.ts:33） | ✅ 属实，行号也对 |
| `feishu-api.ts:57` 有 get_info PermFail 的注释 | ✅ 属实 |
| `exportSheet`（sheet.ts:37）全程不用 token，靠 `resolveTargetTabId()` | ✅ 属实；`resolveTargetTabId` 第一行确实是 `if (_contentTabId != null) return _contentTabId`（feishu-proxy.ts:49-50），方案第三章的时序论证成立 |
| `extractEmbeddedSheetsInPage` 读 `window.spread`（sheet.ts:180） | ✅ 属实，且函数头注释白纸黑字写着「docx 页的模型在 `window.spread`（不是 spreadApp）」 |
| `sheet.ts:55` 是 `wb.sheets.filter((s) => s.rows.length > 0)` | ✅ 属实 |
| `sheet.ts:282-291 / 292-298 / 301 / 342-368 / 370-380 / 382-385` 各段位置 | ✅ 全部对得上 |
| `exportBitable`（bitable.ts:44）读 `window.bitableStore`，第 63-69 行判空、第 78 行起截断提示 | ✅ 属实 |
| `runOfficialMd`（markdown.ts:81-99）中间没有任何判空 | ✅ 属实，第 92-96 行 `downloadBase64` 直下 |
| `runDecodeMd` 的判空只在 `loginHint` 有值时（markdown.ts:131-139） | ✅ 属实 |
| `exportHtml`（html.ts:18-72）全程不判空，解构里没有 `whiteboards`（第 25 行） | ✅ 属实，这个提醒很到位 |
| `pdf.ts` 官方产物出口在第 83-86 行 | ✅ 属实 |
| `markdown.ts:163` 内嵌表格兜底链接是 `/sheets/${shtToken}?sheet=${subId}` | ✅ 属实，「`?sheet=` 后面是子表 id」的推论成立 |
| `editor.ts:78` 白名单 `['docx','wiki']` | ✅ 属实 |
| `src/content/` 下没有任何测试文件 | ✅ 属实（全仓 11 个 `.test.ts`，`exporters/` 下确实一个都没有） |
| 现有 `actions-dispatch.test.ts` 的 `ALL_ACTIONS` 漏了 `'feishu-excel'`（第 50-62 行） | ✅ 属实；也确实没 mock `./exporters/bitable` |
| `docs/internal/技术方案.md:549` 已实测 `obj_type`，`22=docx` | ✅ 属实（第 549 行 + 第 564-566 行的 token 解析链） |
| `docs/plans/2026-07-20-多维表格导出Excel.md:247` 记了 `?table=tbl…&view=vew…` 实测地址 | ✅ 属实 |
| `SKILL.md:38` 写死 `[--format md\|pdf\|html]`、`fetch.mjs:38` 是 `flag('--format','md')` | ✅ 属实 |
| `en.ts` 声明为 `export const en: Dict`，结构不一致会编译报错 | ✅ 属实（i18n/index.ts:13 `DeepStringify<typeof zh>`） |

**额外补一条对方案有利的证据**（方案没写，但它是核心修复能不能成立的关键）：
`src/background/convert/markdown.ts:44-45` 的返回值是
`parts.join('\n\n').replace(/\n{3,}/g,'\n\n').trim() + '\n'` ——
空文档解出来就是**一个换行符**，正好等于 bug 报告里那个「只有一个换行符的 .md」。
所以 §6.3 的 `!markdown.trim()` 判据**确实能拦住本 bug**，html 那个「只有标题、1KB」也一样
（body 来自 `marked.parse('')`，标题来自 `resolved.title`）。这一点核实过了，是方案最扎实的部分。

唯一一处笔误：`folderNameFrom` 在 `fetch.mjs` 第 **142** 行，方案写 143。不影响任何结论。

---

## 二、问题清单

### MAJOR-1 —— `bitableStore` 被当成最高优先级分类信号，但从没验证过 docx 页面上有没有它

- **位置**：v2.md §2.0 判据表、§5.3 `pickWikiKind`、§7.0 探测脚本、§十一 待验证清单
- **为什么是问题**：
  这是 r1 那条 critical 的**同构镜像，方案只修了一半**。
  r1 的 critical 是：`window.spread` 在普通 docx 页面上也存在（`sheet.ts:149-151` 的注释是铁证），
  拿它分类会把「wiki 包的、含内嵌表格块的普通文档」误判成整页表格。v2 正确地把 `spread` 从分类里剔除了。
  但 `pickWikiKind` 的第一条就是：

  ```ts
  if (frames.some((f) => f.bitableStore)) return 'bitable';   // 排在 spreadApp 前面
  ```

  **飞书 docx 是可以内嵌多维表格视图块的**，这类页面上有没有 `window.bitableStore`，
  方案从头到尾没问过——§7.0 的探测脚本只跑「wiki 包内嵌**表格**块的普通文档」，
  §十一 的待验证 #7 问的是反方向（「多维表格页面上是否也挂着 spread/spreadApp」），
  真正致命的那个方向（「docx 页面上是否挂着 bitableStore」）一条都没有。

  一旦成立，后果比 `spread` 那条**更严重**：`spread` 误判走 `exportSheet` 至少会报「未找到表格应用实例」；
  而 `bitableStore` 误判会让 `blockBaseOnly` 在 `runFeishuExport` 的**最前面**（`actions-dispatch.ts:211`，
  在 `withContentTab` 之前）直接返回 `bg.baseOnlyExcel`，一篇正常的 wiki 文档**连 Markdown / PDF / HTML / 附件
  四个导出全被挡死**，用户拿到的是「多维表格只支持导出 Excel」这种驴唇不对马嘴的报错。硬约束 2 正面被破。
- **怎么改**：
  1. §7.0 探测脚本**必须加一页**：找一篇**含内嵌多维表格块的 docx（或 wiki 包的同款）**，跑同一段
     `[typeof window.spreadApp, typeof window.spread, typeof window.bitableStore]`，
     预期 `['undefined','object'?,'undefined']`。§十一 加成待验证 #2b，与 #2 同等份量。
  2. 探到 `bitableStore` 存在 → `pickWikiKind` 不能只看「有没有」，得加结构确认：
     复用 `bitable.ts:140-146` 已有的那套判据
     （`arr(store.services).find(s => s?.modelOperator?.base)` 且 `base.blocks` 非空），
     内嵌块场景大概率结构对不上，能天然区分开。这段逻辑本来就要写在页内探测函数里，成本一行。
  3. 更稳的兜底：把 §2.4 的 C 层（`obj_type`）**从「不实现」提升为「bitable 分支强制实现」**。
     理由是方案自己给的——`obj_type` 已经在 `docs/internal/技术方案.md:549` 实测过、
     `resolveObjToken` 已经在调 `tree/get_node` 了、加一行零额外请求。
     方案说「知道类型不等于导得出」，这话对**导出**成立，但对**拦截**（`blockBaseOnly` 该不该挡）
     恰恰相反：拦截要的就是元数据事实，全局变量反而是最不该用的信号。

### MAJOR-2 —— §6.7「每一个成功出口都自查了」不成立：`wechat.ts` 是同源于 client_vars 的成功出口，全程不判空

- **位置**：v2.md §6.1 的成功出口盘点表、§6.7 的覆盖面结论
- **为什么是问题**：
  brief 的硬约束 4 写得非常死：「方案必须包含『导出内容为空时报错而不是报成功』这一层兜底，
  **覆盖面不限于本 bug**」；评审要求也点名「必须堵住所有成功出口，不只是 client_vars 那条」。
  §6.1 的盘点表只列了 markdown / html / pdf / sheet / bitable **五个**，
  然后 §6.7 直接下结论「每一个成功出口都自己回答了『我这次到底产出了什么』」。

  实际上 `src/background/exporters/wechat.ts` 是第六个、而且**同样吃 client_vars** 的成功出口：

  ```ts
  const cv = await fetchClientVars(resolved);
  const tree = buildBlockTree(data, resolved.objToken);
  ...
  return { success: true, data: { html, title } };     // wechat.ts:83，全程无判空
  ```

  空树 → 渲染出一段只有标题的 HTML → `success: true` → 侧边栏把它写进剪贴板，
  用户以为复制到了全文，粘到公众号编辑器里是空的。**这就是本 bug 的同款静默失败，只是产物是剪贴板不是文件。**

  更说明问题的是：**同目录的 `xhs.ts:31` 早就有这道防线**
  （`if (!nodes.length) throw new Error(t('progress.xhs.empty'))`），
  方案连这个现成的先例都没盘出来，说明 §6.1 那张表是凭印象列的，不是把 `exporters/` 目录扫了一遍。
  v1 被 r1 打的就是「说自己堵住了一整个类别其实漏了官方 md 出口」，v2 在同一个位置换了个文件重犯。
- **怎么改**：
  1. §6.1 的盘点表按 `ls src/background/exporters/` 重列一遍（13 个文件），
     每个成功出口标「已有判空 / 本次加 / 明确不需要（附理由）」。
     `attachments.ts:28-30` 的 `assets.length === 0 → return { success: true, count: 0 }` 也要给个说法。
  2. `wechat.ts` 加一行：在 `collectImageAssets(tree)` 之前判 `tree.order.length === 0`（或复用
     `isBlankExport`，把树先过一遍 `blocksToMarkdown` 代价太大，直接判块数更省），空则
     `reportProgress('wechat','error',t('bg.emptyExport')) + return { success:false }`。
  3. 剩下的（`file.ts` / `transcript.ts` / `pdf.ts` 的 `downloadCloudFileAsPdf`）逐个给结论，
     不加的写清「产物是服务端文件流，零字节由 downloadMedia 抛错兜住」这类具体理由，别一句「不涉及」带过。

### MAJOR-3 —— 桥接路径（R9）在后台隐藏标签页跑 `exportSheet`，而仓库昨天刚证实隐藏标签页会冻结渲染

- **位置**：v2.md §5.8（bridge 分流）、§7.2 的 R9、§九 风险表、§十一 待验证清单
- **为什么是问题**：
  `bridge.ts:466` 是 `chrome.tabs.create({ url: job.url, active: false })`——**后台隐藏页**。
  而本仓库**上一个提交**（`96fcd92`，2026-08-03）刚刚为此打过补丁：

  > `fix: 抓画板前把标签页切到前台，修复后台导出抓不到画板`
  > 「Chrome 会冻结**不可见**标签页的渲染 —— 后台页里 canvas 压根不会被画……
  > CLI/桥接模式的导出正是 `tabs.create({ active: false })` 开的后台页」

  为此新增了 `bringTabToFront()`（whiteboard.ts）。

  而 `extractWorkbookInPage` 的取数方式恰恰是**最吃渲染的那一类**：
  合成 `PointerEvent/MouseEvent` 点 `.sheet-tabs` 里的 tab（`sheet.ts:301-323`，还要
  `getBoundingClientRect()` 拿坐标）→ 轮询 `cs.getActiveSheet()` 直到切过去。
  wiki 壳比 `/sheets/` 直链**还多一层**：内容区大概率是懒挂载的（这正是方案自己在情形 3b
  和 §5.3 里承认可能命中的场景）。

  方案对这条**一个字都没提**：§九 的 9 条风险里没有、§十一 的 10 条待验证里没有、
  §7.2 的 R9 直接写「期望：拿到 zip 而不是空 md」当成理所当然。
  这不是「可能有点慢」，是「桥接这条路可能整条不成立」，而它是 brief 点名要保住的两条链路之一。
- **怎么改**：
  1. §十一 加一条待验证：「桥接后台隐藏页里，wiki 壳的表格模型是否加载、`clickTab` 能否切表」。
     验证方式很便宜：`fetch.mjs` 加 `--keep-tab` 跑一次现有的 `/sheets/` 直链（这条现在就在跑，
     先确认它到底有没有一直在悄悄出错），再跑 wiki 链接。
  2. 若实测受影响，直接复用 `whiteboard.ts` 的 `bringTabToFront()`——它已经写成了通用形态
     （返回 restore 函数、切换失败不影响主流程），把它从 `whiteboard.ts` 提到
     `src/background/tab-util.ts`（该文件已存在，`waitForTabComplete` 就在里面），
     `exportSheet` / `exportBitable` 各包一层。这是纯复用，不违反「不引入新依赖」。
  3. §九 风险表补一条，§7.2 的 R9/R11 期望值里写明「若命中冻结问题，本次可接受的降级是明确报错」。

### MAJOR-4 —— `spread` 回退分支的 `ok` 判据实际退化成「有没有数据」，起不到区分作用，还会把真空表全打成「未读到」

- **位置**：v2.md §三 情形 2 的第 251 行 `out.push({ id, name, rows, ok: read && (rows.length > 0 || !sized) })`
- **为什么是问题**：
  这条判据的本意（§5.6 的注释写得很清楚）是区分「读失败」和「确认的空表」。但展开看：

  - `read` 只有在 `readSheetGrid` 抛异常时才是 `false`，而 `readSheetGrid` 的取数循环
    （抄自 `sheet.ts:195-222` 的 `readGrid`）**每个单元格都包了 try/catch**，
    整体抛异常只可能是 `getRowCount()/getColumnCount()` 本身没有 —— 概率极低。
  - `sized = s.getRowCount() > 0`。飞书表格的空白网格**默认就有行数**（新建表就是 200 行 × 20 列），
    所以 `sized` 近乎恒为 `true`，`!sized` 这一支基本走不到。

  两条合起来，`ok ≈ (rows.length > 0)`。也就是说加了 `ok` 字段之后，
  §5.6(3) 的 `wb.sheets.filter((s) => s.ok && s.rows.length > 0)` 和现在的
  `filter((s) => s.rows.length > 0)` **筛出来的是同一批**，`ok` 一点区分力都没添。

  副作用倒是实打实的：**每一张真的空表都会被塞进 `unread`**，
  于是正常导出的成功文案变成「已导出 3/5 张表；未读到：Sheet4、Sheet5」——用户会以为出问题了去重试。
  更糟的边界：**整本表都是空表**时 `sheets.length === 0` 且 `unread.length > 0`，
  报的是 `t('progress.sheet.unreadable')`「有 5 张工作表没读到数据（页面可能未加载完成），导出已中止」，
  而不是本该报的 `progress.sheet.empty`「表格是空的」。用户会一直等一个永远不会来的加载。

  （对比之下 `spreadApp` 主路径的 `ok` 判据是好的：`ready`（`countTop` 确认 active 表名对上）
  是个真正有区分力的信号，那条改动我认可，包括方案额外发现的「切表失败仍 `readActive()`
  会把上一张表数据重复写进这一张」——这条我核对了 `sheet.ts:371-380`，属实，是个真 bug。）
- **怎么改**：
  在 `spread` 回退里换一个真有区分力的判据。`extractEmbeddedSheetsInPage`（sheet.ts:227-252）
  已经给了现成范式：**「找不到 / 挂载不出模型」才算读失败**。落到这里就是：

  ```ts
  // 定位阶段：sp.sheets 里拿不到这个 sheet 对象，或 getRowCount() 直接抛 → ok:false
  // 取数阶段：模型在、维度读得出 → 无论有没有字都算「确认读到了」，ok:true
  let dims = false;
  try { s.getRowCount(); s.getColumnCount(); dims = true; } catch { dims = false; }
  ...
  out.push({ id, name, rows, ok: dims && read });
  ```

  这样真空表 `ok:true, rows:[]` → 被 `filter` 正常跳过、不进警告；
  只有模型压根没挂载的表才进 `unread`。同时 §5.6(3) 的结算加一层：
  `sheets.length === 0 && unread.length === 0` → `progress.sheet.empty`（保持现有文案），
  `sheets.length === 0 && unread.length > 0` → `unreadable`。方案现在的写法是反的。

---

### MINOR-5 —— §5.5 的 import 改法会让 `index.ts` 编译不过

- **位置**：v2.md §5.5 结尾「import 里把 `requireReady` 换成 `prepareFeishuDoc`（`detectDocForTab` 仍被
  `MSG.CACHE_DOC` 等其他分支用着，别删）」
- **问题**：`requireReady` **同样**还被 `index.ts:310`（`MSG.CACHE_DOC`）用着，删了直接 TS 报错。
  方案只想到了 `detectDocForTab`。
- **改法**：改成「三处 `detectDocForTab + requireReady` 换成 `prepareFeishuDoc`，
  两个 import 都保留（CACHE_DOC 分支不动）」。

### MINOR-6 —— `bridge.ts` 没有 import `t`，且该文件的错误文案惯例是硬编码中文

- **位置**：v2.md §5.8 的 `res = { success: false, error: t('bg.bridgeBitableUnsupported') }`
- **问题**：`bridge.ts:20` 只 import 了 `ensureI18n`，没有 `t`。另外该文件周边所有错误文案都是硬编码中文
  （`'无法打开标签页'`、`'导出失败'`、`'普通网页只支持 md 格式（当前请求 ${fmt}）'`），
  单独这一条走 i18n 是风格分裂。
- **改法**：要么补 `import { t } from '../shared/i18n'` 并说明「桥接错误会回给 CLI，走 i18n 更合适，
  周边硬编码是历史遗留」；要么照周边写硬编码中文，就不用往 zh/en 各加一条。
  顺带确认一下：新文案里不能出现「登录 / login」，否则会被 `bridge.ts:519` 的
  `/登录|not.?logged|login/i` 误判成 `need-login`——我核了一遍，两条新文案都安全。

### MINOR-7 —— §6.5 的 `fail('pdf', …)` 在 `pdf.ts` 里不存在

- **位置**：v2.md §6.5
- **问题**：`fail()` 是 `markdown.ts:338-344` 的私有函数，`pdf.ts` 没有。
  方案括号里写了「按 pdf.ts 自己的错误返回写法调整」，但正文片段仍是照抄不能编译的形态。
  §6.4 对 `html.ts` 就明确写清了「`html.ts` 没有 `fail()`，按它自己的写法来」，两处标准不一致。
- **改法**：直接给出可用片段：
  `await reportProgress('pdf','error',t('bg.emptyExport')); return { success:false, error:t('bg.emptyExport') };`

### MINOR-8 —— 给 `SheetData` 加 `ok` 之后 typecheck 过不去，方案却断言「一次过」

- **位置**：v2.md §5.6(2)、§7.3
- **问题**：`ok` 不只要加在 `SheetData`（sheet.ts:23-28），
  `extractWorkbookInPage` 的**声明返回类型**（sheet.ts:273-277
  `Promise<{ title: string; sheets: { id; name; rows }[]; error?: string }>`）
  和 `EMPTY` 常量（sheet.ts:279）也必须同步加，
  否则 `{ ...EMPTY, error }` 与带 `ok` 的分支类型不兼容，`npm run typecheck` 直接红。
  §7.3 却写「typecheck 应当一次过；若报错，通常是 `actions-dispatch.test.ts` 缺了新 mock」——
  实际最可能的报错点在这里。
- **改法**：§5.6(2) 把三处（interface / 声明返回类型 / `EMPTY`）一起列出来。

### MINOR-9 —— §8.4 的新测试会因 mock 状态串场而飘

- **位置**：v2.md §8.4
- **问题**：现有 `actions-dispatch.test.ts:86-87` 的 `beforeEach` 只有 `vi.clearAllMocks()`，
  它清 `mock.calls` 但**不清** `mockReturnValue` 设的实现。
  §8.4 里 `vi.mocked(pickModelFrameId).mockReturnValue(7)`、`.mockReturnValue(3)`、
  `vi.mocked(pickWikiKind).mockReturnValue('sheet')` 都会泄漏到后续用例，
  用例一换顺序就可能假绿/假红。方案里唯一显式重置的是 critical 回归锁那条
  （`pickWikiKind.mockReturnValue(undefined)`），说明作者其实意识到了，但没系统处理。
- **改法**：这几条改用 `mockReturnValueOnce`，或在新 `describe` 里加
  `beforeEach(() => { vi.mocked(pickWikiKind).mockReturnValue(undefined); vi.mocked(pickModelFrameId).mockReturnValue(undefined); })`。

### MINOR-10 —— 硬约束 3（wiki 包多维表格）两条判据都待验证，C 层又不实现，且没有测试链接

- **位置**：v2.md §7.1 第 5/6 条、§十一 #5 #6 #7
- **问题**：这条能力的 A 层（`?table=tbl…` 是否稳定出现）是待验证 #5/#6，
  B 层（`bitableStore` 优先级是否够稳）是待验证 #7，C 层明确不实现，
  而 §7.1 第 5 条的验收前提是「找一个 wiki 包多维表格的链接」——方案手里并没有这个链接。
  brief 硬约束 3 是明确要求，现在有整条上线即失效、且验收环节自然跳过而无人发现的风险。
- **改法**：落地第 1 步（§十 探测）就把「拿到一个真实 wiki-bitable 链接」列为前置产出。
  拿不到就在 §〇 明确写「本次 wiki-bitable 只做到『不再被 `docType!=='base'` 直接拒掉』，
  能否导出成功不承诺」，别写进 §7.1 的验收表当成已交付。

### MINOR-11 —— `effectiveKind` 放在 `actions-dispatch.ts`，让 `bridge.ts` 为一个纯函数拖进整条 dispatch 依赖图

- **位置**：v2.md §4.2 / §5.8
- **问题**：`actions-dispatch.ts` import 了 `webcopy` / `summarize` / `screenshot` / `analytics` / `badge` /
  6 个 exporter。`bridge.ts` 现在只 import 4 个 exporter，为了一个 3 行纯函数把上面这些全拉进来，
  以后也容易出环（`index.ts` 已经同时 import 两者）。
- **改法**：`effectiveKind` 放 `wiki-model.ts`（它已经 import `DocInfo`，且 `pickModelFrameId` 就要用它），
  或放 `src/shared/`。`actions-dispatch.ts` 从那里 re-export 给测试用即可。

### MINOR-12 —— `spread` 回退里 `clickTab('')` 会对页面上第一个空叶子节点乱派指针事件

- **位置**：v2.md §三 情形 2 的 `try { name = String(s.name()); } catch { /* 名字读不到不影响取数 */ }`
- **问题**：`name` 读失败时保持 `''`，随后无条件 `clickTab(name)`。
  而 `clickTab` 的兜底选择器是（sheet.ts:305-307）
  `[...cont.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent?.trim() === name)`
  —— `name === ''` 会命中**页面上第一个空叶子元素**（随便一个空 div/span/svg），
  然后对它派发 pointerdown/mousedown/pointerup/mouseup/click 五连击。
  在一个协同编辑页面上对着不明元素点五下，后果不可预测。
- **改法**：`if (name) clickTab(name);`。顺带在 §三 的注释里说明「名字读不到就不点 tab，直接读模型
  （`extractEmbeddedSheetsInPage` 证明了不点也能读）」。

### MINOR-13 —— `folderNameFrom` 行号笔误

- **位置**：v2.md §十三 第 4 条「`fetch.mjs:143` 的 `folderNameFrom()`」
- **问题**：实际在第 **142** 行。纯笔误，结论不受影响。

---

## 三、值得肯定的地方（不是客套，是说明哪些别在下一版改坏）

1. **「分类」与「定位」拆开**（§2.0）是正确且必要的修正，`pickWikiKind` / `pickModelFrameId`
   拆成纯函数也确实换来了可单测。这个结构别动。
2. **判空兜底提到落地第 2 步**（§十）判断准确：它是唯一一个「就算全盘探测失败也仍然兑现硬约束 4」的改动，
   而且我核实过 `blocksToMarkdown` 空文档返回 `'\n'`，`!markdown.trim()` **确实能拦住本 bug**。
3. **`prepareFeishuDoc` 收口**（§4.3）解决了 r1 第 3 条，`requireReady` 放在探测之前
   （未授权私有化域名不注入）也是对的，硬约束 5 落实到位。
4. **不改 `docType`、加 `wikiKind` 字段**（§4.1）给的三条理由都经核实成立
   （`resolveObjToken` 的 `docType !== 'wiki'` 早返回、`editor.ts:78` 白名单、`cache-manager` 存 `docType`）。
5. **额外发现 `spreadApp` 主路径「切表失败仍 `readActive()` 导致数据重复」**（§十三 第 5 条）
   —— 我核了 `sheet.ts:371-380`，属实，这是 r1 没提到的真 bug，方案主动挖出来并修掉，加分。
6. 事实核对表（§一）本身就是好实践，且经得起复查。

---

## 四、结论

**score = 7 / 10。critical = 0，major = 4，minor = 9。**

方案的骨架是对的，事实准确度在我见过的同类方案里属上乘，核心修复（判空兜底）经核实**确实能堵住本 bug**。
但离「我愿意为它的成败背书」还差四件事：

- MAJOR-1：分类判据只修了 `spread` 一半，`bitableStore` 那一半原样留着，还排在最高优先级 —— 硬约束 2 有真实破口；
- MAJOR-2：§6.7 的覆盖面结论是错的，`wechat.ts` 这个 client_vars 成功出口漏了 —— 硬约束 4 没做满，
  而且是 v1 被打过的同一类错误；
- MAJOR-3：桥接后台隐藏页的渲染冻结问题（仓库上一个提交刚踩过）完全没进视野 —— 硬约束 2 里的 CLI 链路没保住；
- MAJOR-4：`spread` 回退的 `ok` 判据算出来等于没加，还会把真空表全打成「未读到」，
  整本空表时给的错误提示是错的。

这四条都不需要推翻架构，改法在上面都给了。修完 + 补上 §7.0 的两页新探测（含内嵌 bitable 的 docx、
桥接后台页），我会给到 8.5 以上。
