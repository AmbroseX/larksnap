#!/usr/bin/env node
// larksnap-fetch CLI —— 在 CC 里把一个飞书文档链接抓到本地目录。
//
// 自包含的全局技能：daemon/protocol 随技能一起分发（见 ./bridge/），
// 不依赖任何特定仓库的目录结构，因此可从任意项目调用。
//
// 一次性进程：确保 daemon 在跑（探 /ping，没起就 detached 拉起一个，复用 OpenCLI 思路）
// → POST /command 拿流式 NDJSON（进度/结果）→ 把产物（zip 解包 / 单文件）写到输出目录。
//
// 用法:  node fetch.mjs <飞书链接> <输出目录> [--format md|pdf|html] [--profile <code>]
// 退出码: 0 成功 | 1 失败 | 2 用法错 | 3 需登录 | 4 需授权域名 | 5 桥接未就绪
// 错误契约: 非 0 退出时 stderr 最后一行是一行 JSON（见下方 fail()），供 AI 解析分支。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipInto, writeDataUrl } from './unzip.mjs';
import {
  HOST,
  PORT,
  AUTH_HEADER,
  SIG_HEADER,
  HOME_DIR,
  DAEMON_VERSION,
  loadOrCreateSecret,
  makeSigHeader,
} from './bridge/protocol.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// daemon 随技能自包含分发：scripts/ 下的 bridge/daemon.mjs（与本仓库根的 bridge/ 解耦）。
const DAEMON_PATH = path.resolve(__dirname, 'bridge/daemon.mjs');

const argv = process.argv.slice(2);
function flag(name, def = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    i++; // 跳过其值
    continue;
  }
  positionals.push(argv[i]);
}
const url = positionals[0];
const outDir = positionals[1];
const format = (flag('--format', 'md') || 'md').toLowerCase();
const profile = flag('--profile', null); // 指定浏览器 profile（多 profile 时路由用）

// ==================== 错误契约 ====================
// 错误退出前，stderr 先打给人读的散文，最后一行是一行 JSON（机器可读）：
//   {"ok":false,"error":{"type","subtype","message","hint","retryable"}}
// AI 按 type/subtype 分支决定下一步，不解析散文。退出码由 subtype 派生，不手写。
const EXIT_CODES = {
  bad_args: 2,
  profile_not_found: 2,
  profile_ambiguous: 2,
  need_login: 3,
  need_domain_auth: 4,
  daemon_missing: 5,
  daemon_spawn_failed: 5,
  daemon_timeout: 5,
  bridge_request_failed: 5,
  extension_not_connected: 5,
  signature_invalid: 5,
  // 其余（export_failed / write_failed / no_result / unexpected）→ 1
};

/** 打印散文 + 一行 JSON 到 stderr，按 subtype 派生退出码退出。不返回。 */
function fail({ type, subtype, message, hint, retryable = false }) {
  console.error('✗', message);
  if (hint) console.error('  →', hint);
  console.error(JSON.stringify({ ok: false, error: { type, subtype, message, hint, retryable } }));
  process.exit(EXIT_CODES[subtype] ?? 1);
}

if (!url || !outDir) {
  fail({
    type: 'usage',
    subtype: 'bad_args',
    message: '缺少参数：需要 <飞书链接> 和 <输出目录>。',
    hint: '用法: fetch.mjs <飞书链接> <输出目录> [--format md|pdf|html] [--profile <code>]',
  });
}

// HMAC 共享 key（首个需要方生成；放在用法校验之后，纯用法错不碰文件系统）
const SECRET = loadOrCreateSecret();

main().catch((e) => {
  fail({
    type: 'export',
    subtype: 'unexpected',
    message: e instanceof Error ? e.message : String(e),
    hint: '查看 ~/.larksnap/daemon.log 排查；若像是偶发问题可直接重跑本命令。',
    retryable: true,
  });
});

async function main() {
  await ensureDaemon();
  await runCommand();
}

// ==================== 确保 daemon 在跑（且版本匹配）====================

/** 探活：返回 daemon 版本号（string），未运行返回 null。 */
function ping(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: '/ping', timeout: timeoutMs },
      (res) => {
        let acc = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (acc += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(acc).daemonVersion || 'unknown');
          } catch {
            resolve('unknown');
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** 让在跑的 daemon 退出（对方已死也算成功）。 */
function shutdownDaemon() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: '/shutdown',
        method: 'POST',
        headers: { [AUTH_HEADER]: '1', [SIG_HEADER]: makeSigHeader(SECRET, 'POST', '/shutdown', '') },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', () => resolve());
    req.end();
  });
}

// 拉起锁：防两个 CLI 同时冷启动时拉起两个 daemon（daemon 抢端口失败会自退，这里消掉窗口）
const SPAWN_LOCK = path.join(HOME_DIR, 'spawn.lock');
function acquireSpawnLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(SPAWN_LOCK); // 原子：已存在则抛
      return true;
    } catch {
      try {
        const st = fs.statSync(SPAWN_LOCK);
        if (Date.now() - st.mtimeMs > 15000) {
          fs.rmdirSync(SPAWN_LOCK); // 陈旧锁（上次异常残留）→ 清掉重试
          continue;
        }
      } catch {
        continue; // 锁刚被释放 → 重试
      }
      return false; // 别人正在拉起
    }
  }
  return false;
}
function releaseSpawnLock() {
  try {
    fs.rmdirSync(SPAWN_LOCK);
  } catch {
    /* 忽略 */
  }
}

async function ensureDaemon() {
  const alive = await ping();
  if (alive === DAEMON_VERSION) return;
  if (alive) {
    // 版本漂移自愈：在跑的是别处旧技能的 daemon → 重启到本技能这份
    process.stderr.write(`… daemon v${alive} 与本技能 v${DAEMON_VERSION} 不一致，自动重启\n`);
    await shutdownDaemon();
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      if (!(await ping())) break;
    }
  }
  if (!fs.existsSync(DAEMON_PATH)) {
    fail({
      type: 'bridge',
      subtype: 'daemon_missing',
      message: `找不到 daemon: ${DAEMON_PATH}`,
      hint: '技能文件不完整，重新安装 larksnap-fetch 技能目录（含 scripts/bridge/）后重试。',
    });
  }
  const locked = acquireSpawnLock();
  try {
    // 拿到锁才拉起；没拿到说明另一个 CLI 正在拉，直接进入下面的等待
    if (locked && !(await ping())) {
      try {
        const child = spawn(process.execPath, [DAEMON_PATH], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (e) {
        releaseSpawnLock(); // fail 直接退出不走 finally，先释放
        fail({
          type: 'bridge',
          subtype: 'daemon_spawn_failed',
          message: `无法拉起 daemon: ${e instanceof Error ? e.message : String(e)}`,
          hint: '确认本机 Node.js 可用后重跑本命令。',
        });
      }
    }
    // 轮询直到 ready（~5s，别人拉起的也算）
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if (await ping()) return;
    }
  } finally {
    if (locked) releaseSpawnLock();
  }
  fail({
    type: 'bridge',
    subtype: 'daemon_timeout',
    message: 'daemon 启动超时',
    hint: '查看 ~/.larksnap/daemon.log；若端口 19925 被占用，设环境变量 LARKSNAP_PORT 换端口后重跑本命令。',
    retryable: true,
  });
}

// ==================== 提交任务 + 流式处理 ====================

function runCommand() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ url, format, opts: {}, contextId: profile || undefined });
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: '/command',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          [AUTH_HEADER]: '1',
          [SIG_HEADER]: makeSigHeader(SECRET, 'POST', '/command', body),
        },
      },
      (res) => {
        let acc = '';
        let resolved = false;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          acc += chunk;
          let idx;
          while ((idx = acc.indexOf('\n')) >= 0) {
            const line = acc.slice(0, idx);
            acc = acc.slice(idx + 1);
            if (line.trim()) {
              const code = handleLine(JSON.parse(line));
              if (code != null && !resolved) {
                resolved = true;
                exit(code);
              }
            }
          }
        });
        res.on('end', () => {
          if (!resolved) {
            fail({
              type: 'export',
              subtype: 'no_result',
              message: '连接结束但未收到结果',
              hint: '点一下扩展图标唤醒后台 Service Worker，然后重跑本命令。',
              retryable: true,
            });
          }
        });
      }
    );
    req.on('error', (e) => {
      fail({
        type: 'bridge',
        subtype: 'bridge_request_failed',
        message: `请求 daemon 失败: ${e.message}`,
        hint: '直接重跑本命令；仍失败则查看 ~/.larksnap/daemon.log。',
        retryable: true,
      });
    });
    req.write(body);
    req.end();
    function exit(code) {
      resolve();
      process.exit(code);
    }
  });
}

// daemon/扩展回传的 error 按 subtype 补充 type/hint/retryable（缺省按导出失败处理）
const ERROR_KINDS = {
  extension_not_connected: {
    type: 'bridge',
    hint: '确认 Chrome 已打开并加载 larksnap 扩展，点一下扩展图标唤醒后台，然后重跑本命令。',
    retryable: true,
  },
  profile_not_found: {
    type: 'usage',
    hint: '把 --profile 改成错误信息里列出的已连接 profile code，然后重跑本命令。',
    retryable: false,
  },
  profile_ambiguous: {
    type: 'usage',
    hint: '加 --profile <code> 指定用哪个浏览器 profile（code 见扩展弹窗，可点 Copy 复制），然后重跑本命令。',
    retryable: false,
  },
  export_failed: {
    type: 'export',
    hint: '若提示扩展断开/Service Worker 休眠，点一下扩展图标唤醒后重跑本命令；其余情况查看 ~/.larksnap/daemon.log。',
    retryable: true,
  },
  signature_invalid: {
    type: 'bridge',
    hint: '本技能与本机 daemon 的密钥/版本不一致：更新/重装 larksnap-fetch 技能目录后重跑本命令。',
    retryable: false,
  },
};

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
      // kind==='webpage'：普通网页转 Markdown 的授权入口和飞书不同，话术分叉
      fail({
        type: 'authentication',
        subtype: 'need_domain_auth',
        message: `需要授权域名 ${msg.host || ''}（域名权限需用户手势授权，无法自动完成）。`,
        hint:
          msg.kind === 'webpage'
            ? '让用户在 Chrome 打开该网页 → 点扩展图标打开侧边栏 → 点「授权访问该域名」，完成后重跑本命令。'
            : '让用户打开该域名下任意飞书页面 → 点扩展图标打开侧边栏 → 点「授权该域名」，完成后重跑本命令。',
      });
      return null;
    case 'error': {
      const kind = ERROR_KINDS[msg.subtype] || ERROR_KINDS.export_failed;
      fail({
        type: kind.type,
        subtype: msg.subtype || 'export_failed',
        message: msg.message || '导出失败（未知错误）',
        hint: kind.hint,
        retryable: kind.retryable,
      });
      return null;
    }
    case 'result': {
      try {
        const { folder, written } = deliver(msg.filename, msg.dataUrl, outDir);
        console.log(`✓ 已导出到 ${path.resolve(folder)}`);
        for (const w of written) console.log('   -', w);
        return 0;
      } catch (e) {
        fail({
          type: 'export',
          subtype: 'write_failed',
          message: `写入失败: ${e instanceof Error ? e.message : String(e)}`,
          hint: '检查输出目录可写、磁盘空间充足后重跑本命令。',
        });
        return null;
      }
    }
    default:
      return null;
  }
}

/** 把文件名去扩展名、清掉非法字符，作为「每篇文档一个文件夹」的目录名。 */
function folderNameFrom(filename) {
  const base = (filename || 'feishu-doc').replace(/\.(zip|md|markdown|pdf|html?)$/i, '');
  const safe = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '') // 仅删路径分隔符与非法字符（保留空格/连字符/中文）
    .replace(/[. ]+$/, '') // 结尾的点/空格（Windows 不允许）
    .trim();
  return safe || 'feishu-doc';
}

// 产物落到 <输出目录>/<文档名>/ 子文件夹，避免多篇文档平铺混在一起：
//   <输出目录>/无监督数据修复/无监督数据修复.md
//   <输出目录>/无监督数据修复/images/xxx.png
function deliver(filename, dataUrl, dir) {
  const folder = path.join(dir, folderNameFrom(filename));
  fs.mkdirSync(folder, { recursive: true });
  const head = (dataUrl || '').slice(0, 64);
  const isZip = /\.zip$/i.test(filename || '') || /^data:application\/zip/i.test(head);
  if (isZip) {
    const written = unzipInto(dataUrl, folder).map((w) => path.join(path.basename(folder), w));
    return { folder, written };
  }
  const name = filename || 'feishu-doc';
  writeDataUrl(dataUrl, path.join(folder, name));
  return { folder, written: [path.join(path.basename(folder), name)] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
