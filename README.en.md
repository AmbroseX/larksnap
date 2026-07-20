# LarkSnap · Doc Export · Web Clipper · Snapshot

[简体中文](README.md) | **English**

> Chrome extension: export Feishu / Lark docs to **Markdown / PDF / HTML** in one click, batch-download attachments, cache offline, and **write Markdown back** into docs; convert **any webpage** (incl. Xiaohongshu notes) to Markdown, full-page screenshot, AI summary, remove copy restrictions; download videos from **Bilibili / YouTube / Douyin / TikTok**.

Zero config, fully client-side, nothing leaves your browser. Works with **self-hosted enterprise Feishu domains**. No open-platform app, no API permission requests — it reuses the cookies already in your browser and Feishu's own internal web APIs.

<p>
  <a href="https://chromewebstore.google.com/detail/larksnap-%C2%B7-%E9%A3%9E%E4%B9%A6%E6%96%87%E6%A1%A3%E5%AF%BC%E5%87%BA%E5%8A%A9%E6%89%8B/gepndmikbdjpdedkfiejchmhmhegjeal"><img alt="chrome web store" src="https://img.shields.io/chrome-web-store/v/gepndmikbdjpdedkfiejchmhmhegjeal?label=Chrome%20Web%20Store&color=blue"></a>
  <img alt="manifest" src="https://img.shields.io/badge/Manifest-V3-4285F4">
  <img alt="stack" src="https://img.shields.io/badge/React%2018%20%2B%20Vite%20%2B%20TypeScript-3178C6">
  <img alt="license" src="https://img.shields.io/badge/license-Apache%202.0-green">
</p>

## Install

### Option 1: Chrome Web Store (recommended, auto-updates)

Install with one click from the [Chrome Web Store](https://chromewebstore.google.com/detail/larksnap-%C2%B7-%E9%A3%9E%E4%B9%A6%E6%96%87%E6%A1%A3%E5%AF%BC%E5%87%BA%E5%8A%A9%E6%89%8B/gepndmikbdjpdedkfiejchmhmhegjeal) — future versions update automatically.

### Option 2: Load manually

Download the latest zip from [Releases](https://github.com/AmbroseX/larksnap/releases), unzip it, then:

1. Open `chrome://extensions` and enable "Developer mode"
2. Click "Load unpacked" and select the unzipped folder

To build from source instead, see [Development](#development) below.

## Usage

### Export Feishu docs

1. Log in to Feishu / Lark in your browser (public cloud or self-hosted domain).
2. Open a doc page (`docx` / `wiki` / `sheet`, etc.) and click the extension icon to open the side panel.
   - Self-hosted domains prompt for authorization on first use — one click.
3. Pick an action:

| Action | Notes |
|---|---|
| Export as Markdown | Preserves headings / tables / code blocks / formulas; images bundled into a `.zip` |
| Export as PDF / HTML | High-quality PDF rendering; single-file HTML with inlined assets |
| Export attachments | Batch-download images and files in the doc |
| Cache locally | Offline snapshots and management |
| Export diagnostics | For debugging self-hosted format differences (PII stripped) |

Even if your tenant has disabled the official export, the extension automatically falls back to a self-decoding pipeline (with a confirmation prompt — **use only with proper authorization**).

### Web copy (non-Feishu pages)

Open the side panel on any page, or use the page's right-click menu:

| Action | Notes |
|---|---|
| Page / selection → Markdown | Copy or download `.md`; built-in adapters for sites like Baidu Wenku |
| Remove copy restrictions | Unlock pages that block selection / copy / right-click, fully reversible |
| Auto-copy selected text | Selection goes straight to clipboard; threshold and format configurable |
| Copy tab links | Current tab or all tabs, four formats including Markdown links |

### Use from Claude Code (larksnap-fetch skill)

With the extension loaded, install the skill and paste Feishu links directly in Claude Code:

```bash
npx skills add AmbroseX/larksnap --skill larksnap-fetch -g -a claude-code
```

Then just say:

> Download `https://your-company.feishu.cn/docx/xxxxxxxx` to `./docs`

Each doc lands in its own folder named after its title, with images referenced by relative paths. Requires Node.js and the extension loaded in Chrome (login state and the export engine live in the extension). See [`skills/larksnap-fetch/SKILL.md`](skills/larksnap-fetch/SKILL.md).

### Download arXiv papers (PDF + HTML + Markdown)

The skill ships a standalone script: paste an arXiv link or bare ID and all three formats are downloaded together — **no browser extension, no pandoc required** (the converter is bundled with the skill):

> Download `https://arxiv.org/abs/2601.18226` to `./papers`

Or run it directly:

```bash
node ~/.claude/skills/larksnap-fetch/scripts/arxiv.mjs 2601.18226 ./papers
```

- Accepts every form: bare ID, `arXiv:` prefix, abs / pdf / html links, and legacy IDs (`math.GT/0309136`).
- Output lands in `./papers/2601.18226/`: `.pdf` + `.html` (opens locally without broken images) + `.md` (math restored to `$...$`, images as arxiv.org links).
- Some papers have no HTML version — that's normal; only the PDF is saved and a note is printed.

## Development

```bash
git clone https://github.com/AmbroseX/larksnap.git
cd larksnap
npm install
npm run build      # production build → dist/, load it as described in Install
npm run dev        # or watch build, rebuilds on change
npm run typecheck  # type-check only
```

Architecture, directory layout, the CC bridge protocol, and release workflow are documented in **[docs/架构与技术细节.md](docs/架构与技术细节.md)** (Chinese); specs live in [`specs/`](specs/).

## Privacy & disclaimer

- **Nothing leaves your machine**: doc content, cookies, and login state stay in your local browser — no backend, no third-party reporting.
- **Minimal permissions**: self-hosted domains use on-demand runtime authorization; diagnostics strip PII fields.
- This tool is for lawful, authorized export and personal backup only. Follow your organization's data policies and the Feishu / Lark terms of service; misuse is at your own risk.

## Acknowledgements

Independent implementation, with design ideas referenced from: [feishu2md](https://github.com/Wsine/feishu2md), [xiaoyaosearch-feishu-export-md](https://github.com/dtsola/xiaoyaosearch-feishu-export-md), [feishu-doc-helper](https://github.com/sancijun/feishu-doc-helper), [feishu-backup](https://github.com/dicarne/feishu-backup), [feishu-doc-export](https://github.com/eternalfree/feishu-doc-export), [OpenCLI](https://github.com/jackwener/OpenCLI).

## License

[Apache License 2.0](LICENSE)
