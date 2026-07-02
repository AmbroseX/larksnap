/**
 * content 侧剪贴板写入：navigator.clipboard 优先，
 * 失败降级临时 textarea + execCommand('copy')。
 * 页面无焦点（手势在侧边栏）时两条路都会失败——那种场景不该走这里，
 * 而是把字符串回传给侧边栏写（技术方案 §3.5）。
 */
export async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // 降级
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  Object.assign(ta.style, {
    position: 'fixed',
    left: '-9999px',
    top: '0',
  });
  document.documentElement.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    ta.remove();
  }
  if (!ok) throw new Error('剪贴板写入失败（页面可能失去焦点）');
}
