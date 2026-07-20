/**
 * 整页截图拼接（offscreen 侧）：SW 无 DOM，逐屏 dataURL 在这里用真 canvas 拼成长图。
 * 核心照抄干净版参考 offscreen/offscreen.js，加了 DPR/缩放动态校正、尺寸保护与 PDF 分页。
 */

import { OFFSCREEN_MSG } from '../shared/constants';
import type { ShotStitchProgress, ShotStitchRequest, ShotStitchResult } from '../shared/types';

/** canvas 高度安全上限（超约 32767px 后 toDataURL 会静默返回空白，留余量取 32000） */
const MAX_CANVAS_HEIGHT = 32000;
/** canvas 面积安全上限（约 2.68 亿 px²，留余量取 2.6 亿） */
const MAX_CANVAS_AREA = 2.6e8;

/**
 * 逐屏拼接。用首屏真实像素宽 ÷ 视口 CSS 宽得实际缩放系数（含 DPR 与浏览器缩放），
 * 所有纵向偏移与画布高度都按它换算，避免高分屏/缩放下错位。
 */
export async function stitch(req: ShotStitchRequest): Promise<ShotStitchResult> {
  const { shots, viewportCssWidth, totalHeightCss, format } = req;
  if (!shots.length) throw new Error('没有可拼接的截图');

  const first = await loadImage(shots[0].dataUrl);
  const realWidth = first.naturalWidth;
  // 首屏真实像素宽 ÷ 视口 CSS 宽 = 实际缩放系数（比盲信 devicePixelRatio 更准）
  const scale = viewportCssWidth > 0 ? realWidth / viewportCssWidth : 1;

  let canvasHeight = Math.round(totalHeightCss * scale);
  let truncated = false;
  // 尺寸保护：超限则封顶截断，绝不产出空白文件（FR-010）
  if (canvasHeight > MAX_CANVAS_HEIGHT || realWidth * canvasHeight > MAX_CANVAS_AREA) {
    const areaCap = Math.floor(MAX_CANVAS_AREA / realWidth);
    canvasHeight = Math.min(canvasHeight, MAX_CANVAS_HEIGHT, areaCap);
    truncated = true;
  }

  const canvas = document.createElement('canvas');
  canvas.width = realWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布上下文');

  for (let i = 0; i < shots.length; i++) {
    const y = Math.round(shots[i].yPos * scale);
    if (y >= canvasHeight) break; // 封顶后超出部分不再画
    const img = i === 0 ? first : await loadImage(shots[i].dataUrl);
    ctx.drawImage(img, 0, y);
    reportProgress(i + 1, shots.length);
  }

  // 截图 PDF 仍经 sendMessage 回传 SW，用 JPEG 控体积、别撞 64MiB
  const dataUrl =
    format === 'pdf' ? await canvasToA4Pdf(canvas, { jpeg: true }) : canvas.toDataURL('image/png');
  return { dataUrl, truncated };
}

/** canvas 高度安全上限，供其他离屏渲染（md→pdf）复用 */
export const MAX_PDF_CANVAS_HEIGHT = MAX_CANVAS_HEIGHT;

/** 要独占一页的纵向区间（画布像素），如画板图：切页避开它，不跨页切断 */
export interface OwnPageRegion {
  top: number;
  bottom: number;
}

/**
 * 把长图 canvas 按 A4 页高切成多页 PDF（不做单张超长页，阅读器难看且超长会渲染失败）。
 *
 * 切页规则：
 * - `opts.ownPageRegions`（画板图等）各自独占一页，超过一页高就整体缩小装进一页并居中；
 * - 普通内容的切线尽量落在"整行空白"处（向上回看最多 1/3 页），避免把一行文字拦腰切成两半；
 * - 每页图默认 **PNG（无损，清晰）**——md→pdf 走 blob URL 下载，没有 64MiB 限制。
 *   `opts.jpeg=true` 用 JPEG（0.85）：仅给仍经 sendMessage 回传的截图 PDF 用，靠有损压缩
 *   把体积压到 64MiB 消息上限以下（代价是白底细线会起毛边）。
 */
export async function canvasToA4Pdf(
  canvas: HTMLCanvasElement,
  opts: { jpeg?: boolean; ownPageRegions?: OwnPageRegion[] } = {}
): Promise<string> {
  const { jsPDF } = await import('jspdf');
  const [mime, fmt, quality] = opts.jpeg
    ? (['image/jpeg', 'JPEG', 0.85] as const)
    : (['image/png', 'PNG', undefined] as const);
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  // 每页上下留白（≈1cm）。左右不留：正文渲染时自带水平内边距，已烙在长图里
  const marginY = 28;
  const usableH = pageH - marginY * 2;

  const imgW = canvas.width;
  const imgH = canvas.height;
  // 长图按 A4 宽等比映射后，单页内容区能容纳的原图像素高
  const sliceHpx = Math.max(1, Math.floor((usableH / pageW) * imgW));

  // 独占页区间：夹紧到画布内、按位置排序、重叠的合并
  const regions: OwnPageRegion[] = [];
  for (const r of [...(opts.ownPageRegions ?? [])].sort((a, b) => a.top - b.top)) {
    const top = Math.max(0, Math.floor(r.top));
    const bottom = Math.min(imgH, Math.ceil(r.bottom));
    if (bottom <= top) continue;
    const last = regions[regions.length - 1];
    if (last && top <= last.bottom) last.bottom = Math.max(last.bottom, bottom);
    else regions.push({ top, bottom });
  }

  const src = canvas.getContext('2d');
  const slice = document.createElement('canvas');
  slice.width = imgW;
  const sctx = slice.getContext('2d');
  if (!sctx) throw new Error('无法创建切片画布上下文');

  let firstPage = true;
  /** 把长图 [top, top+h) 段落成一页；独占页整体装进一页并居中，普通页顶格铺 A4 宽 */
  const addSlice = (top: number, h: number, ownPage: boolean): void => {
    slice.height = h;
    sctx.clearRect(0, 0, imgW, h);
    sctx.drawImage(canvas, 0, top, imgW, h, 0, 0, imgW, h);
    if (!firstPage) pdf.addPage();
    firstPage = false;
    let drawW = pageW;
    let drawH = (h / imgW) * pageW;
    if (ownPage && drawH > usableH) {
      drawW = (usableH / drawH) * pageW;
      drawH = usableH;
    }
    const x = ownPage ? (pageW - drawW) / 2 : 0;
    // 普通页顶着上边距铺；独占页在整页里垂直居中（不会越进边距，drawH ≤ usableH）
    const yPt = ownPage ? (pageH - drawH) / 2 : marginY;
    pdf.addImage(slice.toDataURL(mime, quality), fmt, x, yPt, drawW, drawH);
  };

  let y = 0;
  let ri = 0;
  while (y < imgH) {
    while (ri < regions.length && regions[ri].bottom <= y) ri++;
    const reg = ri < regions.length ? regions[ri] : null;
    // 进入独占页区间：这一段单独出一页
    if (reg && y >= reg.top) {
      addSlice(y, reg.bottom - y, true);
      y = reg.bottom;
      ri++;
      continue;
    }
    // 普通内容：切到页高、下一个独占区间或文末，且切线尽量落在空白行
    const boundary = reg ? reg.top : imgH;
    let h = Math.min(sliceHpx, boundary - y);
    if (y + h < boundary) h = cleanCutHeight(src, imgW, y, h);
    addSlice(y, h, false);
    y += h;
  }
  return pdf.output('datauristring');
}

/**
 * 在理想切点附近找"整行空白"的位置收页：从切点向上回看最多 1/3 页，找到整行
 * 接近白/透明的像素行就在那切（避免拦腰切文字）；找不到（密排内容/深色背景截图）
 * 按原切点硬切。读像素失败也硬切，绝不因此丢页。
 */
function cleanCutHeight(
  src: CanvasRenderingContext2D | null,
  imgW: number,
  top: number,
  idealH: number
): number {
  if (!src) return idealH;
  const lookback = Math.min(Math.floor(idealH / 3), idealH - 1);
  if (lookback < 8) return idealH;
  let strip: ImageData;
  try {
    strip = src.getImageData(0, top + idealH - lookback, imgW, lookback);
  } catch {
    return idealH;
  }
  const d = strip.data;
  const stepX = Math.max(1, Math.floor(imgW / 400));
  for (let row = lookback - 1; row >= 0; row--) {
    let blank = true;
    for (let x = 0; x < imgW; x += stepX) {
      const i = (row * imgW + x) * 4;
      // 非空白 = 不透明且不接近纯白（同画板裁边的判据）
      if (d[i + 3] > 8 && !(d[i] > 246 && d[i + 1] > 246 && d[i + 2] > 246)) {
        blank = false;
        break;
      }
    }
    if (blank) return idealH - lookback + row + 1;
  }
  return idealH;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('截图解码失败'));
    img.src = src;
  });
}

/** 逐屏拼接进度 fire-and-forget 推给 SW（对齐 XHS_PROGRESS 写法） */
function reportProgress(done: number, total: number): void {
  const data: ShotStitchProgress = { done, total };
  chrome.runtime.sendMessage({ type: OFFSCREEN_MSG.SHOT_PROGRESS, data }).catch(() => {});
}
