#!/usr/bin/env node
// larksnap-search CLI —— 在 CC 里用「用户自己的浏览器」跑一次搜索，把结果拿回来。
//
// 不买检索 API：后台开搜索引擎结果页 → 扩展解析条目 → 结构化 JSON 回到 stdout。
// 用的是用户已登录的真实浏览器，等于替他按了一次搜索按钮。
//
//   CC ──search.mjs──HTTP /command──▶ daemon ──WS──▶ 扩展 ──后台标签页──▶ 搜索引擎
//
// 一次任务只跑一个引擎、只取第一页。**换引擎降级在本文件里做**（连发多次任务），
// 扩展侧永远只管「打开这一个页面、解析、回结果」。
//
// 用法:  node search.mjs "<关键词>" [--engine auto|bing|google|ddg] [--count 10]
//                                   [--out <文件>] [--md] [--profile <code>]
// 退出码: 0 成功（含「没搜到」）| 1 失败/被拦 | 2 用法错 | 4 需授权域名 | 5 桥接未就绪
// 错误契约: 非 0 退出时 stderr 最后一行是一行 JSON，供 AI 解析分支。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, ensureDaemon, tryCommand, ERROR_KINDS } from './bridge/client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = path.resolve(__dirname, 'bridge/daemon.mjs');

// auto 的顺序：Bing 打头是因为它几乎不弹验证码、结构最稳、不要登录态，一次就中的概率最高；
// Google 结果更好但最容易撞人机验证，排第二；DDG 兜底。
const AUTO_ORDER = ['bing', 'google', 'ddg'];
const ENGINE_LABEL = { bing: 'Bing', google: 'Google', ddg: 'DuckDuckGo' };
const ENGINE_HOST = { bing: 'www.bing.com', google: 'www.google.com', ddg: 'duckduckgo.com' };
const EXTRA_EXIT = { engine_unsupported: 2 };

const argv = process.argv.slice(2);
function flag(name, def = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
function has(name) {
  return argv.indexOf(name) >= 0;
}
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--md') continue; // 无值开关
  if (argv[i].startsWith('--')) {
    i++; // 跳过其值
    continue;
  }
  positionals.push(argv[i]);
}
const query = (positionals[0] || '').trim();
const engineArg = (flag('--engine', 'auto') || 'auto').toLowerCase();
const count = Math.max(1, Math.min(Number(flag('--count', '10')) || 10, 20));
const outFile = flag('--out', null);
const asMarkdown = has('--md');
const profile = flag('--profile', null);

const failWith = (e) => fail(e, EXTRA_EXIT);

if (!query) {
  failWith({
    type: 'usage',
    subtype: 'bad_args',
    message: '缺少参数：需要 <关键词>。',
    hint: '用法: search.mjs "<关键词>" [--engine auto|bing|google|ddg] [--count 10] [--out <文件>] [--md]',
  });
}
if (engineArg !== 'auto' && !ENGINE_LABEL[engineArg]) {
  failWith({
    type: 'usage',
    subtype: 'engine_unsupported',
    message: `不认识的搜索引擎: ${engineArg}`,
    hint: '可选值: auto（默认，bing→google→ddg 依次试）| bing | google | ddg。',
  });
}

main().catch((e) => {
  failWith({
    type: 'search',
    subtype: 'unexpected',
    message: e instanceof Error ? e.message : String(e),
    hint: '查看 ~/.larksnap/daemon.log 排查；偶发问题可直接重跑本命令。',
    retryable: true,
  });
});

// 换引擎也救不了的错：立刻整体失败，别白白再开两个标签页
const HARD_ERRORS = new Set([
  'engine_unsupported',
  'extension_outdated',
  'extension_not_connected',
  'extension_timeout',
  'profile_not_found',
  'profile_ambiguous',
  'signature_invalid',
]);

async function main() {
  await ensureDaemon(DAEMON_PATH, failWith);
  const engines = engineArg === 'auto' ? AUTO_ORDER : [engineArg];
  const tried = [];
  for (const engine of engines) {
    process.stderr.write(`… 用 ${ENGINE_LABEL[engine]} 搜索…\n`);
    const r = await tryCommand(
      {
        kind: 'search',
        search: { engine, query, limit: count },
        opts: {},
        contextId: profile || undefined,
      },
      makeHandler(engine),
      failWith
    );
    tried.push({ engine, ...r });
    if (r.status === 'ok' && r.results.length > 0) return output(engine, r.results);
    // empty / blocked / need_auth / 软错误 → 还有下一家就继续试
    if (r.note) process.stderr.write(`… ${ENGINE_LABEL[engine]}: ${r.note}\n`);
  }

  // 全试完都没结果，按最值得报的原因收口
  const needAuth = tried.filter((t) => t.status === 'need_auth');
  if (needAuth.length === tried.length) {
    const hosts = needAuth.map((t) => ENGINE_HOST[t.engine]).join(' / ');
    failWith({
      type: 'authentication',
      subtype: 'need_domain_auth',
      message: `需要授权搜索引擎域名（${hosts}）——域名权限必须用户手势授权，无法自动完成。`,
      hint:
        '让用户点扩展图标打开侧边栏 → 点截图工具那里的「授权访问所有网站」一次性授权（推荐，' +
        '这样搜到的链接后续也能直接用 fetch.mjs 抓正文）；或在浏览器里打开一次该搜索引擎再单独授权该域名。',
    });
  }
  const blocked = tried.find((t) => t.status === 'blocked');
  if (blocked) {
    failWith({
      type: 'search',
      subtype: 'search_blocked',
      message: `搜索被拦：${ENGINE_LABEL[blocked.engine]} ${blocked.note || '要求人机验证'}。`,
      hint: `让用户在 Chrome 里手动打开一次 https://${ENGINE_HOST[blocked.engine]}/ 完成验证（用的是他自己的 profile，过一次 cookie 就留住了），然后重跑本命令；或改用 --engine 换一家。`,
      retryable: true,
    });
  }
  const softErr = tried.find((t) => t.status === 'error');
  if (softErr) {
    const kind = ERROR_KINDS[softErr.subtype] || { type: 'search', retryable: true };
    failWith({
      type: kind.type || 'search',
      subtype: softErr.subtype || 'search_failed',
      message: softErr.message || '搜索失败（未知错误）',
      hint: kind.hint || '查看 ~/.larksnap/daemon.log 排查后重跑本命令。',
      retryable: kind.retryable ?? true,
    });
  }
  // 真的没搜到 —— 这是正常结果，不是故障：退出码 0
  return output(tried[tried.length - 1].engine, []);
}

/** 处理一行 NDJSON；返回 null 继续，返回对象即终结本次任务（由 main 决定要不要换引擎）。 */
function makeHandler(engine) {
  return (msg) => {
    switch (msg.type) {
      case 'progress':
        process.stderr.write(`… ${msg.message || ''}\n`);
        return null;
      case 'need-auth':
        return { status: 'need_auth', results: [], host: msg.host || ENGINE_HOST[engine] };
      case 'need-login':
        return { status: 'blocked', results: [], note: '该引擎要求登录' };
      case 'error': {
        if (HARD_ERRORS.has(msg.subtype)) {
          const kind = ERROR_KINDS[msg.subtype] || { type: 'search', retryable: false };
          failWith({
            type: kind.type || 'search',
            subtype: msg.subtype,
            message: msg.message || '搜索失败',
            hint: kind.hint,
            retryable: kind.retryable ?? false,
          });
        }
        return { status: 'error', results: [], subtype: msg.subtype, message: msg.message };
      }
      case 'result': {
        const s = msg.search || {};
        return { status: s.status || 'empty', results: s.results || [], note: s.note };
      }
      default:
        return null;
    }
  };
}

function toMarkdown(engine, results) {
  if (results.length === 0) return `没搜到「${query}」的结果（${ENGINE_LABEL[engine]}）。`;
  const lines = [`## 「${query}」搜索结果（${ENGINE_LABEL[engine]}，${results.length} 条）`, ''];
  for (const r of results) {
    lines.push(`${r.rank}. [${r.title}](${r.url}) \`${r.site}\``);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  }
  return lines.join('\n');
}

/** stdout 一行 JSON（默认）或 Markdown；--out 落盘并回一行 JSON 摘要。不返回。 */
function output(engine, results) {
  const payload = { ok: true, engine, query, count: results.length, results };
  const text = asMarkdown ? toMarkdown(engine, results) : JSON.stringify(payload);
  if (outFile) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(path.resolve(outFile), text + (asMarkdown ? '\n' : ''));
    } catch (e) {
      failWith({
        type: 'search',
        subtype: 'write_failed',
        message: `写入失败: ${e instanceof Error ? e.message : String(e)}`,
        hint: '检查输出路径可写、磁盘空间充足后重跑本命令。',
      });
    }
    console.log(JSON.stringify({ ...payload, out: path.resolve(outFile) }));
  } else {
    console.log(text);
  }
  process.exit(0);
}
