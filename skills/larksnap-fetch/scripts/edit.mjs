#!/usr/bin/env node
// larksnap-edit CLI —— 在 CC 里把 Markdown 内容写进一篇飞书文档（用户在浏览器里有编辑权限）。
//
// 原理见 docs/plans/2026-07-07-飞书文档编辑.md 路线 C：扩展在后台标签页里"像用户一样"
// 把内容粘贴进飞书编辑器，协同保存由飞书前端自己完成，我们不碰协同协议。
//
// 用法（写入内容一律走 md 文件，不走命令行参数，避免转义和长度问题）：
//   node edit.mjs <链接> append <md文件>
//   node edit.mjs <链接> insert-after "<标题文本>" <md文件>
//   node edit.mjs <链接> list-blocks                         # 只读，块清单 JSON 打到 stdout
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
const FLAGS_WITH_VALUE = new Set(['--profile', '--expect', '--expect-first']);
// 默认走纯文本 Markdown 口味粘贴（飞书自己解析转块：表格转原生简单表格而非
// 异步提交的内嵌电子表格，代码块注释行也不会被误判成标题）。
// --html-paste：退回 HTML 口味粘贴（万一某租户不支持 md 粘贴解析时用）。
const FLAGS_BOOL = new Set(['--md-paste', '--html-paste']);
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

const USAGE_HINT = [
  '用法: edit.mjs <链接> append <md文件>',
  '     edit.mjs <链接> insert-after "<标题文本>" <md文件>',
  '     edit.mjs <链接> list-blocks',
  '     edit.mjs <链接> replace-block <块ID> <md文件> --expect "<内容摘要>"',
  '     edit.mjs <链接> delete-block <块ID> --expect "<内容摘要>"',
  '     edit.mjs <链接> insert-after-block <块ID> <md文件>',
  '     edit.mjs <链接> replace-all <md文件> --expect-first "<首块内容摘要>"',
].join('\n  ');

function usage(message) {
  fail({ type: 'usage', subtype: 'bad_args', message, hint: USAGE_HINT });
}

const [url, op] = positionals;
if (!url || !op) usage('缺少参数：需要 <链接> 和 <操作>。');

// 各操作的定位参数与内容文件；anchor 是发给扩展的定位信息
// expectSummary: replace/delete 的防呆——扩展执行前比对目标块当前内容，对不上报 block_changed
let anchor = null;
let mdFile = null;
switch (op) {
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
  await ensureDaemon(DAEMON_PATH, fail);
  await postCommand(
    {
      url,
      kind: 'edit',
      op,
      contentMd: contentMd || undefined,
      anchor: anchor || undefined,
      opts: { mdPaste: !flags['--html-paste'] },
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
      if (op === 'list-blocks') {
        // 块清单 JSON 打到 stdout（供 CC 解析定位目标块）
        console.log(JSON.stringify({ ok: true, blocks: msg.blocks || [] }, null, 2));
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
