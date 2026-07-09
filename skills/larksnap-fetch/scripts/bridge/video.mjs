// 视频下载执行器：daemon 收到「扩展发起的 video job」后，在本机跑 yt-dlp 下载落盘。
//
//   扩展 ──WS { type:'video-job', id, url, headers?, cookies? }──▶ daemon
//   daemon ──WS { type:'video-progress' | 'video-result' | 'video-error', id, ... }──▶ 扩展
//
// 安全边界（这条 WS 没有签名，本机进程可伪造 Origin 连进来，所以必须把口子收死）：
//   - yt-dlp 参数全部由本文件白名单拼装，任务里的字符串只能进「值」的位置，绝不当 flag；
//   - URL 前加 `--` 分隔，防 `-` 开头的字符串被当参数；
//   - 输出目录固定在 ~/Downloads/larksnap-video/，不接受任务指定路径；
//   - 请求头只放行 Referer / Origin / User-Agent，其余丢弃；Cookie 走临时文件（0600，用完即删）。
// 最坏情况被压到「往固定目录多下一个文件」，没有命令执行面。
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { HOME_DIR } from './protocol.mjs';

const OUT_DIR = path.join(os.homedir(), 'Downloads', 'larksnap-video');
const MAX_CONCURRENT = 2; // 同时最多几个 yt-dlp 子进程
const URL_MAX_LEN = 4096;
const HEADER_VALUE_MAX = 2048;
const COOKIE_MAX_COUNT = 500;
// 允许透传给 yt-dlp --add-header 的请求头（小写）。Cookie 不在此列（走 --cookies 文件）。
const ALLOWED_HEADERS = new Set(['referer', 'origin', 'user-agent']);
// PATH 找不到时的兜底路径（macOS Homebrew / Linux 常见位置）
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

let runningCount = 0;

/** 探测可执行文件：先 PATH，再兜底目录。找到返回可用于 spawn 的命令，找不到返回 null。 */
async function findBin(name, versionFlag) {
  const candidates = [name, ...EXTRA_BIN_DIRS.map((d) => path.join(d, name))];
  for (const cmd of candidates) {
    const ok = await new Promise((resolve) => {
      execFile(cmd, [versionFlag], { timeout: 10_000 }, (err) => resolve(!err));
    });
    if (ok) return cmd;
  }
  return null;
}

/** 清掉能破坏参数/文件格式的控制字符（换行、制表符等）。 */
function sanitizeValue(v, maxLen) {
  return String(v).replace(/[\r\n\t\0]/g, '').slice(0, maxLen);
}

/**
 * 校验并归一化任务字段。返回 { error } 或 { url, headerArgs, cookies }。
 * headerArgs 是拼好的 'Key:Value' 串数组；cookies 是清洗过的结构化数组（可为 null）。
 */
export function validateVideoJob(msg) {
  const url = typeof msg.url === 'string' ? msg.url.trim() : '';
  if (!url || url.length > URL_MAX_LEN || !/^https?:\/\//i.test(url)) {
    return { error: '视频地址无效：仅接受 http(s) 链接' };
  }
  try {
    new URL(url);
  } catch {
    return { error: '视频地址无法解析' };
  }

  const headerArgs = [];
  if (msg.headers && typeof msg.headers === 'object') {
    for (const [k, v] of Object.entries(msg.headers)) {
      const key = String(k).toLowerCase();
      if (!ALLOWED_HEADERS.has(key) || typeof v !== 'string') continue;
      const value = sanitizeValue(v, HEADER_VALUE_MAX);
      if (value) headerArgs.push(`${key}:${value}`);
    }
  }

  let cookies = null;
  if (Array.isArray(msg.cookies) && msg.cookies.length > 0) {
    cookies = msg.cookies.slice(0, COOKIE_MAX_COUNT).flatMap((c) => {
      if (!c || typeof c !== 'object' || !c.name || !c.domain) return [];
      return [
        {
          domain: sanitizeValue(c.domain, 256),
          path: sanitizeValue(c.path || '/', 512),
          name: sanitizeValue(c.name, 512),
          value: sanitizeValue(c.value ?? '', 8192),
          secure: !!c.secure,
          // Chrome 的 expirationDate 是秒（可能带小数）；会话 cookie 没有 → 0
          expires: Number.isFinite(c.expires) ? Math.max(0, Math.floor(c.expires)) : 0,
        },
      ];
    });
    if (cookies.length === 0) cookies = null;
  }

  return { url, headerArgs, cookies };
}

/** 写 Netscape 格式临时 cookie 文件（0600），返回路径。 */
function writeCookieFile(id, cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    lines.push(
      [c.domain, includeSub, c.path, c.secure ? 'TRUE' : 'FALSE', c.expires, c.name, c.value].join('\t')
    );
  }
  const file = path.join(HOME_DIR, `cookies-${id}-${process.pid}.txt`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}

const INSTALL_HINT =
  'macOS: brew install yt-dlp ffmpeg ｜ Windows: winget install yt-dlp.yt-dlp Gyan.FFmpeg ｜ 其他见 https://github.com/yt-dlp/yt-dlp';

/**
 * 执行一个视频下载任务。send(obj) 用于把消息推回发起任务的扩展连接。
 * 返回句柄 { kill() }（连接断开时杀子进程）；任务结束（成功/失败）后调用 onDone。
 */
export async function runVideoJob(msg, send, log, onDone) {
  const id = msg.id;
  const fail = (message, subtype) => {
    send({ type: 'video-error', id, ...(subtype ? { subtype } : {}), message });
    log('video error', id, subtype || '', message.slice(0, 200));
    onDone();
  };

  const checked = validateVideoJob(msg);
  if (checked.error) {
    fail(checked.error, 'bad_request');
    return null;
  }

  if (runningCount >= MAX_CONCURRENT) {
    fail(`已有 ${runningCount} 个下载在进行，请稍后再试`, 'busy');
    return null;
  }

  // 依赖检测：yt-dlp 必须有；ffmpeg 用于 DASH 分离流合并（B 站/YouTube 高清必需）
  send({ type: 'video-progress', id, message: '正在检测本机依赖（yt-dlp / ffmpeg）…' });
  const [ytdlp, ffmpeg] = await Promise.all([findBin('yt-dlp', '--version'), findBin('ffmpeg', '-version')]);
  const missing = [!ytdlp && 'yt-dlp', !ffmpeg && 'ffmpeg'].filter(Boolean);
  if (missing.length > 0) {
    fail(`本机缺少 ${missing.join(' 和 ')}，无法下载视频。安装方式：${INSTALL_HINT}`, 'dependency_missing');
    return null;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let cookieFile = null;
  try {
    if (checked.cookies) cookieFile = writeCookieFile(id, checked.cookies);
  } catch (e) {
    fail(`写临时 cookie 文件失败：${e.message}`);
    return null;
  }

  // 参数全部在这里拼死；任务内容只出现在 header 值、cookie 文件内容和末尾的 URL 里
  const args = [
    '--newline', // 进度逐行输出，便于解析
    '--no-playlist', // 只下当前这一个视频，防列表页误触发批量
    '-c', // 断点续传
    '-P', OUT_DIR,
    '-o', '%(title).120B [%(id)s].%(ext)s',
    // PATH 里找到的是裸名（yt-dlp 自己会搜 PATH）；只有兜底目录命中才需要显式指路径
    ...(path.isAbsolute(ffmpeg) ? ['--ffmpeg-location', ffmpeg] : []),
    ...checked.headerArgs.flatMap((h) => ['--add-header', h]),
    ...(cookieFile ? ['--cookies', cookieFile] : []),
    '--',
    checked.url,
  ];

  runningCount++;
  log('video start', id, checked.url.slice(0, 120));
  send({ type: 'video-progress', id, percent: 0, message: '正在解析视频信息…' });

  const child = spawn(ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let destFile = null; // 最后一次出现的目标文件（分离流会先后出现视频/音频/合并产物，取最后）
  let lastSentPct = -1;
  let stderrTail = '';
  let settled = false;

  const cleanup = () => {
    if (cookieFile) {
      try {
        fs.unlinkSync(cookieFile);
      } catch {
        /* 已删或不存在 */
      }
      cookieFile = null;
    }
  };

  const onLine = (line) => {
    const dest =
      /^\[download\] Destination: (.+)$/.exec(line) ||
      /^\[Merger\] Merging formats into "(.+)"$/.exec(line) ||
      /^\[download\] (.+) has already been downloaded$/.exec(line);
    if (dest) {
      destFile = dest[1];
      return;
    }
    const prog = /^\[download\]\s+([\d.]+)%/.exec(line);
    if (prog) {
      const pct = Math.min(100, Math.floor(Number(prog[1])));
      if (pct !== lastSentPct) {
        lastSentPct = pct;
        send({ type: 'video-progress', id, percent: pct, message: `下载中 ${pct}%` });
      }
    }
  };

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, nl).trimEnd());
      buf = buf.slice(nl + 1);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
  });

  child.on('error', (e) => {
    if (settled) return;
    settled = true;
    runningCount--;
    cleanup();
    fail(`yt-dlp 启动失败：${e.message}`);
  });

  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    runningCount--;
    cleanup();
    if (code === 0) {
      send({ type: 'video-result', id, file: destFile || OUT_DIR });
      log('video done', id, destFile || '(未捕获文件名)');
      onDone();
    } else {
      // stderr 里通常最后几行才是真错误；取末段给用户
      const brief = stderrTail.trim().split('\n').slice(-4).join('\n') || `退出码 ${code}`;
      fail(`下载失败：${brief}`);
    }
  });

  return {
    kill() {
      if (settled) return;
      settled = true;
      runningCount--;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      log('video killed (连接断开)', id);
      onDone();
    },
  };
}
