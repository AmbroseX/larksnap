/**
 * 解除复制限制（技术方案 §4），三层全部可逆：
 *   ① 事件层：window 捕获阶段 stopImmediatePropagation，拦掉页面对
 *      copy/cut/paste/contextmenu/selectstart 的封锁监听
 *   ② 样式层：注入 user-select: text !important
 *   ③ 属性层：清 document/body 上的 on* 内联句柄，MutationObserver 防写回
 * 不拦 keydown / mousedown：误伤正常交互，且对先注册的 capture 监听无效。
 */

const EVENTS = ['copy', 'cut', 'paste', 'contextmenu', 'selectstart'] as const;

const INLINE_ATTRS = [
  'oncopy',
  'oncut',
  'onpaste',
  'oncontextmenu',
  'onselectstart',
  'ondragstart',
];

const STYLE_ATTR = 'data-larksnap-unlock';

let active = false;
let styleEl: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
/** stop() 时恢复被清掉的内联句柄：element → { attr: 原值 } */
const removedAttrs = new Map<Element, Record<string, string>>();

function blockHandler(e: Event): void {
  // 只掐断传播（让页面的封锁监听跑不到），不 preventDefault——
  // 默认行为（真正的复制/右键菜单/选择）正是我们要保住的
  e.stopImmediatePropagation();
}

function clearInlineAttrs(el: Element): void {
  for (const attr of INLINE_ATTRS) {
    const value = el.getAttribute(attr);
    if (value !== null) {
      const saved = removedAttrs.get(el) ?? {};
      if (!(attr in saved)) saved[attr] = value;
      removedAttrs.set(el, saved);
      el.removeAttribute(attr);
      // getAttribute 拿不到 JS 赋值的句柄，属性对象也一并置空
      (el as unknown as Record<string, unknown>)[attr] = null;
    }
  }
}

export function startUnlock(): void {
  if (active) return;
  active = true;

  // ① 事件层
  for (const ev of EVENTS) {
    window.addEventListener(ev, blockHandler, true);
  }

  // ② 样式层
  styleEl = document.createElement('style');
  styleEl.setAttribute(STYLE_ATTR, '');
  styleEl.textContent = `*, *::before, *::after {
  user-select: text !important;
  -webkit-user-select: text !important;
}`;
  document.documentElement.appendChild(styleEl);

  // ③ 属性层：documentElement/body + 全文档带内联句柄的元素
  clearInlineAttrs(document.documentElement);
  if (document.body) clearInlineAttrs(document.body);
  document
    .querySelectorAll(INLINE_ATTRS.map((a) => `[${a}]`).join(','))
    .forEach(clearInlineAttrs);

  // 防页面脚本写回
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.target instanceof Element) {
        clearInlineAttrs(m.target);
      }
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: INLINE_ATTRS,
  });
}

export function stopUnlock(): void {
  if (!active) return;
  active = false;

  for (const ev of EVENTS) {
    window.removeEventListener(ev, blockHandler, true);
  }
  styleEl?.remove();
  styleEl = null;
  observer?.disconnect();
  observer = null;
  // 恢复原内联句柄
  for (const [el, attrs] of removedAttrs) {
    for (const [attr, value] of Object.entries(attrs)) {
      el.setAttribute(attr, value);
    }
  }
  removedAttrs.clear();
}

export function isUnlocked(): boolean {
  return active;
}
