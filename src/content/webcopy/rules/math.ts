import type TurndownService from 'turndown';
import { MathMLToLaTeX } from 'mathml-to-latex';

/**
 * 公式规则（002.1b）：KaTeX / MathJax / 裸 MathML → LaTeX。
 *   - 优先取页面里的原始 TeX：KaTeX 的 annotation[encoding="application/x-tex"]、
 *     data-latex / alttext 属性；
 *   - 取不到再用 mathml-to-latex 把 MathML 现转；
 *   - 行内式 → $..$，独立式 → $$..$$。
 * 注：content script 在隔离世界，读不到页面的 window.MathJax，无法等它渲染完；
 * MathJax v3 页面渲染后 DOM 里有 mjx-container 即可提取，实际影响很小。
 */

function isMathNode(node: HTMLElement): boolean {
  const name = node.nodeName.toLowerCase();
  if (name === 'math' || name === 'mjx-container') return true;
  const cls = node.classList;
  return (
    cls?.contains('katex') ||
    cls?.contains('katex-display') ||
    cls?.contains('MathJax')
  );
}

function isBlockMath(node: HTMLElement): boolean {
  if (node.classList?.contains('katex-display')) return true;
  const display = node.getAttribute('display');
  if (display === 'block' || display === 'true') return true;
  // 独立公式常被包在 katex-display / p 里居中展示，兜底看容器
  return !!node.closest('.katex-display');
}

function extractTex(node: HTMLElement): string {
  // ① 原始 TeX：KaTeX annotation / 各家 data-latex / MathJax alttext
  const annotation = node.querySelector(
    'annotation[encoding="application/x-tex"]'
  );
  if (annotation?.textContent) return annotation.textContent.trim();
  const dataLatex =
    node.getAttribute('data-latex') ??
    node.querySelector('[data-latex]')?.getAttribute('data-latex');
  if (dataLatex) return dataLatex.trim();
  const alt =
    node.getAttribute('alttext') ??
    node.querySelector('math[alttext]')?.getAttribute('alttext');
  if (alt) return alt.trim();

  // ② MathML 现转
  const mathEl =
    node.nodeName.toLowerCase() === 'math' ? node : node.querySelector('math');
  if (mathEl) {
    try {
      return MathMLToLaTeX.convert(mathEl.outerHTML).trim();
    } catch {
      // 转不动就落到纯文本
    }
  }
  return (node.textContent ?? '').trim();
}

export function addMathRule(td: TurndownService): void {
  td.addRule('math-to-latex', {
    filter: (node) => isMathNode(node as HTMLElement),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      // katex-display 里嵌套的 .katex 由外层统一处理，内层不重复输出
      if (
        !el.classList?.contains('katex-display') &&
        el.closest?.('.katex-display') &&
        el.closest('.katex-display') !== el
      ) {
        return '';
      }
      const tex = extractTex(el);
      if (!tex) return '';
      return isBlockMath(el) ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    },
  });
}
