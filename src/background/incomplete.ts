import type { ClientVarsWarnings, Response } from '../shared/types';
import { t } from '../shared/i18n';

/**
 * 把 fetchClientVars 带回来的"可能不完整"标记翻成给人看的提示句。
 * 导出器拿到后：追加到成功文案（侧边栏可见）+ 写进 Response.data.warnings（桥接可见）。
 */
export function incompleteNotes(warnings?: ClientVarsWarnings): string[] {
  if (!warnings) return [];
  const notes: string[] = [];
  if (warnings.pagingTruncated) notes.push(t('progress.common.incompletePaging'));
  if (warnings.pagingStopped) notes.push(t('progress.common.incompleteStopped'));
  if (warnings.subtreeTruncated) notes.push(t('progress.common.incompleteSubtree'));
  return notes;
}

/** 成功文案 + 提示句，没有提示就原样返回 */
export function withNotes(message: string, notes: string[]): string {
  return notes.length ? `${message}\n${notes.join('\n')}` : message;
}

/** 成功响应：有提示就带上 data.warnings（桥接方据此在命令行打出来），没有就保持原样 */
export function okResponse(notes: string[]): Response {
  return notes.length ? { success: true, data: { warnings: notes } } : { success: true };
}
