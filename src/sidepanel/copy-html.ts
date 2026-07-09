/**
 * 侧边栏写富文本剪贴板（text/html + text/plain 双口味）。
 *
 * 剪贴板写入必须发生在有焦点的文档里——手势在侧边栏，就由侧边栏自己写
 * （与 webcopy"结果回传侧边栏写剪贴板"同一套思路）。
 * ClipboardItem 失败时降级 contenteditable + execCommand('copy')，
 * 这条老路天然产生 text/html 口味。
 */
export async function copyHtmlToClipboard(html: string): Promise<void> {
  const plain = htmlToPlain(html);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
    return;
  } catch {
    // 降级
  }

  const div = document.createElement('div');
  div.contentEditable = 'true';
  div.innerHTML = html;
  Object.assign(div.style, {
    position: 'fixed',
    left: '-9999px',
    top: '0',
  });
  document.body.appendChild(div);
  const range = document.createRange();
  range.selectNodeContents(div);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    sel?.removeAllRanges();
    div.remove();
  }
  if (!ok) throw new Error('剪贴板写入失败，请保持侧边栏在前台后重试');
}

function htmlToPlain(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent ?? '';
}
