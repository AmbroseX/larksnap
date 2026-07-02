import type { WebCopyConfig } from '../../shared/types';
import { selectionToMarkdown, selectionText } from './html2md';
import { writeClipboard } from './clipboard';
import { showToast } from './toast';

/**
 * 选中文字自动复制（技术方案 §5）。
 * 只在本标签页已注入 webcopy 且开关打开时生效，会话级，刷新即失效。
 */

let active = false;
let config: WebCopyConfig | null = null;
let debounceTimer: number | undefined;
let lastCopied = '';

function isEditableTarget(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    (el as HTMLElement).isContentEditable
  );
}

function onSelectionEnd(): void {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(async () => {
    if (!active || !config) return;
    if (isEditableTarget()) return;

    const plain = selectionText().trim();
    if (plain.length < config.autoCopyMinChars) return;
    if (plain === lastCopied) return;

    let text = plain;
    if (config.autoCopyFormat === 'markdown') {
      try {
        text = selectionToMarkdown().markdown;
      } catch {
        return;
      }
    }

    try {
      await writeClipboard(text);
      lastCopied = plain;
      showToast(`已复制 ${plain.length} 字`);
    } catch {
      // 自动触发场景静默失败，不打扰用户
    }
  }, 150);
}

export function startAutoCopy(cfg: WebCopyConfig): void {
  config = cfg;
  if (active) return;
  active = true;
  document.addEventListener('mouseup', onSelectionEnd);
  document.addEventListener('keyup', onSelectionEnd);
}

export function stopAutoCopy(): void {
  if (!active) return;
  active = false;
  window.clearTimeout(debounceTimer);
  document.removeEventListener('mouseup', onSelectionEnd);
  document.removeEventListener('keyup', onSelectionEnd);
}

/** 配置热更新：开关状态跟着最新配置走 */
export function applyAutoCopyConfig(cfg: WebCopyConfig): void {
  if (cfg.autoCopyEnabled) startAutoCopy(cfg);
  else stopAutoCopy();
  config = cfg;
}
