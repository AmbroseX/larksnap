import { useCallback, useEffect, useState } from 'react';
import { createZipDataUrl, type ZipFile } from '../background/zip';
import { base64ToBytes } from '../background/media-util';
import { downloadDataUrl, safeName } from '../background/download';

/**
 * 小红书卡片预览页：SW 出图后先到这里过目，确认再打包下载。
 * - 点缩略图 → 居中放大（lightbox，支持左右切换 / Esc 关闭）；
 * - 每张卡可勾选，只打包勾中的（默认全选）；
 * - 打包与下载直接在侧边栏做（zip/download 工具是纯函数 + chrome.downloads，
 *   扩展页面可用），不用把几十 MB 的 PNG 再发回 SW 一趟。
 */

export interface XhsPreviewData {
  title: string;
  pngs: string[];
  /** 所选主题名（展示用） */
  themeName?: string;
}

interface Props {
  data: XhsPreviewData;
  onBack: () => void;
}

export function XhsPreview({ data, onBack }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [note, setNote] = useState('');
  /** 勾中的卡片下标（默认全选） */
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(data.pngs.map((_, i) => i))
  );
  /** 正在放大查看的卡片下标 */
  const [zoom, setZoom] = useState<number | null>(null);
  /** 放大态再点一下 → 原始尺寸（1080 宽）滚动查看；切卡时复位 */
  const [fill, setFill] = useState(false);
  useEffect(() => setFill(false), [zoom]);

  const total = data.pngs.length;
  const allSelected = selected.size === total;

  const toggle = useCallback((i: number) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((cur) =>
      cur.size === total ? new Set() : new Set(data.pngs.map((_, i) => i))
    );
  }, [total, data.pngs]);

  // 放大态键盘操作：Esc 关闭，← → 切换
  useEffect(() => {
    if (zoom == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(null);
      else if (e.key === 'ArrowLeft') setZoom((z) => (z != null && z > 0 ? z - 1 : z));
      else if (e.key === 'ArrowRight')
        setZoom((z) => (z != null && z < total - 1 ? z + 1 : z));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom, total]);

  /** 侧边栏太窄看不清细节：转成 blob URL 在新标签页开原图（1080×1440） */
  const openInTab = useCallback(
    (i: number) => {
      const png = data.pngs[i];
      const bytes = base64ToBytes(png.slice(png.indexOf(',') + 1));
      const blob = new Blob([bytes as BlobPart], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      chrome.tabs.create({ url });
      // 等标签页加载完再释放
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    [data.pngs]
  );

  const handleDownload = async () => {
    if (!selected.size) return;
    setDownloading(true);
    setNote('正在打包...');
    try {
      // 只打包勾中的，文件名保留原始序号，顺序不乱
      const files: ZipFile[] = [...selected]
        .sort((a, b) => a - b)
        .map((i) => ({
          path: `${String(i + 1).padStart(2, '0')}.png`,
          content: base64ToBytes(data.pngs[i].slice(data.pngs[i].indexOf(',') + 1)),
        }));
      const url = await createZipDataUrl(files);
      await downloadDataUrl(url, `${safeName(data.title)}-小红书卡片.zip`);
      setNote(`已开始下载（${files.length} 张）`);
    } catch (e) {
      setNote(`下载失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="panel">
      <header className="panel-header">
        <div className="title-row">
          <button className="back-btn" onClick={onBack}>
            ‹ 返回
          </button>
          <h1>卡片预览</h1>
        </div>
        <p className="subtitle">
          共 {total} 张{data.themeName ? ` · ${data.themeName}` : ''} ·
          点卡片放大，勾选要下载的
        </p>
        <div className="preview-toolbar">
          <button className="preview-selectall" onClick={toggleAll}>
            {allSelected ? '全不选' : '全选'}
          </button>
          <span className="preview-count">已选 {selected.size}/{total}</span>
        </div>
      </header>

      <main className="preview-grid">
        {data.pngs.map((png, i) => {
          const on = selected.has(i);
          return (
            <figure key={i} className={`preview-cell${on ? '' : ' unselected'}`}>
              <img
                src={png}
                alt={`卡片 ${i + 1}`}
                loading="lazy"
                onClick={() => setZoom(i)}
              />
              <button
                className={`preview-check${on ? ' on' : ''}`}
                title={on ? '取消选择' : '选择此张'}
                onClick={() => toggle(i)}
              >
                ✓
              </button>
              <figcaption>{i + 1}</figcaption>
            </figure>
          );
        })}
      </main>

      <footer className="preview-actions">
        <button
          className="preview-download"
          onClick={handleDownload}
          disabled={downloading || selected.size === 0}
        >
          {downloading
            ? '打包中...'
            : selected.size === 0
              ? '未选择卡片'
              : `确认下载 ZIP（已选 ${selected.size} 张）`}
        </button>
        <button className="preview-cancel" onClick={onBack} disabled={downloading}>
          取消
        </button>
        {note && <p className="preview-note">{note}</p>}
      </footer>

      {zoom != null && (
        <div className="lightbox" onClick={() => setZoom(null)}>
          <div
            className={`lightbox-scroll${fill ? ' fill' : ''}`}
            onClick={() => setZoom(null)}
          >
            <img
              className={`lightbox-img${fill ? ' fill' : ''}`}
              src={data.pngs[zoom]}
              alt={`卡片 ${zoom + 1}`}
              title={fill ? '点击恢复适应大小' : '点击查看原始尺寸'}
              onClick={(e) => {
                e.stopPropagation();
                setFill((f) => !f);
              }}
            />
          </div>
          {zoom > 0 && (
            <button
              className="lightbox-nav prev"
              onClick={(e) => {
                e.stopPropagation();
                setZoom(zoom - 1);
              }}
            >
              ‹
            </button>
          )}
          {zoom < total - 1 && (
            <button
              className="lightbox-nav next"
              onClick={(e) => {
                e.stopPropagation();
                setZoom(zoom + 1);
              }}
            >
              ›
            </button>
          )}
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <label className="lightbox-select">
              <input
                type="checkbox"
                checked={selected.has(zoom)}
                onChange={() => toggle(zoom)}
              />
              选中此张
            </label>
            <span className="lightbox-page">
              {zoom + 1}/{total}
            </span>
            <button
              className="lightbox-open"
              title="在新标签页查看 1080 宽原图"
              onClick={() => openInTab(zoom)}
            >
              原图
            </button>
            <button className="lightbox-close" onClick={() => setZoom(null)}>
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
