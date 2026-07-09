import { CSRF_COOKIE_NAMES, MSG } from '../../shared/constants';

/**
 * 飞书内部接口请求封装 —— **运行在 content script（飞书页面上下文）**。
 *
 * 宪法原则 I 的落地：同源（`location.origin`）+ referer + `credentials:'include'`
 * + POST 带 `x-csrftoken`。SW 不得直发，必须经 CONTENT_MSG.FEISHU_REQUEST 转到这里。
 */

/** trace/request id：飞书要求 request-id / x-tt-trace-id */
function genReqId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return `${Date.now()}${Math.floor(performance.now())}`;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 经 SW 读 HttpOnly cookie；失败回退 document.cookie（非 HttpOnly 时可读） */
async function readCookie(name: string): Promise<string | null> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: MSG.GET_COOKIE,
      data: { name },
    })) as { data?: string } | undefined;
    if (res?.data) return res.data;
  } catch {
    /* ignore，走 document.cookie 回退 */
  }
  return document.cookie.match(new RegExp(`${name}=([^;]+)`))?.[1] ?? null;
}

/** 带退避重试的 fetch：缓解 policy-sdk 拦截导致的 `Failed to fetch` */
async function fetchWithRetry(
  input: string,
  init: RequestInit,
  retries = 2
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      await sleep(300 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function feishuGet<T = unknown>(path: string): Promise<T> {
  const res = await fetchWithRetry(`${location.origin}${path}`, {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json, text/plain, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** 把对象编成 x-www-form-urlencoded 串（跳过 undefined 值） */
function encodeForm(body: unknown): string {
  const obj = (body ?? {}) as Record<string, unknown>;
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/**
 * 单次 POST（指定 csrf cookie 名），返回解析后的 JSON 或文本。
 * form=true 时用 x-www-form-urlencoded 编码（explorer/create 一类接口只认表单，
 * 发 JSON 会报 code:2 Parameter Error）；默认仍走 JSON。
 */
async function postOnce(
  path: string,
  body: unknown,
  csrfName: string,
  form: boolean
): Promise<unknown> {
  const reqId = genReqId();
  const csrf = (await readCookie(csrfName)) ?? '';
  const res = await fetchWithRetry(`${location.origin}${path}`, {
    method: 'POST',
    mode: 'cors',
    credentials: 'include',
    referrer: location.href,
    referrerPolicy: 'strict-origin-when-cross-origin',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': form
        ? 'application/x-www-form-urlencoded'
        : 'application/json',
      'doc-biz': 'Lark',
      'request-id': reqId,
      'x-request-id': reqId,
      'x-tt-trace-id': reqId,
      'x-csrftoken': csrf,
    },
    body: form ? encodeForm(body) : JSON.stringify(body),
  });
  const text = await res.text();
  // 未登录时飞书返回纯文本 `403 csrf token error`，保留原文供上层判定
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text, __status: res.status };
  }
}

function isCsrfError(result: unknown): boolean {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const raw = String(r.__raw ?? '');
    const msg = String(r.msg ?? '');
    return /csrf/i.test(raw) || /csrf/i.test(msg);
  }
  return false;
}

export async function feishuPost<T = unknown>(
  path: string,
  body: unknown,
  form = false
): Promise<T> {
  let last: unknown;
  // CSRF cookie 候选名逐个尝试：收到 csrf 错误就换名重试
  for (const name of CSRF_COOKIE_NAMES) {
    last = await postOnce(path, body, name, form);
    if (!isCsrfError(last)) return last as T;
  }
  return last as T;
}
