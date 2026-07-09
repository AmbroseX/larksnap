import type { InlineNode } from '../../shared/types';

/**
 * InlineNode[] → HTML 行内片段（粗体/斜体/删除线/行内代码/链接/公式）。
 *
 * 小红书卡片与公众号排版共用这一个工具（DRY，见 2026-07-09 两份方案）。
 * 输出只含行内标签，块级结构由各渲染器自己套。
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function inlineToHtml(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      if (n.text === '\n') return '<br>';
      // 行内公式：卡片/公众号都渲染不了 LaTeX，以代码样式保留源码
      if (n.equation) return `<code>${escapeHtml(n.equation.trim())}</code>`;
      let t = escapeHtml(n.text);
      if (n.inlineCode) t = `<code>${t}</code>`;
      if (n.bold) t = `<strong>${t}</strong>`;
      if (n.italic) t = `<em>${t}</em>`;
      if (n.strike) t = `<s>${t}</s>`;
      if (n.underline) t = `<u>${t}</u>`;
      const styles: string[] = [];
      if (n.color) styles.push(`color:${n.color}`);
      if (n.background) styles.push(`background-color:${n.background}`);
      // 卡片是静态图片，链接点不了，保留文字并加下划线示意
      if (n.link) styles.push('text-decoration:underline');
      if (styles.length) t = `<span style="${styles.join(';')}">${t}</span>`;
      return t;
    })
    .join('');
}

/**
 * 公众号版行内渲染：编辑器会丢掉 class 和大部分语义标签的默认样式，
 * 所以粗体/斜体等全部落成内联 CSS（crx 逆向规则，方案 §二）。
 */
export function inlineToWechatHtml(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      if (n.text === '\n') return '<br>';
      if (n.equation) return wechatInlineCode(escapeHtml(n.equation.trim()));
      const t = escapeHtml(n.text);
      if (n.inlineCode) return wechatInlineCode(t);

      const styles: string[] = [];
      if (n.bold) styles.push('font-weight:700');
      if (n.italic) styles.push('font-style:italic');
      const deco: string[] = [];
      if (n.strike) deco.push('line-through');
      if (n.underline) deco.push('underline');
      if (deco.length) styles.push(`text-decoration:${deco.join(' ')}`);
      if (n.color) styles.push(`color:${n.color}`);
      if (n.background) styles.push(`background-color:${n.background}`);
      if (n.link) {
        // 公众号会剥掉外链 <a> 但保留文字；配色示意这是个链接
        styles.push('color:#576b95');
        return `<a href="${escapeHtml(n.link)}" style="${styles.join(';')}">${t}</a>`;
      }
      return styles.length ? `<span style="${styles.join(';')}">${t}</span>` : t;
    })
    .join('');
}

/** 行内代码：灰底 + 1px 边框 + 圆角（crx 实测公众号能保留的写法） */
function wechatInlineCode(escaped: string): string {
  return (
    '<code style="background:rgb(245,246,247);border:1px solid rgba(0,0,0,0.08);' +
    'border-radius:4px;padding:1px 5px;font-size:14px;' +
    "font-family:Consolas,Monaco,monospace\">" +
    escaped +
    '</code>'
  );
}
