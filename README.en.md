# LarkSnap · Feishu / Lark Document Exporter

[简体中文](README.md) | **English**

> Chrome MV3 extension · One-click export of Feishu / Lark docs to **Markdown / PDF / HTML**, batch-download attachments, and cache docs offline; plus **any-page → Markdown**, copy-protection unlock, and auto-copy on selection.

Zero config, fully client-side, nothing leaves your machine — and it **works with self-hosted / private-deployment** Feishu domains.

<p>
  <img alt="manifest" src="https://img.shields.io/badge/Manifest-V3-4285F4">
  <img alt="stack" src="https://img.shields.io/badge/React%2018%20%2B%20Vite%20%2B%20TypeScript-3178C6">
  <img alt="status" src="https://img.shields.io/badge/status-active%20development-orange">
  <img alt="license" src="https://img.shields.io/badge/license-Apache%202.0-green">

</p>

---

## Why

In many enterprise tenants the official Feishu "Export" button is disabled by admins, while third-party exporters typically require you to register an app on the Feishu Open Platform, request scopes, and wait for approval. This extension takes a different route: **it reuses the login cookie already in your browser and Feishu's own internal web APIs**. Open the side panel on a doc page and export in one click — no backend, no API application.

It was originally built for LLM-corpus / knowledge-base migration — turning docs scattered across Feishu into high-quality Markdown in bulk, images packed alongside. That Markdown pipeline is now open to every web page: convert any page (or just a selection) to Markdown in one click, and unlock pages that block copying while you're at it.

## Features

- **One-click, multi-format**: Markdown (images packed into `.zip`), PDF (high-res render), HTML (single file with inlined resources).
- **High-quality Markdown**: preserves headings, lists, code blocks, tables (incl. merged cells), formulas, callouts, images, and more.
- **Dual data paths with auto-routing**: at runtime it probes the doc's host — if the tenant keeps official export on it uses **P-official** (best fidelity); if it's disabled it automatically falls back to **P-decode** (`client_vars` + apool self-decoding). Either way you only ever click one "Export Markdown".
- **Private-deployment friendly**: no domain allowlist. Beyond public cloud (`feishu.cn` / `feishu.net` / `larksuite.com`) it also recognizes self-hosted domains (e.g. `*.corp.example.com`); host permissions are granted at runtime on demand, and granted domains can be reviewed / revoked.
- **Batch attachment download**: parses image / file tokens in the doc and saves them via the media download API.
- **Offline cache**: store docs as local snapshots for offline browsing and management.
- **Any web page → Markdown**: non-Feishu pages go through Readability content extraction + Turndown (GFM) conversion; copy or download `.md` from the side panel or the page context menu. Sites whose content isn't in the DOM get dedicated adapters (Baidu Wenku supported).
- **Copy-protection unlock**: one click unlocks pages that block selection / copy / right-click — three reversible layers (event, style, inline handlers); toggle off to restore the page exactly.
- **Auto-copy on selection**: once enabled, selected text goes straight to the clipboard (plain text or Markdown, minimum length configurable in settings); session-scoped, never persistent.
- **Copy tab links**: copy the current tab or all tabs in one click, as Markdown links / title+URL / title only / URL only.
- **Export diagnostics**: one-click export of a redacted diagnostic bundle (DocInfo / API response samples / routing decision / version) to pin down field differences between private and public deployments — PII fields like `editor_map` / `user_map` / `creator_id` are explicitly stripped.
- **CC bridge (optional)**: connect command-line tools like Claude Code to this logged-in extension via a local daemon and run exports unattended (see [CC bridge skill](#cc-bridge-skill-larksnap-fetch)).

## How it works

```
                          ┌──────────────────── Chrome extension (MV3) ───────────────┐
                          │                                                            │
  Feishu doc ──side panel▶│  Side Panel (React)                                        │
                          │      │  message                                            │
                          │      ▼                                                     │
                          │  Service Worker ──┬─ doc-detect   detect doc / grant perms │
                          │   (export engine) ├─ feishu-proxy relay internal API       │
                          │      │             ├─ capability   probe export ability     │
                          │      │             └─ exporters    md / pdf / html / files   │
                          │      ▼                                                     │
                          │  content script ──same-origin fetch▶ Feishu internal API   │
                          └────────────────────────────────────────────────────────────┘
```

A few deliberate design principles:

1. **Internal APIs are called by the content script same-origin**; the Service Worker only proxies and orchestrates — avoiding CORS and risk-control triggers.
2. **No specific Feishu domain is ever hardcoded** as the sole target; media / export download hosts are derived from the current page host (known suffix for public cloud, strip the leftmost tenant subdomain for private deployments).
3. **Unsupported blocks degrade to a placeholder** while preserving descendant text where possible, so content isn't lost.
4. **Nothing leaves your machine, no backend** — the whole flow is client-side.

> requirement specs in [`specs/`](specs/).

## Install (load from source)

```bash
git clone https://github.com/AmbroseX/larksnap.git
cd larksnap
npm install
npm run build          # production build → dist/
```

1. Open `chrome://extensions`
2. Enable "Developer mode" (top-right)
3. Click "Load unpacked" and select the project's `dist/` directory

## Usage

1. Log in to Feishu / Lark in your browser as usual (public cloud or a private domain — both work).
2. Open any Feishu doc page (`docx` / `wiki` / `sheet`, etc.).
3. Click the extension icon to open the side panel and confirm the title and type are detected at the top.
   - For an **unauthorized private domain**, the side panel prompts you to grant access — one click completes Chrome's runtime authorization.
4. Pick an action from the list:

   | Action | Notes | Status |
   |---|---|---|
   | Export as Markdown | To Markdown, images packed into `.zip` | ✅ |
   | Export as PDF | Rendered to high-res PDF | ✅ |
   | Export as HTML | Single-file HTML (inlined resources) | ✅ |
   | Export attachments | Batch-download images and files in the doc | ✅ |
   | Cache locally / view cache | Offline snapshots and management | ✅ |
   | Export diagnostics | Locate format differences on private Feishu (redacted) | ✅ |
   | Export as Word | — | 🚧 In progress |
   | Any web page → Markdown | Non-Feishu pages via a generic Readability + Turndown pipeline | ✅ ([spec 002](specs/002-generic-page-markdown/)) |

> ⚠️ When a tenant has disabled official export and the extension falls back to P-decode, it first warns "official export for this doc is disabled; continuing bypasses that restriction." **Use only when you are authorized to.**

### Web copy (non-Feishu pages)

On a **non-Feishu page** the side panel automatically switches to the "Web copy" view; you can also skip the panel entirely and use the page **context menu**:

| Action | Notes |
|---|---|
| Page → Markdown (copy / download `.md`) | Readability extracts the article → Turndown (GFM) converts it; sites like Baidu Wenku that render text into canvas use a built-in adapter that fetches the data directly |
| Selection → Markdown | Converts the selected HTML to Markdown and copies it |
| Copy-protection unlock (on / off) | Unlocks pages that block selection / copy / right-click; turning it off restores the page exactly |
| Auto-copy on selection | Selections of ≥ N chars go straight to the clipboard (threshold and plain-text / Markdown format configurable in settings); session-scoped per tab |
| Copy tab links | Current tab as a Markdown link; all tabs as Markdown / title+URL / title only / URL only |

Permissions: the context menu relies on the `activeTab` gesture — **no domain needs to be pre-authorized**; if the side-panel path fails to inject, it prompts for that domain's permission within the same click, and you can always fall back to the context menu.

## CC bridge skill (larksnap-fetch)

`skills/larksnap-fetch/` is a **self-contained Claude Code skill**: paste a Feishu link in CC and it exports to a local directory. It bundles a zero-dependency local matchmaking daemon that hands the link to the **logged-in extension** to export, so the CLI side never has to deal with login state.

```
  CLI  ──HTTP POST /command (streaming NDJSON)──▶  daemon (127.0.0.1:19925)  ──WS push──▶  extension
  ext  ──WS (progress / result)──────────────────▶  daemon  ──back into /command stream──▶  CLI
```

- The extension is a WebSocket client that **dials out** to the local daemon (à la OpenCLI, no native messaging); kept alive via `alarms` + backoff reconnect.
- The daemon binds `127.0.0.1` only, and defends against browser-side CSRF via Origin checks + a custom request header.
- On receiving a job, the extension opens a background tab, runs the export engine, captures the artifact via a download sink, and streams it back over WS; missing login / permission returns `need-*`.

Protocol constants: [`skills/larksnap-fetch/scripts/bridge/protocol.mjs`](skills/larksnap-fetch/scripts/bridge/protocol.mjs); daemon: [`skills/larksnap-fetch/scripts/bridge/daemon.mjs`](skills/larksnap-fetch/scripts/bridge/daemon.mjs).

### Install the skill (one line)

The skill installs globally straight from this repo via [`npx skills`](https://github.com/vercel-labs/skills), usable from any project:

```bash
npx skills add AmbroseX/larksnap --skill larksnap-fetch -g -a claude-code
```

> ⚠️ This installs the **skill files only**. To actually run, two prerequisites are required:
> 1. **Node.js** installed locally (the skill uses it to spawn the daemon).
> 2. This repo's **extension built and loaded into Chrome** (login state and the export engine live in the extension and can't be bundled into the skill):
>    run `npm run build` in the repo root → `chrome://extensions` Developer mode → "Load unpacked" → select `dist/` → click the extension icon to wake the background.
>
> Once set up, just paste a Feishu link in CC and say "download it to some directory." Usage and exit codes: [`skills/larksnap-fetch/SKILL.md`](skills/larksnap-fetch/SKILL.md).

### Usage example

With the extension + skill installed, just tell Claude Code:

> Download `https://your-company.feishu.cn/docx/xxxxxxxx` into `./docs`

The skill drives the extension to export; the result lands in your target directory, in a subfolder named after the doc title (one folder per doc):

```
docs/
└── Quarterly Review/
    ├── Quarterly Review.md
    └── images/           # images referenced by relative path
        └── xxx.png
```

Or call it directly from the command line, bypassing CC:

```bash
node ~/.claude/skills/larksnap-fetch/scripts/fetch.mjs \
  "https://your-company.feishu.cn/docx/xxxxxxxx" ./docs --format md
```

## Project layout

```
manifest.json          # MV3 manifest (side panel as main entry)
vite.config.ts         # build: multi-entry React + content script as IIFE + prod obfuscation
build.sh               # build / package script
sidepanel.html         # side panel entry (main UI)
options.html           # settings page
popup.html             # fallback popup entry
skills/                # Claude Code skills installable via `npx skills add`
  larksnap-fetch/    #   Feishu link → local directory (self-contained, bundled bridge daemon)
docs/                  # design docs, PRD
specs/                 # feature specs (spec-driven)
src/
  background/          # Service Worker (export engine)
    index.ts           #   message routing + open side panel + start bridge
    bridge.ts          #   CC bridge (extension-side WS client)
    doc-detect.ts      #   detect the current Feishu doc
    capability.ts      #   probe Markdown export ability by host (P-official / P-decode)
    feishu-proxy.ts    #   relay internal APIs same-origin via content
    feishu-api.ts      #   internal API wrappers (client_vars / media, etc.)
    progress.ts        #   unified progress reporting
    convert/           #   apool decode + block tree → Markdown
    exporters/         #   markdown / pdf / html / attachments / export task
    cache-manager.ts   #   local cache read/write
    diagnostic.ts      #   redacted diagnostics
    permissions.ts     #   runtime auth for private domains / trusted list
    webcopy.ts         #   web-copy SW side (context menu / injection / tab links)
    webcopy-adapters.ts#   site-specific adapters (Baidu Wenku etc.)
  content/             # injected page scripts (same-origin fetch / DOM snapshot)
    webcopy/           #   web copy (Readability + Turndown / unlock / auto-copy)
  sidepanel/           # side panel UI (React, Feishu export + web copy views)
  options/             # settings UI
  popup/               # popup UI
  shared/              # types / constants / storage / messaging / host derivation
```

## Development

```bash
npm install
npm run dev        # watch build to dist/
npm run typecheck  # type-check only
```

After loading `dist/`, source edits rebuild automatically; click "Reload" on the extension in `chrome://extensions` to pick them up.

## Build & release

```bash
npm run build      # production build + obfuscation → dist/
./build.sh         # same as above (with version log)
./build.sh --zip   # also package release/*.zip (for Chrome Web Store upload)
```

Pushing a `v*` tag (e.g. `v0.2.4`) triggers GitHub Actions to build, package zip / crx, and create a GitHub Release (see [`.github/workflows/release.yml`](.github/workflows/release.yml)).

## Tech stack

- **Runtime**: Chrome Manifest V3 (Service Worker + Side Panel + content script)
- **UI**: React 18 + TypeScript
- **Build**: Vite 5 (multi-entry React + content script as IIFE) + `javascript-obfuscator` for production
- **Deps**: `jszip` (packaging), `marked` (Markdown rendering), `@mozilla/readability` + `turndown` (web page → Markdown)
- **Bridge**: zero-dependency Node.js HTTP + hand-rolled WebSocket daemon

## Privacy & compliance

- **Nothing leaves your machine**: doc content, cookies, and login state stay in your local browser; the extension never reports to any third-party server.
- **Redacted diagnostics**: the diagnostic bundle explicitly strips PII fields like `editor_map` / `user_map` / `creator_id` / `owner_id` before packaging.
- **Least privilege**: private domains use `optional_host_permissions` + user-gesture runtime authorization; no upfront all-sites access.
- **Respect org policy**: when official export is disabled by the org, P-decode clearly states what it's doing. Use only when authorized. This tool is for lawful, authorized document export and personal backup only.

## Roadmap

- [x] Dual-path Markdown export (P-official / P-decode) + image packaging
- [x] PDF / HTML / attachments / offline cache
- [x] Private-deployment compatibility + diagnostics
- [x] CC ⇄ extension local bridge
- [x] Any web page → Markdown (Readability + Turndown generic pipeline + site adapters)
- [x] Copy-protection unlock / auto-copy on selection / tab-link copy
- [ ] Word export
- [ ] More site adapters (Zhihu, WeChat articles, etc.)
- [ ] Multi-doc / knowledge-base batch export

## Acknowledgments

All code in this project is an independent implementation. The design drew ideas from the following open-source projects — thanks to their authors:

- [Wsine/feishu2md](https://github.com/Wsine/feishu2md) — block-assembly approach over the OpenAPI route
- [dtsola/xiaoyaosearch-feishu-export-md](https://github.com/dtsola/xiaoyaosearch-feishu-export-md) — block-type → Markdown mapping design
- [sancijun/feishu-doc-helper](https://github.com/sancijun/feishu-doc-helper) / [sancijun/doc-export-helper](https://github.com/sancijun/doc-export-helper) — validation of the cookie-based internal-API route
- [dicarne/feishu-backup](https://github.com/dicarne/feishu-backup), [eternalfree/feishu-doc-export](https://github.com/eternalfree/feishu-doc-export) — batch-export approach comparison
- [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI) — architecture ideas for the local bridge daemon

## License

Released under the [Apache License 2.0](LICENSE). You may freely use, modify, distribute, and use it commercially, provided you retain the copyright notice and license text; the license also grants patent rights and includes trademark-protection terms.

## Disclaimer

This tool is for lawful, authorized document export and personal backup only. Users are responsible for ensuring they hold the appropriate rights to any exported document and for complying with their organization's data-management policies and the Feishu / Lark terms of service. Any consequences arising from misuse are borne solely by the user; the author assumes no liability.
