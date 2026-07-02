#!/usr/bin/env node
// feishu-doc-fetch CLI —— 在 CC 里把一个飞书文档链接抓到本地目录。
//
// 自包含的全局技能：daemon/protocol 随技能一起分发（见 ./bridge/），
// 不依赖任何特定仓库的目录结构，因此可从任意项目调用。
//
// 一次性进程：确保 daemon 在跑（探 /ping，没起就 detached 拉起一个，复用 OpenCLI 思路）
// → POST /command 拿流式 NDJSON（进度/结果）→ 把产物（zip 解包 / 单文件）写到输出目录。
//
// 用法:  node fetch.mjs <飞书链接> <输出目录> [--format md|pdf|html] [--profile <code>]
// 退出码: 0 成功 | 1 失败 | 2 用法错 | 3 需登录 | 4 需授权域名 | 5 桥接未就绪
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipInto, writeDataUrl } from './unzip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// daemon 随技能自包含分发：scripts/ 下的 bridge/daemon.mjs（与本仓库根的 bridge/ 解耦）。
const DAEMON_PATH = path.resolve(__dirname, 'bridge/daemon.mjs');

const HOST = '127.0.0.1';
const PORT = Number(process.env.FEISHU2MD_PORT || 19925);
const AUTH_HEADER = 'x-feishu2md';

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

if (!url || !outDir) {
  console.error('用法: fetch.mjs <飞书链接> <输出目录> [--format md|pdf|html] [--profile <code>]');
  process.exit(2);
}

main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

async function main() {
  await ensureDaemon();
  await runCommand();
}

// ==================== 确保 daemon 在跑 ====================

function ping(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: '/ping', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureDaemon() {
  if (await ping()) return;
  if (!fs.existsSync(DAEMON_PATH)) {
    console.error(`✗ 找不到 daemon: ${DAEMON_PATH}`);
    process.exit(5);
  }
  // detached 拉起，脱离本进程独立存活
  try {
    const child = spawn(process.execPath, [DAEMON_PATH], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    console.error('✗ 无法拉起 daemon:', e instanceof Error ? e.message : String(e));
    process.exit(5);
  }
  // 轮询直到 ready（~3s）
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (await ping()) return;
  }
  console.error('✗ daemon 启动超时');
  process.exit(5);
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
            console.error('✗ 连接结束但未收到结果');
            exit(1);
          }
        });
      }
    );
    req.on('error', (e) => {
      console.error('✗ 请求失败:', e.message);
      exit(5);
    });
    req.write(body);
    req.end();
    function exit(code) {
      resolve();
      process.exit(code);
    }
  });
}

/** 处理一行 NDJSON；返回退出码表示终结，返回 null 表示继续。 */
function handleLine(msg) {
  switch (msg.type) {
    case 'progress':
      process.stderr.write(
        `… ${msg.message || ''}${msg.percent != null ? ` (${msg.percent}%)` : ''}\n`
      );
      return null;
    case 'need-login':
      console.error('✗ 需要登录：请在 Chrome 中登录飞书后重试。');
      return 3;
    case 'need-auth':
      console.error(
        `✗ 需要授权域名 ${msg.host || ''}：\n` +
          '  打开该域名下任意飞书页面 → 点扩展图标打开侧边栏 → 点「授权该域名」，然后重试。\n' +
          '  （私有化部署域名的权限需用户手势授权，无法自动完成。）'
      );
      return 4;
    case 'error':
      console.error('✗ 导出失败:', msg.message || '(未知错误)');
      return 1;
    case 'result': {
      try {
        const { folder, written } = deliver(msg.filename, msg.dataUrl, outDir);
        console.log(`✓ 已导出到 ${path.resolve(folder)}`);
        for (const w of written) console.log('   -', w);
        return 0;
      } catch (e) {
        console.error('✗ 写入失败:', e instanceof Error ? e.message : String(e));
        return 1;
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
