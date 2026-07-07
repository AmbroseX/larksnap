#!/usr/bin/env node
// larksnap-fetch / arxiv.mjs —— 把一篇 arXiv 论文的 PDF + HTML + Markdown 一起下载到本地目录。
//
// arXiv 完全公开、不需要登录态，因此不走 daemon/扩展桥，直接 https 下载。
// Markdown 由 HTML 就地转换（turndown 打包在 ./vendor/ 里，零外部依赖），
// 公式用 LaTeXML 在 <math> 上自带的 alttext 还原成 $...$ / $$...$$。
//
// 用法:  node arxiv.mjs <arXiv链接或ID> <输出目录> [--pdf-only|--html-only]
// 退出码: 0 成功 | 1 失败 | 2 用法错
// 错误契约: 非 0 退出时 stderr 最后一行是一行 JSON（与 fetch.mjs 一致），供 AI 解析分支。
import fs from 'node:fs';
import path from 'node:path';

const UA = 'larksnap-fetch/arxiv (+https://github.com/AmbroseX/larksnap)';
const TIMEOUT_MS = 120_000; // 单个文件下载上限（PDF 可能几十 MB）

// ==================== 参数 ====================
const argv = process.argv.slice(2);
const positionals = argv.filter((a) => !a.startsWith('--'));
const pdfOnly = argv.includes('--pdf-only');
const htmlOnly = argv.includes('--html-only');
const input = positionals[0];
const outDir = positionals[1];

const EXIT_CODES = { bad_args: 2 }; // 其余 subtype（download_failed / unexpected）→ 1

/** 打印散文 + 一行 JSON 到 stderr，按 subtype 派生退出码退出。不返回。 */
function fail({ type, subtype, message, hint, retryable = false }) {
  console.error('✗', message);
  if (hint) console.error('  →', hint);
  console.error(JSON.stringify({ ok: false, error: { type, subtype, message, hint, retryable } }));
  process.exit(EXIT_CODES[subtype] ?? 1);
}

if (!input || !outDir || (pdfOnly && htmlOnly)) {
  fail({
    type: 'usage',
    subtype: 'bad_args',
    message: '缺少参数或参数冲突：需要 <arXiv链接或ID> 和 <输出目录>，--pdf-only 与 --html-only 不能同用。',
    hint: '用法: arxiv.mjs <arXiv链接或ID> <输出目录> [--pdf-only|--html-only]',
  });
}

// ==================== ID 归一化 ====================
// 都能认：裸 ID（2601.18226 / 2601.18226v2 / arXiv:2601.18226）、老式 ID（math.GT/0309136）、
// arxiv.org 的 abs/pdf/html 三种链接（含 .pdf 后缀、版本号、查询串）。认不出返回 null。
function parseArxivId(raw) {
  let s = raw.trim();
  const m = s.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?#]+)/i);
  if (m) s = m[1];
  s = s.replace(/\/+$/, '').replace(/\.pdf$/i, '').replace(/^arxiv:/i, '');
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return s; // 新式：YYMM.NNNNN[vN]
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/.test(s)) return s; // 老式：archive.SC/YYMMNNN[vN]
  return null;
}

const id = parseArxivId(input);
if (!id) {
  fail({
    type: 'usage',
    subtype: 'bad_args',
    message: `认不出 arXiv ID：${input}`,
    hint: '支持裸 ID（如 2601.18226）、arXiv: 前缀、arxiv.org 的 abs/pdf/html 链接，修正后重跑。',
  });
}

// 老式 ID 带斜杠（math.GT/0309136），做文件/目录名时替换成下划线
const safeName = id.replace(/\//g, '_');

// ==================== 下载 ====================

/**
 * 下载一个 URL。404 返回 null（由调用方决定算不算失败）；其余非 2xx 直接 fail。
 * 返回 { body: Buffer, finalUrl }，finalUrl 是跟随重定向后的最终地址（HTML 注入 <base> 要用）。
 */
async function download(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    fail({
      type: 'export',
      subtype: 'download_failed',
      message: `下载失败：${url}（${e?.cause?.code || e.message}）`,
      hint: '多为网络波动或超时，直接重跑本命令。',
      retryable: true,
    });
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const transient = res.status === 429 || res.status >= 500;
    fail({
      type: 'export',
      subtype: 'download_failed',
      message: `下载失败：${url}（HTTP ${res.status}）`,
      hint: transient ? 'arXiv 暂时不可用或限流，稍等片刻后重跑本命令。' : '确认该链接能在浏览器里打开后重跑。',
      retryable: transient,
    });
  }
  return { body: Buffer.from(await res.arrayBuffer()), finalUrl: res.url || url };
}

/**
 * 保证页面里有一个**绝对地址**的 <base href="...">，让相对/根相对引用（图片、CSS、JS）
 * 都解析回 arxiv.org，本地 file:// 打开不裂图。
 * arXiv 的 HTML 自带 <base href="/html/xxx/">（根相对路径，本地解析不出来），改写成绝对地址；
 * 没有 <base> 就在 <head> 后注入一个。
 */
function injectBase(html, finalUrl) {
  const abs = finalUrl.endsWith('/') ? finalUrl : finalUrl + '/';
  const existing = html.match(/<base\s+[^>]*href="([^"]*)"[^>]*\/?>/i);
  if (existing) {
    const resolved = new URL(existing[1], abs).href;
    return html.replace(existing[0], () => existing[0].replace(existing[1], resolved));
  }
  const tag = `<base href="${abs}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

// ==================== HTML → Markdown ====================

/** 极简 HTML 实体解码（alttext 属性里只会出现这几类）。 */
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * arXiv 的 LaTeXML HTML → Markdown。
 * 公式先换成占位符（防止 turndown 把 LaTeX 里的 \ _ * 转义坏），转完再换回 $...$；
 * 图片/链接改成绝对地址（md 文件没有 <base> 可用）；只取 <article> 正文。
 */
async function htmlToMarkdown(html, finalUrl) {
  const { TurndownService, gfm } = await import('./vendor/turndown.bundle.mjs');
  // 相对地址的解析基准：优先用文档自带的 <base>（arXiv 用它指向带版本号的资源目录），没有才用最终 URL
  let baseAbs = finalUrl.endsWith('/') ? finalUrl : finalUrl + '/';
  const pageBase = html.match(/<base\s+[^>]*href="([^"]*)"/i);
  if (pageBase) {
    try {
      baseAbs = new URL(pageBase[1], baseAbs).href;
    } catch {}
  }

  const maths = [];
  let pre = html.replace(/<math\b([^>]*)>[\s\S]*?<\/math>/gi, (m, attrs) => {
    const alt = attrs.match(/alttext="([^"]*)"/);
    if (!alt) return '';
    const tex = decodeEntities(alt[1]);
    maths.push(/display="block"/.test(attrs) ? `\n$$${tex}$$\n` : `$${tex}$`);
    return `@@MATH${maths.length - 1}@@`;
  });

  pre = pre.replace(/(src|href)="([^"]*)"/gi, (m, attr, v) => {
    if (!v || /^(https?:|data:|#|mailto:)/i.test(v)) return m;
    try {
      return `${attr}="${new URL(v, baseAbs).href}"`;
    } catch {
      return m;
    }
  });

  const article = pre.match(/<article[\s\S]*<\/article>/i);
  if (article) pre = article[0];

  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);
  td.remove(['script', 'style', 'noscript']);
  const md = td.turndown(pre);

  return md.replace(/@@MATH(\d+)@@/g, (_, i) => maths[+i] ?? '') + '\n';
}

// ==================== 主流程 ====================

main().catch((e) => {
  fail({
    type: 'export',
    subtype: 'unexpected',
    message: e instanceof Error ? e.message : String(e),
    hint: '若像是偶发问题可直接重跑本命令。',
    retryable: true,
  });
});

async function main() {
  const dir = path.resolve(outDir, safeName);
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  let htmlMissing = false;

  if (!htmlOnly) {
    const pdf = await download(`https://arxiv.org/pdf/${id}`);
    if (!pdf) {
      fail({
        type: 'export',
        subtype: 'download_failed',
        message: `arXiv 上找不到 ${id} 的 PDF（404）。`,
        hint: '确认 ID 或链接是否正确（先在浏览器里打开试试）后重跑。',
      });
    }
    const p = path.join(dir, `${safeName}.pdf`);
    fs.writeFileSync(p, pdf.body);
    written.push(p);
  }

  if (!pdfOnly) {
    const html = await download(`https://arxiv.org/html/${id}`);
    // 部分论文的 /html/ 会被重定向到摘要页（/abs/），也视为没有 HTML 版
    const noHtml = !html || /arxiv\.org\/abs\//i.test(html.finalUrl);
    if (noHtml) {
      if (htmlOnly) {
        fail({
          type: 'export',
          subtype: 'download_failed',
          message: `该论文没有 HTML 版（arXiv 只为有 LaTeX 源且转换成功的论文提供 HTML）。`,
          hint: '去掉 --html-only 重跑，改下载 PDF。',
        });
      }
      htmlMissing = true;
    } else {
      const raw = html.body.toString('utf8');
      const p = path.join(dir, `${safeName}.html`);
      fs.writeFileSync(p, injectBase(raw, html.finalUrl));
      written.push(p);

      // 顺带把 HTML 转一份 Markdown（转换失败不影响 PDF/HTML 产物）
      try {
        const mdPath = path.join(dir, `${safeName}.md`);
        fs.writeFileSync(mdPath, await htmlToMarkdown(raw, html.finalUrl));
        written.push(mdPath);
      } catch (e) {
        console.error(`ℹ Markdown 转换失败（${e instanceof Error ? e.message : e}），PDF/HTML 不受影响。`);
      }
    }
  }

  console.log(`✓ 已导出到 ${dir}`);
  for (const p of written) console.log(`   - ${path.join(safeName, path.basename(p))}`);
  if (htmlMissing) {
    console.error('ℹ 该论文没有 HTML 版（arXiv 只为有 LaTeX 源且转换成功的论文提供 HTML），仅保存了 PDF。');
  }
}
