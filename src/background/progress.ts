import type { ExportAction, ExportProgress, TaskStatus } from '../shared/types';
import { MSG } from '../shared/constants';
import { setRuntimeState } from '../shared/storage';

/**
 * 进度 sink —— 桥接模式下把进度同步转发给 CC（经原生宿主）。
 * 设为 null 即只走 UI 推送。
 */
type ProgressSink = (p: ExportProgress) => void;
let _progressSink: ProgressSink | null = null;
export function setProgressSink(sink: ProgressSink | null): void {
  _progressSink = sink;
}

/**
 * 统一的进度上报：写入运行时状态 + 向 UI 推送 PROGRESS 消息。
 * UI 离线（侧边栏未打开）时 sendMessage 会 reject，忽略即可——
 * 重新打开时会通过 GET_STATUS 拉取 lastProgress。
 */
export async function reportProgress(
  action: ExportAction,
  status: TaskStatus,
  message: string,
  percent?: number
): Promise<void> {
  const progress: ExportProgress = { action, status, message, percent };
  _progressSink?.(progress);
  await setRuntimeState({ lastProgress: progress });
  chrome.runtime
    .sendMessage({ type: MSG.PROGRESS, data: progress })
    .catch(() => {});
}
