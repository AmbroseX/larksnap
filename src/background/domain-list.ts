import { FEISHU_HOSTS } from '../shared/constants';
import { baseFromPattern } from '../shared/feishu-host';
import { getTrustedOrigins } from '../shared/storage';
import { listTrusted } from './permissions';

/**
 * 已授权域名清单（007）：new-doc 免链接建档的数据源。
 *
 * 清单 = manifest 内置公有云域名（FEISHU_HOSTS 常量，宪法原则 II：不新增硬编码）
 *      + 用户手势授权的私有域名（listTrusted() 的 pattern 剥基础域）。
 * 每项解析 sampleUrl（能真正建文档的真实租户 origin），优先级：
 *   A 授权时记下的 trustedOrigins → B 当前已打开标签的 origin → null（CLI 引导用户喂链接）。
 */

/** 域名清单条目（扩展 → daemon → CLI 原样透传） */
export interface DomainEntry {
  /** 基础域（如 a.example.com），不是 pattern */
  host: string;
  /** builtin = manifest 内置公有云；trusted = 用户手势授权的私有域名 */
  kind: 'builtin' | 'trusted';
  /** 能建文档的真实租户 origin（https://tenant.a.example.com），解析不出为 null */
  sampleUrl: string | null;
}

/** 纯核心：由采集好的输入合成清单（可单测，chrome 采集在 buildDomainList） */
export function composeDomainList(inputs: {
  builtin: readonly string[];
  trustedPatterns: string[];
  origins: Record<string, string>;
  openTabUrls: string[];
}): DomainEntry[] {
  const { builtin, trustedPatterns, origins, openTabUrls } = inputs;
  // 已打开标签的 host → origin（坏 URL 忽略）
  const tabOrigins: Array<{ host: string; origin: string }> = [];
  for (const url of openTabUrls) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        tabOrigins.push({ host: u.host, origin: u.origin });
      }
    } catch {
      /* 坏 URL 忽略 */
    }
  }
  const resolveSample = (base: string): string | null => {
    if (origins[base]) return origins[base]; // A：授权时记下的真实 origin
    const hit = tabOrigins.find((t) => t.host === base || t.host.endsWith(`.${base}`));
    return hit ? hit.origin : null; // B：已打开标签兜底；都没有 → null
  };
  const trustedBases = [
    ...new Set(trustedPatterns.map(baseFromPattern).filter((b): b is string => !!b)),
  ];
  return [
    ...builtin.map((h) => ({ host: h, kind: 'builtin' as const, sampleUrl: resolveSample(h) })),
    ...trustedBases.map((h) => ({ host: h, kind: 'trusted' as const, sampleUrl: resolveSample(h) })),
  ];
}

/** 采集 chrome 侧输入并合成清单（bridge 的 list-domains 消息用） */
export async function buildDomainList(): Promise<DomainEntry[]> {
  const [trustedPatterns, origins, tabs] = await Promise.all([
    listTrusted(),
    getTrustedOrigins(),
    chrome.tabs.query({}),
  ]);
  return composeDomainList({
    builtin: FEISHU_HOSTS,
    trustedPatterns,
    origins,
    openTabUrls: tabs.map((t) => t.url || ''),
  });
}
