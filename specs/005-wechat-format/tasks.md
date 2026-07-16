# Tasks: 飞书转公众号排版

**Plan**: `specs/005-wechat-format/plan.md` · **Spec**: `./spec.md`

约定:`[P]` 可与同段其他 `[P]` 并行(改不同文件);顺序项有依赖。每个 phase 末尾跑 `npm run typecheck`。已实现任务按实际代码回填勾选。

## Phase 0 — 路线 A:剪贴板全链路 [US1/US3 · 已完成]

- [x] T001 `src/shared/types.ts`:`InlineNode` 增 `color`/`background`/`underline`;`ExportAction` 增 `'wechat'`
- [x] T002 `src/background/convert/apool.ts`:解码透传下划线/文字颜色/背景高亮(只认 CSS 形态色值,枚举号忽略);`mergeAdjacent` 同步比较新字段(否则不同颜色相邻节点被错误合并)
- [x] T003 [P] `src/background/convert/inline-html.ts`:`inlineToWechatHtml`——粗/斜/删/下划线/颜色/高亮/链接全落内联 CSS,行内代码灰底+边框+圆角;`escapeHtml` 公用
- [x] T004 [P] `src/shared/themes.ts`:`WECHAT_THEME_OPTIONS`(选择器元数据)+ `WechatTheme` 完整定义(headingColor/accentBar/quoteBorder)+ `WECHAT_THEMES` 三主题(经典黑/商务蓝/微信绿)+ `getWechatTheme`;单一来源供 SW 渲染器与侧边栏预览共用
- [x] T005 `src/background/convert/wechat-html.ts`:块树→全内联 `<section>` HTML 渲染器——heading1-6(字号阶梯 28~16px+主题色/色条)/text/todo(☐☑)/连续列表合组+深度轮换 type/code(code-snippet 三类名+data-lang+每行 display:block)/quote(主题边条+浅灰底)/callout(flex+色盘枚举+emoji 码点转换)/divider/image(dataURL+对齐+失败占位)/grid(flex 按 width_ratio)/table(真 rowspan+colspan+覆盖格跳过+首行表头+降级占位)/未知块占位;`collectImageAssets` 收集图片素材
- [x] T006 `src/background/exporters/wechat.ts`:SW 编排——resolveObjToken → fetchClientVars → buildBlockTree → `downloadImageDataUrls`(进度 10-90)→ renderWechatHtml(95)→ 回传 `{html,title}`;全程 `reportProgress`,失败给可读错误
- [x] T007 [P] `src/shared/constants.ts` `MSG.EXPORT_WECHAT` + `src/background/index.ts` 路由(themeId 透传、sheet-only 文档拦截、trackedExport 统计)
- [x] T008 [P] `src/sidepanel/copy-html.ts`:侧边栏写剪贴板 text/html + text/plain 双口味;`ClipboardItem` 失败降级 contenteditable + `execCommand('copy')`
- [x] T009 `src/sidepanel/actions.ts` + `SidePanel.tsx`:「复制为公众号格式」卡片 + 主题胶囊选择器 + 悬浮真配色预览(`WechatThemePreview`)+ localStorage 记忆上次主题;成功后提示"去公众号编辑器粘贴"
- [x] T010 `npm run typecheck` + `npm run build` 通过;合成 client_vars 块树冒烟 13 断言通过(脚本在会话 scratchpad,未入库)

## Phase 1 — 路线 A 真实编辑器实测校准 [US1/US4 验收 · 待做]

- [ ] T011 公众号编辑器 PC 端实测:拿含 标题/加粗/高亮/代码块/引用/callout/嵌套列表/合并单元格表格/图片/分栏 的文档粘贴,逐块核对样式留存;与 feishu2weixin crx 转换结果做基准对照(spec SC-001)
- [ ] T012 手机端预览校准:grid flex 是否挤压(风险项),挤压则 `src/background/convert/wechat-html.ts` 的 `renderGrid` 降级为上下堆叠;section 嵌套深度是否被过滤
- [ ] T013 按实测结论微调渲染器样式常量(只动 `wechat-html.ts`/`inline-html.ts`),`npm run typecheck`

## Phase 2 — 渲染器补微信 schema 与块标记 [US4 P1]

- [x] T014 [P] `src/background/convert/wechat-html.ts` `renderCode`:代码行内容包 `<span leaf="">`(微信新版编辑器叶节点标记,set_content 后才被识别为代码块);外层补 `<section class="code-snippet__js">` 包裹,以 Phase 1 实测的编辑器留存形态为准(plan §5.6)
  - **实现说明**:已按 plan §5.6 目标形态实现(`section.code-snippet__js > pre.code-snippet* > code > span[leaf]`);T011 实测后如有出入按实测微调。
- [x] T015 [P] `src/background/convert/wechat-html.ts`:块级元素打三属性 `data-larksnap-key`(块类型)/`data-larksnap-content`(正文容器)/`data-larksnap-action-id`(唯一 id)(FR-010,壹伴 data-mpa-md-* 同构);回归确认粘贴路线不受影响
  - **实现说明**:action-id 直接用块的 client_vars id(天然唯一且可回查);text/heading/todo/quote/li 等自身即正文容器的块,三属性打在同一元素上;code/callout/image/table 的 `data-larksnap-content` 打在内层正文容器。粘贴路线为纯增量属性,不影响样式(冒烟确认)。
- [x] T016 `npm run typecheck` + 重跑合成块树冒烟
  - **实现说明**:合成块树冒烟 14 断言全过(脚本在会话 scratchpad,验证 leaf 包裹/三属性/三类名/列表合并),typecheck 通过。

## Phase 3 — 路线 B:mp 页双世界注入与 JSAPI 直灌 [US1 P0]

- [ ] T017 `manifest.json`:`mp.weixin.qq.com` host 权限(形态待拍板,见 plan 开放问题 1)+ `web_accessible_resources` 暴露 `mp-main.js`
- [ ] T018 `vite.config.ts`:增两个 IIFE 入口 `src/content/mp/index.ts` → `dist/mp.js`、`src/content/mp/main-world.ts` → `dist/mp-main.js`(与 content.js 同配置)
- [ ] T019 [P] `src/shared/constants.ts`:`MSG.WECHAT_FILL`;`MP_MSG={FILL,RESULT}`;双世界 CustomEvent 名常量
- [ ] T020 [P] `src/shared/types.ts`:`WechatFillRequest{html,title,mode:'replace'|'insert'}`、`WechatFillResult{editor,uploaded,failed}`
- [ ] T021 `src/content/mp/main-world.ts`:主世界脚本——编辑器判定(`__MP_Editor_JSAPI__`+`.ProseMirror` → 新版,否则 `#ueditor_0` → 老版,都无 → 报错);新版 `mp_editor_get_isready` 等就绪(10s 超时)→ `mp_editor_set_content`/`mp_editor_insert_html`;`mp_editor_get_content` 判空稿;结果 CustomEvent 回传(依赖 T019/T020)
- [ ] T022 `src/content/mp/index.ts`:隔离世界入口——幂等标记;注入 `mp-main.js`(`chrome.runtime.getURL` + script 标签);接收 SW 的 `MP_MSG.FILL` → 转交主世界(带请求 id/来源校验/超时)→ 回传结果(依赖 T021)
- [ ] T023 `src/background/index.ts`:路由 `MSG.WECHAT_FILL`——查找 `mp.weixin.qq.com` 图文编辑页 tab(无则报"请先打开公众号图文编辑页")→ `chrome.scripting.executeScript` 注入 `mp.js`(幂等)→ `tabs.sendMessage(MP_MSG.FILL)` → 回传结果(依赖 T019/T022)
- [ ] T024 `src/sidepanel/actions.ts` + `SidePanel.tsx`:公众号卡片增「灌入编辑器」入口——检测 mp 编辑页 tab 决定可点性;非空稿弹覆盖确认(spec US1-4);成功提示灌入结果与失败图数量(依赖 T023)
- [ ] T025 `npm run typecheck` + `npm run build`;新版编辑器页实测:空稿 set_content 成功、未就绪/非编辑页给明确提示(SC-003)

## Phase 4 — 路线 B:图片上传素材库 [US2 P0]

- [ ] T026 `src/content/mp/upload.ts`:签名获取——扫页面 `<script>` 正则抠 `user_name`/`nick_name`/`ticket`,`token` 从编辑页 URL 取;抠不到给可读错误(登录态异常)
- [ ] T027 `src/content/mp/upload.ts`:上传——dataURL→blob;宽×高 >5e6 像素先 canvas 等比压缩;`FormData.append("file",blob)` POST `/cgi-bin/filetransfer?action=upload_material&f=json&scene=8&writetype=doublewrite&groupid=1&ticket_id=…&ticket=…&svr_time=…&token=…&lang=zh_CN&seq=…`(同源自动带 Cookie);解析响应 `cdn_url`(依赖 T026)
- [ ] T028 `src/content/mp/index.ts`:灌入前遍历 HTML 里的 dataURL `<img>`,逐张上传(并发 ≤3,单张失败换占位提示不拖垮整篇,FR-007)→ src 回填 mmbiz 链接 → 再转交主世界灌入;统计 uploaded/failed 回传(依赖 T022/T027)
- [ ] T029 实测:含 3+ 张图(其中 1 张构造超大图)的文档灌入,正文所有 `<img src>` 为 `mmbiz.qpic.cn`、预览无丢图(SC-002);构造一张必失败图验证占位不拖垮(SC-004);`npm run typecheck`

## Phase 5 — 路线 B:老版 UEditor 兜底 [US5 P2]

- [ ] T030 `src/content/mp/main-world.ts`:老版分支——`#ueditor_0` iframe 内 `execCommand("inserthtml", html)`;失败直接写 iframe body;结果标记 `editor:'ueditor'`
- [ ] T031 老版编辑器页实测插入可用;两代特征都无时提示改用剪贴板路线(spec US5-2);`npm run typecheck`

## Phase 6 — 验收与回归

- [ ] T032 跑通 spec SC-001~004:10 篇抽样(路线 A ≥9 篇排版正确;路线 B 无外链图/代码块识别/表格正确)
- [ ] T033 飞书回归:markdown/word/pdf/html/xhs 各跑一篇确认零变化(SC-005)
- [ ] T034 取证:`grep -rn "fetch(" src/background/` 确认 SW 无飞书内部接口请求(宪法 I);`grep -rn "http" src/content/mp/ src/background/convert/wechat-html.ts src/background/exporters/wechat.ts` 确认除 mp.weixin.qq.com 外无外发域(SC-006/宪法 V);`npm run typecheck` + `npm run build` 通过

## 依赖图

```
Phase 0(已完成)──T011──T012──T013          (路线 A 实测校准)
                    │
        T014[P]/T015[P]──T016               (schema 强化,依赖 T011 实测形态)
                    │
T017──T018──┬──T021──T022──T023──T024──T025 (JSAPI 直灌)
T019[P]/T020[P]─┘         │
              T026──T027──T028──T029        (素材库上传,T028 依赖 T022)
                          │
                    T030──T031              (UEditor 兜底)
                          │
                 T032──T033──T034           (验收回归)
```
