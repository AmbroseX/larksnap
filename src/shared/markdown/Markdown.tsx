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

/** 把相对路径 img src 换成解析结果（本地编辑器用：images/x.png → blob:...） */
function rewriteImg(html: string, resolveSrc: (src: string) => string | undefined): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let touched = false;
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src) return;
    const mapped = resolveSrc(src);
    if (mapped) {
      img.setAttribute('src', mapped);
      touched = true;
    }
  });
  return touched ? doc.body.innerHTML : html;
}

function render(
  text: string,
  allowImages: boolean,
  resolveSrc?: (src: string) => string | undefined
): string {
  const html = sanitizeHtml(marked.parse(text, { async: false }) as string, allowImages);
  return resolveSrc ? rewriteImg(html, resolveSrc) : html;
}

export function Markdown({
  text,
  streaming = false,
  allowImages = false,
  resolveSrc,
}: {
  text: string;
  streaming?: boolean;
  /** 是否保留图片（本地编辑器传 true；对话页默认 false 防远程图泄漏） */
  allowImages?: boolean;
  /** 相对路径解析器（返回可用 URL，如 blob:）；不传则相对图片按原样（多半加载失败） */
  resolveSrc?: (src: string) => string | undefined;
}) {
  const [html, setHtml] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  // allowImages/resolveSrc 走 ref，render 取最新值，不用塞进 effect 依赖
  const allowImagesRef = useRef(allowImages);
  allowImagesRef.current = allowImages;
  const resolveSrcRef = useRef(resolveSrc);
  resolveSrcRef.current = resolveSrc;

  useEffect(() => {
    if (!streaming) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setHtml(render(textRef.current, allowImagesRef.current, resolveSrcRef.current));
      return;
    }
    if (timerRef.current) return; // 已排程：触发时取 textRef 里的最新文本
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setHtml(render(textRef.current, allowImagesRef.current, resolveSrcRef.current));
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
