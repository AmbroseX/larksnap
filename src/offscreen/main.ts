import html2canvas from 'html2canvas';
import { OFFSCREEN_MSG } from '../shared/constants';
import type {
  DocToPdfRequest,
  DocToPdfResult,
  Response,
  ShotStitchRequest,
  ShotStitchResult,
} from '../shared/types';
import type {
  XhsRenderProgress,
  XhsRenderRequest,
  XhsRenderResult,
} from '../background/xhs/types';
import { getTheme } from './themes';
import { paginate } from './paginate';
import { addPageNumber, SCALE } from './render';
import { stitch, canvasToA4Pdf, MAX_PDF_CANVAS_HEIGHT } from './stitch';

/**
 * 离屏页入口（§六）：SW 没有 DOM，html2canvas（小红书卡片）与整页截图拼接都在这里跑。
 * 只认自己的消息类型，其余（PROGRESS 推送等广播）一律放行给别的监听者。
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === OFFSCREEN_MSG.XHS_RENDER) {
    render(message.data as XhsRenderRequest)
      .then((pngs) =>
        sendResponse({ success: true, data: { pngs } } satisfies Response<XhsRenderResult>)
      )
      .catch((err: unknown) =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies Response)
      );
    return true; // 异步响应
  }

  if (message?.type === OFFSCREEN_MSG.SHOT_STITCH) {
    stitch(message.data as ShotStitchRequest)
      .then((data) =>
        sendResponse({ success: true, data } satisfies Response<ShotStitchResult>)
      )
      .catch((err: unknown) =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies Response)
      );
    return true; // 异步响应
  }

  if (message?.type === OFFSCREEN_MSG.DOC_TO_PDF) {
    htmlToPdf(message.data as DocToPdfRequest)
      .then((data) =>
        sendResponse({ success: true, data } satisfies Response<DocToPdfResult>)
      )
      .catch((err: unknown) =>
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies Response)
      );
    return true; // 异步响应
  }

  return false;
});

/**
 * 文档 HTML → 多页 PDF（官方 PDF 关闭时的 md→pdf 回退）。
 * 在屏幕外按 A4 宽把正文渲染出来，html2canvas 截成整张长图，再切成 A4 多页。
 * 长文档会超过 canvas 高度上限，这里按比例缩小渲染以塞进上限（清晰度略降，但不丢内容）。
 */
async function htmlToPdf(req: DocToPdfRequest): Promise<DocToPdfResult> {
  const stage = document.createElement('div');
  Object.assign(stage.style, {
    position: 'fixed',
    left: '-99999px',
    top: '0',
    width: `${req.cssWidth}px`,
    background: '#ffffff',
  } satisfies Partial<CSSStyleDeclaration>);
  stage.innerHTML = req.html;
  document.body.appendChild(stage);

  try {
    await waitImages(stage);
    const heightCss = stage.scrollHeight || stage.offsetHeight || 1;
    // 选缩放系数使画布高不超上限：短文放大到 2 倍更清晰，超长文缩到 <1 也要装下整篇
    const scale = Math.min(2, MAX_PDF_CANVAS_HEIGHT / heightCss);
    const canvas = await html2canvas(stage, {
      scale,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: req.cssWidth,
    });
    const dataUrl = await canvasToA4Pdf(canvas);
    return { dataUrl, truncated: scale < 1 };
  } finally {
    stage.remove();
  }
}

/** 等容器内所有图片解码完成（内联 dataURL 也是异步解码），避免 html2canvas 抓到空图 */
function waitImages(root: HTMLElement): Promise<unknown> {
  const imgs = Array.from(root.querySelectorAll('img'));
  return Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise((res) => {
            img.addEventListener('load', res, { once: true });
            img.addEventListener('error', res, { once: true });
          })
    )
  );
}

async function render(req: XhsRenderRequest): Promise<string[]> {
  const theme = getTheme(req.themeId);
  // 屏幕外容器：有真实布局（分页要量高），用户不可见
  const stage = document.createElement('div');
  Object.assign(stage.style, {
    position: 'fixed',
    left: '-99999px',
    top: '0',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(stage);

  try {
    const cards = await paginate(req.nodes, req.title, theme, req.imageMap, stage);
    if (!cards.length) throw new Error('文档没有可渲染的内容');
    cards.forEach((card, i) => addPageNumber(card, i + 1, cards.length, theme));

    // 逐张串行截图，控内存（§十-3）
    const pngs: string[] = [];
    for (let i = 0; i < cards.length; i++) {
      const canvas = await html2canvas(cards[i], {
        scale: SCALE,
        backgroundColor: theme.bg,
        useCORS: true,
        logging: false,
      });
      pngs.push(canvas.toDataURL('image/png'));
      reportCardProgress(i + 1, cards.length);
    }
    return pngs;
  } finally {
    stage.remove();
  }
}

function reportCardProgress(done: number, total: number): void {
  const data: XhsRenderProgress = { done, total };
  chrome.runtime
    .sendMessage({ type: OFFSCREEN_MSG.XHS_PROGRESS, data })
    .catch(() => {});
}
