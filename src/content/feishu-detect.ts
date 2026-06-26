import type { DocInfo, FeishuDocType } from '../shared/types';
import { FEISHU_HOSTS, FEISHU_TOKEN_RE } from '../shared/constants';

/** URL 路径段 → 文档类型映射 */
const PATH_TYPE_MAP: Record<string, FeishuDocType> = {
  docx: 'docx',
  docs: 'docs',
  wiki: 'wiki',
  sheets: 'sheets',
  base: 'base',
  file: 'file',
};

/** 判断 host 是否属于受支持的飞书域名（含私有化部署的子域） */
export function isFeishuHost(host: string): boolean {
  return FEISHU_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * 从当前页面 URL 解析飞书文档信息。
 * 形如 https://xxx.feishu.cn/docx/<token> / /wiki/<token> 等。
 */
export function detectDocFromUrl(url: string): DocInfo {
  const base: DocInfo = {
    isFeishuDoc: false,
    docType: 'unknown',
    token: '',
    title: '',
    url,
    host: '',
    isPrivateDeploy: false,
  };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return base;
  }

  base.host = parsed.host;

  // 路径：/<type>/<token>[/...]
  const segments = parsed.pathname.split('/').filter(Boolean);
  const docType = segments.length >= 2 ? PATH_TYPE_MAP[segments[0]] : undefined;
  const token = segments[1] ?? '';

  // 双信号识别：已知公有云域名直接信任；未知域名靠"路径 + token 正则"模式
  const known = isFeishuHost(parsed.host);
  const looksLikeFeishu = !!docType && FEISHU_TOKEN_RE.test(token);

  if (docType && (known || looksLikeFeishu)) {
    base.isFeishuDoc = true;
    base.docType = docType;
    base.token = token;
    base.isPrivateDeploy = !known; // 未知域名命中 → 标记私有化
  }

  return base;
}

/** 尽力从 DOM 中提取文档标题 */
export function extractTitle(): string {
  // 飞书文档标题通常在页面顶部的可编辑标题区域，先用通用回退
  const selectors = [
    '.docs-title input',
    '.title-content',
    '[data-testid="title"]',
    'h1',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = (el as HTMLInputElement)?.value || el?.textContent;
    if (text && text.trim()) return text.trim();
  }
  return document.title.replace(/ - 飞书.*$/, '').trim() || document.title;
}

/** 组合 URL + DOM，得到完整的当前页文档信息 */
export function detectCurrentDoc(): DocInfo {
  const info = detectDocFromUrl(location.href);
  if (info.isFeishuDoc) {
    info.title = extractTitle();
  }
  return info;
}
