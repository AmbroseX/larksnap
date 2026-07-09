import html2canvas from 'html2canvas';
import { OFFSCREEN_MSG } from '../shared/constants';
import type { Response } from '../shared/types';
import type {
  XhsRenderProgress,
  XhsRenderRequest,
  XhsRenderResult,
} from '../background/xhs/types';
import { getTheme } from './themes';
import { paginate } from './paginate';
import { addPageNumber, SCALE } from './render';

/**
 * 离屏渲染页入口（§六）：SW 没有 DOM，html2canvas 在这里跑。
 * 只认 XHS_RENDER 一种消息，其余（PROGRESS 推送等广播）一律放行给别的监听者。
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== OFFSCREEN_MSG.XHS_RENDER) return false;
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
});

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
