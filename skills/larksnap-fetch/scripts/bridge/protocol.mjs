// 桥接协议、常量与「手搓零依赖」WebSocket 服务端 —— daemon / fetch.mjs 共用。
//
// 架构（仿 OpenCLI，去掉 native messaging）：
//   CLI ──HTTP POST /command(流式 NDJSON 响应)──▶ daemon ──WS push──▶ 扩展
//   扩展 ──WS 消息(进度/结果)──▶ daemon ──写入 /command 流──▶ CLI
//   daemon 监听 127.0.0.1:PORT；扩展是 WS 客户端，主动连出。
//
// 安全（防浏览器 CSRF + 防本机其他身份冒充，参考 OpenCLI/官方 sidecar 思路）：
//   - Origin 校验：HTTP/WS 的 Origin 非 chrome-extension:// 一律拒（Node 不发 Origin → 放行）
//   - HMAC 签名：CLI→daemon 的写操作端点每个请求签名（key 存 ~/.larksnap/secret，0600），
//     签名覆盖 版本/时间戳/method/path/body摘要，60s 防重放，验签失败无回落
//   - 扩展侧 WS 无法读本地 key 文件，维持 Origin 校验（已知局限，配对方案留待需要时再做）
//   - 只绑 127.0.0.1；body 上限
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const DAEMON_VERSION = '1.6.0'; // 1.6.0: GET /hosts 已授权域名清单（new-doc 免链接）
export const PROTOCOL_VERSION = 4; // WS 握手用：hello/welcome 双向携带，不匹配时提示更新。v2: kind='edit'；v3: 扩展可主动发 video-job，daemon 主动推进度；v4: daemon 可发 list-domains，扩展回 domains-result
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.LARKSNAP_PORT || 19925);
export const PING_URL = `http://${HOST}:${PORT}/ping`;
export const COMMAND_URL = `http://${HOST}:${PORT}/command`;
export const WS_PATH = '/ext';
export const AUTH_HEADER = 'x-larksnap';
export const SIG_HEADER = 'x-larksnap-sig';

export const HOME_DIR = path.join(os.homedir(), '.larksnap');
export const LOG_PATH = path.join(HOME_DIR, 'daemon.log');
export const SECRET_PATH = path.join(HOME_DIR, 'secret');
export const PID_PATH = path.join(HOME_DIR, 'daemon.pid');

export function ensureHomeDir() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
}

// ==================== HMAC 签名（CLI ⇄ daemon）====================

/** 读共享 key；不存在则生成（32 字节 hex，0600）。并发生成时输家重读赢家的。 */
export function loadOrCreateSecret() {
  ensureHomeDir();
  try {
    const s = fs.readFileSync(SECRET_PATH, 'utf8').trim();
    if (s) return s;
  } catch {
    /* 不存在 → 下面生成 */
  }
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_PATH, fresh + '\n', { mode: 0o600, flag: 'wx' });
    return fresh;
  } catch {
    // 另一进程刚写入（EEXIST）→ 用它的
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  }
}

function hmacHex(secret, ts, method, pathname, body) {
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const toSign = `v1\n${ts}\n${method.toUpperCase()}\n${pathname}\n${bodyHash}`;
  return crypto.createHmac('sha256', secret).update(toSign).digest('hex');
}

/** 生成签名头的值：`v1,t=<unix秒>,s=<hex>`。 */
export function makeSigHeader(secret, method, pathname, body) {
  const ts = Math.floor(Date.now() / 1000);
  return `v1,t=${ts},s=${hmacHex(secret, ts, method, pathname, body)}`;
}

/** 校验签名头。时间戳漂移超过 skewSec 或签名不符 → false。 */
export function verifySigHeader(secret, headerValue, method, pathname, body, skewSec = 60) {
  const m = /^v1,t=(\d+),s=([0-9a-f]{64})$/.exec(String(headerValue || ''));
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > skewSec) return false;
  const expected = hmacHex(secret, ts, method, pathname, body);
  const a = Buffer.from(m[2], 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ==================== 手搓 WebSocket 服务端 ====================

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 把 WS 升级处理挂到一个 http.Server 上。verifyOrigin(origin)→false 则拒绝握手。
 * 每个连接回调 onConnection(WSConnection)。
 */
export function attachWsServer(httpServer, { wsPath = WS_PATH, verifyOrigin, onConnection }) {
  httpServer.on('upgrade', (req, socket) => {
    if ((req.url || '').split('?')[0] !== wsPath) {
      socket.destroy();
      return;
    }
    const origin = req.headers['origin'];
    if (verifyOrigin && !verifyOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    onConnection(new WSConnection(socket));
  });
}

/**
 * 单个 WS 连接（服务端侧）。
 * 事件：'message'(string) / 'pong' / 'close'。方法：send(str) / ping() / close()。
 * 客户端→服务端帧带掩码，服务端→客户端帧不带掩码（RFC6455）。
 */
export class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this.emit('close'));
    socket.on('error', () => this.emit('close'));
    // http.Server 升级出的 socket 是 allowHalfOpen：对端进程被杀只发 FIN 时
    // 只触发 'end' 不触发 'close'，连接会泄漏到心跳超时（~30s）才回收。
    // 收到 FIN 就把我方也关掉，让 'close' 立即触发。
    socket.on('end', () => {
      try {
        socket.end();
      } catch {
        /* 忽略 */
      }
    });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // 一次 data 可能含多帧/半帧；循环切出完整帧
    let frame;
    while ((frame = this._readFrame())) this._handleFrame(frame);
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      len = Number(b.readBigUInt64BE(offset));
      offset += 8;
    }
    let maskKey;
    if (masked) {
      if (b.length < offset + 4) return null;
      maskKey = b.subarray(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + len) return null; // 帧未到齐，等更多 data
    let payload = b.subarray(offset, offset + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    }
    this.buf = b.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(f) {
    if (f.opcode === 0x8) {
      // close
      this.close();
      this.emit('close');
      return;
    }
    if (f.opcode === 0x9) {
      this._send(0xa, f.payload); // ping → pong
      return;
    }
    if (f.opcode === 0xa) {
      this.emit('pong');
      return;
    }
    // 0x0 续帧 / 0x1 文本 / 0x2 二进制
    if (f.opcode === 0x0) {
      this.fragments.push(f.payload);
    } else {
      this.fragments = [f.payload];
      this.fragOpcode = f.opcode;
    }
    if (f.fin) {
      const full = Buffer.concat(this.fragments);
      this.fragments = [];
      if (this.fragOpcode === 0x1) this.emit('message', full.toString('utf8'));
    }
  }

  _send(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      /* 连接已断 */
    }
  }

  send(str) {
    this._send(0x1, Buffer.from(str, 'utf8'));
  }

  ping() {
    this._send(0x9, Buffer.alloc(0));
  }

  close() {
    try {
      this._send(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch {
      /* 忽略 */
    }
  }
}
