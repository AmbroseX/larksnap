import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github.css';
import { sanitizeHtml } from './sanitize';

/**
 * Markdown 渲染组件（007）：marked → sanitize 白名单 → dangerouslySetInnerHTML。
 * 流式期间每次 delta 都全文重渲会二次方地卡，所以：
 *   - streaming 时 150ms 合并一次（trailing），中间态跳过代码高亮；
 *   - streaming 结束后立即终渲一次并补 highlight.js。
 * marked 对未闭合代码块/表格也能出稳定结果，残缺中间态无需特殊容错。
 */

const THROTTLE_MS = 150;

function render(text: string): string {
  return sanitizeHtml(marked.parse(text, { async: false }) as string);
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [html, setHtml] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (!streaming) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setHtml(render(textRef.current));
      return;
    }
    if (timerRef.current) return; // 已排程：触发时取 textRef 里的最新文本
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setHtml(render(textRef.current));
    }, THROTTLE_MS);
  }, [text, streaming]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  // 代码高亮只在非流式（终渲后）做
  useEffect(() => {
    if (streaming || !boxRef.current) return;
    boxRef.current.querySelectorAll('pre code').forEach((el) => {
      hljs.highlightElement(el as HTMLElement);
    });
  }, [html, streaming]);

  return <div ref={boxRef} className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
