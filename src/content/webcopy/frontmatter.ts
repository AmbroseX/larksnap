import type { ArticleMeta } from './extract';

/**
 * YAML frontmatter（002 US3）：title/source/author/published/description/clipped，
 * 缺字段整键省略。值统一双引号包裹并转义，防冒号/引号破坏 YAML。
 */

function yamlValue(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

export function buildFrontmatter(meta: ArticleMeta, url: string): string {
  const fields: Array<[string, string | undefined]> = [
    ['title', meta.title],
    ['source', url],
    ['author', meta.author],
    ['published', meta.published],
    ['description', meta.description],
    ['clipped', new Date().toISOString()],
  ];
  const lines = fields
    .filter((f): f is [string, string] => !!f[1] && f[1].trim().length > 0)
    .map(([k, v]) => `${k}: ${yamlValue(v.trim())}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}
