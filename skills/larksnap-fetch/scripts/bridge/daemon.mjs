#!/usr/bin/env node
// 桥接守护进程：HTTP(CLI 侧) + WebSocket(扩展侧) 的本地撮合器。
//
//   CLI  ──POST /command（流式 NDJSON 响应）──▶ daemon ──WS──▶ 扩展
//   扩展 ──WS(progress/result/...)──▶ daemon ──写回 /command 流──▶ CLI
//
// 多浏览器 profile：每个扩展安装有自己的 profile code(contextId)，hello 时上报；
// daemon 按 contextId 维护连接，CLI 可用 --profile 指定路由（仿 OpenCLI）。
//
// 由 fetch.mjs 按需 detached 拉起；持久存活（空闲 30 分钟自退）；只绑 127.0.0.1。
import { createServer } from 'node:http';
import fs from 'node:fs';
import {
  HOST,
  PORT,
  WS_PATH,
  AUTH_HEADER,
  SIG_HEADER,
  LOG_PATH,
  PID_PATH,
  DAEMON_VERSION,
  PROTOCOL_VERSION,
  ensureHomeDir,
  attachWsServer,
  loadOrCreateSecret,
  verifySigHeader,
} from './protocol.mjs';

ensureHomeDir();
const SECRET = loadOrCreateSecret();
function log(...a) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${a.join(' ')}\n`);
  } catch {
    /* 忽略 */
  }
}

const extConns = new Map(); // contextId -> WSConnection（每个浏览器 profile 一条）
const pending = new Map(); // jobId -> { res, contextId }（CLI 流式响应）
let jobSeq = 0;
let idleTimer = null;

/** 路由到目标扩展连接。返回 { conn } 或 { error, subtype }（subtype 供 CLI 错误契约分支）。 */
function resolveConn(contextId) {
  if (contextId) {
    const conn = extConns.get(contextId);
    if (conn) return { conn };
    return {
      subtype: 'profile_not_found',
      error: `未找到 profile「${contextId}」。当前已连接: ${[...extConns.keys()].join(', ') || '(无)'}`,
    };
  }
  if (extConns.size === 0) {
    return {
      subtype: 'extension_not_connected',
      error: '扩展未连接：请确认 Chrome 已打开并加载 larksnap 扩展，点一下图标唤醒后台后重试。',
    };
  }
  if (extConns.size === 1) return { conn: [...extConns.values()][0] };
  return {
    subtype: 'profile_ambiguous',
    error: `检测到多个浏览器 profile（${[...extConns.keys()].join(', ')}），请用 --profile <code> 指定其一。`,
  };
}

// ==================== HTTP（CLI 侧）====================

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let acc = '';
    req.on('data', (c) => {
      acc += c;
      if (acc.length > limit) reject(new Error('body 过大'));
    });
    req.on('end', () => resolve(acc));
    req.on('error', reject);
  });
}

const httpServer = createServer(async (req, res) => {
  const origin = req.headers['origin'];
  // 防 CSRF：带 Origin 且非扩展来源 → 拒（Node CLI 不发 Origin → 放行）
  if (origin && !String(origin).startsWith('chrome-extension://')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const pathname = (req.url || '/').split('?')[0];

  // 探活端点：扩展连 WS 前先 fetch 这个（避免 ERR_CONNECTION_REFUSED 刷错误页），无需自定义头。
  // 扩展 SW 从 chrome-extension:// 发的是跨源 fetch，必须回 CORS 头，否则被浏览器拦掉。
  if (pathname === '/ping' && (req.method === 'GET' || req.method === 'OPTIONS')) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': '*',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    res
      .writeHead(200, { ...cors, 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, daemonVersion: DAEMON_VERSION }));
    return;
  }

  // 其余端点要求自定义头（网页发不出，预检又被拒）+ HMAC 签名（防本机其他身份冒充，无回落）
  if (!req.headers[AUTH_HEADER]) {
    res.writeHead(403).end('missing auth header');
    return;
  }
  let rawBody = '';
  if (req.method === 'POST') {
    try {
      rawBody = await readBody(req);
    } catch {
      res.writeHead(400).end('bad body');
      return;
    }
  }
  if (!verifySigHeader(SECRET, req.headers[SIG_HEADER], req.method, pathname, rawBody)) {
    log('signature reject', req.method, pathname);
    if (pathname === '/command') {
      // 用 NDJSON 错误行回，新旧 CLI 都能给出可读提示
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(
        JSON.stringify({
          type: 'error',
          subtype: 'signature_invalid',
          message: '请求签名无效：CLI 与 daemon 的密钥/版本不一致，请更新 larksnap-fetch 技能后重试。',
        }) + '\n'
      );
    } else {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: 'bad signature' }));
    }
    return;
  }

  // 状态/诊断：列出已连接的 profile（供 CLI 校验 --profile）
  if (req.method === 'GET' && pathname === '/status') {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, daemonVersion: DAEMON_VERSION, profiles: [...extConns.keys()] }));
    return;
  }

  if (req.method === 'POST' && pathname === '/shutdown') {
    res.writeHead(200).end('ok');
    setTimeout(() => process.exit(0), 50);
    return;
  }

  if (req.method === 'POST' && pathname === '/command') {
    let job;
    try {
      job = JSON.parse(rawBody);
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    if (!job.url) {
      res.writeHead(400).end('missing url');
      return;
    }
    const routed = resolveConn(job.contextId);
    if (routed.error) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ type: 'error', subtype: routed.subtype, message: routed.error }) + '\n');
      return;
    }
    // 流式响应：进度/结果逐行写回，结束时 end
    const id = `j${++jobSeq}`;
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
    pending.set(id, { res, contextId: routed.conn._contextId });
    armIdle();
    res.on('close', () => {
      pending.delete(id); // CLI 提前断开
      armIdle();
    });
    routed.conn.send(
      JSON.stringify({
        type: 'job',
        id,
        url: job.url,
        format: job.format || 'md',
        opts: job.opts || {},
      })
    );
    log('dispatch', id, routed.conn._contextId, job.url);
    return;
  }

  res.writeHead(404).end('not found');
});

httpServer.on('error', (e) => {
  // 端口被占多半是已有 daemon → 让位退出
  log('http error', e.code || e.message);
  process.exit(1);
});

// ==================== WebSocket（扩展侧）====================

attachWsServer(httpServer, {
  wsPath: WS_PATH,
  // 只接受扩展来源（或无 Origin）；挡掉网页伪装连 ws://localhost
  verifyOrigin: (origin) => !origin || String(origin).startsWith('chrome-extension://'),
  onConnection: (conn) => {
    conn._contextId = null;
    log('extension socket connected (待 hello)');
    armIdle();

    // 心跳：每 15s ping，连续 2 次无 pong 视为掉线
    let missed = 0;
    const hb = setInterval(() => {
      if (missed >= 2) {
        clearInterval(hb);
        conn.close();
        return;
      }
      missed++;
      conn.ping();
    }, 15000);
    conn.on('pong', () => {
      missed = 0;
    });

    conn.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        const cid = (msg.contextId && String(msg.contextId)) || 'default';
        conn._contextId = cid;
        extConns.set(cid, conn);
        // 回握手：daemon 版本（popup 展示）+ 协议版本（不匹配时扩展提示更新，不硬断以免升级期全瘫）
        const extProto = msg.protocolVersion ?? null;
        conn.send(
          JSON.stringify({
            type: 'welcome',
            daemonVersion: DAEMON_VERSION,
            protocolVersion: PROTOCOL_VERSION,
          })
        );
        if (extProto !== null && extProto !== PROTOCOL_VERSION) {
          log('protocol mismatch', `ext=${extProto}`, `daemon=${PROTOCOL_VERSION}`, cid);
        }
        log('extension hello', cid, msg.version || '', `proto=${extProto ?? '(旧扩展未报)'}`);
        return;
      }
      // 业务消息（progress/result/error/need-login/need-auth），按 id 写回 CLI 流
      const entry = msg.id != null ? pending.get(msg.id) : null;
      if (!entry) return;
      try {
        entry.res.write(JSON.stringify(msg) + '\n');
      } catch {
        /* CLI 已断 */
      }
      if (msg.type === 'result' || msg.type === 'error') {
        pending.delete(msg.id);
        try {
          entry.res.end();
        } catch {
          /* 忽略 */
        }
        log('done', msg.id, msg.type);
        armIdle();
      }
    });

    conn.on('close', () => {
      clearInterval(hb);
      const cid = conn._contextId;
      if (cid && extConns.get(cid) === conn) extConns.delete(cid);
      log('extension disconnected', cid || '(未 hello)');
      // 该 profile 的在途任务收尾报错
      for (const [id, entry] of pending) {
        if (cid && entry.contextId !== cid) continue;
        try {
          entry.res.write(
            JSON.stringify({ type: 'error', message: '扩展断开（Service Worker 休眠？点图标唤醒后重试）' }) + '\n'
          );
          entry.res.end();
        } catch {
          /* 忽略 */
        }
        pending.delete(id);
      }
      armIdle();
    });
  },
});

// 无扩展且无在途任务 30 分钟 → 自退
function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => {
      if (extConns.size === 0 && pending.size === 0) {
        log('idle exit');
        process.exit(0);
      } else {
        armIdle();
      }
    },
    30 * 60 * 1000
  );
}

httpServer.listen(PORT, HOST, () => {
  // PID 文件：诊断用（谁在监听）；抢端口失败的实例走上面 http error 退出，不会覆盖赢家的
  try {
    fs.writeFileSync(PID_PATH, String(process.pid) + '\n');
  } catch {
    /* 忽略 */
  }
  log('daemon listening', `${HOST}:${PORT}`, 'v' + DAEMON_VERSION, 'pid=' + process.pid);
  armIdle();
});

process.on('exit', () => {
  // 只清理自己的 PID 文件（别的实例可能已接管）
  try {
    if (fs.readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_PATH);
  } catch {
    /* 忽略 */
  }
});
