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

  const dataUrl = format === 'pdf' ? await toPdf(canvas) : canvas.toDataURL('image/png');
  return { dataUrl, truncated };
}

/** 把长图 canvas 按 A4 页高切成多页 PDF（不做单张超长页，阅读器难看且超长会渲染失败） */
async function toPdf(canvas: HTMLCanvasElement): Promise<string> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  const imgW = canvas.width;
  const imgH = canvas.height;
  // 长图按 A4 宽等比映射后，单页能容纳的原图像素高
  const sliceHpx = Math.max(1, Math.floor((pageH / pageW) * imgW));

  const slice = document.createElement('canvas');
  slice.width = imgW;
  const sctx = slice.getContext('2d');
  if (!sctx) throw new Error('无法创建切片画布上下文');

  let y = 0;
  let firstPage = true;
  while (y < imgH) {
    const h = Math.min(sliceHpx, imgH - y);
    slice.height = h;
    sctx.clearRect(0, 0, imgW, h);
    sctx.drawImage(canvas, 0, y, imgW, h, 0, 0, imgW, h);
    if (!firstPage) pdf.addPage();
    // 该切片按 A4 宽铺满，高度等比（末页按剩余高度收尾）
    const drawH = (h / imgW) * pageW;
    pdf.addImage(slice.toDataURL('image/png'), 'PNG', 0, 0, pageW, drawH);
    firstPage = false;
    y += h;
  }
  return pdf.output('datauristring');
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
