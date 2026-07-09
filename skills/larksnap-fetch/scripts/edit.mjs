#!/usr/bin/env node
// larksnap-edit CLI —— 在 CC 里把 Markdown 内容写进一篇飞书文档（用户在浏览器里有编辑权限）。
//
// 原理见 docs/plans/2026-07-07-飞书文档编辑.md 路线 C：扩展在后台标签页里"像用户一样"
// 把内容粘贴进飞书编辑器，协同保存由飞书前端自己完成，我们不碰协同协议。
//
// 用法（写入内容一律走 md 文件，不走命令行参数，避免转义和长度问题）：
//   node edit.mjs <链接> new-doc [<md文件>] --name "<标题>"   # 新建文档，<链接>只用来定位租户
//   node edit.mjs <链接> append <md文件>
//   node edit.mjs <链接> insert-after "<标题文本>" <md文件>
//   node edit.mjs <链接> list-blocks                         # 只读，块清单 JSON 打到 stdout
//   node edit.mjs <链接> find-blocks "<关键词>" [--regex] [--type <类型前缀>] [--limit N]
//                                                            # 只读，按内容检索块（长文档定位用）
//   node edit.mjs <链接> replace-block <块ID> <md文件> --expect "<内容摘要>"
//   node edit.mjs <链接> delete-block <块ID> --expect "<内容摘要>"
//   node edit.mjs <链接> insert-after-block <块ID> <md文件>
//   node edit.mjs <链接> replace-all <md文件> --expect-first "<首块内容摘要>"   # 危险：整篇正文替换
// 通用旗标: --profile <code> 指定浏览器 profile（多 profile 时路由用）
//
// 退出码: 0 成功 | 1 失败 | 2 用法错 | 3 需登录 | 4 需授权域名 | 5 桥接未就绪 | 6 需编辑权限
// 错误契约: 非 0 退出时 stderr 最后一行是一行 JSON（与 fetch.mjs 完全一致），供 AI 解析分支。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail as baseFail, ensureDaemon, postCommand, ERROR_KINDS } from './bridge/client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = path.resolve(__dirname, 'bridge/daemon.mjs');

// 编辑专属退出码（其余沿用 client.mjs 的 BASE_EXIT_CODES）
const EDIT_EXIT_CODES = { need_edit_permission: 6, need_edit_grant: 7 };
const fail = (err) => baseFail(err, EDIT_EXIT_CODES);

// 编辑专属错误分类：扩展回传 error 的 subtype → type/hint/retryable
const EDIT_ERROR_KINDS = {
  anchor_not_found: {
    type: 'edit',
    hint: '标题按文本精确匹配。先跑 list-blocks 查看文档结构，确认标题文本后重试。',
    retryable: false,
  },
  anchor_ambiguous: {
    type: 'edit',
    hint: '文档里有多个同名标题。改用 list-blocks 拿到目标块 ID，用 insert-after-block 精确定位。',
    retryable: false,
  },
  block_not_found: {
    type: 'edit',
    hint: '目标块可能已被删除或 ID 传错。重新跑 list-blocks 获取最新块清单后重试。',
    retryable: false,
  },
  block_changed: {
    type: 'edit',
    hint: '文档在 list-blocks 之后被修改过（可能有人在编辑）。重新跑 list-blocks 核对内容后重试。',
    retryable: false,
  },
  save_unconfirmed: {
    type: 'edit',
    hint: '内容可能已写入但未确认保存成功。让用户打开文档人工检查，勿盲目重试（可能写入两次）。',
    retryable: false,
  },
};

// ==================== 参数解析 ====================

const argv = process.argv.slice(2);

// USAGE_HINT 必须先于解析循环定义：循环里遇到未知旗标就会调 usage()
const USAGE_HINT = [
  '用法: edit.mjs <链接> new-doc [<md文件>] --name "<标题>"',
  '     edit.mjs <链接> append <md文件>',
  '     edit.mjs <链接> insert-after "<标题文本>" <md文件>',
  '     edit.mjs <链接> list-blocks',
  '     edit.mjs <链接> find-blocks "<关键词>" [--regex] [--type <类型前缀>] [--limit N]',
  '     edit.mjs <链接> replace-block <块ID> <md文件> --expect "<内容摘要>"',
  '     edit.mjs <链接> delete-block <块ID> --expect "<内容摘要>"',
  '     edit.mjs <链接> insert-after-block <块ID> <md文件>',
  '     edit.mjs <链接> replace-all <md文件> --expect-first "<首块内容摘要>"',
].join('\n  ');

function usage(message) {
  fail({ type: 'usage', subtype: 'bad_args', message, hint: USAGE_HINT });
}

const FLAGS_WITH_VALUE = new Set(['--profile', '--expect', '--expect-first', '--type', '--limit', '--name']);
// 默认走纯文本 Markdown 口味粘贴（飞书自己解析转块：表格转原生简单表格而非
// 异步提交的内嵌电子表格，代码块注释行也不会被误判成标题）。
// --html-paste：退回 HTML 口味粘贴（万一某租户不支持 md 粘贴解析时用）。
const FLAGS_BOOL = new Set(['--md-paste', '--html-paste', '--regex']);
const flags = {};
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    if (FLAGS_BOOL.has(argv[i])) {
      flags[argv[i]] = true;
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(argv[i])) usage(`未知旗标: ${argv[i]}`);
    flags[argv[i]] = argv[++i];
    continue;
  }
  positionals.push(argv[i]);
}

const [url, op] = positionals;
if (!url || !op) usage('缺少参数：需要 <链接> 和 <操作>。');

// 各操作的定位参数与内容文件；anchor 是发给扩展的定位信息
// expectSummary: replace/delete 的防呆——扩展执行前比对目标块当前内容，对不上报 block_changed
let anchor = null;
let mdFile = null;
switch (op) {
  case 'new-doc':
    // 新建文档：<链接> 只用来定位在哪个租户/域名下建（网盘首页或任意文档都行）。
    // <md文件> 可选，作为新文档初始内容；不给就建一篇空文档。--name 设标题。
    mdFile = positionals[2] || null;
    anchor = flags['--name'] ? { name: flags['--name'] } : null;
    break;
  case 'append':
    mdFile = positionals[2];
    if (!mdFile) usage('append 需要 <md文件>。');
    break;
  case 'insert-after':
    if (!positionals[2] || !positionals[3]) usage('insert-after 需要 "<标题文本>" 和 <md文件>。');
    anchor = { heading: positionals[2] };
    mdFile = positionals[3];
    break;
  case 'list-blocks':
  case 'probe': // 隐藏命令（开发/实验用）：收集编辑器 DOM 形态，JSON 打到 stdout
    break;
  case 'find-blocks': {
    // 只读检索：在块的完整纯文本上匹配（解决 list-blocks 摘要 80 字盲区 + 长文档全量输出太贵）。
    // 要搜以 -- 开头的内容，用 --regex 加转义绕过参数解析。
    const query = positionals[2];
    if (!query) usage('find-blocks 需要 "<关键词>"。');
    if (flags['--regex']) {
      // 预检旗标必须与扩展端执行完全一致（iu）：u 旗标下未转义的 { 、孤立的 \p 等都是语法错
      try {
        new RegExp(query, 'iu');
      } catch (e) {
        usage(`正则语法错误: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (!query.replace(/\s+/g, '')) {
      // 纯空白关键词归一化后是空串，空串子串匹配会命中所有块
      usage('find-blocks 的关键词去掉空白后不能为空。');
    }
    let limit;
    if (flags['--limit'] !== undefined) {
      limit = Number(flags['--limit']);
      if (!Number.isInteger(limit) || limit <= 0) usage('--limit 必须是正整数。');
    }
    anchor = {
      query,
      regex: flags['--regex'] || undefined,
      typeFilter: flags['--type'] || undefined,
      limit,
    };
    break;
  }
  case 'replace-block':
    if (!positionals[2] || !positionals[3]) usage('replace-block 需要 <块ID> 和 <md文件>。');
    if (!flags['--expect']) usage('replace-block 必须带 --expect "<内容摘要>"（取自 list-blocks 输出的 summary，防止改错块）。');
    anchor = { blockId: positionals[2], expectSummary: flags['--expect'] };
    mdFile = positionals[3];
    break;
  case 'delete-block':
    if (!positionals[2]) usage('delete-block 需要 <块ID>。');
    if (!flags['--expect']) usage('delete-block 必须带 --expect "<内容摘要>"（取自 list-blocks 输出的 summary，防止删错块）。');
    anchor = { blockId: positionals[2], expectSummary: flags['--expect'] };
    break;
  case 'insert-after-block':
    if (!positionals[2] || !positionals[3]) usage('insert-after-block 需要 <块ID> 和 <md文件>。');
    anchor = { blockId: positionals[2] };
    mdFile = positionals[3];
    break;
  case 'replace-all':
    // 整篇正文替换（最危险的操作）：--expect-first 必带，扩展执行前比对当前文档
    // 首块内容，对不上报 block_changed，防止把别人刚改过的文档洗掉
    mdFile = positionals[2];
    if (!mdFile) usage('replace-all 需要 <md文件>。');
    if (!flags['--expect-first'])
      usage('replace-all 必须带 --expect-first "<首块内容摘要>"（取自 list-blocks 输出第一个块的 summary，防止洗错文档）。');
    anchor = { expectSummary: flags['--expect-first'] };
    break;
  default:
    usage(`不认识的操作「${op}」。`);
}

// 读取写入内容（daemon body 上限 4MB，留余量）
let contentMd = null;
if (mdFile) {
  try {
    contentMd = fs.readFileSync(mdFile, 'utf8');
  } catch (e) {
    usage(`读取 md 文件失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!contentMd.trim()) usage(`md 文件是空的: ${mdFile}`);
  if (Buffer.byteLength(contentMd) > 2 * 1024 * 1024) {
    usage('md 文件超过 2MB，请拆分内容分批写入。');
  }
}

// ==================== 图片内嵌（实验 I1/I2 结论，2026-07-08） ====================
// 飞书只认「HTML 粘贴里的 data URI 图片」（转成 image 块并上传）；md 文本粘贴里的
// 图片留成字面文本，HTML 粘贴里的外链图片被整个丢弃。所以：
//   本地路径 / 外链 → 这里统一转成 data URI 内嵌，并强制该次写入走 HTML 粘贴。
// 代码围栏里的图片语法是示例代码，不动。

// 只收实测飞书粘贴接受的格式（2026-07-08 iflytek 实测：png/jpg/gif/webp/bmp 转成
// image 块；svg/ico 被静默丢弃——静默丢图不如在这里直接报错）
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
};

/** 把 md 里的本地/外链图片转成 data URI；返回 { md, embedded } */
async function embedImages(md, baseDir) {
  const imgRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const lines = md.split('\n');
  let inFence = false;
  let embedded = 0;
  const out = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || !line.includes('![')) {
      out.push(line);
      continue;
    }
    // 行内代码 span 的范围（`![](图片)` 这种示例不是真图片引用，和围栏同理不动）
    const codeSpans = [...line.matchAll(/`[^`]*`/g)].map((c) => [c.index, c.index + c[0].length]);
    const inCode = (i) => codeSpans.some(([s, e]) => i >= s && i < e);
    // 逐个替换本行的图片引用（串行 await，图片通常不多）
    let result = '';
    let last = 0;
    for (const m of line.matchAll(imgRe)) {
      const [full, alt, src] = m;
      result += line.slice(last, m.index);
      last = m.index + full.length;
      if (src.startsWith('data:') || inCode(m.index)) {
        result += full; // 已是内嵌 / 行内代码里的示例，原样保留
        continue;
      }
      const { mime, buf } = await loadImage(src, baseDir);
      embedded++;
      result += `![${alt}](data:${mime};base64,${buf.toString('base64')})`;
    }
    result += line.slice(last);
    out.push(result);
  }
  return { md: out.join('\n'), embedded };
}

/** 读一张图片：外链下载 / 本地文件读取（相对路径以 md 文件所在目录为基准） */
async function loadImage(src, baseDir) {
  if (/^https?:\/\//i.test(src)) {
    let res;
    try {
      res = await fetch(src, { signal: AbortSignal.timeout(20000) });
    } catch (e) {
      fail({
        type: 'edit', subtype: 'image_fetch_failed',
        message: `外链图片下载失败: ${src}（${e instanceof Error ? e.message : String(e)}）`,
        hint: '确认外链可访问，或先手工下载图片改用本地路径。', retryable: true,
      });
    }
    if (!res.ok) {
      fail({
        type: 'edit', subtype: 'image_fetch_failed',
        message: `外链图片下载失败: ${src}（HTTP ${res.status}）`,
        hint: '确认外链可访问，或先手工下载图片改用本地路径。', retryable: true,
      });
    }
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    const allowed = new Set(Object.values(IMAGE_MIME));
    const extMime = IMAGE_MIME[src.split('?')[0].split('.').pop()?.toLowerCase() ?? ''];
    const mime = allowed.has(ct) ? ct : extMime;
    if (!mime) {
      const kind = ct.startsWith('image/') ? 'image_unsupported' : 'image_fetch_failed';
      fail({
        type: 'edit', subtype: kind,
        message: kind === 'image_unsupported'
          ? `外链图片格式飞书不接受: ${src}（${ct}）`
          : `外链不是图片: ${src}（content-type: ${ct || '未知'}）`,
        hint: kind === 'image_unsupported'
          ? `支持: ${Object.keys(IMAGE_MIME).join(' / ')}（svg/ico 飞书粘贴会静默丢弃）。请先转换格式。`
          : '确认链接指向图片文件本身，不是网页。',
        retryable: false,
      });
    }
    return { mime, buf };
  }
  const p = path.resolve(baseDir, decodeURI(src));
  const mime = IMAGE_MIME[p.split('.').pop()?.toLowerCase() ?? ''];
  if (!mime) {
    fail({
      type: 'edit', subtype: 'image_unsupported',
      message: `不支持的图片格式: ${src}`,
      hint: `支持: ${Object.keys(IMAGE_MIME).join(' / ')}。`, retryable: false,
    });
  }
  try {
    return { mime, buf: fs.readFileSync(p) };
  } catch {
    fail({
      type: 'edit', subtype: 'image_not_found',
      message: `本地图片不存在: ${p}（相对路径以 md 文件所在目录为基准）`,
      hint: '检查图片路径；相对路径相对于 md 文件所在目录解析。', retryable: false,
    });
  }
}

// ==================== 主流程 ====================

main().catch((e) => {
  fail({
    type: 'edit',
    subtype: 'unexpected',
    message: e instanceof Error ? e.message : String(e),
    hint: '查看 ~/.larksnap/daemon.log 排查；若像是偶发问题可直接重跑本命令。',
    retryable: true,
  });
});

async function main() {
  let mdPaste = !flags['--html-paste'];
  if (contentMd && /!\[[^\]]*\]\(/.test(contentMd)) {
    const { md, embedded } = await embedImages(contentMd, path.dirname(path.resolve(mdFile)));
    contentMd = md;
    if (embedded > 0 || /!\[[^\]]*\]\(data:/.test(contentMd)) {
      // 含图片的写入只能走 HTML 粘贴（md 文本粘贴丢图，实验 I2 结论）
      mdPaste = false;
      process.stderr.write(`… 已内嵌 ${embedded} 张图片，本次写入走 HTML 粘贴口味\n`);
    }
    if (Buffer.byteLength(contentMd) > 2 * 1024 * 1024) {
      fail({
        type: 'edit', subtype: 'image_too_large',
        message: '图片内嵌后内容超过 2MB 上限。',
        hint: '压缩图片，或把内容拆成多次写入（每次带更少的图片）。', retryable: false,
      });
    }
  }
  await ensureDaemon(DAEMON_PATH, fail);
  await postCommand(
    {
      url,
      kind: 'edit',
      op,
      contentMd: contentMd || undefined,
      anchor: anchor || undefined,
      opts: { mdPaste },
      contextId: flags['--profile'] || undefined,
    },
    handleLine,
    fail
  );
}

/** 处理一行 NDJSON；返回 0 表示成功终结，返回 null 表示继续；错误走 fail() 直接退出。 */
function handleLine(msg) {
  switch (msg.type) {
    case 'progress':
      process.stderr.write(
        `… ${msg.message || ''}${msg.percent != null ? ` (${msg.percent}%)` : ''}\n`
      );
      return null;
    case 'need-login':
      fail({
        type: 'authentication',
        subtype: 'need_login',
        message: '需要登录：浏览器里没有该域名的飞书登录态。',
        hint: '让用户在 Chrome 中打开该文档域名并登录飞书，登录完成后重跑本命令。',
      });
      return null;
    case 'need-auth':
      fail({
        type: 'authentication',
        subtype: 'need_domain_auth',
        message: `需要授权域名 ${msg.host || ''}（域名权限需用户手势授权，无法自动完成）。`,
        hint: '让用户打开该域名下任意飞书页面 → 点扩展图标打开侧边栏 → 点「授权该域名」，完成后重跑本命令。',
      });
      return null;
    case 'need-edit-grant':
      fail({
        type: 'authorization',
        subtype: 'need_edit_grant',
        message: '编辑功能不可用：扩展缺少调试权限（debugger），可能安装的是不带编辑功能的旧版本。',
        hint: '让用户在 chrome://extensions 更新/重新加载 LarkSnap 扩展到带编辑功能的版本，完成后重跑本命令。',
      });
      return null;
    case 'need-edit-permission':
      fail({
        type: 'authorization',
        subtype: 'need_edit_permission',
        message: '已登录但对该文档只读，无法编辑。',
        hint: '让用户在浏览器里打开该文档确认/申请编辑权限，拿到权限后重跑本命令。',
      });
      return null;
    case 'error': {
      const kind = EDIT_ERROR_KINDS[msg.subtype] || ERROR_KINDS[msg.subtype] || {
        type: 'edit',
        hint: '若提示扩展断开/Service Worker 休眠，点一下扩展图标唤醒后重跑本命令；其余情况查看 ~/.larksnap/daemon.log。',
        retryable: true,
      };
      fail({
        type: kind.type,
        subtype: msg.subtype || 'edit_failed',
        message: msg.message || '编辑失败（未知错误）',
        hint: kind.hint,
        retryable: kind.retryable,
      });
      return null;
    }
    case 'result': {
      if (op === 'new-doc') {
        // 新文档地址打到 stdout（JSON，供 CC 接着 fetch / 继续编辑）
        console.log(
          JSON.stringify({ ok: true, url: msg.url ?? null, message: msg.message ?? '' }, null, 2)
        );
        return 0;
      }
      if (op === 'list-blocks') {
        // 块清单 JSON 打到 stdout（供 CC 解析定位目标块）
        console.log(JSON.stringify({ ok: true, blocks: msg.blocks || [] }, null, 2));
        return 0;
      }
      if (op === 'find-blocks') {
        // 命中块 JSON 打到 stdout；total > shown 说明被 --limit 截断，还有没展示的命中
        console.log(
          JSON.stringify(
            { ok: true, total: msg.total ?? 0, shown: msg.shown ?? 0, blocks: msg.blocks || [] },
            null,
            2
          )
        );
        return 0;
      }
      if (op === 'probe') {
        console.log(JSON.stringify({ ok: true, probe: msg.probe || null }, null, 2));
        return 0;
      }
      console.log(`✓ ${msg.message || '编辑完成，已通过回读校验。'}`);
      return 0;
    }
    default:
      return null;
  }
}
