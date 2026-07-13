import type TurndownService from 'turndown';
import hljs from 'highlight.js/lib/common';

/**
 * 代码块规则（002.1b）：<pre> 统一产 fenced 代码块。
 * 语言检测三级（参考 MarkSnip）：
 *   ① class="language-xxx / lang-xxx" 直接取；
 *   ② 取到的名字过 hljs.getLanguage() 验证是真语言；
 *   ③ 都没有再 highlightAuto()，relevance >= 2 才采信。
 * 代码内容含 ``` 时围栏自动加长防破格。
 * 兼容 CSDN/掘金那类高亮行号表格嵌套结构（直接取代码文本）。
 */

function classLang(pre: HTMLElement, code: HTMLElement | null): string {
  const cls = `${pre.className} ${code?.className ?? ''}`;
  const m = cls.match(/(?:language|lang)-([\w+#-]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function detectLang(pre: HTMLElement, code: HTMLElement | null, text: string): string {
  const fromClass = classLang(pre, code);
  // class 名过 hljs 验证；不是真语言（language-plain 之类）就落到自动检测
  if (fromClass && hljs.getLanguage(fromClass)) return fromClass;
  if (text.trim().length < 20) return '';
  try {
    const auto = hljs.highlightAuto(text);
    if (auto.language && auto.relevance >= 2) return auto.language;
  } catch {
    // 检测失败就不标语言
  }
  return '';
}

/** 围栏长度：内容里已有 N 连反引号时用 N+1（至少 3）根 */
function fenceFor(text: string): string {
  const runs = text.match(/`{3,}/g);
  const longest = runs ? Math.max(...runs.map((s) => s.length)) : 0;
  return '`'.repeat(Math.max(3, longest + 1));
}

export function addCodeRule(td: TurndownService): void {
  td.addRule('pre-fenced-code', {
    filter: 'pre',
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      const code = pre.querySelector('code');
      const text = ((code ?? pre).textContent ?? '').replace(/\n+$/, '');
      if (!text.trim()) return '';
      const lang = detectLang(pre, code, text);
      const fence = fenceFor(text);
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });
}
