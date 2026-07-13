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
import { promisify } from 'node:util';
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
// 画质：null=最高；或 { res, fps }（fps 可空）。接受 '1080' / '1080@60' / '2160@30' 形态，
// 只用于拼 -S 的值位（res:N / res:N,fps:F），其他一律当最高。
function normalizeQuality(q) {
  const m = typeof q === 'string' ? /^(\d{3,4})(?:@(30|60))?$/.exec(q) : null;
  if (!m) return null;
  const res = Number(m[1]);
  if (res < 144 || res > 4320) return null;
  return { res, fps: m[2] ? Number(m[2]) : null };
}

/** quality → yt-dlp 排序参数（fps 也封顶：选 1080P 时不给 60 帧变体） */
function qualityArgs(quality) {
  if (!quality) return [];
  return ['-S', `res:${quality.res}${quality.fps ? `,fps:${quality.fps}` : ''}`];
}
// 系统代理环境变量：失败且像网络/代理问题时，在「代理 ⇄ 直连」间切换重试
// （国内站被代理掐、国外站靠代理，两头都照顾）。扩展可带 route 指定先试哪条
// （按站点线路记忆），带 proxy 指定显式代理地址（否则用这些环境变量）。
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const PROXY_ERROR_RE = /SSL|EOF|proxy|tunnel|Connection (reset|refused|aborted)|timed? ?out|unreachable/i;
// 显式代理地址只接受这些协议，且只进 --proxy 的值位
const PROXY_URL_RE = /^(https?|socks[45]h?):\/\/\S{1,2048}$/i;

/**
 * 按线路组装环境与 --proxy 参数。
 *   direct：--proxy ''（yt-dlp 语义为强制直连），再剥环境变量兜底；
 *   proxy：有显式地址用 --proxy <url>，否则继承环境变量（跟随系统代理）。
 */
function routeSetup(route, userProxy) {
  const env = { ...process.env };
  if (route === 'direct') {
    for (const k of PROXY_ENV_KEYS) delete env[k];
    return { env, proxyArgs: ['--proxy', ''] };
  }
  return { env, proxyArgs: userProxy ? ['--proxy', userProxy] : [] };
}

/** 另一条线路是否值得一试：两条线路网络路径确实不同才切换。 */
function hasAltRoute(route, userProxy) {
  if (route === 'proxy') return true; // 代理失败 → 直连总是可试
  return !!userProxy || PROXY_ENV_KEYS.some((k) => process.env[k]); // 直连失败 → 得有代理可用
}
// PATH 找不到时的兜底路径，按平台给常见安装位置
// （Windows 上 execFile 无后缀名时系统会自动补 .exe，无需显式写）
const EXTRA_BIN_DIRS =
  process.platform === 'win32'
    ? [
        // scoop 与 winget 的可执行链接目录（daemon 从非登录环境启动时 PATH 可能不含它们）
        path.join(os.homedir(), 'scoop', 'shims'),
        path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
          'Microsoft',
          'WinGet',
          'Links'
        ),
      ]
    : [
        '/opt/homebrew/bin', // macOS Homebrew（Apple 芯片）
        '/usr/local/bin', // macOS Intel Homebrew / Linux 手动安装
        path.join(os.homedir(), '.local', 'bin'), // pip install yt-dlp 的默认位置
      ];

let runningCount = 0;

/** 探测可执行文件：先 PATH，再兜底目录。找到返回可用于 spawn 的命令，找不到返回 null。 */
async function findBin(name, versionFlag, extraDirs = []) {
  const candidates = [name, ...[...EXTRA_BIN_DIRS, ...extraDirs].map((d) => path.join(d, name))];
  for (const cmd of candidates) {
    const ok = await new Promise((resolve) => {
      execFile(cmd, [versionFlag], { timeout: 10_000 }, (err) => resolve(!err));
    });
    if (ok) return cmd;
  }
  return null;
}

/** nvm 装的 node 不在固定路径上，扫版本目录取最新一个的 bin 目录。 */
function nvmNodeDirs() {
  try {
    const base = path.join(os.homedir(), '.nvm', 'versions', 'node');
    return fs
      .readdirSync(base)
      .map((v) => v.replace(/^v/, '').split('.').map(Number))
      .filter((p) => p.length === 3 && p.every(Number.isFinite))
      .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])
      .slice(0, 1)
      .map((p) => path.join(base, `v${p.join('.')}`, 'bin'));
  } catch {
    return [];
  }
}

// YouTube 的 nsig 反爬需要 JS 运行时解题，yt-dlp 默认只认 PATH 上的 deno；
// 找到 node/bun（或兜底目录里的 deno）时显式传 --js-runtimes。都没有则不传，yt-dlp 走降级接口。
let jsRuntimeArgsPromise = null;
function jsRuntimeArgs() {
  jsRuntimeArgsPromise ??= (async () => {
    for (const name of ['deno', 'node', 'bun']) {
      const cmd = await findBin(name, '--version', name === 'node' ? nvmNodeDirs() : []);
      if (!cmd) continue;
      if (name === 'deno' && !path.isAbsolute(cmd)) return []; // PATH 上的 deno 就是默认行为
      return ['--js-runtimes', path.isAbsolute(cmd) ? `${name}:${cmd}` : name];
    }
    return [];
  })();
  return jsRuntimeArgsPromise;
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

  // 显式代理地址：协议白名单 + 只进 --proxy 值位；不合法直接忽略（回落系统代理）
  const proxy =
    typeof msg.proxy === 'string' && PROXY_URL_RE.test(msg.proxy.trim()) ? msg.proxy.trim() : null;
  // 首选线路：非法值当 'proxy'（历史默认顺序）；routeLocked=命中扩展侧「不代理列表」，失败不切换
  const route = msg.route === 'direct' ? 'direct' : 'proxy';
  const routeLocked = msg.routeLocked === true;

  return { url, headerArgs, cookies, quality: normalizeQuality(msg.quality), proxy, route, routeLocked };
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

  // 每个任务一份完整日志（yt-dlp 全量 stdout/stderr），报错时把路径带给用户
  const logDir = path.join(OUT_DIR, 'logs');
  let logStream = null;
  let logFile = '';
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, `${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}-${id}.log`);
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.write(`URL: ${checked.url}\n`);
  } catch {
    logStream = null; // 日志写不了不影响下载
  }

  // 参数全部在这里拼死；任务内容只出现在 header 值、cookie 文件内容、--proxy 值和末尾的 URL 里
  // （--proxy 与 -- URL 由 attempt() 按线路追加）
  const args = [
    '--newline', // 进度逐行输出，便于解析
    '--no-playlist', // 只下当前这一个视频，防列表页误触发批量
    '-c', // 断点续传
    '-P', OUT_DIR,
    // 文件名带分辨率与帧率标注（如 [1080P][60fps]，小数帧率取整）；取不到的段自动省略，不出现 NA
    '-o', '%(title).120B [%(id)s]%(height&[{0}P]|)s%(fps&[{0:.0f}fps]|)s.%(ext)s',
    // PATH 里找到的是裸名（yt-dlp 自己会搜 PATH）；只有兜底目录命中才需要显式指路径
    ...(path.isAbsolute(ffmpeg) ? ['--ffmpeg-location', ffmpeg] : []),
    // 画质封顶（未指定时用 yt-dlp 默认排序即最高）
    ...qualityArgs(checked.quality),
    // YouTube nsig 解题的 JS 运行时（没有 deno 时启用 node/bun）
    ...(await jsRuntimeArgs()),
    ...checked.headerArgs.flatMap((h) => ['--add-header', h]),
    ...(cookieFile ? ['--cookies', cookieFile] : []),
  ];

  runningCount++;
  log('video start', id, `q=${checked.quality ? checked.quality.res + (checked.quality.fps ? '@' + checked.quality.fps : '') : 'best'}`, checked.url.slice(0, 120));
  send({ type: 'video-progress', id, percent: 0, message: '正在解析视频信息…' });

  let child = null;
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
  const settle = () => {
    settled = true;
    runningCount--;
    cleanup();
    try {
      logStream?.end();
    } catch {
      /* 忽略 */
    }
  };

  /**
   * 按线路跑一次 yt-dlp。首选线路失败且像网络/代理问题时切换到另一条重试一次；
   * routeLocked（扩展侧「不代理列表」命中）或另一条线路不存在则不切换。
   */
  const attempt = (route, isRetry) => {
    const { env, proxyArgs } = routeSetup(route, checked.proxy);
    logStream?.write(`\n==== ${new Date().toISOString()} 线路=${route}${proxyArgs.length ? ` proxy=${proxyArgs[1] || '(直连)'}` : '(系统代理)'} ====\n`);
    child = spawn(ytdlp, [...args, ...proxyArgs, '--', checked.url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let destFile = null; // 最后一次出现的目标文件（分离流会先后出现视频/音频/合并产物，取最后）
    let lastSentPct = -1;
    let stderrTail = '';

    const onLine = (line) => {
      const dest =
        /^\[download\] Destination: (.+)$/.exec(line) ||
        /^\[Merger\] Merging formats into "(.+)"$/.exec(line) ||
        /^\[download\] (.+) has already been downloaded$/.exec(line);
      if (dest) {
        destFile = dest[1];
        return;
      }
      // 形如 [download]  42.3% of ~123.45MiB at 2.50MiB/s ETA 00:12（速度/ETA 可能缺或为 Unknown）
      const prog = /^\[download\]\s+([\d.]+)%/.exec(line);
      if (prog) {
        const pct = Math.min(100, Math.floor(Number(prog[1])));
        if (pct !== lastSentPct) {
          lastSentPct = pct;
          const speed = / at\s+([\d.]+\s*[KMGT]?i?B\/s)/.exec(line)?.[1]?.replace(/\s+/, '');
          const eta = / ETA (\d[\d:]*)/.exec(line)?.[1];
          const parts = [`下载中 ${pct}%`];
          if (speed) parts.push(speed);
          if (eta) parts.push(`剩余 ${eta}`);
          send({ type: 'video-progress', id, percent: pct, message: parts.join(' · ') });
        }
      }
    };

    let buf = '';
    child.stdout.on('data', (chunk) => {
      logStream?.write(chunk);
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl).trimEnd());
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (chunk) => {
      logStream?.write(chunk);
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
    });

    child.on('error', (e) => {
      if (settled) return;
      settle();
      fail(`yt-dlp 启动失败：${e.message}`);
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code === 0) {
        settle();
        // route 回传给扩展做「按站点线路记忆」，下个同站任务直接走对的线路
        send({ type: 'video-result', id, file: destFile || OUT_DIR, route });
        log('video done', id, `route=${route}`, destFile || '(未捕获文件名)');
        onDone();
        return;
      }
      // 错误像网络/代理问题 → 切换线路重试一次（代理⇄直连双向）
      if (
        !isRetry &&
        !checked.routeLocked &&
        hasAltRoute(route, checked.proxy) &&
        PROXY_ERROR_RE.test(stderrTail)
      ) {
        const alt = route === 'proxy' ? 'direct' : 'proxy';
        log('video retry via', alt, id);
        send({
          type: 'video-progress',
          id,
          message: route === 'proxy' ? '通过代理访问失败，正在直连重试…' : '直连访问失败，正在通过代理重试…',
        });
        attempt(alt, true);
        return;
      }
      settle();
      // stderr 里通常最后几行才是真错误；取末段给用户，完整日志给路径
      const brief = stderrTail.trim().split('\n').slice(-4).join('\n') || `退出码 ${code}`;
      fail(`下载失败：${brief}${logFile ? `\n完整日志：${logFile}` : ''}`);
    });
  };

  attempt(checked.route, false);

  return {
    kill() {
      if (settled) return;
      settle();
      try {
        child?.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      log('video killed (连接断开)', id);
      onDone();
    },
  };
}

const execFileP = promisify(execFile);

/**
 * 探测视频可用清晰度：yt-dlp -J 拉格式列表，按（分辨率, 帧率档）去重后回传。
 * 带和下载相同的 headers/cookies，所以结果如实反映登录态（没登录 B 站就列不出 1080P+）。
 * 成功推 { type:'video-probe-result', id, title, options:[{height,fps}] }（fps 只分 60/null 两档）。
 */
export async function runVideoProbe(msg, send, log, onDone) {
  const id = msg.id;
  const fail = (message, subtype) => {
    send({ type: 'video-error', id, ...(subtype ? { subtype } : {}), message });
    log('probe error', id, subtype || '', String(message).slice(0, 200));
    onDone();
  };

  const checked = validateVideoJob(msg);
  if (checked.error) {
    fail(checked.error, 'bad_request');
    return null;
  }
  const ytdlp = await findBin('yt-dlp', '--version');
  if (!ytdlp) {
    fail(`本机缺少 yt-dlp，无法探测清晰度。安装方式：${INSTALL_HINT}`, 'dependency_missing');
    return null;
  }

  let cookieFile = null;
  try {
    if (checked.cookies) cookieFile = writeCookieFile(`probe-${id}`, checked.cookies);
  } catch (e) {
    fail(`写临时 cookie 文件失败：${e.message}`);
    return null;
  }

  const args = [
    '-J', // 输出单条视频的 info JSON，不下载
    '--no-playlist',
    ...(await jsRuntimeArgs()),
    ...checked.headerArgs.flatMap((h) => ['--add-header', h]),
    ...(cookieFile ? ['--cookies', cookieFile] : []),
  ];

  let killed = false;
  let currentChild = null;
  const runOnce = (route) => {
    const { env, proxyArgs } = routeSetup(route, checked.proxy);
    const p = execFileP(ytdlp, [...args, ...proxyArgs, '--', checked.url], {
      env,
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    currentChild = p.child;
    return p;
  };

  log('probe start', id, `route=${checked.route}`, checked.url.slice(0, 120));
  void (async () => {
    try {
      let stdout;
      let usedRoute = checked.route;
      try {
        ({ stdout } = await runOnce(usedRoute));
      } catch (e1) {
        const errText = `${e1.stderr || ''}${e1.message || ''}`;
        if (
          killed ||
          checked.routeLocked ||
          !hasAltRoute(usedRoute, checked.proxy) ||
          !PROXY_ERROR_RE.test(errText)
        ) {
          throw e1;
        }
        usedRoute = usedRoute === 'proxy' ? 'direct' : 'proxy';
        log('probe retry via', usedRoute, id);
        ({ stdout } = await runOnce(usedRoute));
      }
      if (killed) return;
      const info = JSON.parse(stdout);
      // 按（高度, 是否60帧档）去重；fps>=50 归 60 帧档
      const seen = new Map();
      for (const f of info.formats || []) {
        if (!f.height || f.vcodec === 'none') continue;
        const hi = (f.fps || 0) >= 50;
        const key = `${f.height}-${hi ? 60 : 30}`;
        if (!seen.has(key)) seen.set(key, { height: f.height, fps: hi ? 60 : null });
      }
      const options = [...seen.values()].sort((a, b) => b.height - a.height || (b.fps || 0) - (a.fps || 0));
      send({ type: 'video-probe-result', id, title: String(info.title || '').slice(0, 200), options, route: usedRoute });
      log('probe done', id, `route=${usedRoute}`, options.map((o) => `${o.height}${o.fps ? '@60' : ''}`).join(','));
      onDone();
    } catch (e) {
      if (killed) return;
      const brief = String(e.stderr || e.message || e).trim().split('\n').slice(-3).join('\n');
      fail(`探测清晰度失败：${brief}`);
    } finally {
      if (cookieFile) {
        try {
          fs.unlinkSync(cookieFile);
        } catch {
          /* 已删 */
        }
      }
    }
  })();

  return {
    kill() {
      killed = true;
      try {
        currentChild?.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    },
  };
}
