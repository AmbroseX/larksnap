import type { DocInfo, Response } from '../shared/types';
import { EXTENSION_VERSION } from '../shared/constants';
import { getConfig, getMarkdownCapability } from '../shared/storage';
import { t } from '../shared/i18n';
import { reportProgress } from './progress';
import { resolveObjToken, fetchClientVars } from './feishu-api';
import { getSnapshot } from './feishu-proxy';

/** 诊断脱敏：必须显式剔除的 PII 字段（宪法原则 V、§8） */
const PII_KEYS = new Set([
  'editor_map',
  'user_map',
  'creator_id',
  'owner_id',
  'creator',
  'owner',
  'avatar_url',
  'email',
]);

/** 深度遍历剔除 PII 字段，返回脱敏后的副本 */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 12 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(k)) continue; // 剔除 PII
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 导出诊断信息（定位私有化飞书格式差异，§5.7）。
 * 收集：环境 + DocInfo + 脱敏 client_vars 样本 + Markdown 选路结论 + 快照摘要。
 */
export async function exportDiagnostic(doc: DocInfo | null): Promise<Response> {
  await reportProgress('diagnostic', 'running', t('progress.diagnostic.collecting'), 40);

  const config = await getConfig();

  // 诊断包附带配置便于排查，但打包前必须显式删除 AI 的 API Key——
  // 用户凭据绝不进诊断包（FR-006 取证点，宪法 V）
  const reportConfig: Record<string, unknown> = { ...config };
  if (config.ai) {
    const aiSafe: Record<string, unknown> = { ...config.ai };
    delete aiSafe.apiKey;
    reportConfig.ai = aiSafe;
  }

  // 块内容样本（脱敏）——仅在已识别+已授权时尝试，失败不阻断
  let blocksSample: unknown = null;
  let mdCapability: unknown = null;
  if (doc?.isFeishuDoc && !doc.needsAuth) {
    try {
      const resolved = await resolveObjToken(doc);
      const cv = await fetchClientVars(resolved);
      blocksSample = sanitize(cv);
      mdCapability = await getMarkdownCapability(doc.host);
    } catch (e) {
      blocksSample = { __error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 快照摘要（不含正文，仅长度/标题），受配置控制
  let snapshotSummary: unknown = null;
  if (config.diagnosticIncludeSnapshot && doc?.isFeishuDoc && !doc.needsAuth) {
    try {
      const snap = await getSnapshot();
      snapshotSummary = { title: snap.title, htmlLength: snap.html.length };
    } catch {
      snapshotSummary = null;
    }
  }

  await reportProgress('diagnostic', 'running', t('progress.diagnostic.packing'), 80);

  const report = {
    version: EXTENSION_VERSION,
    userAgent: navigator.userAgent,
    generatedAt: new Date().toISOString(),
    doc,
    mdCapability,
    blocksSample,
    snapshotSummary,
    config: reportConfig,
  };

  const json = JSON.stringify(report, null, 2);
  const dataUrl =
    'data:application/json;charset=utf-8,' + encodeURIComponent(json);
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: `larksnap-diagnostic-${Date.now()}.json`,
      saveAs: true,
    });
    await reportProgress('diagnostic', 'success', t('progress.diagnostic.done'), 100);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reportProgress('diagnostic', 'error', t('progress.diagnostic.failed', { msg: message }));
    return { success: false, error: message };
  }
}
