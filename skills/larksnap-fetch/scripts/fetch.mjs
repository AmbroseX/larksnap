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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipInto, writeDataUrl } from './unzip.mjs';
import { fail, ensureDaemon, postCommand, ERROR_KINDS } from './bridge/client.mjs';

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

// 错误契约（fail/退出码派生）与 daemon 管理、/command 流式请求都在 bridge/client.mjs，
// 与 edit.mjs 共用。本文件只负责 fetch 自己的参数、产物落盘与图片本地化。
if (!url || !outDir) {
  fail({
    type: 'usage',
    subtype: 'bad_args',
    message: '缺少参数：需要 <飞书链接> 和 <输出目录>。',
    hint: '用法: fetch.mjs <飞书链接> <输出目录> [--format md|pdf|html] [--profile <code>]',
  });
}

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
  await ensureDaemon(DAEMON_PATH, fail);
  await postCommand(
    { url, format, opts: {}, contextId: profile || undefined },
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
      // kind==='webpage'：普通网页（如小红书）要求登录的是站点本身，不是飞书，按 host 措辞
      fail({
        type: 'authentication',
        subtype: 'need_login',
        message:
          msg.kind === 'webpage'
            ? `需要登录：浏览器里没有 ${msg.host || '该网站'} 的登录态。`
            : '需要登录：浏览器里没有该域名的飞书登录态。',
        hint:
          msg.kind === 'webpage'
            ? `让用户在 Chrome 中打开并登录 ${msg.host || '该网站'}，登录完成后重跑本命令。`
            : '让用户在 Chrome 中打开该文档域名并登录飞书，登录完成后重跑本命令。',
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
        // 小红书等站点的 CDN 图片外链下载到本地（异步，全部落地后才打结果退出）
        return localizeCdnImages(folder, written).then((extra) => {
          console.log(`✓ 已导出到 ${path.resolve(folder)}`);
          for (const w of [...written, ...extra]) console.log('   -', w);
          return 0;
        });
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

// ==================== CDN 图片本地化 ====================
// 小红书图片 CDN 允许非浏览器客户端直接下载（实测无 TLS 指纹拦截，且带
// Access-Control-Allow-Origin: *），把 md 里这些外链图片下载到 images/ 并
// 改写为相对路径。链接有时效签名，抓完立刻下载最稳。只认这几个域名族，
// 其他网站的图片维持外链不动（很多站点会拦非浏览器请求，下载大概率失败）。
const IMAGE_CDN_HOSTS = /(^|\.)(xhscdn\.com|xiaohongshu\.com|rednote\.com)$/;
const IMAGE_EXT_BY_TYPE = {
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/** 下载 md 产物里命中 CDN 域名的图片；返回新增文件的相对路径列表。失败不致命，保留外链。 */
async function localizeCdnImages(folder, written) {
  const extra = [];
  for (const rel of written) {
    if (!/\.md$/i.test(rel)) continue;
    const mdPath = path.join(outDir, rel);
    let md;
    try {
      md = fs.readFileSync(mdPath, 'utf8');
    } catch {
      continue;
    }
    const links = [
      ...new Set([...md.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1])),
    ].filter((u) => {
      try {
        return IMAGE_CDN_HOSTS.test(new URL(u).hostname);
      } catch {
        return false;
      }
    });
    if (links.length === 0) continue;

    process.stderr.write(`… 正在下载 ${links.length} 张图片…\n`);
    const imagesDir = path.join(folder, 'images');
    let seq = 0;
    let okCount = 0;
    for (const link of links) {
      seq++;
      try {
        const res = await fetch(link, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error('空响应');
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        const name = `img-${String(seq).padStart(2, '0')}${IMAGE_EXT_BY_TYPE[type] || '.webp'}`;
        fs.mkdirSync(imagesDir, { recursive: true });
        fs.writeFileSync(path.join(imagesDir, name), buf);
        md = md.split(link).join(`images/${name}`);
        extra.push(path.join(path.basename(folder), 'images', name));
        okCount++;
      } catch {
        // 单张失败：md 里保留这张的外链，继续下一张
      }
    }
    if (okCount > 0) {
      try {
        fs.writeFileSync(mdPath, md);
      } catch {
        /* 改写失败不影响已交付的 md */
      }
    }
    if (okCount < links.length) {
      process.stderr.write(`… ${links.length - okCount} 张图片下载失败，md 中保留外链\n`);
    }
  }
  return extra;
}
