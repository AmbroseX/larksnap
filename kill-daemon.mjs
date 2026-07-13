#!/usr/bin/env node
// 停掉 larksnap daemon（macOS / Linux / Windows 通用）。
// 带 --restart（或 -r）时，停完再拉起一个新的并等它 ready。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { PID_PATH, DAEMON_VERSION } from './skills/larksnap-fetch/scripts/bridge/protocol.mjs';
import { ping } from './skills/larksnap-fetch/scripts/bridge/client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = path.join(HERE, 'skills/larksnap-fetch/scripts/bridge/daemon.mjs');
const IS_WIN = process.platform === 'win32';
const RESTART = process.argv.slice(2).some((a) => a === '--restart' || a === '-r');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM：进程在但不属于当前用户，也算活着
    return e.code === 'EPERM';
  }
}

function force(pid) {
  if (IS_WIN) execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
  else process.kill(pid, 'SIGKILL');
}

/** 停掉 PID 文件里记的 daemon；返回是否真的停了一个在跑的进程。 */
async function stopDaemon() {
  const raw = fs.existsSync(PID_PATH) ? fs.readFileSync(PID_PATH, 'utf8').trim() : '';
  const pid = Number(raw);
  if (!raw || !Number.isInteger(pid) || pid <= 0) {
    console.log('没有 PID 文件，daemon 应该没在跑：' + PID_PATH);
    return false;
  }
  if (!alive(pid)) {
    fs.rmSync(PID_PATH, { force: true });
    console.log(`PID ${pid} 已经不在了，清掉了残留的 PID 文件`);
    return false;
  }

  // 先温和地停：Windows 上 process.kill 走的是 TerminateProcess，同样有效
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    force(pid);
  }
  // 最多等 3 秒，还赖着就强杀
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  if (alive(pid)) force(pid);

  fs.rmSync(PID_PATH, { force: true });
  console.log(`daemon 已停止（PID ${pid}）`);
  return true;
}

/** 拉起一个新 daemon 并等它能应答 /ping。 */
async function startDaemon() {
  if (!fs.existsSync(DAEMON_PATH)) {
    console.error(`✗ 找不到 daemon：${DAEMON_PATH}`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [DAEMON_PATH], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const v = await ping();
    if (v) {
      console.log(`daemon 已启动（v${v}${v === DAEMON_VERSION ? '' : `，本地代码是 v${DAEMON_VERSION}`}）`);
      return;
    }
  }
  console.error('✗ daemon 起来了但 5 秒内没应答 /ping，看下 ~/.larksnap/daemon.log');
  process.exit(1);
}

await stopDaemon();
if (RESTART) {
  // 端口还没释放干净就拉新的会撞车，等到 ping 不通再起
  for (let i = 0; i < 20 && (await ping()); i++) await sleep(100);
  await startDaemon();
}
