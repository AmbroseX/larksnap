/**
 * 整页截图的「页面端」纯函数集。
 *
 * 这些函数会被 `chrome.scripting.executeScript({ func })` 序列化后注入目标页面执行，
 * 因此每个函数必须自包含：不能引用模块作用域的变量/导入，所有输入只能走 args 传入。
 * 逻辑照抄干净版参考实现 background/background.js（fixed 去重 + 逐屏测量）。
 */

/** preparePage 返回的初始测量值 */
export interface PagePrep {
  /** 整页高度（CSS 像素） */
  scrollHeight: number;
  /** 视口高度（CSS 像素） */
  innerHeight: number;
  /** 视口宽度（CSS 像素） */
  innerWidth: number;
  /** 点击截图前的原始滚动位置（截完恢复用） */
  origScrollY: number;
  /** 设备像素比 */
  dpr: number;
}

/** 逐屏 frameStep 返回的每屏测量值 */
export interface FrameInfo {
  /** 是否已到最后一屏 */
  isLast: boolean;
  /** 当前屏顶部在文档中的纵向偏移（CSS 像素） */
  yPos: number;
  /** 当前整页高度（CSS 像素，懒加载可能变化，每屏重测） */
  docHeight: number;
  /** 视口宽度（CSS 像素） */
  innerWidth: number;
  /** 设备像素比 */
  dpr: number;
}

/** 注入禁动画 CSS、滚到顶、记录原滚动位置，返回初始测量值 */
export function preparePage(): PagePrep {
  const origScrollY = window.scrollY;
  window.scrollTo(0, 0);
  const style = document.createElement('style');
  style.id = 'larksnap-shot-styles';
  style.textContent =
    '*, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }';
  document.head.appendChild(style);
  return {
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    origScrollY,
    dpr: window.devicePixelRatio || 1,
  };
}

/**
 * 每屏一次：测量当前尺寸 + 处理 fixed/sticky 元素去重。
 * 首屏（frameIndex===0）保留悬浮元素原样；其余屏把「在视口上半区」的悬浮元素置
 * opacity:0，避免顶栏/悬浮按钮每屏重复入镜；最后一屏对底部悬浮元素恢复可见。
 * 用 opacity 不用 display:none，避免回流改变页面高度。
 */
export function frameStep(frameIndex: number): FrameInfo {
  const h = window.innerHeight;
  const d = document.documentElement.scrollHeight;
  const s = window.scrollY;
  const isLast = Math.ceil(s + h) >= d;

  document.querySelectorAll<HTMLElement>('*').forEach((el) => {
    const style = window.getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'sticky') {
      const rect = el.getBoundingClientRect();
      if (typeof el.dataset.larksnapOpacity === 'undefined') {
        el.dataset.larksnapOpacity = el.style.opacity || '';
      }
      if (rect.top > h / 2) {
        // 底部悬浮：只在最后一屏显示，其余屏隐藏
        el.style.opacity = isLast ? el.dataset.larksnapOpacity : '0';
      } else {
        // 顶部悬浮：只在首屏显示，其余屏隐藏
        el.style.opacity = frameIndex === 0 ? el.dataset.larksnapOpacity : '0';
      }
    }
  });

  return {
    isLast,
    yPos: s,
    docHeight: d,
    innerWidth: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
  };
}

/** 向下滚动一个视口高度 */
export function scrollDown(): void {
  window.scrollTo(0, window.scrollY + window.innerHeight);
}

/** 收尾：移除禁动画样式、恢复悬浮元素透明度、滚回原始位置 */
export function restorePage(origScrollY: number): void {
  const styleEl = document.getElementById('larksnap-shot-styles');
  if (styleEl) styleEl.remove();
  document.querySelectorAll<HTMLElement>('*').forEach((el) => {
    if (typeof el.dataset.larksnapOpacity !== 'undefined') {
      el.style.opacity = el.dataset.larksnapOpacity;
      delete el.dataset.larksnapOpacity;
    }
  });
  window.scrollTo(0, origScrollY);
}
