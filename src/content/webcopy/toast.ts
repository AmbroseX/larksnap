/** 页面右下角轻提示，2 秒后自动消失。复制成功/失败统一走这里，不用系统通知。 */

let currentToast: HTMLDivElement | null = null;
let hideTimer: number | undefined;

export function showToast(text: string): void {
  if (currentToast) {
    currentToast.remove();
    window.clearTimeout(hideTimer);
  }
  const el = document.createElement('div');
  el.textContent = text;
  el.setAttribute('data-larksnap-toast', '');
  Object.assign(el.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    padding: '8px 14px',
    borderRadius: '8px',
    background: 'rgba(32,32,36,0.92)',
    color: '#fff',
    fontSize: '13px',
    lineHeight: '1.5',
    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
    maxWidth: '60vw',
    pointerEvents: 'none',
    transition: 'opacity 0.2s',
  } satisfies Partial<CSSStyleDeclaration>);
  document.documentElement.appendChild(el);
  currentToast = el;
  hideTimer = window.setTimeout(() => {
    el.style.opacity = '0';
    window.setTimeout(() => {
      el.remove();
      if (currentToast === el) currentToast = null;
    }, 200);
  }, 2000);
}
