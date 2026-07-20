name: larksnap-heading-misrender-bug
description: larksnap-fetch edit.mjs 写入长飞书文档时，某个二级标题偶发被粘成字面文本；用户要自己修插件
metadata:
node_type: memory
type: project
originSessionId: a9ac5098-0236-48cf-addb-8c531c282e89
larksnap-fetch 的 edit.mjs（CDP paste 写入飞书文档）有两个待修的问题，用户说后面自己修插件，不要再靠反复 replace-all 绕：
问题 1：长文档 replace-all 时个别二级标题被渲染成普通文本（带字面 ## ）。
•
复现：把 docs/SDD规范驱动开发培训（算法组）.md（~650 行）replace-all 进 docx doxrzSoNp2qc5LBWHq4JInCZ28U，## 9. 现场演练（15 分钟 + 课后作业）稳定被粘成 type:text 块、summary 为字面 ## 9. 现场演练…，而其它 ## 0.~## 8. 标题都正确渲染成 heading2。
•
本地 md 那行是干净的 ## 9. ...\n（xxd 验证无隐藏字符），所以是粘贴引擎问题，不是源文件。
•
怀疑是 CDP paste 对长内容分块，分块边界正好切在这个标题，导致 ##  标记与文本转换脱节，按字面粘贴。边界随内容长度漂移（改动前面章节长度会换成别的标题中招）。
问题 2：单个短块的 replace-block / insert-after-block 反复报 save_unconfirmed（DOM 未确认），且实际把旧块删了却没插入新块。
•
复现：想把上面那个 text 块 replace-block 成 heading，或 insert-after-block 补一个只含 ## 9. ... 的标题文件，均返回 save_unconfirmed；事后 find-blocks 显示旧块已删、新标题没落地（total:0），还可能留下空 [text] 首块。
•
即"超短内容（单标题一行）粘贴的回读校验无法确认落地"。修插件时建议：短内容注入后加重试/延时再回读，或对 heading-only 注入走非 paste 路径。
当前飞书文档状态：内容是干净单份（已去重）、章节号已是阿拉伯数字 0~9，唯一瑕疵是「9. 现场演练」标题显示为带 ##  的正文文本（可读，仅样式不对）。本地 md docs/SDD规范驱动开发培训（算法组）.md 完全正确。用户会自己修插件后再处理这个标题，我不要再对该文档做 replace-all / 块编辑。
相关：[[larksnap-profile-code]]（导出用 profile 6gbmn78t）。