// CLI 侧共享逻辑 —— fetch.mjs / edit.mjs 共用。
//
// 职责：错误契约（stderr 最后一行 JSON + 派生退出码）、确保 daemon 在跑（探活/
// 版本自愈/拉起锁）、POST /command 并流式消费 NDJSON 响应。
// 各 CLI 只负责解析自己的参数、组装 job、处理自己关心的响应行。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  HOST,
  PORT,
  AUTH_HEADER,
  SIG_HEADER,
  HOME_DIR,
  DAEMON_VERSION,
  loadOrCreateSecret,
  makeSigHeader,
} from './protocol.mjs';

// ==================== 错误契约 ====================
// 错误退出前，stderr 先打给人读的散文，最后一行是一行 JSON（机器可读）：
//   {"ok":false,"error":{"type","subtype","message","hint","retryable"}}
// AI 按 type/subtype 分支决定下一步，不解析散文。退出码由 subtype 派生，不手写。
export const BASE_EXIT_CODES = {
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
  extension_outdated: 5,
  signature_invalid: 5,
  // 其余（export_failed / write_failed / no_result / unexpected …）→ 1
};

/** 打印散文 + 一行 JSON 到 stderr，按 subtype 派生退出码退出。不返回。 */
export function fail({ type, subtype, message, hint, retryable = false }, extraExitCodes = {}) {
  console.error('✗', message);
  if (hint) console.error('  →', hint);
  console.error(JSON.stringify({ ok: false, error: { type, subtype, message, hint, retryable } }));
  process.exit({ ...BASE_EXIT_CODES, ...extraExitCodes }[subtype] ?? 1);
}

// daemon/扩展回传的 error 按 subtype 补充 type/hint/retryable（缺省按导出失败处理）
export const ERROR_KINDS = {
  extension_not_connected: {
    type: 'bridge',
    hint: '确认 Chrome 已打开并加载 larksnap 扩展，点一下扩展图标唤醒后台，然后重跑本命令。',
    retryable: true,
  },
  extension_outdated: {
    type: 'bridge',
    hint: '让用户更新 larksnap 扩展（Chrome 商店更新，或开发模式下重新构建并在 chrome://extensions 刷新），然后重跑本命令。',
    retryable: false,
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

// HMAC 共享 key 懒加载：纯用法错不碰文件系统
let secret = null;
function getSecret() {
  if (!secret) secret = loadOrCreateSecret();
  return secret;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================== 确保 daemon 在跑（且版本匹配）====================

/** 探活：返回 daemon 版本号（string），未运行返回 null。 */
export function ping(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/ping', timeout: timeoutMs }, (res) => {
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
    });
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
        headers: {
          [AUTH_HEADER]: '1',
          [SIG_HEADER]: makeSigHeader(getSecret(), 'POST', '/shutdown', ''),
        },
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

/**
 * 确保 daemon 在跑且版本匹配；失败走 failFn 直接退出。
 * @param {string} daemonPath bridge/daemon.mjs 的绝对路径（随技能分发）
 * @param {(err: object) => never} failFn
 */
export async function ensureDaemon(daemonPath, failFn) {
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
  if (!fs.existsSync(daemonPath)) {
    failFn({
      type: 'bridge',
      subtype: 'daemon_missing',
      message: `找不到 daemon: ${daemonPath}`,
      hint: '技能文件不完整，重新安装 larksnap-fetch 技能目录（含 scripts/bridge/）后重试。',
    });
  }
  const locked = acquireSpawnLock();
  try {
    // 拿到锁才拉起；没拿到说明另一个 CLI 正在拉，直接进入下面的等待
    if (locked && !(await ping())) {
      try {
        const child = spawn(process.execPath, [daemonPath], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (e) {
        releaseSpawnLock(); // fail 直接退出不走 finally，先释放
        failFn({
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
  failFn({
    type: 'bridge',
    subtype: 'daemon_timeout',
    message: 'daemon 启动超时',
    hint: '查看 ~/.larksnap/daemon.log；若端口 19925 被占用，设环境变量 LARKSNAP_PORT 换端口后重跑本命令。',
    retryable: true,
  });
}

// ==================== 提交任务 + 流式处理 ====================

/**
 * POST /command 并逐行消费 NDJSON 响应。
 * onLine(msg) 返回退出码（number 或 Promise<number>）表示终结，返回 null 表示继续。
 * 流结束仍无终结 → no_result 报错。失败均走 failFn 直接退出，本函数不返回。
 */
export function postCommand(job, onLine, failFn) {
  return new Promise((resolve) => {
    const body = JSON.stringify(job);
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
          [SIG_HEADER]: makeSigHeader(getSecret(), 'POST', '/command', body),
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
              // 终结分支可返回 Promise（如 fetch 要先下载图片），其余返回数字或 null
              const code = onLine(JSON.parse(line));
              if (code != null && !resolved) {
                resolved = true;
                Promise.resolve(code).then(exit);
              }
            }
          }
        });
        res.on('end', () => {
          if (!resolved) {
            failFn({
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
      failFn({
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
