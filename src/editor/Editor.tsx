import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from '../shared/markdown/Markdown';
import { useI18n } from '../shared/i18n/useI18n';

/**
 * 本地 Markdown 编辑器（整页）：
 *   左 textarea 写源码 → 右侧复用 Markdown 组件实时渲染（本地文件可信，开 allowImages）。
 *
 * 打开两种方式：
 *   - 打开文件：优先 File System Access（拿可写句柄 → ⌘S 写回原文件），
 *     不支持则退回 <input type=file> 只读（保存 = 下载副本）。
 *   - 打开文件夹：<input webkitdirectory> 整目录读进内存（任何环境可用），
 *     相对路径图片（images/x.png）映射成 blob 显示；只读，保存 = 下载。
 *
 * 未保存 = 当前文本 ≠ 上次保存基线，脏则关页前弹浏览器原生确认。
 */

const MD_TYPES: FilePickerAcceptType[] = [
  { description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } },
];

/** 输入停顿多久算“打完了”：期间走 Markdown 的流式节流跳高亮，停顿后终渲一次 */
const TYPING_IDLE_MS = 200;

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const MD_EXT = /\.(md|markdown|mdx|txt)$/i;

type StatusKind = 'idle' | 'success' | 'error';

const hasFsApi = typeof window !== 'undefined' && 'showOpenFilePicker' in window;

/** 归一化路径：去掉 . 、处理 .. 、合并多余斜杠 */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** 写文件前确保拿到读写授权（首次弹一次，同会话之后免问） */
async function ensureWritable(handle: FileSystemFileHandle): Promise<boolean> {
  const desc: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };
  if ((await handle.queryPermission(desc)) === 'granted') return true;
  return (await handle.requestPermission(desc)) === 'granted';
}

export function Editor() {
  const { t } = useI18n();

  const [content, setContent] = useState('');
  /** 上次保存到磁盘的文本基线，用来判断脏 */
  const [savedText, setSavedText] = useState('');
  const [handle, setHandle] = useState<FileSystemFileHandle | null>(null);
  const [fileName, setFileName] = useState('');
  const [typing, setTyping] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<StatusKind>('idle');

  const dirty = content !== savedText;
  /** 有可写句柄才能写回原文件；否则保存只能下载副本 */
  const canWriteBack = handle != null;

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 相对路径 → blob URL（打开文件夹时建立），md 所在目录前缀，供 resolveSrc 用 */
  const blobMapRef = useRef<Map<string, string>>(new Map());
  const baseDirRef = useRef('');
  /** 最新值给键盘快捷键闭包用，避免旧闭包存到过期文本/句柄 */
  const contentRef = useRef(content);
  contentRef.current = content;
  const handleRef = useRef(handle);
  handleRef.current = handle;

  // <input webkitdirectory> 的属性 TS JSX 类型里没有，用 ref 设上去
  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  const revokeBlobs = useCallback(() => {
    for (const url of blobMapRef.current.values()) URL.revokeObjectURL(url);
    blobMapRef.current = new Map();
  }, []);

  useEffect(() => () => revokeBlobs(), [revokeBlobs]);

  const report = useCallback((kind: StatusKind, msg: string) => {
    setStatusKind(kind);
    setStatus(msg);
  }, []);

  const onChange = useCallback((v: string) => {
    setContent(v);
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
  }, []);

  /** 载入一段文本作为当前文档（重置图片映射，除非调用方另建） */
  const loadText = useCallback((text: string, name: string) => {
    setContent(text);
    setSavedText(text);
    setFileName(name);
    setTyping(false);
  }, []);

  // ---- 打开文件 ----
  const doOpen = useCallback(async () => {
    if (hasFsApi) {
      try {
        const [h] = await window.showOpenFilePicker({ types: MD_TYPES });
        if (!h) return;
        const file = await h.getFile();
        revokeBlobs();
        baseDirRef.current = '';
        setHandle(h);
        loadText(await file.text(), file.name);
        report('idle', '');
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        report('error', `${t('editor.openFailed')}: ${describe(e)}`);
      }
      return;
    }
    fileInputRef.current?.click();
  }, [revokeBlobs, loadText, report, t]);

  const onFilePicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      revokeBlobs();
      baseDirRef.current = '';
      setHandle(null);
      loadText(await f.text(), f.name);
      report('idle', '');
    },
    [revokeBlobs, loadText, report]
  );

  // ---- 打开文件夹（相对图片靠这个才显示得出来） ----
  const doOpenFolder = useCallback(() => folderInputRef.current?.click(), []);

  const onFolderPicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      e.target.value = '';
      if (!files.length) return;
      const mds = files.filter((f) => MD_EXT.test(f.name));
      if (!mds.length) {
        report('error', t('editor.noMd'));
        return;
      }
      // 建图片 blob 映射（键 = 归一化的目录内相对路径）
      revokeBlobs();
      const map = new Map<string, string>();
      for (const f of files) {
        if (!IMG_EXT.test(f.name)) continue;
        const rel = normalizePath(f.webkitRelativePath || f.name);
        map.set(rel, URL.createObjectURL(f));
      }
      blobMapRef.current = map;
      const md = mds[0];
      baseDirRef.current = dirname(normalizePath(md.webkitRelativePath || md.name));
      setHandle(null); // 文件夹是只读输入，保存 = 下载
      loadText(await md.text(), md.name);
      report(
        'idle',
        mds.length > 1 ? t('editor.multiMd', { name: md.name, n: mds.length }) : ''
      );
    },
    [revokeBlobs, loadText, report, t]
  );

  /** 相对图片路径 → blob；带协议的 URL（http/data/blob）不改，返回 undefined */
  const resolveSrc = useCallback((src: string): string | undefined => {
    try {
      new URL(src);
      return undefined; // 绝对 URL，交给浏览器直接加载
    } catch {
      // 相对路径
    }
    const map = blobMapRef.current;
    return (
      map.get(normalizePath(`${baseDirRef.current}/${src}`)) ??
      map.get(normalizePath(src))
    );
  }, []);

  // ---- 保存 ----
  const download = useCallback((name: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'untitled.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  /** 把文本写进给定句柄 */
  const writeTo = useCallback(
    async (h: FileSystemFileHandle, text: string): Promise<boolean> => {
      if (!(await ensureWritable(h))) {
        report('error', t('editor.permissionDenied'));
        return false;
      }
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      return true;
    },
    [report, t]
  );

  const doSaveAs = useCallback(async () => {
    const text = contentRef.current;
    const name = fileName || t('editor.newFile');
    if (!hasFsApi) {
      download(name, text);
      setSavedText(text);
      report('success', t('editor.downloaded', { name }));
      return;
    }
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types: MD_TYPES });
      if (!(await writeTo(h, text))) return;
      setHandle(h);
      setFileName(h.name);
      setSavedText(text);
      report('success', t('editor.saved', { name: h.name }));
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      report('error', `${t('editor.saveFailed')}: ${describe(e)}`);
    }
  }, [fileName, download, writeTo, report, t]);

  const doSave = useCallback(async () => {
    const h = handleRef.current;
    if (!h) {
      await doSaveAs(); // 无可写句柄：FS API 走另存，否则下载副本
      return;
    }
    try {
      const text = contentRef.current;
      if (!(await writeTo(h, text))) return;
      setSavedText(text);
      report('success', t('editor.saved', { name: fileName }));
    } catch (e) {
      report('error', `${t('editor.saveFailed')}: ${describe(e)}`);
    }
  }, [doSaveAs, writeTo, report, t, fileName]);

  // ⌘/Ctrl+S 全局拦截保存（浏览器默认是“保存网页”，必须挡掉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSave]);

  // 有未保存改动时关页/刷新弹浏览器原生确认（自定义文案现代浏览器已忽略）
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(
    () => () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (driverTimer.current) clearTimeout(driverTimer.current);
    },
    []
  );

  // textarea Tab 键插入两个空格而非跳焦点
  const onTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: end, value } = ta;
      onChange(`${value.slice(0, s)}  ${value.slice(end)}`);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    },
    [onChange]
  );

  // 两栏按比例双向同步滚动。driver 记住谁在主动滚——被带动的一方触发的
  // scroll 事件（from ≠ driver）直接忽略，避免来回抖；停手 120ms 后释放。
  const scrollDriver = useRef<'src' | 'preview' | null>(null);
  const driverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncScroll = useCallback((from: 'src' | 'preview') => {
    if (scrollDriver.current && scrollDriver.current !== from) return;
    const ta = taRef.current;
    const pv = previewRef.current;
    if (!ta || !pv) return;
    scrollDriver.current = from;
    if (driverTimer.current) clearTimeout(driverTimer.current);
    driverTimer.current = setTimeout(() => (scrollDriver.current = null), 120);

    if (from === 'src') {
      const range = ta.scrollHeight - ta.clientHeight;
      if (range > 0) pv.scrollTop = (ta.scrollTop / range) * (pv.scrollHeight - pv.clientHeight);
    } else {
      const range = pv.scrollHeight - pv.clientHeight;
      if (range > 0) ta.scrollTop = (pv.scrollTop / range) * (ta.scrollHeight - ta.clientHeight);
    }
  }, []);

  return (
    <div className="ed-root">
      <header className="ed-toolbar">
        <button type="button" className="ed-btn" onClick={() => void doOpen()}>
          {t('editor.open')}
        </button>
        <button type="button" className="ed-btn" onClick={doOpenFolder}>
          {t('editor.openFolder')}
        </button>
        <span className="ed-filename" title={fileName}>
          {fileName || t('editor.newFile')}
          {dirty && <span className="ed-dot" title={t('editor.unsaved')} />}
        </span>
        <span className="ed-spacer" />
        {status && <span className={`ed-status ed-status-${statusKind}`}>{status}</span>}
        {!canWriteBack && content !== '' && (
          <span className="ed-hint">{t('editor.fallbackHint')}</span>
        )}
        <button type="button" className="ed-btn" onClick={() => void doSaveAs()}>
          {t('editor.saveAs')}
        </button>
        <button type="button" className="ed-btn primary" onClick={() => void doSave()}>
          {canWriteBack ? t('editor.save') : t('editor.download')}
        </button>
      </header>

      <div className="ed-body">
        <textarea
          ref={taRef}
          className="ed-source"
          value={content}
          spellCheck={false}
          placeholder={t('editor.placeholder')}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onTextareaKeyDown}
          onScroll={() => syncScroll('src')}
        />
        <div
          className="ed-preview"
          ref={previewRef}
          onScroll={() => syncScroll('preview')}
        >
          <Markdown text={content} streaming={typing} allowImages resolveSrc={resolveSrc} />
        </div>
      </div>

      {/* 无 File System Access 时的兜底输入（隐藏，点按钮触发） */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown"
        style={{ display: 'none' }}
        onChange={(e) => void onFilePicked(e)}
      />
      <input
        ref={folderInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => void onFolderPicked(e)}
      />
    </div>
  );
}

/** 把异常转成能显示的简短原因 */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
