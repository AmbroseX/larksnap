# arXiv 论文下载(PDF + HTML + Markdown 一起落地)

链接或 ID 指向 arXiv 论文时,**不走 daemon/扩展**(arXiv 完全公开,不需要登录态),改用独立脚本直接下载:

```bash
node ~/.claude/skills/larksnap-fetch/scripts/arxiv.mjs <arXiv链接或ID> <输出目录> [--pdf-only|--html-only]
```

- 链接和 ID 全兼容:裸 ID(`2601.18226`)、`arXiv:` 前缀、`arxiv.org` 的 abs/pdf/html 三种链接(含 `.pdf` 后缀、`v2` 版本号)、老式 ID(`math.GT/0309136`,做目录名时斜杠替换为下划线)。
- 产物同样独立成夹,文件夹用 ID 命名:`<输出目录>/2601.18226/2601.18226.pdf` + `.html` + `.md`。
- HTML 里注入了 `<base>`,图片/样式解析回 arxiv.org 绝对地址,本地打开不裂图(图片本身不下载到本地)。
- Markdown 由 HTML 就地转换,**零外部依赖**(turndown 打包在 `scripts/vendor/` 里,不需要 pandoc):公式用 LaTeXML 自带的 alttext 还原成 `$...$`/`$$...$$`,图片/引用链接为 arxiv.org 绝对地址;复杂表格以内嵌 HTML 保留。转换失败只影响 `.md`,PDF/HTML 照常落地。
- **部分论文没有 HTML 版属正常**(arXiv 只为有 LaTeX 源且转换成功的论文提供 HTML,老论文也可能已被回补):此时只落 PDF,退出码仍为 0,stderr 有 `ℹ` 提示——**不要当成失败重试**。
- 退出码:`0` 成功 ｜ `1` 失败 ｜ `2` 用法错;错误契约与 fetch.mjs 相同(非 0 退出时 stderr 最后一行是一行 JSON,按 `hint` 分支)。
