import { useEffect, useState, useCallback } from 'react';
import type {
  Response,
  VideoState,
  WebCopyConfig,
  WebCopyMdResult,
  WebCopyNeedsPermission,
  WebCopyState,
} from '../shared/types';
import { DEFAULT_CONFIG, MSG } from '../shared/constants';
import { sendToBackground } from '../shared/messaging';
import { getConfig, saveConfig } from '../shared/storage';

/**
 * 网页复制区块（非飞书页面的侧边栏主入口）。
 * 手势和焦点都在侧边栏，剪贴板/下载统一由本组件完成（技术方案 §3.5）；
 * 注入失败时在同一手势里 permissions.request 兜底后重试（§2.1 辅路径）。
 */

/** 消息调用 + 权限兜底重试 */
async function callWebcopy<T>(type: string, data?: unknown): Promise<Response<T>> {
  const res = await sendToBackground<T | WebCopyNeedsPermission>(type, data);
  const fallback = res.data as WebCopyNeedsPermission | undefined;
  if (!res.success && fallback?.needsPermission) {
    const granted = await chrome.permissions
      .request({ origins: [fallback.originPattern] })
      .catch(() => false);
    if (!granted) {
      return { success: false, error: '未授权该域名，可改用页面右键菜单操作' };
    }
    return (await sendToBackground<T>(type, data)) as Response<T>;
  }
  return res as Response<T>;
}

function sanitizeFilename(name: string): string {
  let n = (name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100)
    .trim();
  return n || '网页导出';
}

/**
 * 侧边栏内锚点下载：blob 是本页面创建的同源资源，download 属性命名稳定生效。
 * 不走 chrome.downloads —— 扩展页 + blob URL 下 filename 参数会被忽略，
 * 落下来变成 blob UUID 名（实测踩坑）。
 */
function downloadMarkdown(markdown: string, title: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(title)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给下载留足启动时间再释放
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function WebCopyView() {
  const [status, setStatus] = useState('可将当前网页转为 Markdown');
  const [statusKind, setStatusKind] = useState<'idle' | 'success' | 'error'>('idle');
  const [busy, setBusy] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [webcopyCfg, setWebcopyCfg] = useState<WebCopyConfig>(DEFAULT_CONFIG.webcopy);
  /** 剪贴板写入失败时展示结果，让用户手动复制 */
  const [preview, setPreview] = useState<string | null>(null);
  /** 当前页是视频站点时非 null（含桥接就绪与否） */
  const [video, setVideo] = useState<VideoState | null>(null);
  /** 下载可能持续几分钟，用独立 busy，不锁其他按钮 */
  const [videoBusy, setVideoBusy] = useState(false);

  useEffect(() => {
    getConfig().then((cfg) => setWebcopyCfg(cfg.webcopy));
    // 只查状态不注入，保持零侵入
    sendToBackground<WebCopyState>(MSG.WEBCOPY_GET_STATE).then((res) => {
      if (res.success && res.data) setUnlocked(res.data.unlocked);
    });
    sendToBackground<VideoState>(MSG.GET_VIDEO_STATE).then((res) => {
      if (res.success && res.data?.supported) setVideo(res.data);
    });
  }, []);

  const report = useCallback((ok: boolean, msg: string) => {
    setStatus(msg);
    setStatusKind(ok ? 'success' : 'error');
  }, []);

  /**
   * 侧边栏自己写剪贴板。
   * navigator.clipboard 依赖「用户激活」窗口——站点适配器抓取是异步的（要 fetch
   * 多页数据），等抓完再写时点击的激活窗口可能已过期而被拒。故失败降级为临时
   * textarea + execCommand（只要侧边栏有焦点即可，不吃激活窗口），都失败才给预览。
   */
  const copyText = useCallback(
    async (text: string, okMsg: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setPreview(null);
        report(true, okMsg);
        return;
      } catch {
        // 降级 execCommand
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      if (ok) {
        setPreview(null);
        report(true, okMsg);
      } else {
        setPreview(text);
        report(false, '剪贴板写入失败，请在下方手动复制');
      }
    },
    [report]
  );

  const run = useCallback(
    async (key: string, task: () => Promise<void>) => {
      if (busy) return;
      setBusy(key);
      setStatusKind('idle');
      setStatus('执行中...');
      try {
        await task();
      } catch (e) {
        report(false, e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, report]
  );

  const handlePageMd = (mode: 'copy' | 'download') =>
    run(`page-${mode}`, async () => {
      const res = await callWebcopy<WebCopyMdResult>(MSG.WEBCOPY_PAGE_MD, { mode });
      if (!res.success || !res.data) {
        report(false, res.error || '转换失败');
        return;
      }
      const { markdown, title } = res.data;
      if (mode === 'copy') {
        await copyText(markdown, `已复制整页 Markdown（${markdown.length} 字符）`);
      } else {
        downloadMarkdown(markdown, title);
        report(true, `已下载「${sanitizeFilename(title)}.md」`);
      }
    });

  const handleSelectionMd = () =>
    run('selection', async () => {
      const res = await callWebcopy<WebCopyMdResult>(MSG.WEBCOPY_SELECTION_MD);
      if (!res.success || !res.data) {
        report(false, res.error || '转换失败');
        return;
      }
      await copyText(res.data.markdown, '已复制选中内容的 Markdown');
    });

  const handleToggleUnlock = () =>
    run('unlock', async () => {
      const next = !unlocked;
      const res = await callWebcopy<{ enabled: boolean }>(
        MSG.WEBCOPY_TOGGLE_UNLOCK,
        { enabled: next }
      );
      if (!res.success || !res.data) {
        report(false, res.error || '操作失败');
        return;
      }
      setUnlocked(res.data.enabled);
      report(true, res.data.enabled ? '已解除复制限制' : '已恢复页面原状');
    });

  const handleCopyTabs = (scope: 'current' | 'all') =>
    run(`tabs-${scope}`, async () => {
      const res = await sendToBackground<{ text: string; count: number }>(
        MSG.COPY_TABS,
        {
          scope,
          format: scope === 'current' ? 'markdown' : webcopyCfg.tabCopyFormat,
        }
      );
      if (!res.success || !res.data) {
        report(false, res.error || '复制失败');
        return;
      }
      await copyText(
        res.data.text,
        scope === 'current'
          ? '已复制本页 Markdown 链接'
          : `已复制 ${res.data.count} 个标签页`
      );
    });

  /** 下载视频：任务在本地 daemon 跑 yt-dlp，进度显示在底部状态栏（PROGRESS 推送） */
  const handleDownloadVideo = async () => {
    if (videoBusy) return;
    setVideoBusy(true);
    setStatusKind('idle');
    setStatus('正在发起视频下载，进度见底部状态栏…');
    try {
      const res = await sendToBackground<{ file?: string }>(MSG.DOWNLOAD_VIDEO);
      if (res.success) {
        report(true, res.data?.file ? `视频已保存：${res.data.file}` : '视频下载完成');
      } else {
        report(false, res.error || '下载失败');
      }
    } catch (e) {
      report(false, e instanceof Error ? e.message : String(e));
    } finally {
      setVideoBusy(false);
    }
  };

  const handleToggleAutoCopy = () =>
    run('autocopy', async () => {
      const next = { ...webcopyCfg, autoCopyEnabled: !webcopyCfg.autoCopyEnabled };
      await saveConfig({ webcopy: next });
      setWebcopyCfg(next);
      if (next.autoCopyEnabled) {
        // 注入当前标签页让开关立即生效；其他页面需再次手动激活（P0 会话级）
        const res = await callWebcopy<WebCopyState>(MSG.WEBCOPY_ENSURE);
        report(
          true,
          res.success
            ? '自动复制已开启（当前标签页已生效）'
            : '自动复制已开启，当前页未激活：' + (res.error || '')
        );
      } else {
        report(true, '自动复制已关闭');
      }
    });

  return (
    <div className="webcopy">
      {video?.supported && (
        <div className="wc-card">
          <div className="wc-card-title">下载视频</div>
          <div className="wc-btn-row">
            <button
              className="wc-btn primary"
              disabled={videoBusy || !video.bridgeReady}
              onClick={handleDownloadVideo}
            >
              {videoBusy ? '下载中…' : '下载当前视频'}
            </button>
          </div>
          <div className="wc-row-sub">
            {video.bridgeReady
              ? '由本地 yt-dlp 下载到「下载/larksnap-video」文件夹'
              : video.reason || '本地 daemon 未就绪'}
          </div>
        </div>
      )}

      <div className="wc-card">
        <div className="wc-card-title">整页转 Markdown</div>
        <div className="wc-btn-row">
          <button
            className="wc-btn primary"
            disabled={!!busy}
            onClick={() => handlePageMd('copy')}
          >
            复制
          </button>
          <button
            className="wc-btn"
            disabled={!!busy}
            onClick={() => handlePageMd('download')}
          >
            下载 .md
          </button>
          <button className="wc-btn" disabled={!!busy} onClick={handleSelectionMd}>
            仅选中内容
          </button>
        </div>
      </div>

      <div className="wc-card">
        <label className="wc-toggle-row">
          <span>
            <span className="wc-row-title">解除复制限制</span>
            <span className="wc-row-sub">禁止选择/复制/右键的页面一键解锁</span>
          </span>
          <input
            type="checkbox"
            checked={unlocked}
            disabled={!!busy}
            onChange={handleToggleUnlock}
          />
        </label>
        <label className="wc-toggle-row">
          <span>
            <span className="wc-row-title">选中文字自动复制</span>
            <span className="wc-row-sub">
              选中 ≥{webcopyCfg.autoCopyMinChars} 字自动进剪贴板（本页会话级）
            </span>
          </span>
          <input
            type="checkbox"
            checked={webcopyCfg.autoCopyEnabled}
            disabled={!!busy}
            onChange={handleToggleAutoCopy}
          />
        </label>
      </div>

      <div className="wc-card">
        <div className="wc-card-title">标签页链接</div>
        <div className="wc-btn-row">
          <button
            className="wc-btn"
            disabled={!!busy}
            onClick={() => handleCopyTabs('current')}
          >
            复制本页链接(MD)
          </button>
          <button
            className="wc-btn"
            disabled={!!busy}
            onClick={() => handleCopyTabs('all')}
          >
            复制全部标签页
          </button>
        </div>
      </div>

      <div className={`wc-status wc-status-${statusKind}`}>{status}</div>

      {preview != null && (
        <div className="wc-card">
          <div className="wc-card-title">转换结果（手动复制）</div>
          <textarea
            className="wc-preview"
            readOnly
            value={preview}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}
