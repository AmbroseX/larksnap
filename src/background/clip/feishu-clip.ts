/**
 * 「剪存」协议客户端 —— 把任意 HTML 内容转存为飞书云文档。
 *
 * 协议来源：对目标扩展「飞书转存专家」v0.8.19 的逆向分析
 * （见 feishu-export/doc/02-feishu-api-and-clip-protocol.md）。
 * 它为浏览器扩展复用飞书官方「剪存」的私有上传通道：
 *
 *   ① box/upload/prepare          → upload_id + 分块参数
 *   ② merge_block × N（可批量）    → 上传 HTML 字节（Adler-32 校验）
 *   ③ box/upload/finish           → file_token
 *   ④ parser/wiki/parse_html      → ticket（提交解析任务）
 *   ⑤ parser/wiki/clip/result     → 轮询拿 docUrl
 *
 * 小于 30MB 的内容可直接走 ④ 的 multipart 直传（file 字段），跳过 ①②③。
 *
 * 约束：HTML 正文由任意页面的 content script（webcopy）提取，其余全部请求都在
 * SW 侧发起——internal-api-space.* 与页面主域不同，靠 host 权限（*.feishu.cn /
 * *.larksuite.com）直接 fetch（带 credentials），并用 DNR 规则把 Origin/Referer
 * 改成飞书租户域（与目标扩展同款做法；规则用完即删）。
 */

import { clipHostFor, CLIP_COVER_ICON, CLIP_VERSION } from '../../shared/constants';
import { t } from '../../shared/i18n';

/** 30MB 直传上限（超过走分块上传） */
const DIRECT_UPLOAD_LIMIT = 30 * 1024 * 1024;

/** 各步骤超时（ms），对齐目标扩展实测值 */
const T_PREPARE = 30_000;
const T_MERGE = 120_000;
const T_PARSE = 60_000;
const T_RESULT = 20_000;
const RESULT_POLL_MAX = 100;

export interface ClipProgress {
  /** 0-100 */
  percent: number;
  message: string;
}

export interface ClipResult {
  docUrl: string;
}

export interface ClipInput {
  /** HTML 原文（Blob 或字符串） */
  html: string | Blob;
  /** 文档标题 */
  title: string;
  /** 来源 URL（写进文档元信息） */
  originUrl: string;
  /** 租户页面 host（如 my.feishu.cn / example.corp.com），用于推导解析服务域名 */
  host: string;
  /** 租户页面 origin（如 https://my.feishu.cn），用于 DNR 伪装请求头；缺省按 https+host 推导 */
  origin?: string;
  onProgress?: (p: ClipProgress) => void;
}

/** 带超时的 fetch（失败抛中文错误） */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMsg: string
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`${timeoutMsg}（>${Math.round(timeoutMs / 1000)}s）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 未登录判定（与目标扩展同款关键字） */
const LOGIN_RE = /please\s+log\s+in|to view this content|login required|请.*登录|未登录/i;

function isLoginError(payload: string): boolean {
  return LOGIN_RE.test(payload);
}

function uuid(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.floor(Math.random() * 16);
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}

/** 解析响应：非 2xx / 未登录 / code!=0 均抛错 */
async function parseJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '');
  if (isLoginError(text)) throw new Error(t('clip.notLoggedIn'));
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 240)}`);
  try {
    return JSON.parse(text || '{}') as Record<string, unknown>;
  } catch {
    throw new Error(`${what}: 响应不是 JSON：${text.slice(0, 120)}`);
  }
}

/** Adler-32 校验（飞书上传块校验用；与 RFC 1950 一致，输出无符号 32 位整数） */
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** 分块（blockSize 由服务端给定） */
function splitChunks(bytes: Uint8Array, blockSize: number, numBlocks: number) {
  const chunks: { sequenceNumber: number; data: Uint8Array; size: number }[] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks && offset < bytes.length; i++) {
    const end = Math.min(offset + blockSize, bytes.length);
    chunks.push({ sequenceNumber: i, data: bytes.slice(offset, end), size: end - offset });
    offset = end;
  }
  return chunks;
}

/**
 * 动态 DNR 规则：把 internal-api-space.* 的 Origin/Referer 改成租户域
 * （模拟从租户页面发出的请求；规则用完即删）。
 * 规则 id 用独立段位避免与目标扩展/其它规则冲突。
 */
const CLIP_RULE_IDS = [33901, 33902];

async function withClipRefererRules<T>(origin: string, run: () => Promise<T>): Promise<T> {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return run();
  const referer = `${origin}/`;
  try {
    await dnr.updateDynamicRules({
      removeRuleIds: [...CLIP_RULE_IDS],
      addRules: [
        {
          id: CLIP_RULE_IDS[0],
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [
              { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: origin },
              { header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: referer },
            ],
          },
          condition: {
            urlFilter: '||internal-api-space.feishu.cn/space/api/parser/wiki/',
            resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
          },
        },
        {
          id: CLIP_RULE_IDS[1],
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [
              { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: origin },
              { header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: referer },
            ],
          },
          condition: {
            urlFilter: '||internal-api-space-sg.larksuite.com/space/api/parser/wiki/',
            resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
          },
        },
      ],
    });
  } catch (err) {
    // 规则加不上不致命：继续尝试直接上传（与目标扩展一致）
    console.warn('[larksnap] 设置剪存 Referer 规则失败，继续尝试直接上传', err);
    return run();
  }
  try {
    return await run();
  } finally {
    await dnr.updateDynamicRules({ removeRuleIds: [...CLIP_RULE_IDS] }).catch(() => {});
  }
}

/**
 * 转存 HTML 到飞书文档。返回新建文档的 URL。
 */
export async function clipHtmlToFeishu(input: ClipInput): Promise<ClipResult> {
  const { title, originUrl, host, onProgress } = input;
  const origin = input.origin ?? `https://${host}`;
  const htmlBlob =
    input.html instanceof Blob
      ? input.html
      : new Blob([input.html], { type: 'text/html;charset=utf-8' });

  // 文件名走 text/plain（飞书用它当文档标题）
  const file = new File([await htmlBlob.text()], title, { type: 'text/plain' });

  return withClipRefererRules(origin, async () => {
    onProgress?.({ percent: 20, message: t('clip.submitting') });

    let ticket: string;
    if (file.size > DIRECT_UPLOAD_LIMIT) {
      onProgress?.({ percent: 30, message: t('clip.chunking') });
      ticket = await uploadInChunks(file, title, originUrl, host, onProgress);
    } else {
      ticket = await parseHtmlDirect(file, title, originUrl, host);
    }

    onProgress?.({ percent: 82, message: t('clip.waitingResult') });
    const docUrl = await pollClipResult(ticket, host, onProgress);
    return { docUrl };
  });
}

/** 小文件路径：parse_html 直接 multipart 附带文件 */
async function parseHtmlDirect(
  file: File,
  title: string,
  originUrl: string,
  host: string
): Promise<string> {
  const form = new FormData();
  form.append('description', '');
  form.append('cover', '');
  form.append('originUrl', originUrl);
  form.append('lang', 'zh-CN');
  form.append('clipVersion', CLIP_VERSION);
  form.append('docType', 'docx');
  form.append('file', file, title);

  const res = await fetchWithTimeout(
    `${clipHostFor(host)}/space/api/parser/wiki/parse_html/`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Request-Id': uuid(), 'X-Request-Source': 'feishu-clipper', env: 'false' },
      body: form,
    },
    T_PARSE,
    t('clip.parseTimeout')
  );
  const json = await parseJson(res, t('clip.parseFailed'));
  const ticket = json.ticket as string | undefined;
  if (!ticket) {
    throw new Error(t('clip.parseNoTicket', { msg: String(json.msg || json.message || '') }));
  }
  return ticket;
}

/** 大文件路径：prepare → merge_block → finish → parse_html(fileToken) */
async function uploadInChunks(
  file: File,
  title: string,
  originUrl: string,
  host: string,
  onProgress?: (p: ClipProgress) => void
): Promise<string> {
  // ① prepare
  const prepRes = await fetchWithTimeout(
    `${clipHostFor(host)}/space/api/box/upload/prepare/`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Request-Id': uuid(),
        'X-Request-Source': 'feishu-clipper',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mount_node_token: '',
        mount_point: 'wiki_confluence',
        name: title,
        size: file.size,
      }),
    },
    T_PREPARE,
    t('clip.prepareTimeout')
  );
  const prep = await parseJson(prepRes, t('clip.prepareFailed'));
  const prepData = (prep.data ?? {}) as Record<string, unknown>;
  if (prep.code !== 0 || !prepData.upload_id) {
    throw new Error(
      t('clip.prepareFailed') + `: ${String(prep.msg || prep.code || 'unknown')}`
    );
  }
  const uploadId = prepData.upload_id as string;
  const blockSize = Number(prepData.block_size || Math.ceil(file.size / 3));
  const numBlocks = Number(prepData.num_blocks || 3);
  const optionBlockSize = Number(prepData.option_block_size || blockSize * 4);
  const blocksPerBatch = Math.max(1, Math.round(optionBlockSize / blockSize));

  // ② 分块 + 校验和
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks = splitChunks(bytes, blockSize, numBlocks);
  const checksums: number[] = [];
  for (const chunk of chunks) {
    checksums.push(adler32(chunk.data));
  }

  // 分批 merge_block；批失败则逐块重试
  for (let i = 0; i < chunks.length; i += blocksPerBatch) {
    const batch = chunks.slice(i, i + blocksPerBatch);
    const seqList = batch.map((c) => c.sequenceNumber);
    const batchSums = seqList.map((seq) => checksums[seq]);
    const batchBytes = mergeBytes(batch.map((c) => c.data));
    onProgress?.({
      percent: 30 + Math.round((i / chunks.length) * 45),
      message: t('clip.uploading', {
        done: Math.min(i + batch.length, chunks.length),
        total: chunks.length,
      }),
    });
    try {
      await mergeBlock(uploadId, host, batchBytes, seqList, batchSums, blockSize);
    } catch {
      // 批失败 → 逐块重试（对齐目标扩展的 Ue() 降级）
      for (const chunk of batch) {
        await mergeBlock(
          uploadId,
          host,
          chunk.data,
          [chunk.sequenceNumber],
          [checksums[chunk.sequenceNumber]],
          chunk.size
        );
      }
    }
  }

  // ③ finish
  const finishRes = await fetchWithTimeout(
    `${clipHostFor(host)}/space/api/box/upload/finish/`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Request-Id': uuid(),
        'X-Request-Source': 'feishu-clipper',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ upload_id: uploadId, num_blocks: numBlocks }),
    },
    T_PREPARE,
    t('clip.finishTimeout')
  );
  const finish = await parseJson(finishRes, t('clip.finishFailed'));
  const finishData = (finish.data ?? {}) as Record<string, unknown>;
  const fileToken = finishData.file_token as string | undefined;
  if (finish.code !== 0 || !fileToken) {
    throw new Error(
      t('clip.finishFailed') + `: ${String(finish.msg || finish.code || 'unknown')}`
    );
  }

  // ④ parse_html（fileToken 路径）
  const form = new FormData();
  form.append('description', '');
  form.append('cover', CLIP_COVER_ICON);
  form.append('docType', 'docx');
  form.append('originUrl', originUrl);
  form.append('clipVersion', CLIP_VERSION);
  form.append('lang', 'zh-CN');
  form.append('fileToken', fileToken);
  form.append('title', title);

  const parseRes = await fetchWithTimeout(
    `${clipHostFor(host)}/space/api/parser/wiki/parse_html/`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Request-Id': uuid(), 'X-Request-Source': 'feishu-clipper', env: 'false' },
      body: form,
    },
    T_PARSE,
    t('clip.parseTimeout')
  );
  const parseJsonRes = await parseJson(parseRes, t('clip.parseFailed'));
  const ticket = parseJsonRes.ticket as string | undefined;
  if (!ticket) {
    throw new Error(
      t('clip.parseNoTicket', { msg: String(parseJsonRes.msg || parseJsonRes.message || '') })
    );
  }
  return ticket;
}

/** 单次 merge_block 请求 */
async function mergeBlock(
  uploadId: string,
  host: string,
  body: Uint8Array,
  seqList: number[],
  checksums: number[],
  originSize: number
): Promise<void> {
  const res = await fetchWithTimeout(
    `${clipHostFor(host)}/space/api/box/stream/upload/merge_block/?upload_id=${encodeURIComponent(uploadId)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Request-Id': uuid(),
        'X-Request-Source': 'feishu-clipper',
        'Content-Type': 'application/octet-stream',
        'x-seq-list': seqList.join(','),
        'x-block-list-checksum': checksums.join(','),
        'x-block-origin-size': String(originSize),
      },
      body: new Blob([body as BlobPart]),
    },
    T_MERGE,
    t('clip.mergeTimeout')
  );
  const json = await parseJson(res, t('clip.mergeFailed'));
  if (json.code !== 0) {
    throw new Error(t('clip.mergeFailed') + `: ${String(json.msg || json.code || 'unknown')}`);
  }
}

/** 拼接多个分块为单个 Uint8Array */
function mergeBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** ⑤ 轮询 clip/result 直到拿到 docUrl */
async function pollClipResult(
  ticket: string,
  host: string,
  onProgress?: (p: ClipProgress) => void
): Promise<string> {
  for (let round = 1; round <= RESULT_POLL_MAX; round++) {
    const rand = Math.random().toString(36).slice(2);
    const res = await fetchWithTimeout(
      `${clipHostFor(host)}/space/api/parser/wiki/clip/result?_r=${rand}_${Date.now()}&ticket=${encodeURIComponent(ticket)}`,
      {
        method: 'GET',
        credentials: 'include',
        headers: { 'x-request-source': 'feishu-clipper' },
      },
      T_RESULT,
      t('clip.resultTimeout')
    );
    if (res.ok) {
      const text = await res.text();
      if (isLoginError(text)) throw new Error(t('clip.notLoggedIn'));
      if (text.trim()) {
        const json = JSON.parse(text) as { docUrl?: string };
        if (json.docUrl) {
          onProgress?.({ percent: 100, message: t('clip.done') });
          return json.docUrl;
        }
      }
    }
    onProgress?.({
      percent: Math.min(99, 82 + Math.round((round / RESULT_POLL_MAX) * 17)),
      message: t('clip.polling', { round }),
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(t('clip.pollTimeout'));
}
