VERDICT: score=3 critical=1 major=5 minor=2

1. **critical**
   - 位置：方案 §5.3 `probeInPage()`（v1:404-412）；[sheet.ts](/Users/ambrose/WorkSpace/Code/work/larksnap/src/background/exporters/sheet.ts:143)
   - 问题：方案把 `window.spread` 存在直接判成整页电子表格。但真实代码明确说明，普通 docx 的内嵌表格也挂在 `window.spread`。因此，一个包含内嵌表格的普通 wiki 文档会被误判为整页 sheet，原本正常的 Markdown 导出会改走 `exportSheet`，直接破坏“wiki 包普通文档原样工作”的硬约束。
   - 建议：`spreadApp` 可以作为整页 sheet 信号，`spread` 不能单独作为类型信号。只有 URL/API 已确认节点是 sheet 后，才能将 `spread` 用作抽取后端；否则应继续走文档管线。最好用已验证的 `obj_type` 或可靠页面容器信号确认外层类型。

2. **major**
   - 位置：方案 §5.4 `fillWikiKind()`（v1:461-469）、§3 情形 3（v1:203-220）
   - 问题：`doc.wikiKind` 已由 `?sheet=`/`?table=`填好时，`fillWikiKind` 立即返回，不执行 frame 探测。因此复现 URL 本身带 `?sheet=` 且模型位于 iframe 时，拿不到 `frameId`，`exportSheet` 仍注入主 frame，情形 3 的方案实际跑不通。
   - 建议：将“类型判断”和“模型/frame 定位”拆开。wikiKind 已知时仍应定位对应模型所在 frame，或者让 exporter 自己在所有 frame 中查找并只执行一次抽取。

3. **major**
   - 位置：方案 §4.3、§5.4；[index.ts](/Users/ambrose/WorkSpace/Code/work/larksnap/src/background/index.ts:219)、[index.ts](/Users/ambrose/WorkSpace/Code/work/larksnap/src/background/index.ts:233)、[index.ts](/Users/ambrose/WorkSpace/Code/work/larksnap/src/background/index.ts:291)
   - 问题：全局探测只接入 `runFeishuExport` 和 `runExcelExport`。小红书、微信、附件三个入口直接调用 `detectDocForTab → blockSheetOnly/blockBaseOnly`，没有 `fillWikiKind`。无 query 参数的 wiki sheet/base 在这些入口仍会被当成普通文档执行。
   - 建议：把“识别并补齐 effective kind”收口为公共入口，所有需要类型限制的导出动作都先调用；至少覆盖 XHS、Wechat、Attachments。相关测试也要覆盖无 query 的探测结果。

4. **major**
   - 位置：方案 §5.7（v1:591-610）；[bridge.ts](/Users/ambrose/WorkSpace/Code/work/larksnap/src/background/bridge.ts:503)；[larksnap-fetch/SKILL.md](/Users/ambrose/WorkSpace/Code/work/larksnap/skills/larksnap-fetch/SKILL.md:38)
   - 问题：桥接协议目前只接受 `md|pdf|html`，方案却让任何 bitable 请求都忽略 `fmt` 并返回 `.xlsx`。这会导致调用方请求 Markdown/PDF/HTML，却收到格式和扩展名完全不同的产物，也改变 `/base/` 直链的现有桥接行为。
   - 建议：本次应在 bridge 对 bitable 返回明确的“不支持，请在侧边栏导出 Excel”。若确实要支持 xlsx，必须同步扩展 CLI 参数校验、协议文档和测试，不能只改扩展端。

5. **major**
   - 位置：方案 §3 情形 2（v1:173-201）、风险 8（v1:963）；[sheet.ts](/Users/ambrose/WorkSpace/Code/work/larksnap/src/background/exporters/sheet.ts:55)
   - 问题：`window.spread` 回退中，切换或加载失败的非空 sheet 会得到空 rows，随后被 `filter` 静默丢弃；只要另一张表有数据，最终仍报告完整成功。方案甚至把这种“只有部分表”列为可接受降级，直接违反“不许静默失败”。
   - 建议：记录预期 sheet、切换是否成功、读取是否就绪。任何无法确认是真空表的 sheet 都应导致整体失败，或明确返回“部分导出 N/M”警告，不能与真实空表一起静默过滤。

6. **major**
   - 位置：方案 §6（v1:623-719）；[markdown.ts](/Users/ambrose/WorkSpace/Code/work/larksnap/src/background/exporters/markdown.ts:81)
   - 问题：方案声称堵住“导出成功但内容为空”这一类别，实际只检查 client_vars 解码路径。官方 Markdown 路径直接下载 `result.base64` 并返回成功，没有检查零字节、空白文本或仅换行内容，硬约束仍未完整落实。
   - 建议：在 `runOfficialMd` 下载前校验解码后的文本/字节；同时保留 decode 和 HTML 的结构化判空。不要用统一字节阈值，但各 exporter 必须覆盖自己的成功出口。

7. **minor**
   - 位置：方案 §8.2-8.3
   - 问题：测试没有覆盖 `frameId` 从探测结果传入 exporter、多个 frame 的选择顺序、`spread` 对普通 wiki 文档的误判，也没有验证空导出守卫确实接入 Markdown/HTML 成功出口。把 `probeWikiKind` 视为“不值得单测”不成立，它包含本次最关键的分类逻辑。
   - 建议：mock `chrome.scripting.executeScript` 返回不同 `frameId/result`，测试主 frame、iframe、冲突结果和无结果；断言 exporter 收到正确 frame。为 guard 及其调用位置增加测试。

8. **minor**
   - 位置：方案开头“改动地图”（v1:17-30）、§6
   - 问题：声称“8 个文件，其中 1 个新建”，但表格已包含 9 个物理文件，后文又新增 `guard.ts` 并修改 `markdown.ts`、`html.ts`，实际约 12 个文件、2 个新文件。改动范围和落地顺序不一致。
   - 建议：重新列完整文件清单，并明确哪些改动由探测结果决定、哪些是无条件改动。