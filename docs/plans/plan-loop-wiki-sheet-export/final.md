# wiki 节点承载表格 / 多维表格的导出修复 —— 终稿

> **bug**：`/wiki/<token>?sheet=xxx` 点「导出 Markdown」报成功，产出的 `.md` 里只有一个换行符。
> 复现链接：`https://yf2ljykclb.xfchat.iflytek.com/wiki/JwUOwuU9KiUJYnkcb35r5aJkzsb?sheet=fakwBh`
>
> **状态**：三轮「写稿 → 跨模型评审 → 修订」用尽，**未达收敛标准**（要求 critical=0、major=0、score≥8；
> r3 codex 实际 score=5 / major=4 / minor=3）。剩余问题一条不删地列在**第十四章**；其中三条不用实测就能定论的，
> 终稿已就地改掉并标「未再经评审」，其余全部卡在同一件事上：**没有实测数据**。
>
> **先读第零章。它没做完，第三、五章有一半是猜的，不要写代码。**

---

## 零、现在唯一该做的事：先跑探测

### 0.1 为什么

地基是一个至今没人验证的事实：**wiki 外壳页面上，表格模型挂在哪个全局变量上？**
仓库里三种先例互不相同：`/sheets/` 直链用 `window.spreadApp`（`sheet.ts:37`）；docx 的**内嵌表格块**用
`window.spread`（`sheet.ts:180`，注释明写「不是 spreadApp」）；多维表格用 `window.bitableStore`（`bitable.ts:44`）。
wiki 壳属于哪种，**零数据**。后果：第三章三条路径最终只用得上一条；iframe 定向注入那套可能压根不需要；
r3 剩下的 4 个 major 里 **3 个直接源于「没数据只能猜」**（§14.3）。

### 0.2 要跑的探测

**页面 A —— 复现链接本人**（已登录、等加载完）：

```js
// ① 谁在？—— 整份方案的分叉点
[typeof window.spreadApp, typeof window.spread, typeof window.bitableStore]
// ② 链路对不对（决定情形 1 能否一行不改复用 exportSheet）
window.spreadApp?.collaborativeSpread?.getActiveSheet?.().name?.()
window.spreadApp?.shell?.viewModelManager?.spread?.sheets?.length
window.spread === window.spreadApp?.shell?.viewModelManager?.spread
// ③ 模型在不在 iframe 里（决定 frameId 那套要不要做）
[...document.querySelectorAll('iframe')].map(f => {
  try { const w = f.contentWindow;
    return [f.src.slice(0,80), typeof w.spreadApp, typeof w.spread, typeof w.bitableStore]; }
  catch { return [f.src.slice(0,80), 'cross-origin']; } })
// ④ 切表用的 tab 容器在不在
!!document.querySelector('.sheet-tabs')
```

**页面 B —— wiki 包的、含内嵌表格块的普通文档**：跑 ①，预期 `['undefined','object','undefined']`
（「`spread` 不能用来分类」的正面证据）。顺手看地址栏有没有 `?sheet=`（待验证 #12）。

**页面 C —— 含内嵌多维表格视图块的 docx（或 wiki 包的同款）**：跑 ①，再跑结构确认，预期 `['undefined','no-base']`：

```js
[typeof window.bitableStore,
 (() => { const arr = o => Array.isArray(o) ? o : o && typeof o === 'object' ? Object.values(o) : [];
   const b = arr(window.bitableStore?.services).find(x => x?.modelOperator?.base)?.modelOperator?.base;
   return b ? arr(b.blocks).length : 'no-base'; })()]
```

**页面 D —— 桥接后台页**：给 `skills/larksnap-fetch/scripts/fetch.mjs` 临时加个 `--keep-tab`（别关掉
`tabs.create({active:false})` 开的后台页），**先跑现有的 `/sheets/` 直链**（确认它是不是一直在悄悄出错），再跑 wiki 链接：
看模型能不能加载、`clickTab` 能不能切表、zip 里有没有真数据。

**另外要拿到**：一个真实的 **wiki 包多维表格链接**（`/wiki/<token>?table=tbl…&view=vew…`）。没有它，硬约束 3 无从验收。

### 0.3 结果 → 走哪条路

| 探测结果 | 结论 | 方案怎么裁 |
|---|---|---|
| A① = `['object','object','undefined']` 且 A② 的 `sheets.length>0` | **情形 1，主路径成立**（最可能） | 第三章只留 §3.1；**删掉 §3.2 的 `spread` 回退（B1）** 与 §5.5(5)。页内抽取器一行不改 |
| A① = `['undefined','object','undefined']` | **情形 2**：只有 `window.spread` | 必须做 B1。分类只能靠 URL `?sheet=`，`spread` 无区分力 |
| A① 三个全无，但 A③ 某 iframe 里有 | **情形 3a**：模型在子 frame | `allFrames` + `frameId` 是必需的，§5.2 / §5.5(1) 全保留 |
| **A③ 没有 iframe，或 iframe 里也没模型** | 模型一定在主 frame | **整套删掉 `allFrames` / `frameId` / `pickModelFrameId`**：只注主 frame，exporter 不加参数。少约 40 行代码 + 6 条测试，**r3 的 major-2 / major-3 直接消失** |
| A① 三个全无、A③ 也没有 | 情形 3b | 只保证「明确报错而不是空文件」；要真支持得实现 §2.5 的 C 层，或按 §14 声明不支持 |
| A④ = `false` | wiki 壳 tab 容器不同款 | `clickTab` 补一个容器 fallback，否则多表只能导出当前这张 |
| **页面 B 出现 `spreadApp`** | 灾难信号 | 分类判据整个作废，必须改用 C 层 `obj_type`。**会推翻骨架** |
| **页面 C 的 `bitableStore` 是 object 且 blocks>0** | §2.4 的结构确认不够 | **必须启用 C 层**做二次确认并实测 `obj_type` 数值。**另一个会推翻骨架的结果** |
| 页面 C = `['undefined','no-base']` | 结构确认够用 | C 层不实现 |
| 页面 D：`/sheets/` 直链在后台页正常 / 就拿不到数据 | 桥接健康 / 后台页冻结影响表格 | 按 §5.6 改，B2 不做 / 做 B2（`bringTabToFront()` 搬到 `tab-util.ts`），或声明「CLI 不支持表格」 |
| 拿不到 wiki-bitable 链接 | 硬约束 3 无法验收 | §7.1 的 6/7 移入未验证项，交付说明写死边界，**不许当已交付跳过** |

**探测完**：原始输出逐字贴进第十二章 → 按上表裁方案 → 从第十章第 2 步开工。
（第 2 步「空导出兜底」是唯一**不依赖探测结果**的改动，急着写代码就只写这步。）

---

## 一、事实校准（照 brief 直接写会写错的 5 处）

| brief 的说法 | 真实代码 |
|---|---|
| `resolveDoc(doc)` | 真名 **`resolveObjToken(doc)`**（`feishu-api.ts:33`），返回 `ResolvedDoc { objToken, wikiToken?, spaceId?, title? }` |
| `obj_type` 未经验证 | **已验证**：`docs/internal/技术方案.md:549` 记私有化实测返回 `obj_token / obj_type / title / space_id`，564 行给了 `22`=docx；sheet / bitable 的数值**仍待实测** |
| `feishu-detect` 已有 `.test.ts` | **不存在**，`src/content/` 下一个测试文件都没有 → 新建 |
| 只有一个分流点 | 另有 **`bridge.ts:505`** 的 `if (doc.docType === 'sheets')`。不改它，CLI 抓 wiki 表格照样空文件 |
| 只有经 `dispatchAction` 的入口 | **`index.ts:219/233/291`**（小红书/微信/附件）绕开 dispatch，自己 `detectDocForTab + requireReady + blockXxxOnly` |

**两条决定判据成立与否的证据（已核对源码）**：`convert/markdown.ts:44-45` 返回 `parts.join('\n\n')…trim() + '\n'`
——**空文档解出来就是一个换行符**，正好是 bug 里那个 `.md`，所以第六章 `!markdown.trim()` 确实拦得住本 bug；
`markdown.ts:163` 拼内嵌表格链接用 `/sheets/${ref.shtToken}?sheet=${ref.subId}`——**`?sheet=` 后面就是子表 id**，
坐实 `fakwBh` 是子表 id，也坐实「URL 带 `?sheet=` ⇒ 这页渲染的是电子表格」。

另两处更正：`wechat.ts:79` 的判空**是死代码**而非不存在（§6.4）；`sheet.ts:150` 的「后台页模型照常加载」实测
只覆盖 `spread` 路径且没验过点 tab（风险 3）。

---

## 二、怎么判断 `/wiki/` 链接包的是什么

### 2.1 分类 vs 定位（骨架）

| | 分类：这节点是什么 | 定位：模型在哪个 frame |
|---|---|---|
| 何时做 | `docType==='wiki'` 且 URL 判不出时 | 已知/已判出是 sheet / bitable 时 |
| 认哪些信号 | `?sheet=` / `?table=tbl…`；`spreadApp`、`bitableStore`（**都要结构确认**） | sheet → 优先 `spreadApp`，退而求其次 `spread`；bitable → `bitableStore` |
| 为何不认 `spread` | docx 内嵌表格块也挂它，零区分力 | 类型已定，此时它只回答「模型在这儿」 |

### 2.2 四种判据

| 判据 | 代价 | 可靠性 / 何时失效 |
|---|---|---|
| **A. URL query** | 零 | 高；从目录树点进去可能只有 `/wiki/<token>` |
| **B. 全局变量 + 结构确认** | 一次注入，需域名已授权 | **最高**——导出器要用的就是这个模型，探到就一定导得出；页面没加载完时探不到 |
| **C. wiki API `obj_type`** | 两跳网络 | 高，但 `get_info` 在个人版/部分私有化会 PermFail（`feishu-api.ts:57`）；知道类型 ≠ 导得出 |
| **D. DOM 特征** | 一次注入 | 低，class 名随版本漂移。不用 |

**A 主判据 + B 兜底；C 不实现（写清落点与启用条件）；D 不用。**
要的不是「服务端元数据是什么」，而是「当前页上有没有一个我能读出数据的模型」——后者才是导出成败的充要条件。

### 2.3 A 层：URL 参数

`?sheet=<非空>` → `'sheet'`；`?table=` 值以 `tbl` 开头 → `'bitable'`（佐证：
`docs/plans/2026-07-20-多维表格导出Excel.md:247` 的实测地址 `?table=tblSGe3lJ8GDnah1&view=vewLxqjFRD`）；
其余 → `undefined` 交 B 层。不强制同时带 `view=vew`（**待验证**；多一个条件只会漏判不会误判，按宽的写）。
**只在 `docType === 'wiki'` 时解析。**

⚠️ 这是**候选信号不是铁证**（r3 minor-1）：没数据证明普通 wiki 文档 URL 上绝不会出现 `?sheet=`。
兜底是第六章判空——误判后读不到模型会明确报错，不落空文件。

### 2.4 B 层：全局变量 + **结构确认**

只对 wiki 跑。**光看 `typeof` 不够**：飞书 docx 能内嵌多维表格视图块，那类页面上会不会也挂 `window.bitableStore`
**从未验证**（页面 C 要回答的）。一旦挂着而我们只看「有没有」，正常 wiki 文档会被判成 bitable，而 `blockBaseOnly`
在 `runFeishuExport` **最前面**（`actions-dispatch.ts:211`，在 `withContentTab` 之前）直接返回 `bg.baseOnlyExcel`，
**md/pdf/html/附件四个导出全被挡死**，硬约束 2 正面被破。

所以探测顺手做结构确认（判据抄现成代码）：`bitableStore` 要在 `services` 里找得到 `modelOperator.base` 且
`base.blocks` 非空（抄 `bitable.ts:129-146`）；`spreadApp` 要 `shell.viewModelManager.spread.sheets.length > 0`
（抄 `sheet.ts:284-296`）。内嵌视图块不会挂一整个 base 模型，天然区分开。代价：探测函数 3 行变 20 行，零网络。
**容器归一化必须和抽取器同款**（r3 minor-2，终稿已改）：照抄 `bitable.ts:129-130` 的 `arr()`，`services` 和 `blocks`
都用它，别一处 `Object.keys` 一处 `arr`，否则分类结论和实际抽取结论会打架。

### 2.5 C 层：`obj_type`（不实现，写清落点 + 启用条件）

A、B 都判不出说明页面上确实没有可读模型，此时查出类型也导不出，只能改善提示文案——**收益是提示质量不是功能**，
按 YAGNI 不做。落点：`resolveObjToken()` 已在调 `tree/get_node` 读 `n?.obj_token`，加一行
`objType: n?.obj_type != null ? Number(n.obj_type) : undefined` 即可，零额外请求。
**启用条件**：页面 C 若探到「内嵌 bitable 视图块的 docx 上也挂着结构完整的 `bitableStore`」，**必须启用 C 层**
做二次确认并实测数值。⚠️ r3 对「不实现 C 层」有异议（§14 M1）：**功能不做，但必须在交付说明里把
「无 query + 模型未挂载」明确写成不支持，不许含糊成已覆盖。**

---

## 三、三种探测结果各自的实现路径

**3.1 情形 1（主路径）：`spreadApp` 存在。** 页内抽取器一行不用改（只需 `frameId` 参数 + 第六章判空改造）。
`exportSheet(doc)` 全程不用 `doc.token`，靠 `resolveTargetTabId()` 拿 tab 注入读 `window.spreadApp`。
时序前提（已核对）：`runFeishuExport` 在 `withContentTab(ctx.tabId, …)` 里调 exporter，后者会 `setContentTab`，
而 `resolveTargetTabId()` 第一行是 `if (_contentTabId != null) return _contentTabId`（`feishu-proxy.ts:49-50`）——
**探测用的 tab 和导出注入的 tab 必然是同一个**，不会「在 A 页探到、跑去 B 页导」。`exportBitable` 同理。

**3.2 情形 2（条件项 B1）：只有 `window.spread`。** 类型必须由 A 层（URL `?sheet=`）确认，`spread` 自己不能当分类依据；
URL 也没有就按普通文档走，由第六章判空给明确错误。`app.shell.viewModelManager.spread` 很可能**就是**
`window.spread`（**待验证**，A②）。若成立，情形 2 只缺 `cs.getActiveSheet()` 这一个读数入口——而
`extractEmbeddedSheetsInPage` 已证明**不需要它**：直接对 `spread.sheets[]` 的 sheet 对象调
`getRowCount() / getColumnCount() / getText(r,c)` 就能读。分支加在 `extractWorkbookInPage` 内 `run()` 的 `if (!app)` 处，
**`spreadApp` 分支一字不改**，逐张表：

遍历 `sp.sheets`，每张表：`name = s.name()`、`id = s.id?.()`（各自包 try/catch）；**`if (name) clickTab(name)`——
名字读不到就别点**，`clickTab('')` 的兜底选择器会命中页面第一个空叶子元素并派五连击（`sheet.ts:305-307`），
不点也能读（`extractEmbeddedSheetsInPage` 已证明）。然后最多轮询 8 次（每次 `sleep(700)`）：
`try { s.getRowCount(); s.getColumnCount(); dims = true; rows = readSheetGrid(s); } catch { dims = false; }`，
`dims && (rows.length > 0 || i >= 4)` 就 break，最后 `out.push({ id, name, rows, ok: dims })`。
**`ok` 判据是「维度报不报得出」不是「有没有数据」**：模型在、维度读得出 = 确认读到（哪怕一个字没有，那是真空表）；
维度都读不出 = 没挂载好，数据不可信。

配套小重构（都在 `extractWorkbookInPage` 内部，行为不变）：`readActive()`（342-368 行）的读格逻辑抽成
`readSheetGrid(s)`（入参是 sheet 对象），`readActive()` 改成 `readSheetGrid(cs.getActiveSheet())` 再包 id/name；
`clickTab`（301 行）和标题提取（382-385 行，抽成 `pageTitle()`）提到 `run()` 顶部共用；
**不碰 `extractEmbeddedSheetsInPage`**。

**3.3 情形 3：三个全局都没有。**
*3a 模型在 iframe 里*：两个 exporter 现在是 `executeScript({ target: { tabId }, … })`，**默认只注主 frame**。
解法：探测用 `allFrames: true`，`pickModelFrameId` 挑 frame，exporter 加可选 `frameId`
（`target: frameId != null ? { tabId, frameIds: [frameId] } : { tabId }`，不传就是现在的行为，直链零影响）；
`clickTab` 里的 `document.querySelector('.sheet-tabs')` 注进那个 frame 后自然指向该 frame。
**若 A③ 证明没有 iframe，这套按 §0.3 删掉。**
*3b 页面没加载完 / 这节点根本不是表格*：`wikiKind` 保持 `undefined`，按现状走 `exportMarkdown`；若它真是表格，
`client_vars` 解出来是空的 —— 由第六章判空变成明确报错而不是落空文件。若实测发现 3b 频繁出现，
再加短轮询重探（3 次 × 800ms）。**先不做。**

---

## 四、`DocInfo` 怎么表达，连锁影响是什么

**4.1 加字段不改 `docType`**：`DocInfo` 追加 `wikiKind?: 'sheet' | 'bitable'`（注释：只在 `docType==='wiki'` 时可能有值；
URL 能判就先判，判不出靠页面模型探测补齐；`undefined` = 按普通文档处理）。
不改 `docType` 的三个理由：① `resolveObjToken` 第一行 `if (doc.docType !== 'wiki') return { objToken: doc.token, … }`，
改了会把 **wiki_token 当 obj_token** 用；② `editor.ts:78` 白名单是 `['docx','wiki']`，改了会让本能编辑的 wiki 文档被误拒；
③ `cache-manager.ts:22` 存 `docType`、`CacheView.tsx:62` 直接显示，用户会看到和 URL 对不上的类型。加字段则信息只增不减。

**4.2 判据 + 识别定位收口，都放 `wiki-model.ts`**（`bridge.ts` 也要用，而它现在**完全没 import `actions-dispatch`**，
后者却拉着 webcopy/summarize/screenshot/analytics/badge/6 个 exporter；`index.ts` 又同时 import 两者，容易出环。
`actions-dispatch.ts` re-export 给测试用即可）：

```ts
/** 把「/sheets/ 直链」与「wiki 壳里包的表格」归成同一件事，多维表格同理。所有分流点只认它。 */
export function effectiveKind(doc: DocInfo): 'sheet' | 'bitable' | 'doc' {
  if (doc.docType === 'sheets' || doc.wikiKind === 'sheet') return 'sheet';
  if (doc.docType === 'base' || doc.wikiKind === 'bitable') return 'bitable';
  return 'doc';
}

/** 只对 wiki 做：补齐 wikiKind + 找出模型所在 frame。其他 docType 零开销原样返回。
 *  不依赖侧边栏状态，bridge.ts 直接复用（r3 minor-3，终稿已改）。 */
export async function resolveWikiModel(tabId: number, doc: DocInfo) {
  if (doc.docType !== 'wiki') return { doc, frameId: undefined };
  const frames = await probeFrames(tabId);          // 即使 URL 已判出 wikiKind 也要探，否则拿不到 frameId
  const kind = doc.wikiKind ?? pickWikiKind(frames);
  const filled = kind ? { ...doc, wikiKind: kind } : doc;
  return { doc: filled, frameId: pickModelFrameId(frames, effectiveKind(filled)) };
}
```

`actions-dispatch.ts` 侧再包一层就绪校验：`prepareFeishuDoc(tabId)` 返回
`{ doc: DocInfo | null; frameId?: number; error: Response | null }`——先 `detectDocForTab`，再 `requireReady`
（**必须在探测之前**：未授权私有化域名注不进去，白抛一次异常，硬约束 5），`error` 非 null 就原样返回给调用方，
否则 `resolveWikiModel(tabId, doc)` 补齐 `doc` 和 `frameId`。

**4.3 连锁影响逐条清点**：

| 位置 | 现状 → 改后 | 说明 |
|---|---|---|
| `requireReady` | 查 `UNSUPPORTED_EXPORT_TYPES[docType]`（该表是空的）→ **不动** | 没有全局不可导出的类型 |
| `blockSheetOnly` | `docType==='sheets'` → `effectiveKind(doc)==='sheet'` | **正向变化**：wiki 表格点 PDF/HTML 从「1KB 空文件」变明确报错 |
| `blockBaseOnly` | `docType==='base'` → `effectiveKind(doc)==='bitable'` | **正向变化**：wiki 多维表格点 md 从空文件变「请用导出 Excel」。误判风险见 §2.4 / 风险 2 |
| `runExcelExport` | `docType!=='base'` 就拒 → `effectiveKind(doc)!=='bitable'` 才拒 | **硬约束 3 落地** |
| `runFeishuExport` md 分支 | `isSheet = docType==='sheets'` → `effectiveKind(doc)==='sheet'`，调 `exportSheet(doc, frameId)` | 本 bug 的正主 |
| `index.ts` 小红书/微信/附件 | 手写三件套 → 改用 `prepareFeishuDoc` | 不改则 wiki 表格照样走错管线 |
| `bridge.ts:505` | `if (docType==='sheets')` → 按 `effectiveKind` 三分支，bitable 明确报错 | 不改则 CLI 抓 wiki 表格照样空文件 |
| `resolveObjToken` | `docType!=='wiki'` 早返回 → **不动** | 加字段方案的最大好处 |
| `editor.ts:78` | `['docx','wiki']` 白名单 → **不动** | wiki 表格会被放行进编辑然后失败。既有行为，非本次引入，列为可选加固 |
| `cache-manager` / `CacheView` | 存/显示 `docType` → **不动** | wiki 表格缓存显示为 `wiki`，与 URL 一致 |
| `ContextZone.tsx` PageBar | 显示 `doc?.docType` → **不动** | 可选打磨（显示成 `wiki · 表格`），不进本次 |
| `sidepanel/actions.ts` | 5 个导出按钮全类型可见 → **不动** | 保持「点了给准确错误」，与 `/base/` 直链体验一致 |

---

## 五、改动清单（改哪些文件、加什么分支）

**A. 无条件改（14 处）**：① `shared/types.ts` 加 `wikiKind`；② `content/feishu-detect.ts` 加 `wikiKindFromUrl()`；
③ **新建** `background/wiki-model.ts`；④ `actions-dispatch.ts` 加 `prepareFeishuDoc()`、三处换判据；
⑤ `index.ts` 三个入口改用它；⑥ `bridge.ts` 按 `effectiveKind` 分流、bitable 明确报错；
⑦ `exporters/sheet.ts` 加 `frameId?`、`ok` 标记、修「切表失败仍读 active」；⑧ `exporters/bitable.ts` 加 `frameId?`；
⑨ **新建** `exporters/guard.ts`；⑩⑪⑫ `markdown.ts`/`html.ts`/`pdf.ts` 加判空；⑬ `wechat.ts` 修死判据；
⑭ `i18n/zh.ts`+`en.ts` 各 3 条文案。
**B. 探测决定**：B1（只有 `spread`）→ §3.2 回退抽取器；B2（后台页读不到模型）→ `bringTabToFront()` 从
`whiteboard.ts` 提到 `tab-util.ts` 共用；B3（没有 iframe）→ **反向删减** `allFrames`/`frameId`/`pickModelFrameId`。
**C. 测试**：新建 `feishu-detect.test.ts` / `wiki-model.test.ts` / `guard.test.ts`，扩 `actions-dispatch.test.ts`。

### 5.1 `feishu-detect.ts`

新增纯函数 `wikiKindFromUrl(parsed: URL): DocInfo['wikiKind']`：`parsed.searchParams.get('sheet')` 非空 → `'sheet'`；
`get('table')?.startsWith('tbl')` → `'bitable'`；否则 `undefined`。
在 `detectDocFromUrl` 已有的 `if (docType && (known || looksLikeFeishu))` 块（52-57 行）末尾**只加一行**：
`if (docType === 'wiki') base.wikiKind = wikiKindFromUrl(parsed);`。
`detectCurrentDoc()` 走同一个函数，content script 那条路径自动带上。

### 5.2 `wiki-model.ts`（新建，约 110 行）

```ts
export interface FrameSignals {
  frameId: number;
  sheetApp: boolean;    // 整页电子表格：spreadApp 存在且 sheets 列得出来
  sheetModel: boolean;  // 任意表格模型（含 docx 内嵌块的 window.spread）——只用于定位
  bitable: boolean;     // 多维表格：bitableStore 存在且有一个 blocks 非空的 base
}

// probeFrames(tabId)：用同一个 probeInPage 跑两次 executeScript（world:'MAIN'）——先 { tabId } 单探主 frame，
// 再 { tabId, allFrames: true }；各自包 try/catch 返回 []，最后按 frameId 用 Map 合并（主 frame 的结果覆盖同 id）。
// 分两次是有意的（r3 major-3）：allFrames 只要遇到一个不可注入的跨源 frame 就整体 reject，
// 一把梭会把「主 frame 明明有模型」也一起吞掉，退化成误走普通文档管线。
// 结果项：{ frameId: r.frameId ?? 0, ...r.result }，r.result 为空的过滤掉。

/** 注入 MAIN world，必须自包含、只读不写。光看 typeof 不够（§2.4），顺手确认模型结构。 */
function probeInPage(): { sheetApp: boolean; sheetModel: boolean; bitable: boolean } {
  const w = window as unknown as { spreadApp?: any; spread?: any; bitableStore?: any };
  const arr = (o: any): any[] =>            // 与 bitable.ts:129-130 完全同款，别换写法
    Array.isArray(o) ? o : o && typeof o === 'object' ? Object.values(o) : [];
  let sheetApp = false, bitable = false;
  try { sheetApp = !!w.spreadApp && w.spreadApp.shell.viewModelManager.spread.sheets.length > 0; } catch {}
  try {
    const base = arr(w.bitableStore?.services).find((x) => x?.modelOperator?.base)?.modelOperator?.base;
    bitable = !!base && arr(base.blocks).length > 0;
  } catch {}
  return { sheetApp, sheetModel: sheetApp || !!w.spread, bitable };
}

```

**`pickWikiKind(frames)`（分类）**：有任一 frame `bitable` → `'bitable'`（特异性更高，电子表格页不会有 `bitableStore`）；
否则有任一 `sheetApp` → `'sheet'`；否则 `undefined`。
**⚠️ `sheetModel` 一票都没有**：普通 docx 的内嵌表格块也挂 `window.spread`（`sheet.ts:150`）。

**`pickModelFrameId(frames, kind)`（定位）**：按「档」依次匹配，`bitable` 只有一档 `f.bitable`；
**`sheet` 分两档：先 `f.sheetApp`，没有才退 `f.sheetModel`**（r3 major-2：主 frame 若只是个挂着 `window.spread`
的内嵌表格块、真正的 `spreadApp` 在子 frame，按「`sheetModel` + 主 frame 优先」会选中主 frame，`exportSheet` 照样扑空）；
`doc` 没有档，永远返回 `undefined`。同一档内命中多个时主 frame（`frameId===0`）优先，否则取第一个；
选中主 frame 时返回 `undefined`（= 按现状注主 frame）。

⚠️ 落到 `sheetModel` 那一档时用的是 `window.spread` 抽取器（B1），不是 `spreadApp` 分支。
即 B1 在「没有 iframe」时可删，在「模型在子 frame 且只有 `spread`」时必需——由 A①③ 决定。

### 5.3 `actions-dispatch.ts`（五处）

1. 新增 `prepareFeishuDoc`（§4.2），从 `wiki-model.ts` re-export `effectiveKind`。
2. 两个拦截器换判据（文案不变）：`blockSheetOnly` 的 `doc.docType === 'sheets'` → `effectiveKind(doc) === 'sheet'`；
   `blockBaseOnly` 的 `doc.docType === 'base'` → `effectiveKind(doc) === 'bitable'`。
3. `runFeishuExport`（203-227 行）开头三行（`detectDocForTab` + `requireReady` + 取 doc）换成一行
   `const { doc, frameId, error } = await prepareFeishuDoc(ctx.tabId);`，其余结构不动；
   md 分支里 `const isSheet = doc!.docType === 'sheets'` 改成 `const isSheet = effectiveKind(doc!) === 'sheet'`，
   调用改成 `exportSheet(doc!, frameId)`。pdf / html 两支一字不动。
4. `runExcelExport`（149-159 行）：同样换 `prepareFeishuDoc`；拒绝条件 `doc!.docType !== 'base'` →
   `effectiveKind(doc!) !== 'bitable'`；调用换成 `exportBitable(doc!, frameId)`。
5. `requireReady` 必须留在 `prepareFeishuDoc` 内部、探测**之前**（硬约束 5：未授权私有化域名不做任何注入）。

### 5.4 `index.ts`（三个绕开 dispatch 的入口）

`MSG.EXPORT_XHS`（219-231）、`MSG.EXPORT_WECHAT`（233-245）、`MSG.EXPORT_ATTACHMENTS`（291-304）三处改法一样：
把各自的 `detectDocForTab + requireReady` 两行换成 `const { doc, error } = await prepareFeishuDoc(ctx.tabId);`，
后面的 `error ?? blockSheetOnly(doc!) ?? blockBaseOnly(doc!) ?? withContentTab(...)` 结构不动。三处都不需要 `frameId`。
**import**：`detectDocForTab` 和 `requireReady` **两个都保留**——`MSG.CACHE_DOC`（309-310 行）同时用着它俩，
删任何一个都 TS 报错；只新增 `prepareFeishuDoc`。

### 5.5 `sheet.ts`

**(1) 加可选 `frameId`**：`exportSheet(doc: DocInfo, frameId?: number)`，注入处
`target: frameId != null ? { tabId, frameIds: [frameId] } : { tabId }`。不传 = 现状，直链零影响。

**(2) 加 `ok` 标记——三处类型必须一起改，漏一处 typecheck 就红**：`interface SheetData`（23-28 行）、
`extractWorkbookInPage` 的**声明返回类型**（273-277 行）、页内 `EMPTY` 常量（279 行）。
不改后两处，`{ ...EMPTY, error }` 与带 `ok` 的分支类型不兼容。
`ok`：`true` = 确认读到了这张表（哪怕它确实是空表）；`false` = 没切过去/没挂载好，数据不可信。

**(3) `spreadApp` 主路径循环**（370-380 行）改成：`clickTab(name)` 后轮询最多 12 次（每次 `sleep(700)`），
用 `countTop(name)` 判 `ready`（它确认 active 表名对得上，有真区分力）：`ready && n>0` 就 break，
`ready && i>=4` 也 break（确实是空表，不死等）。**关键修正**：轮询结束仍 `!ready` 时
`sheets.push({ id, name, rows: [], ok: false })` 然后 `continue`——旧代码这里无条件 `readActive()`，
**会把上一张表的数据重复写进这一张**（静默错数据，比空数据更坏）；`ready` 时才 `sheets.push({ ...readActive(), ok: true })`。

**(4) Service Worker 侧结算**（55-76 行）分三类：`unread = wb.sheets.filter(s => !s.ok)`、
`sheets = wb.sheets.filter(s => s.ok && s.rows.length > 0)`。`sheets.length === 0` 时报错返回，文案按
`unread.length ? t('progress.sheet.unreadable', {n}) : t('progress.sheet.empty')`
（一张都没读到 → 让用户等加载；全读到但都是空表 → 别让用户白等）。有产物但 `unread.length > 0` 时，
zip 照给，成功文案换成 `t('progress.sheet.partial', { ok, total, names })`，**不许报纯成功**（硬约束 4）。

**(5) `spread` 回退分支**：条件项 B1，见 §3.2。

### 5.6 `bitable.ts` 与 `bridge.ts`

`bitable.ts`：只加参数（`exportBitable(doc, frameId?)` + 同款 `target` 三元），抽取器一行不改。
它已有的「空表全滤掉 → 报错」（63-69 行）和「被首屏上限截断 → 成功但提示 N/M 行」（78 行起）本就符合硬约束 4。

`bridge.ts` 503-510 行现状是 `if (doc.docType === 'sheets') res = await exportSheet(doc)`，改成：先
`const { doc: prepared, frameId } = await resolveWikiModel(tabId!, doc); doc = prepared;`（`doc` 是 `let`，484 行；
`tabId` 在 470 行已 throw 过），再按 `effectiveKind(doc)` 三分支：
`'bitable'` → `res = { success: false, error: '多维表格无法通过命令行桥接导出，请在浏览器侧边栏点「导出 Excel」' }`；
`'sheet'` → `exportSheet(doc, frameId)`；否则按 `fmt` 走 pdf / html / markdown（原逻辑）。

- **与侧边栏共用 `resolveWikiModel`，别在这里重写分类/定位**（r3 minor-3）。
- **文案硬编码中文不走 i18n**：`bridge.ts:20` 只 import 了 `ensureI18n` 没有 `t`，周边错误文案全是硬编码中文。
  **已核对**：该文案不含「登录 / login」，不会被 `bridge.ts:519` 的 `/登录|not.?logged|login/i` 误判成 `need-login`。
- 多维表格只有 `.xlsx` 一条出路，而桥接协议对外只承诺 md/pdf/html（`SKILL.md:38`、`fetch.mjs:38`），
  回一个扩展名对不上的产物不如明确报错。`/base/` 直链现在走 `exportMarkdown` 本来就解不出内容——
  改成明确报错是把静默失败变显式失败。
- ⚠️ **这条路能不能跑通取决于页面 D**（后台隐藏页 + 合成指针事件 + 定时器），见风险 3 与 §14 M4。

---

## 六、空导出兜底加在哪一层

**定层**：`trackedExport` 只有 `Response { success, error }`、拿不到产物内容；`downloadDataUrl` 判得出「字节少」
却判不出「这算不算异常」（网页转 md、短文档都走它，统一阈值会误伤）。**选各 exporter 自查**——它知道什么叫有内容。

### 6.1 逐个成功出口盘点（按 `ls src/background/exporters/` 的 13 个文件）

| 文件 | 成功出口 | 现状 → 本次 |
|---|---|---|
| `markdown.ts` `runOfficialMd`（81-99） | `downloadBase64` | ❌ 完全不查 → ✅ 下载前查（文本模式） |
| `markdown.ts` `runDecodeMd`（125-139） | 两个下载分支 | ⚠️ 只在 `loginHint` 有值时才查 → ✅ 改无条件查 |
| `html.ts`（60-72） | `downloadDataUrl` | ❌ 完全不查（1KB 空 html 从这儿出）→ ✅ 生成前查 |
| `pdf.ts` 官方分支（83-86） | `downloadBase64` | ❌ 不查 → ✅ 只查零字节 |
| `sheet.ts`（55-60） | zip | ⚠️「没读到」和「真空表」混一个桶 → ✅ 见 §5.5(4) |
| `bitable.ts`（63-69） | xlsx | ✅ 已有判空 + 截断提示 → 不动 |
| `wechat.ts`（79-83） | 剪贴板 HTML | ⚠️ 有 `if (!html.trim()) throw`，**但它是死代码** → ✅ 换判据，见 §6.4 |
| `xhs.ts`（31） | 离屏渲图 | ✅ 已有 `if (!nodes.length) throw t('progress.xhs.empty')` → 不动（现成先例） |
| `attachments.ts`（28-30） | 多个文件 | ✅ `assets.length===0 → { success:true, count:0 }` → **不动**：「没有附件」是正确且常见的答案，`progress.attachments.none` 已明说，且**不下载任何文件** |
| `file.ts` / `pdf.ts` 的 `downloadCloudFileAsPdf` | 云文件字节流 | 不需要：产物是服务端文件流，零字节由 `downloadMedia` 抛错兜住 |
| `transcript.ts` | 妙记文本 | 不需要：空转写是合法结果（会议没人说话），不是导出故障 |
| `screenshot.ts` / `whiteboard.ts` | 截图 / 画板 PNG | 不需要：前者产物是 canvas 位图必非空；后者失败返回 `null`，调用方降级占位 |

### 6.2 新增 `exporters/guard.ts`（新建，约 25 行，两个纯函数）

- `isBlankExport(markdown, assetCount) = !markdown.trim() && assetCount === 0`——client_vars 管线的空产出判据：
  正文没字 + 一个素材都没有 = 这次啥也没解出来（成因：token 根本不是 docx，或私有文档匿名读不到）。
- `isBlankArtifact(base64, treatAsText)`——官方导出产物的空判据：`base64ToBytes`（`media-util` 既有导出，
  `markdown.ts` 已在用）解码失败或零字节 → `true`；`treatAsText` 时再看 `new TextDecoder().decode(bytes).trim() === ''`
  （本 bug 的空 `.md` 正是这种）。**故意不设字节数阈值**——短文档是合法的，只判「等于没有」。

### 6.3 四个出口的改法

- **`runOfficialMd`**：`const title = …` 之后、`downloadBase64` 之前插
  `if (isBlankArtifact(result.base64, true)) return fail('markdown', t('bg.emptyExport'));`。
  **故意不回退 P-decode**：官方说「有文档但没东西」，解码读的是同一份 client_vars，多半也空。
- **`runDecodeMd`**：把现有 131-139 行整段换成
  `if (isBlankExport(markdown, images.length + sheetBlocks.length + whiteboards.length)) return fail('markdown', loginHint || t('bg.emptyExport'));`
  ——由「只在 `loginHint` 有值时判」改成无条件判。
- **`html.ts`**：第 25 行 `blocksToMarkdown(...)` 之后插同款 `isBlankExport` 判空，命中则
  `reportProgress('html','error',msg,100)` + `return { success:false, error: msg }`。
  `html.ts` **没有 `fail()`**（那是 `markdown.ts:338-344` 的私有函数）；它的解构里**没有 `whiteboards`**，素材只加两项。
- **`pdf.ts`**：`const title = …` 之后插 `isBlankArtifact(result.base64, false)`（只查零字节），命中则
  `reportProgress('pdf','error',…)` + `return`。**必须 `return` 不能 `throw`**——`pdf.ts` 的 catch 会对
  `ExportDisabledError` 回退到 `exportPdfViaDecode`，抛异常会误闯那条路。

### 6.4 `wechat.ts`：判空是死代码

79 行有 `if (!html.trim()) throw …`，但 `renderWechatHtml`（`wechat-html.ts:63-72`）永远返回
`<section style="…">${body}</section>`，**`html.trim()` 恒非空**，这道防线从没生效过。空块树 → 空壳 HTML →
`success:true` → 写进剪贴板 → 用户粘到公众号编辑器里是空的。**同款静默失败，只是产物是剪贴板不是文件。**
改法：在 `collectImageAssets(tree)` **之前**判块数（把树过一遍 `blocksToMarkdown` 代价太大）：
`if (tree.order.length === 0) throw new Error(t('progress.wechat.empty'));`——复用现成文案零新增 i18n，
`catch` 块已有 `reportProgress + return { success:false }`。79 行那句死代码留着无害。

### 6.5 新增文案（zh/en 各 3 条；`en.ts` 声明为 `export const en: Dict`，少一条就编译报错）

- `bg.emptyExport`：`'没有解析出任何内容，导出已中止（该链接可能是表格/多维表格/画板，或你没有阅读权限）'`
- `progress.sheet.unreadable`：`'有 {n} 张工作表没读到数据（页面可能未加载完成），导出已中止'`
- `progress.sheet.partial`：`'已导出 {ok}/{total} 张表；未读到：{names}（页面可能未加载完成）'`

英文对应逐条译出即可（桥接那条 bitable 文案按 §5.6 硬编码中文，不进 i18n）。

**覆盖面**：官方 md/pdf 看产物字节；解码 md/html/公众号看结构化中间结果；表格区分「确认的空表」和「没读到」；
多维表格和小红书本来就有；附件明确不需要；云文件走 `downloadMedia` 抛错兜底。覆盖的成因不止本 bug：
wiki 包表格/多维表格/画板、私有文档匿名读、`client_vars` 改版导致解码全空、翻页失效丢块、官方任务回空包，全被接住。

---

## 七、验证步骤

> 前置探测见第零章；这里只写改完代码之后的验证。

### 7.1 修复验证

| # | 操作 | 期望 |
|---|---|---|
| 1 | 复现链接点「导出 Markdown」 | 下载 zip：1 个 `.md`（H1 + 每表 H2 + GFM 表格）+ `csv/` 下每表一个 CSV，**有真实数据** |
| 2 / 3 | 同页点「导出 PDF」/「导出 HTML」 | 明确报错「电子表格暂只支持导出 Markdown…」，**不下载任何文件**，不再产出 1KB 只有标题的 html |
| 4 | 同页点「导出附件」/「小红书」/「公众号」 | 都被 `blockSheetOnly` 挡住并报错（**验证 index.ts 三个入口也接上了**） |
| 5 | 去掉 `?sheet=fakwBh` 只留 `/wiki/<token>` 再点「导出 Markdown」 | 探到 `spreadApp` → 正常出 zip；只有 `spread` → 报「没有解析出任何内容…」而不是落空文件（两种都算通过，按第零章结论对照） |
| 6 | wiki 包多维表格链接点「导出 Excel」 | 下载 `.xlsx` 含真实数据；被首屏上限截断时提示「N/M 行」 |
| 7 | 同页点「导出 Markdown」 | 报错「多维表格只支持导出 Excel…」 |

**6/7 的前提是手里有真实 wiki-bitable 链接，现在没有。** 落地第 1 步必须把「拿到一个真实 wiki-bitable 链接」
列为前置产出；拿不到就把 6/7 移到「未验证项」，并在交付说明里写死：「本次 wiki-bitable 只做到
『不再被 `docType!=='base'` 直接拒掉』，能否导出成功不承诺」——**不许当成已交付跳过**。

### 7.2 回归验证

| # | 场景 · 操作 | 期望 |
|---|---|---|
| R1 | `/docx/` 直链 · md/pdf/html | 与改动前完全一致 |
| R2 | `/wiki/` 包**普通文档** · md/pdf/html | 三种都正常，md 内容完整，别被判空兜底误杀 |
| R3 | `/wiki/` 包**含内嵌表格块**的普通文档 · md | **必测**：正文完整 + 内嵌表格照常替换成 GFM 表格，**绝不能走 `exportSheet`** |
| R3b | **含内嵌多维表格视图块**的 docx/wiki 文档 · md/pdf/html/附件 | **必测**：四个导出全正常，**绝不能被 `blockBaseOnly` 挡掉** |
| R4 | `/sheets/` 直链 · md | zip 正常（`frameId` 不传，走原路径），每张表都有数据 |
| R5 / R6 | `/base/` 直链 · Excel / md·pdf·html | xlsx 正常 / 仍被 `blockBaseOnly` 挡 |
| R7 | `/docx/` 内含内嵌表格块 · md | 内嵌表格照常替换（验证 `sheet.ts` 重构没碰坏 `extractEmbeddedSheets`） |
| R8 | 未授权私有化域名 · 任意导出 | 仍提示「请先授权访问该域名」，**且没有任何注入尝试** |
| R9 | CLI 桥接抓 wiki 表格链接 | 拿到 zip 而不是空 md。**若命中后台页问题，本次可接受的降级是明确报错**（风险 3） |
| R10 / R11 | CLI 抓 `/docx/` 直链 / 抓 `/base/` 或 wiki 多维表格 | 与改动前一致 / 明确报「请在侧边栏导出 Excel」，退出码非 0，**不产出任何文件** |
| R12 | **真的没有内容**的空 docx · md | 现在会报「没有解析出任何内容」。**有意的行为变化**，判据是「一个字+一张图+一个表+一块画板都没有」 |
| R13 | 含一张**真空表**的表格 · md | 真空表被正常跳过、**不进「未读到」警告**；整本都是空表时报 `empty` 不是 `unreadable` |
| R14 | 正常 docx · 复制为公众号 | 正常出 HTML（验证 §6.4 的 `tree.order.length` 判据没误杀） |

R2 / R3 / R3b / R12 / R13 是五个最重要的回归点，务必手测。
**自动化**：`npm run typecheck` + `npm run test`。**最可能的报错点是 §5.5(2) 那三处 `ok` 类型没改齐**，
其次是 `actions-dispatch.test.ts` 缺新 mock。

---

## 八、单元测试

**新建 `src/content/feishu-detect.test.ts`**（纯函数无依赖，最划算）：`/wiki/<T>?sheet=fakwBh` →
`{docType:'wiki',token:T,isPrivateDeploy:true,wikiKind:'sheet'}`；`?table=tblXxx&view=vewXxx` → `'bitable'`；
无参数 / `?from=space` / `?table=1` → `undefined`；`/sheets/<T>?sheet=…`、`/docx/<T>?sheet=…` → `undefined`（非 wiki 不填）。
**回归锁**：`https://xxx.feishu.cn/docx/<T>` → `{isFeishuDoc:true,docType:'docx',isPrivateDeploy:false}`；
`'not a url'` / 普通网页 → 不抛异常且 `isFeishuDoc === false`。

**新建 `src/background/wiki-model.test.ts`**（本次最关键的分类逻辑）。构造器
`f = (frameId, s={}) => ({ frameId, sheetApp:false, sheetModel:false, bitable:false, ...s })`：

- `pickWikiKind`：`[f(0,{sheetApp:1})]→'sheet'`；`[f(0,{bitable:1})]→'bitable'`；
  **`[f(0,{sheetModel:1})]→undefined`（critical 回归锁：只有 `window.spread` 绝不判成表格）**；
  `[f(0,{bitable:1,sheetModel:1})]→'bitable'`；`[]→undefined`；`[f(0), f(7,{sheetApp:1})]→'sheet'`。
- `pickModelFrameId`：主 frame 命中→`undefined`；只有子 frame 命中→返回该 id；主+子都命中→`undefined`；
  **`([f(0,{sheetModel:1}), f(9,{sheetApp:1,sheetModel:1})],'sheet') → 9`（r3 major-2 回归锁）**；
  `([f(4,{sheetModel:1})],'sheet')→4`；`([f(4,{sheetModel:1})],'bitable')→undefined`；`kind='doc'`→永远 `undefined`。
- `probeFrames`（mock `chrome.scripting.executeScript`）：多 frame 按 frameId 归一；两次都 reject → `[]` 不抛；
  **allFrames 那次 reject 但主 frame 成功 → 仍返回主 frame 信号（r3 major-3 回归锁）**；`result:undefined` 的 frame 被过滤。
- `effectiveKind`：`sheets→'sheet'`、`base→'bitable'`、`wikiDoc('sheet')→'sheet'`、`wikiDoc('bitable')→'bitable'`、
  `wikiDoc(undefined)→'doc'`、`docx→'doc'`。

**新建 `exporters/guard.test.ts`**：`isBlankExport('   \n ',0)→true`、`('# 标题',0)→false`、`('',3)→false`（纯图文档不算空）；
`isBlankArtifact('',*)→true`、`(b64('\n'),true)→true`（**本 bug 的产物**）、`(b64('# hi'),true)→false`、`(b64('\n'),false)→false`。

**扩 `actions-dispatch.test.ts`**。先补三处基座：mock `./exporters/bitable`；mock `./wiki-model`（保留真的
`effectiveKind`，mock 掉 `probeFrames`/`pickWikiKind`/`pickModelFrameId`）；`ALL_ACTIONS`（50-62 行）补上
`'feishu-excel'`（现在只有 11 个，那句「全覆盖」断言其实是漏的）。**mock 状态串场必须显式处理**：现有 `beforeEach`
（86-87 行）只有 `vi.clearAllMocks()`，它清 `mock.calls` 但**不清** `mockReturnValue`，`vitest.config.ts` 也没配
`mockReset`，用例一换顺序就假绿/假红 → 新 `describe` 里加一层 `beforeEach` 把两个 mock 返回值重置成 `undefined`。
新增用例：`wikiKind='sheet'` + `feishu-md` → 调 `exportSheet` 不调 `exportMarkdown`，且 `probeFrames` **仍被调**
（URL 已判出也要探，否则没有 frameId）；`pickModelFrameId→7`/`→3` → `exportSheet(objectContaining({wikiKind:'sheet'}), 7)`
/ `exportBitable(anything, 3)`；`wikiKind='sheet'` + pdf/html → `success:false` 且 `exportPdf` 没被调；
`wikiKind='bitable'` → excel 放行、md 被挡；`pickWikiKind→'sheet'`（URL 没判出）→ 走 `exportSheet`；
**`pickWikiKind→undefined` → 走 `exportMarkdown`、`exportSheet` 没被调（critical 回归锁）**；
`docx` 直链 → `probeFrames` **没被调**；`needsAuth:true` → `success:false` 且 `probeFrames` **没被调**（硬约束 5）。

**不写单测的**：`index.ts` 三个入口（SW 消息路由，仓库没基座）靠 7.1 第 4 条 +「三处调同一个 `prepareFeishuDoc`」的
结构保证；页内抽取器（跑在 MAIN world 依赖飞书 SDK 真实对象，现有三个抽取器一个都没单测）靠真机矩阵；
`bridge.ts`（要 mock WebSocket + 标签页 + 下载 sink）靠 R9/R10/R11——**bridge 无单测是已知缺口（r3 minor-3 残留）**。

---

## 九、风险与预案

| # | 风险 | 概率 / 影响 | 预案 |
|---|---|---|---|
| 1 | wiki 壳上三个全局一个都没有 | 中 / 主路径不成立 | 先做第零章。真遇到走 3a 的 `allFrames` + 定向注入；仍不行则只保证「明确报错而不是空文件」 |
| 2 | **内嵌 bitable 视图块的 docx 上也挂着结构完整的 `bitableStore`** | 低（结构确认挡一道）/ **正常 wiki 文档四个导出全被挡死**，硬约束 2 被破 | 页面 C 必测；命中就启用 C 层二次确认。R3b 是回归锁 |
| 3 | **桥接后台隐藏页里模型不加载 / `clickTab` 切不了表** | 低-中 / R9 拿不到数据 | `sheet.ts:150` 的实测只覆盖 `spread` 路径且没验过点 tab。页面 D 先测**现有** `/sheets/` 直链；命中就做 B2：把 `whiteboard.ts:47-77` 的 `bringTabToFront()` 提到 `tab-util.ts`（已是通用形态：返回 restore 函数、切换失败不影响主流程），两个 exporter 各包一层。纯复用 |
| 4 | `?sheet=` 误判：某个 wiki 包的 docx 恰好带它 | 低 / 普通文档被送进 `exportSheet` | 读不到模型会明确报错（不出空文件），去掉参数可重试。要更紧可要求 `/^[A-Za-z0-9]{4,}$/`，**先不加**（r3 minor-1 认为该加二次确认） |
| 5 | 判空兜底误杀真·空文档（R12） | 低 | 判据是「无正文 + 无图 + 无内嵌表 + 无画板」同时成立。真被投诉就降级成「照常下载但进度提示警告」 |
| 6 | `sheet.ts` 抽取器重构碰坏内嵌表格导出 | 低 / R7 回归 | 重构严格限定在 `extractWorkbookInPage` 内部，**不碰 `extractEmbeddedSheetsInPage`**。R7 必测 |
| 7 | 多两次注入 / 多个 frame 同时命中 | 低 | 探测只做几个 `!!`；frame 选择先 `sheetApp` 后 `sheetModel`、同档内主 frame 优先，已单测 |
| 8 | CLI 拿到「桥接不支持 bitable」后体验变差 | 低 | 比回一个扩展名对不上的 `.xlsx` 强。真要支持得同步改 `fetch.mjs` 的 `--format`、`folderNameFrom`（第 **142** 行）、`SKILL.md:38`、退出码语义 —— 另一个需求 |

---

## 十、落地顺序

按「先验证、后改代码、每步可独立回滚」拆 5 步，每步跑一次 `npm run test`：

1. **探测（不写代码）**：跑第零章页面 A/B/C/D，结果写进第十二章，按 §0.3 裁剪方案。
   **同时把「拿到一个真实 wiki-bitable 链接」当作本步前置产出**（拿不到按 §7.1 降级承诺）。
2. **判空兜底**（`guard.ts` + `markdown/html/pdf/wechat` + i18n + `guard.test.ts`）。**先做这步**：
   它自己就是独立有价值的修复——即使后面全不做，本 bug 也从「成功但文件是空的」变成「明确报错」，硬约束 4 立刻兑现；
   后面几步出问题时它还能把静默失败变成看得见的报错，反过来帮调试。跑 R2 / R12 / R14。
3. **识别层**（`types.ts` + `feishu-detect.ts` + 其测试）。纯加法，不改任何现有行为。
4. **分类与定位**（新建 `wiki-model.ts` + 其测试）。纯新增，不接线。
5. **分流层接线**（`actions-dispatch.ts` + `index.ts` + `bridge.ts` + `sheet.ts` + `bitable.ts` + 扩 dispatch 测试；
   按第 1 步结论决定 B1/B2/B3）。跑 7.1 + 7.2 全部。

---

## 十一、待验证清单（实现时逐条销，不许当成已知事实写进代码注释）

| # | 待验证 | 影响 | 怎么验 |
|---|---|---|---|
| 1 | wiki 壳上 `spreadApp`/`spread`/`bitableStore` 哪个存在 | **决定走哪条路径**，也决定 §14 里 3 个 major 还剩几个 | 页面 A ① |
| 2 | wiki 包含内嵌表格块的普通文档上**只有** `spread` | 分类判据的正面证据 | 页面 B |
| 2b | 含内嵌 bitable 视图块的 docx 上有没有 `bitableStore`、结构是否完整 | **决定结构确认够不够、C 层要不要启用** | 页面 C |
| 3 | `window.spread === window.spreadApp?.shell?.viewModelManager?.spread` | 影响情形 2 写法 | 页面 A ② |
| 4 | wiki 壳里模型是否渲染在 iframe | **决定 `frameId` 那整套是必需还是该删** | 页面 A ③ |
| 5 / 6 | wiki-bitable 链接是否稳定带 `?table=tbl…` / 会不会只带 `table` 不带 `view` | 影响 A 层命中率 | 先拿到真实链接（落地第 1 步前置产出） |
| 7 | 桥接后台隐藏页里模型能否加载、`clickTab` 能否切表 | 决定 B2 做不做、R9 能不能过 | 页面 D |
| 8 | `obj_type` 对 sheet/bitable 的具体数值（22=docx 已确认） | C 层备用 | 启用 C 层时实测 |
| 9 | wiki 壳里有没有 `.sheet-tabs`（`clickTab` 的容器） | 影响多表切换完整度 | 页面 A ④ |
| 10 | 官方 md 导出对「wiki 包表格」这个 token 到底返回什么（零字节？只有换行？还是报错？） | 决定 §6.3 第一行是否真拦得住 | 落地第 2 步真机 |
| 11 | 飞书空白网格默认行数（`getRowCount()` 是否恒 > 0） | 影响 §3.2 `ok` 判据的边界 | 落地第 5 步顺手确认 |
| 12 | 普通 wiki 文档的 URL 会不会出现 `?sheet=` | 决定 A 层要不要二次确认（r3 minor-1） | 页面 B 打开时看地址栏 |

---

## 十二、实测记录（落地时补，逐字贴原始输出）

```
页面 A ①：（待填）      页面 A ②③④：（待填）
页面 B：（待填）        页面 C：（待填）        页面 D：（待填）
wiki-bitable 真实链接：（待填 / 未拿到）
```

---

## 十三、三轮迭代摘要

| 轮次 | 稿件 | 评审 | 分数 | 修了什么 |
|---|---|---|---|---|
| r1 | v1（51KB） | codex / gpt-5.6-sol | **3**（critical 1 / major 5 / minor 2） | — |
| r2 | v2（84KB） | Claude（codex 当轮上游断流，退回 Claude） | **7**（0 / 4 / 9） | r1 全部 8 条 |
| r3 | v3（67KB） | codex / gpt-5.6-sol | **5**（0 / 4 / 3） | r2 全部 13 条 |

**v1 → v2（3 → 7，critical 清零）改的是骨架**：① 把 `window.spread` 从分类信号里剔除（r1 的 critical）——
docx 内嵌表格块也挂它，拿它分类会把「wiki 包的、含内嵌表格块的普通文档」误判成整页表格，正面违反硬约束 2；
由此引出本方案最重要的结构：**分类与定位拆成两件事**。② 识别收口成 `prepareFeishuDoc`（`index.ts` 三个入口
绕开了 dispatch，v1 没接）。③ `bridge.ts` 对 bitable 明确报错，不再无视 `fmt` 回 `.xlsx`。④ 每张表加 `ok` 标记，
不再把「读失败的表」和「真空表」一起静默 filter。⑤ 判空兜底补上官方 md 出口。⑥ 补两个新测试文件。

**v2 → v3（7 → 5，major 数没降）改的是细节严密度**：① `bitableStore` 也不能只看 `typeof`，加结构确认 +
探测页面 C + 回归锁 R3b（这是 r1 critical 的「同构镜像」，v2 只修一半）。② 13 个 exporter 逐个盘点，
挖出 `wechat.ts` 的判空是**死代码**。③ 补上「桥接后台隐藏页」这个视野盲区（仓库上一个提交刚为画板踩过），
列成风险 3 + 页面 D + 条件项 B2。④ `spread` 回退的 `ok` 判据从「有没有数据」改成「维度读不读得出」。
⑤ 11 条 minor（`index.ts` import 不能删、`pdf.ts` 没有 `fail()`、`ok` 三处类型要一起改、mock 串场、
`effectiveKind` 该放哪、`clickTab('')` 会乱派事件……）。⑥ 体积 84KB → 67KB。

### 为什么同一水平的稿子 Claude 给 7、codex 只给 5

两个评审的**打分口径根本不同**，不是谁更严格：

| | Claude（r2） | codex / gpt-5.6-sol（r1、r3） |
|---|---|---|
| 主要动作 | 把方案点名的每处文件:行号、函数签名、变量名**打开源码逐条核对**，先出一张事实核对表 | 直接盯**关键假设有没有证据**，问「这方案能不能为成败背书」 |
| 什么算大问题 | 方案**自己声称覆盖、实际漏了**的东西（内部不自洽） | 方案**没有数据支撑却当成已解决**的东西（外部不确定） |
| 对「待验证」标注 | 标了就算尽责，不重复扣分 | 标了照扣：**「未验证」= 这条路径没有可行性保证** |
| 分数反映的是 | 文本质量、自洽度、事实准确度 | 落地确定性 |

具体到 r3 的四条 major：只有一条（`pickModelFrameId` 混用两种信号）是方案自己写错了，另外三条的实质都是
「**你没实测过，所以我不认为这条路径成立**」。v3 相对 v2 的文本质量确实提升了（minor 从 9 条降到 3 条），
但**落地确定性一点没变**——三轮里没有任何一条新的实测数据进来。Claude 给 7 是说「这稿写得对」，
codex 给 5 是说「写得对不等于跑得通」。两个结论并不矛盾。

**由此得到本次迭代最重要的结论：再写第四版没有用。** 瓶颈不在写作，在没有页面上的探测数据；
文档层面能修的，r2 那 13 条基本修完了，剩下的分数只能靠去页面上跑那几行代码换。

---

## 十四、未解决问题清单（r3 codex，一条不删）

> 三轮用尽，**未达收敛标准**（要求 critical=0、major=0、score≥8；实际 major=4 minor=3 score=5）。

| # | 等级 | 问题 | 状态 |
|---|---|---|---|
| M1 | major | C 层 `obj_type` 不实现，无 query / 模型未挂载场景无解 | **仍未解决**（部分卡实测，部分是有意取舍） |
| M2 | major | `pickModelFrameId` 把 `sheetApp` 和 `sheetModel` 混，会选错 frame | **终稿已改**（未再经评审） |
| M3 | major | `allFrames` 一次注入整体失败就返回 `[]`，吞掉主 frame 结果 | **终稿已改**（未再经评审；跨源 frame 仍是硬边界） |
| M4 | major | CLI 桥接后台隐藏页跑 `spreadApp` + 点 tab，从未验证 | **仍未解决，纯卡实测** |
| m1 | minor | `?sheet=`/`?table=` 只是候选信号，未证实、缺带 query 的普通 wiki 回归用例 | **部分解决**（加了警告与待验证项，没加二次确认） |
| m2 | minor | 探测用 `Object.keys(blocks)`、抽取器用 `arr(blocks)`，两处不一致 | **终稿已改** |
| m3 | minor | `bridge.ts` 重写分类/定位，与侧边栏两个入口会漂移 | **终稿已改**（抽 `resolveWikiModel` 共用；bridge 仍无单测） |

**M1 —— C 层不实现。** 评审要求：至少让 `resolveObjToken` 返回 `objType` 并定出 sheet/bitable 的真实数值，
在模型探不到时用它；若它只能改善提示，那也**必须把该场景明确写成「不支持」，不许写成已覆盖**。
**这轮为什么没解决**：三轮里「不实现 C 层」一直是有意取舍（`get_info` 在个人版/部分私有化会 PermFail，
且知道类型 ≠ 导得出，属 YAGNI），r3 没推翻这个理由，它不接受的是**表述**——v3 把「无 query + 模型未挂载」
写得像已经覆盖了；而 r3 是最后一轮，没有第四轮修订机会。**终稿**：功能仍不做，但 §2.5、§7.1 写死承诺边界。

**M2 —— `pickModelFrameId` 混用两种信号。** 评审对：sheet 定位若按 `sheetModel`（有 `window.spread` 就算）+
主 frame 优先，则「主 frame 是个挂着内嵌表格块的 docx、真正的 `spreadApp` 在子 frame」时会选中主 frame，
`exportSheet` 照样扑空——正好是方案声称要解决的场景。**这条与实测数据无关，是方案自己的逻辑漏洞**
（v2 写下、v3 没发现）。**终稿已改**：§5.2 分档匹配（先 `sheetApp`、没有才退 `sheetModel`，退到时明确走
`window.spread` 抽取器），§八 加了回归锁用例。

**M3 —— `allFrames` 的失败边界。** `executeScript({allFrames:true})` 只要遇到一个不可注入的跨源/特殊 frame 就整体
reject，v3 的 `catch { return [] }` 会把「主 frame 明明有模型」也一起吞掉。**终稿已改**：主 frame 单独探一次 +
allFrames 再探一次、按 frameId 合并。**残留硬边界（改不掉）**：模型若真在**跨源** iframe 里，扩展没有对应
host 权限就注不进去，只能明确报错——要不要在意，由页面 A③ 决定。

**M4 —— CLI 桥接的可行性没有保证。** `bridge.ts:466` 开的是 `tabs.create({url, active:false})` **后台隐藏页**，
而 `exportSheet` 要 `getBoundingClientRect()` 拿坐标、合成五连击指针事件点 tab、靠 `sleep(700)` 轮询——
全是吃渲染和定时器的动作。仓库现有实测（`sheet.ts:150`）只证明 **`window.spread` 在隐藏页会加载**，
**没有**证明 `spreadApp` 可用、**没有**证明 `clickTab` 点得动；上一个提交（`96fcd92`）刚因为「后台页 rAF 冻结
抓不到画板」打过补丁。v3 把它列成条件项 B2 + 待验证 #7，同时又把 CLI wiki-sheet 写进修复路径，r3 认为自相矛盾。
**这条 100% 是数据问题**：页面 D 跑一次就有答案，三种结局是「能跑（本条消失）」「做 B2」「声明不支持」。

**m1 —— URL 参数只是候选信号。** `?sheet=` 是否只表示「当前节点就是整页表格」没被证明；真实 wiki-bitable 链接
至今没拿到，`?table=tbl…` 的稳定性也是猜的。**没做二次确认的原因**：结构模型确认在「页面还没加载完」时必然失败，
而那正是 A 层存在的意义；`obj_type` 二次确认就是 M1 说的 C 层。**终稿**：§2.3 加显式警告、§十一 加待验证 #12、
风险 4 保留；误判的兜底是第六章判空，会明确报错不落空文件。

**m2**：终稿已改，探测里的 `services` 和 `blocks` 都用和 `bitable.ts:129-130` 一样的 `arr()`。
**m3**：终稿已改，抽出不依赖侧边栏状态的 `resolveWikiModel(tabId, doc)`，`prepareFeishuDoc` 和 `bridge.ts` 都调它；
**残留缺口**：`bridge.ts` 仍没有单测，只能靠 R9/R10/R11 真机验证。

### 14.3 关键判断：这些 major 有多少是「没实测数据、只能猜」造成的

**四条 major 里，三条（M1、M3、M4）的存亡直接由第零章那几行探测决定；只有 M2 是方案自己的逻辑错。**

| 探测结果 | 直接后果 |
|---|---|
| **A① 有 `spreadApp`** | 情形 1 成立 → **§3.2 的 `spread` 回退（B1）整段删掉**，连带 §5.5(5) 和 §八 里 `sheetModel` 相关的一半用例。M1 缩水：「无 query」由 B 层探测覆盖，只剩「页面没加载完」这个边角，而那本就只是提示质量问题——**M1 从 major 降成一句承诺边界** |
| **A③ 没有 iframe** | **`allFrames`/`frameId`/`pickModelFrameId` 整套删掉**（§5.2 少一半，§5.5(1)、§5.6 的参数都不用加，§八 少 6 条用例）。**M2 和 M3 同时消失**——不是被修好，是被删掉了 |
| **页面 D：`/sheets/` 直链在后台页导得出** | **M4 消失**，B2 不做 |
| **页面 C = `['undefined','no-base']`** | 风险 2 解除，C 层确定不做 |

也就是说：**一次十分钟的控制台探测，最多能一次性消掉四条 major 里的三到四条，外加删掉方案约三分之一的代码量。**
反过来，不探测就开工，这三分之一的代码会真的被写出来、被测试覆盖、被维护——其中至少一半注定用不上。

反向情况也要说清：若 A① 探到「三个全局都没有」，M1 会**升级**——C 层从「按 YAGNI 不做」变成「不做就无法识别」，
第二、三章要重写。这同样只有数据能回答。

**唯一不受探测影响的**：M2（逻辑错，终稿已改）、m2/m3（写法一致性，终稿已改），
以及第六章的判空兜底——那一层完全不依赖任何探测结果，是现在唯一可以动手的部分。

---

## 附：与 brief 硬约束的对照

| 硬约束 | 落实位置 |
|---|---|
| 1. 不引入新依赖、不重写 exporter、改动集中在类型识别 + 分流 | 新建两个文件都是纯函数/判据；三个 exporter 只加可选参数；B2 是仓库内已有函数搬家 |
| 2. 不破坏三种直链与 wiki 包普通文档 | `wikiKind` 只在 `docType==='wiki'` 时填；`frameId` 不传 = 现状；R1–R7 + R3b + R14 是回归锁 |
| 3. wiki 包多维表格一并考虑 | A 层 `?table=tbl…` + B 层 `bitableStore`；`runExcelExport` 改判据。**承诺边界见 §7.1** |
| 4. 不许静默失败 | 第六章：13 个 exporter 逐个盘点、每个成功出口给结论；落地第 2 步先做，且不依赖任何探测 |
| 5. 私有化授权流程不改 | `requireReady` 在探测之前；未授权不做任何注入；R8 |
| 6. 中文注释、简洁直白、YAGNI/KISS | C 层不实现（只写落点 + 启用条件）、3b 不加轮询、bitable 桥接不做 xlsx |
| 7. 代码片段对得上真实签名，不确定处标「待验证」 | 第一章事实校准 + 第十一章 12 条待验证 + 第十四章未解决清单 |



