import type { ActionId, DispatchContext, Response, TaskRecord } from '../shared/types';
import { STORAGE_KEYS } from '../shared/constants';

/**
 * 后台入口（右键/快捷键）的结果反馈（006，US5）：
 *   - 任务记录写 storage.session，键按 tabId 分片，每 tab 最近 10 条（浏览器重启自动清）
 *   - 角标用 chrome.action 的 per-tab badge：按 tab 隔离、tab 关闭自动消失
 *   - 清除时机：用户打开侧边栏（GET_STATUS）或切换到该 tab（tabs.onActivated）
 *   - 同 tab 并发：角标后写覆盖，任务记录各自保留
 * 不使用 chrome.notifications（省权限，badge + 侧边栏详情已能承载失败原因）。
 */

const MAX_RECORDS_PER_TAB = 10;
const BADGE_COLOR_OK = '#22c55e';
const BADGE_COLOR_FAIL = '#ef4444';

/** SW 休眠重启会归零；配合时间戳保证 id 唯一性足够 */
let seq = 0;

function tasksKey(tabId: number): string {
  return `${STORAGE_KEYS.TASKS_PREFIX}${tabId}`;
}

/** 读某 tab 的任务记录（新→旧）；形状不合法即丢弃，扩展更新瞬间不崩溃 */
export async function listTaskRecords(tabId: number): Promise<TaskRecord[]> {
  const key = tasksKey(tabId);
  const got = await chrome.storage.session.get(key);
  const list = got[key];
  if (!Array.isArray(list)) return [];
  return (list as TaskRecord[]).filter(
    (r) => r && typeof r.tabId === 'number' && typeof r.actionId === 'string'
  );
}

async function saveRecord(record: TaskRecord): Promise<void> {
  const list = await listTaskRecords(record.tabId);
  const idx = list.findIndex((r) => r.id === record.id);
  if (idx >= 0) list[idx] = record;
  else list.unshift(record);
  await chrome.storage.session.set({
    [tasksKey(record.tabId)]: list.slice(0, MAX_RECORDS_PER_TAB),
  });
}

async function setBadge(tabId: number, ok: boolean): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: ok ? BADGE_COLOR_OK : BADGE_COLOR_FAIL,
    });
    await chrome.action.setBadgeText({ tabId, text: ok ? '✓' : '!' });
  } catch {
    // tab 已关闭等：per-tab badge 随 tab 消亡，无需处理
  }
}

/** 清某 tab 的角标（用户已看到结果） */
export async function clearBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    // 同上
  }
}

/** 包装后台入口动作：先落 running 记录，结束落终态 + 设角标；异常不外抛，转为失败记录 */
export async function runTracked(
  actionId: ActionId,
  ctx: DispatchContext,
  run: () => Promise<Response>
): Promise<Response> {
  const record: TaskRecord = {
    id: `${ctx.tabId}-${Date.now()}-${seq++}`,
    tabId: ctx.tabId,
    actionId,
    status: 'running',
    startedAt: Date.now(),
  };
  await saveRecord(record);

  let res: Response;
  try {
    res = await run();
  } catch (err) {
    res = { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  record.status = res.success ? 'success' : 'error';
  if (!res.success) record.error = res.error || '';
  record.endedAt = Date.now();
  await saveRecord(record);
  await setBadge(ctx.tabId, !!res.success);
  return res;
}

/** SW 启动时注册（MV3 监听器必须在模块顶层同步注册）：切到该 tab 即清角标；tab 关闭清记录 */
export function setupBadge(): void {
  chrome.tabs.onActivated.addListener(({ tabId }) => void clearBadge(tabId));
  // per-tab badge 随 tab 关闭自动消失；任务记录也同步清掉，session 存储不留孤儿键
  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.session.remove(tasksKey(tabId)).catch(() => {});
  });
}
