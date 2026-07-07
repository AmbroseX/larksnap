// CC ⇄ 扩展 桥接（扩展侧）。
//
// 扩展是 WebSocket 客户端，主动连出到本地 daemon（仿 OpenCLI，无 native messaging）。
// 连 WS 前先 fetch /ping 探活（new WebSocket 连被拒端口会往扩展错误页刷不可捕获的
// ERR_CONNECTION_REFUSED）。alarms ~24s 保活 + 断线退避重连。
//
// 收到 daemon push 的 { type:'job', id, url, format } → 后台开标签页跑导出引擎，
// 用 download sink 截获产物（zip/md 的 data URL）经 WS 回传；登录/授权缺失回 need-*。
//
// 端口/路径需与 skills/larksnap-fetch/scripts/bridge/protocol.mjs 保持一致。
import type { DocInfo, ExportProgress, Response, WebCopyMdResult } from '../shared/types';
import { CONTENT_MSG } from '../shared/constants';
import { detectDocFromUrl, stripSiteSuffix } from '../content/feishu-detect';
import { hasPermissionForHost } from './permissions';
import { setContentTab } from './feishu-proxy';
import { safeName, setDownloadSink } from './download';
import { injectWebcopy, isRestrictedUrl, runAdapter, sendToTab } from './webcopy';
import { findAdapter } from './webcopy-adapters';
import { setProgressSink } from './progress';
import { exportMarkdown } from './exporters/markdown';
import { exportSheet } from './exporters/sheet';
import { exportPdf } from './exporters/pdf';
import { exportHtml } from './exporters/html';
import { track } from './analytics';

const PORT = 19925;
const PING_URL = `http://127.0.0.1:${PORT}/ping`;
const WS_URL = `ws://127.0.0.1:${PORT}/ext`;
// 需与 skills/larksnap-fetch/scripts/bridge/protocol.mjs 的 PROTOCOL_VERSION 一致；
// welcome 里对不上时置 protocolMismatch 提示用户更新（不硬断，避免升级期间全瘫）。
const PROTOCOL_VERSION = 1;
const KEEPALIVE_ALARM = 'larksnap-bridge-keepalive';
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 5000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let connecting = false;
let daemonVersion: string | null = null;
let protocolMismatch = false; // daemon 协议版本与本扩展不一致（提示更新 skill/扩展）
let contextId: string | null = null;

const CONTEXT_ID_KEY = 'larksnap:bridge:context-id';

/** 取/生成本安装的 profile code（持久化在 chrome.storage.local）。 */
async function getContextId(): Promise<string> {
  if (contextId) return contextId;
  try {
    const got = (await chrome.storage.local.get(CONTEXT_ID_KEY)) as Record<string, unknown>;
    const existing = got[CONTEXT_ID_KEY];
    if (typeof existing === 'string' && existing) {
      contextId = existing;
      return contextId;
    }
  } catch {
    /* 忽略 */
  }
  contextId = genContextId();
  try {
    await chrome.storage.local.set({ [CONTEXT_ID_KEY]: contextId });
  } catch {
    /* 忽略 */
  }
  return contextId;
}

function genContextId(): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

/** popup 查询桥接状态。 */
export async function getBridgeStatus(): Promise<{
  connected: boolean;
  reconnecting: boolean;
  daemonVersion: string | null;
  protocolMismatch: boolean;
  contextId: string;
  extensionVersion: string;
}> {
  return {
    connected: ws?.readyState === WebSocket.OPEN,
    reconnecting: reconnectTimer != null,
    daemonVersion,
    protocolMismatch,
    contextId: await getContextId(),
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

/** SW 启动时调用：建立连接 + alarms 保活。 */
export function startBridge(): void {
  void getContextId();
  void connect();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === KEEPALIVE_ALARM) void connect();
  });
}

function isActive(): boolean {
  return ws != null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

async function connect(): Promise<void> {
  if (isActive() || connecting) return;
  connecting = true;
  try {
    // 先探活：daemon 没起就别 new WebSocket（避免刷不可捕获的连接错误）
    try {
      const res = await fetch(PING_URL, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) return;
    } catch {
      return; // daemon 未运行 → 安静返回，等下次 alarm
    }
    if (isActive()) return;

    const sock = new WebSocket(WS_URL);
    ws = sock;
    sock.onopen = async () => {
      if (ws !== sock) return;
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const cid = await getContextId();
      if (ws !== sock) return;
      sock.send(
        JSON.stringify({
          type: 'hello',
          version: chrome.runtime.getManifest().version,
          protocolVersion: PROTOCOL_VERSION,
          contextId: cid,
        })
      );
      console.log('[larksnap] 桥接已连接 daemon');
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      void onMessage(ev.data as string);
    };
    sock.onclose = () => {
      if (ws === sock) {
        ws = null;
        daemonVersion = null;
        protocolMismatch = false;
      }
      scheduleReconnect();
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* 忽略 */
      }
    };
  } finally {
    connecting = false;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE * 2 ** (reconnectAttempts - 1), RECONNECT_MAX);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

interface HostMessage {
  type: string;
  id?: string;
  url?: string;
  format?: string;
  opts?: { keepTab?: boolean };
}

async function onMessage(raw: string): Promise<void> {
  let msg: HostMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === 'welcome') {
    const w = msg as { daemonVersion?: string; protocolVersion?: number };
    daemonVersion = w.daemonVersion ?? null;
    // 旧 daemon 不回 protocolVersion → 也视为不一致（提示更新 skill）
    protocolMismatch = w.protocolVersion !== PROTOCOL_VERSION;
    if (protocolMismatch) {
      console.warn(
        `[larksnap] 桥接协议版本不一致（扩展 v${PROTOCOL_VERSION} / daemon ${w.protocolVersion ?? '未知'}），请更新 larksnap-fetch 技能或重新构建扩展`
      );
    }
    return;
  }
  if (msg.type === 'job' && msg.id && msg.url) {
    await runJob({ id: msg.id, url: msg.url, format: msg.format || 'md', opts: msg.opts || {} });
  }
}

interface Job {
  id: string;
  url: string;
  format: string;
  opts: { keepTab?: boolean };
}

function reply(id: string, payload: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...payload, id }));
}

async function runJob(job: Job): Promise<void> {
  let tabId: number | undefined;
  let artifact: { url: string; filename: string } | null = null;
  try {
    const info = detectDocFromUrl(job.url);
    if (!info.isFeishuDoc) {
      // 普通网页：走 webcopy 通用管线转 Markdown
      await runWebpageJob(job, info.host);
      return;
    }

    // 私有化/未知域名权限：无法用代码申请（需用户手势），缺失则引导授权
    const granted = await hasPermissionForHost(info.host);
    if (!granted) {
      reply(job.id, { type: 'need-auth', host: info.host });
      return;
    }

    reply(job.id, { type: 'progress', message: '正在后台打开文档…', percent: 3 });
    const tab = await chrome.tabs.create({ url: job.url, active: false });
    tabId = tab.id;
    if (tabId == null) throw new Error('无法打开标签页');
    await waitForTabComplete(tabId);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });

    // 把后续 content 同源请求 / 进度 / 产物都接到本次任务
    setContentTab(tabId);
    setProgressSink((p: ExportProgress) => {
      reply(job.id, { type: 'progress', message: p.message, percent: p.percent });
    });
    setDownloadSink((a) => {
      artifact = a; // 最终产物（zip 或单文件 md/html/pdf 的 data URL）
    });

    // 取完整 DocInfo（含标题）；失败退回 URL 信息
    let doc: DocInfo = info;
    try {
      const full = (await chrome.tabs.sendMessage(tabId, {
        type: CONTENT_MSG.DETECT_DOC,
      })) as DocInfo | undefined;
      if (full?.isFeishuDoc) doc = full;
    } catch {
      /* 退回 URL 信息 */
    }
    // 标题兜底：DOM 没取到就用标签页标题，避免文件名退化成 token
    if (!doc.title) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.title) doc.title = stripSiteSuffix(tab.title);
      } catch {
        /* 忽略 */
      }
    }

    const fmt = (job.format || 'md').toLowerCase();
    let res: Response;
    if (doc.docType === 'sheets') {
      // 电子表格：无论请求什么格式，都走内存抽取 → Markdown + CSV（打包 zip）
      res = await exportSheet(doc);
    } else if (fmt === 'pdf') res = await exportPdf(doc);
    else if (fmt === 'html') res = await exportHtml(doc);
    else res = await exportMarkdown(doc);

    void track({
      name: 'bridge',
      url: '/bridge/task',
      data: { ok: !!res?.success && !!artifact },
    });
    if (!res?.success) {
      const message = res?.error || '导出失败';
      // 导出器把 NotLoggedInError 收敛为 error 文案，这里据文案识别登录态
      if (/登录|not.?logged|login/i.test(message)) reply(job.id, { type: 'need-login' });
      else reply(job.id, { type: 'error', message });
    } else if (!artifact) {
      reply(job.id, { type: 'error', message: '导出成功但未捕获到产物（sink 未命中）' });
    } else {
      reply(job.id, {
        type: 'result',
        filename: (artifact as { filename: string }).filename,
        dataUrl: (artifact as { url: string }).url,
      });
    }
  } catch (err) {
    void track({ name: 'bridge', url: '/bridge/task', data: { ok: false } });
    const message = err instanceof Error ? err.message : String(err);
    reply(job.id, { type: 'error', message });
  } finally {
    setDownloadSink(null);
    setProgressSink(null);
    setContentTab(null);
    if (tabId != null && job.opts.keepTab !== true) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 标签页可能已被关闭 */
      }
    }
  }
}

/**
 * 普通网页任务：后台开标签页 → 注入 webcopy.js → 整页转 Markdown 回传。
 * 只支持 md 格式；产物是单个 .md 文件，图片保留为外链绝对 URL（不下载）。
 */
async function runWebpageJob(job: Job, host: string): Promise<void> {
  const fmt = (job.format || 'md').toLowerCase();
  // 开标签页之前先把能挡的都挡掉：格式 → 保留页 → 域名权限
  if (fmt !== 'md') {
    reply(job.id, { type: 'error', message: `普通网页只支持 md 格式（当前请求 ${fmt}）` });
    return;
  }
  if (isRestrictedUrl(job.url)) {
    reply(job.id, { type: 'error', message: '此页面不支持转换（浏览器保留页面或非 http/https 链接）' });
    return;
  }
  if (!(await hasPermissionForHost(host))) {
    // kind 字段让 Skill 端把授权引导话术切到普通网页口径
    reply(job.id, { type: 'need-auth', host, kind: 'webpage' });
    return;
  }

  let tabId: number | undefined;
  try {
    reply(job.id, { type: 'progress', message: '正在后台打开网页…', percent: 5 });
    const tab = await chrome.tabs.create({ url: job.url, active: false });
    tabId = tab.id;
    if (tabId == null) throw new Error('无法打开标签页');
    await waitForTabComplete(tabId);

    // 适配器站点（小红书等）：正文不在 DOM 里或必须持登录态，先于通用管线走主世界抓取。
    // 用标签页最终 URL 匹配（xhslink.com 等短链 302 后才落到真实域名）。
    let finalUrl = job.url;
    try {
      finalUrl = (await chrome.tabs.get(tabId)).url || job.url;
    } catch {
      /* 用原 URL */
    }
    let md: WebCopyMdResult | null = null;
    const adapter = findAdapter(finalUrl);
    if (adapter) {
      const finalHost = new URL(finalUrl).hostname;
      if (finalHost !== host && !(await hasPermissionForHost(finalHost))) {
        // 短链跳转后落在未授权域名：按最终域名引导授权
        reply(job.id, { type: 'need-auth', host: finalHost, kind: 'webpage' });
        return;
      }
      reply(job.id, { type: 'progress', message: '正在提取页面内容…', percent: 60 });
      const r = await runAdapter(tabId, adapter);
      if (r?.abort === 'need-login') {
        // 带 host+kind 让 fetch.mjs 按站点措辞（默认文案写死了"飞书"）
        reply(job.id, { type: 'need-login', host: finalHost, kind: 'webpage' });
        return;
      }
      if (r?.abort) {
        void track({ name: 'bridge', url: '/bridge/task', data: { ok: false, kind: 'webpage' } });
        reply(job.id, { type: 'error', message: r.note || '页面无法抓取' });
        return;
      }
      if (r?.markdown) md = r;
      // r == null：适配器不适用此页 → 退通用管线
    }

    if (!md) {
      reply(job.id, { type: 'progress', message: '正在转换为 Markdown…', percent: 60 });
      await injectWebcopy(tabId);
      const res = await sendToTab<WebCopyMdResult>(tabId, CONTENT_MSG.WEBCOPY_PAGE_TO_MD, {});
      if (!res.success || !res.data?.markdown) {
        void track({ name: 'bridge', url: '/bridge/task', data: { ok: false, kind: 'webpage' } });
        reply(job.id, { type: 'error', message: res.error || '网页转换失败' });
        return;
      }
      md = res.data;
    }

    // 标题兜底用标签页标题原值（普通网页不去飞书站点后缀）
    let title = md.title;
    if (!title) {
      try {
        title = (await chrome.tabs.get(tabId)).title || '';
      } catch {
        /* 忽略 */
      }
    }
    // safeName 是落盘安全的唯一防线：Skill 端写文件不再清洗文件名
    const filename = `${safeName(title || '网页')}.md`;
    void track({ name: 'bridge', url: '/bridge/task', data: { ok: true, kind: 'webpage' } });
    reply(job.id, {
      type: 'result',
      filename,
      dataUrl: `data:text/markdown;charset=utf-8,${encodeURIComponent(md.markdown)}`,
    });
  } catch (err) {
    void track({ name: 'bridge', url: '/bridge/task', data: { ok: false, kind: 'webpage' } });
    reply(job.id, { type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (tabId != null && job.opts.keepTab !== true) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 标签页可能已被关闭 */
      }
    }
  }
}

/** 等标签页加载完成（飞书为 SPA，complete 后再宽限一会儿让页面上下文就绪）。 */
function waitForTabComplete(tabId: number, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          setTimeout(resolve, 1500); // SPA 渲染/cookie 就绪宽限
          return;
        }
      } catch {
        reject(new Error('标签页已关闭'));
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('打开文档超时'));
        return;
      }
      setTimeout(tick, 300);
    };
    void tick();
  });
}
