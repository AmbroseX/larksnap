import type { WhiteboardRef } from '../../shared/types';
import { resolveTargetTabId } from '../feishu-proxy';

/**
 * docx 画板（whiteboard）块抓图 —— 和 sheet 块同一套"注入页面取数"的路子。
 *
 * 私有化/公有云的画板都是浏览器端 WASM 引擎实时画在 <canvas> 上的，client_vars
 * 里没有任何图片，服务端也不提供"画板转图片"接口。所以唯一可靠的办法：注入页面，
 * 滚到画板块、等它的 canvas 渲染出内容，再 `canvas.toDataURL()` 拿到高清 PNG。
 *
 * 嵌入文档里的画板是"整块自动缩放铺满块框"的预览态，canvas 里就是完整画板内容
 * （不是只截可视区）。但显示得小（约 820px 宽），直接抓只有 ~1600px、密集文字会糊，
 * 所以抓前临时把显示框放大逼引擎按更高分辨率重绘（见 enlargeForHiRes），拿到清晰大图。
 *
 * 返回 blockId → PNG dataURL；抓不到的块为 null（exporter 降级为占位说明）。
 */
export async function extractWhiteboards(
  refs: WhiteboardRef[]
): Promise<Record<string, string | null>> {
  const tabId = await resolveTargetTabId();
  const [{ result } = { result: undefined }] =
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractWhiteboardsInPage,
      args: [refs.map((r) => r.blockId)],
    });
  return (result as Record<string, string | null>) ?? {};
}

/**
 * 注入到 docx 页面 MAIN world 执行。**必须自包含**（不能引用外部变量），返回值可序列化。
 * 逐块：按 data-record-id 找画板块 → 滚进视口触发懒渲染 → 轮询等块内 canvas 出现且
 * "画上了东西"（采样像素有非透明点）→ toDataURL 转 PNG。
 */
function extractWhiteboardsInPage(
  blockIds: string[]
): Promise<Record<string, string | null>> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const findBlockEl = (blockId: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      `[data-record-id="${CSS.escape(blockId)}"]`
    );

  // 画板块可能在虚拟化视口外还没挂载：逐段滚动整篇文档，边滚边找该块
  const scrollUntilFound = async (blockId: string): Promise<HTMLElement | null> => {
    let el = findBlockEl(blockId);
    if (el) return el;
    const scroller =
      document.querySelector('.bear-web-x-container') ||
      document.scrollingElement ||
      document.documentElement;
    let last = -1;
    for (let i = 0; i < 40 && !el; i++) {
      scroller.scrollTop = Math.min(
        scroller.scrollTop + scroller.clientHeight * 0.8,
        scroller.scrollHeight
      );
      await sleep(250);
      el = findBlockEl(blockId);
      // 滚到底且高度不再增长就停
      if (scroller.scrollTop === last && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight) break;
      last = scroller.scrollTop;
    }
    return el;
  };

  // canvas 是否"画上了东西"：采样若干像素，只要有一个非全透明就算渲染好了
  const isPainted = (canvas: HTMLCanvasElement): boolean => {
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return true; // 拿不到 2d 上下文（如 webgl）就不判空，交给下游
      const w = canvas.width;
      const h = canvas.height;
      if (!w || !h) return false;
      // 网格采样，避免整幅 getImageData 太慢
      const step = 20;
      for (let y = Math.floor(h / step / 2); y < h; y += Math.floor(h / step) || 1) {
        for (let x = Math.floor(w / step / 2); x < w; x += Math.floor(w / step) || 1) {
          const d = ctx.getImageData(x, y, 1, 1).data;
          if (d[3] !== 0) return true;
        }
      }
      return false;
    } catch {
      return true; // 读像素异常（跨源污染等）就不拦，直接尝试导出
    }
  };

  // 轮询等块内 canvas 出现且画好
  const waitPaintedCanvas = async (
    el: HTMLElement,
    tries: number
  ): Promise<HTMLCanvasElement | null> => {
    for (let i = 0; i < tries; i++) {
      const c = el.querySelector('canvas');
      if (c && c.width > 0 && isPainted(c)) return c;
      await sleep(400);
    }
    const c = el.querySelector('canvas');
    return c && c.width > 0 && isPainted(c) ? c : null;
  };

  /**
   * 等放大后的高清 canvas 就绪：WASM 重绘是异步的，canvas 会先变大、可能一度被清空
   * （isPainted 闪空），中途尺寸还会跳变。所以判据是"比底图明显更大 + 已绘制 + 连续两轮
   * 宽度不变（稳定）"，避免抓到还在重绘的中间态。等不到就返回 null，由上游落回底图。
   */
  const waitGrownStable = async (
    el: HTMLElement,
    baseWidth: number
  ): Promise<HTMLCanvasElement | null> => {
    let stableW = -1;
    let stableCount = 0;
    for (let i = 0; i < 50; i++) {
      const c = el.querySelector('canvas');
      if (c && c.width > baseWidth * 1.2 && isPainted(c)) {
        if (c.width === stableW) {
          if (++stableCount >= 2) return c;
        } else {
          stableW = c.width;
          stableCount = 0;
        }
      }
      await sleep(400);
    }
    const c = el.querySelector('canvas');
    return c && c.width > baseWidth * 1.2 && isPainted(c) ? c : null;
  };

  /**
   * 高清重绘：画板 canvas 的像素数 = 显示框尺寸 × DPR，嵌在文档里显示得小（约 820px），
   * 所以直接抓只有 ~1600px 宽、密集文字会糊。这里临时把显示框放大若干倍，逼 WASM 引擎
   * 按更大尺寸重新渲染（是真·矢量重绘，不是拉伸），抓完立即还原。改的只是几个视图容器的
   * 内联 CSS，不碰画板数据。返回还原函数与目标像素宽（还原用 try/finally 保证执行）。
   */
  const TARGET_DEVICE_PX = 4000; // 目标 canvas 长边像素，密集文字够清晰
  const MAX_SCALE = 4;
  const enlargeForHiRes = (
    el: HTMLElement,
    baseCanvasW: number
  ): { restore: () => void; targetW: number } => {
    const noop = { restore: () => {}, targetW: baseCanvasW };
    const rw = el.querySelector('.resizable-wrapper');
    // resizable-wrapper 里那个带内联像素宽度的子 div 才是真正锁分辨率的层
    const inner =
      rw &&
      (Array.from(rw.children) as HTMLElement[]).find(
        (c) => c.style && /px/.test(c.style.width)
      );
    if (!inner) return noop;
    const outer = el.querySelector<HTMLElement>('.whiteboard-block_container');
    const w0 = parseFloat(inner.style.width) || inner.offsetWidth;
    const h0 = parseFloat(inner.style.height) || inner.offsetHeight;
    if (!w0 || !h0) return noop;

    let scale = TARGET_DEVICE_PX / Math.max(1, baseCanvasW);
    scale = Math.max(1, Math.min(scale, MAX_SCALE));
    if (scale <= 1.05) return noop; // 已经够大就不折腾

    const savedInner = {
      w: inner.style.width,
      h: inner.style.height,
      mw: inner.style.maxWidth,
    };
    const savedOuter = outer
      ? { w: outer.style.width, h: outer.style.height, mw: outer.style.maxWidth }
      : null;
    if (outer) {
      outer.style.maxWidth = 'none';
      outer.style.width = w0 * scale + 'px';
      outer.style.height = h0 * scale + 'px';
    }
    inner.style.maxWidth = 'none';
    inner.style.width = w0 * scale + 'px';
    inner.style.height = h0 * scale + 'px';
    window.dispatchEvent(new Event('resize'));

    const restore = () => {
      Object.assign(inner.style, {
        width: savedInner.w,
        height: savedInner.h,
        maxWidth: savedInner.mw,
      });
      if (outer && savedOuter) {
        Object.assign(outer.style, {
          width: savedOuter.w,
          height: savedOuter.h,
          maxWidth: savedOuter.mw,
        });
      }
      window.dispatchEvent(new Event('resize'));
    };
    return { restore, targetW: Math.round(baseCanvasW * scale) };
  };

  /**
   * 裁掉画板四周的空白后转 PNG dataURL。
   *
   * 画板 canvas 是"整块画布"，真正画的内容往往只占中间一块，四周是空白——透明或
   * **不透明的纯白底**（引擎先铺白再画）。不裁的话，导出到 A4 页宽时内容被这圈空白
   * 挤成中间一小块、又小又糊。这里把"透明或接近纯白"都当空白，按内容像素求包围盒、
   * 留一点边距裁出内容区，导出时才能铺满页宽、清晰。读像素失败（跨源污染等）或本就
   * 占满时，退回原图不裁。
   */
  const toCroppedDataUrl = (canvas: HTMLCanvasElement): string => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas.toDataURL('image/png');
    const W = canvas.width;
    const H = canvas.height;
    const { data } = ctx.getImageData(0, 0, W, H); // 跨源污染会抛，交给上层 catch
    // 大画布抽样求包围盒：步进扫描够快，配合边距无需精确到 1px
    const step = Math.max(1, Math.floor(Math.min(W, H) / 1000));
    let minX = W;
    let minY = H;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const i = (y * W + x) * 4;
        // 内容像素 = 不透明且不接近纯白（>246 视为白底/抗锯齿边，算空白）
        if (
          data[i + 3] > 8 &&
          !(data[i] > 246 && data[i + 1] > 246 && data[i + 2] > 246)
        ) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return canvas.toDataURL('image/png'); // 全空白，别裁
    const pad = Math.round(Math.max(W, H) * 0.01);
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(W - 1, maxX + pad + step);
    maxY = Math.min(H - 1, maxY + pad + step);
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    // 内容本就基本占满，裁不掉多少：省一次绘制
    if (cw >= W * 0.95 && ch >= H * 0.95) return canvas.toDataURL('image/png');
    const out = document.createElement('canvas');
    out.width = cw;
    out.height = ch;
    const octx = out.getContext('2d');
    if (!octx) return canvas.toDataURL('image/png');
    octx.drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return out.toDataURL('image/png');
  };

  const grab = async (blockId: string): Promise<string | null> => {
    const el = await scrollUntilFound(blockId);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });

    // 先等基础分辨率的 canvas 画好，并留一份底图当兜底
    const base = await waitPaintedCanvas(el, 30);
    if (!base) return null;
    const baseW = base.width;
    let baseUrl: string | null = null;
    try {
      baseUrl = toCroppedDataUrl(base);
    } catch {
      return null;
    }

    // 放大重绘拿高清；拿不到就用底图，绝不因为求清晰反而丢图
    const { restore, targetW } = enlargeForHiRes(el, baseW);
    if (targetW <= baseW) return baseUrl; // 没放大，底图即最终
    let hiUrl: string | null = null;
    try {
      const hi = await waitGrownStable(el, baseW);
      if (hi) {
        try {
          hiUrl = toCroppedDataUrl(hi);
        } catch {
          hiUrl = null;
        }
      }
    } finally {
      restore();
    }
    return hiUrl || baseUrl;
  };

  const run = async () => {
    const out: Record<string, string | null> = {};
    for (const blockId of blockIds) {
      try {
        out[blockId] = await grab(blockId);
      } catch {
        out[blockId] = null;
      }
    }
    return out;
  };

  return run().catch(() => ({}));
}
