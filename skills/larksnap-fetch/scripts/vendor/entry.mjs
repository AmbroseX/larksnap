// turndown.bundle.mjs 的打包入口 —— 让 arxiv.mjs 零依赖地做 HTML→Markdown。
// 依赖升级后在仓库根重新打包：
//   node_modules/.bin/esbuild skills/larksnap-fetch/scripts/vendor/entry.mjs \
//     --bundle --format=esm --platform=node --minify \
//     --outfile=skills/larksnap-fetch/scripts/vendor/turndown.bundle.mjs
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
export { TurndownService, gfm };
