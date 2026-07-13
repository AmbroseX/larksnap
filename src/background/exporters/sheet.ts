import type { DocInfo, EmbeddedSheetRef, Response } from '../../shared/types';
import { t } from '../../shared/i18n';
import { reportProgress } from '../progress';
import { resolveTargetTabId } from '../feishu-proxy';
import { createZipDataUrl, type ZipFile } from '../zip';
import { downloadDataUrl, safeName } from '../download';

/**
 * 电子表格（sheets）导出 —— 与 docx 的 client_vars 路子完全不同。
 *
 * 表格的单元格数据不走可拉取的 REST 接口，而是通过协同 WebSocket 推到页面内存、
 * 画在 canvas 上（DOM 里没有单元格）。所以这里不请求接口，而是**在页面主世界读
 * 页面自己的表格模型**（window.spreadApp），把每张 sheet 的单元格读成二维数组。
 *
 * 产出：一个 zip，含「转换后的 Markdown」+「每张表一个 CSV（原始数据）」，
 * 桥接侧会解包成一个以文档标题命名的文件夹。
 *
 * ⚠️ 只读页面已渲染的数据，能读到什么取决于你在该页面的访问权限。
 * 详见 docs/plans/2026-07-03-sheets导出适配研究.md
 */

/** 单张表的抽取结果 */
interface SheetData {
  id: string;
  name: string;
  /** 已裁掉全空尾行/尾列的二维单元格文本 */
  rows: string[][];
}

/** 整个工作簿的抽取结果 */
interface Workbook {
  title: string;
  sheets: SheetData[];
  error?: string;
}

export async function exportSheet(doc: DocInfo): Promise<Response> {
  try {
    await reportProgress('markdown', 'running', t('progress.sheet.reading'), 20);
    const tabId = await resolveTargetTabId();

    const [{ result } = { result: undefined }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: extractWorkbookInPage,
      });
    const wb = result as Workbook | undefined;

    if (!wb || wb.error) {
      const msg = wb?.error || t('progress.sheet.readFailed');
      await reportProgress('markdown', 'error', msg, 100);
      return { success: false, error: msg };
    }
    const sheets = wb.sheets.filter((s) => s.rows.length > 0);
    if (sheets.length === 0) {
      const msg = t('progress.sheet.empty');
      await reportProgress('markdown', 'error', msg, 100);
      return { success: false, error: msg };
    }

    await reportProgress('markdown', 'running', t('progress.sheet.converting'), 70);
    const title = wb.title || doc.title || doc.token;
    const files = buildFiles(title, sheets);

    await reportProgress('markdown', 'running', t('progress.sheet.packing'), 90);
    const zipUrl = await createZipDataUrl(files);
    await downloadDataUrl(zipUrl, `${safeName(title)}.zip`);

    await reportProgress(
      'markdown',
      'success',
      t('progress.sheet.done', { n: sheets.length }),
      100
    );
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('markdown', 'error', msg, 100);
    return { success: false, error: msg };
  }
}

/** 组装 zip 文件清单：一个 Markdown + 每张表一个 CSV */
function buildFiles(title: string, sheets: SheetData[]): ZipFile[] {
  const files: ZipFile[] = [];
  files.push({ path: `${safeName(title)}.md`, content: toMarkdown(title, sheets) });
  const used = new Set<string>();
  for (const sh of sheets) {
    let base = safeName(sh.name) || 'sheet';
    // 同名 sheet 去重，避免 CSV 互相覆盖
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base}(${i++})`;
    used.add(name);
    files.push({ path: `csv/${name}.csv`, content: toCsv(sh.rows) });
  }
  return files;
}

// ==================== 转换器（SW 侧，纯数据处理） ====================

/** 整个工作簿 → Markdown：H1 标题 + 每张表 H2 + GFM 表格 */
function toMarkdown(title: string, sheets: SheetData[]): string {
  const parts: string[] = [`# ${title}`, ''];
  for (const sh of sheets) {
    parts.push(`## ${sh.name}`, '');
    parts.push(sheetToMdTable(sh.rows), '');
  }
  return parts.join('\n');
}

/**
 * 二维数组 → GFM 表格。第一行当表头。
 * 单元格里的竖线和换行会破坏表格，分别转义/换成 <br>。
 * （docx 内嵌 sheet 块的替换也用它，勿改成私有）
 */
export function sheetToMdTable(rows: string[][]): string {
  if (rows.length === 0) return t('progress.sheet.emptyTable');
  const cols = Math.max(...rows.map((r) => r.length));
  const cell = (v: string) =>
    (v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const pad = (r: string[]) => {
    const out = r.slice(0, cols).map(cell);
    while (out.length < cols) out.push('');
    return `| ${out.join(' | ')} |`;
  };
  const header = pad(rows[0]);
  const divider = `| ${Array(cols).fill('---').join(' | ')} |`;
  const body = rows.slice(1).map(pad);
  return [header, divider, ...body].join('\n');
}

/** 二维数组 → CSV（RFC 4180：含逗号/引号/换行的字段用双引号包裹并转义引号） */
function toCsv(rows: string[][]): string {
  const esc = (v: string) => {
    const s = v ?? '';
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

// ==================== docx 内嵌 sheet 块抽取 ====================

/**
 * 读 docx 页面里内嵌 sheet 块的单元格（技术调研见
 * docs/plans/2026-07-06-docx内嵌sheet块导出.md）。
 *
 * ⚠️ 和独立表格页不是一套全局：docx 页的模型在 `window.spread`（不是 spreadApp），
 * 且不能用 getActiveSheet——多块时 active 的不一定是目标块，要按子表 id 在
 * `spread.sheets[]` 里定位。已实测后台标签页（hidden + rAF 冻结）模型照常加载。
 *
 * 返回 blockId → 单元格二维数组；定位失败的块为 null（exporter 降级为链接）。
 */
export async function extractEmbeddedSheets(
  refs: EmbeddedSheetRef[]
): Promise<Record<string, string[][] | null>> {
  const tabId = await resolveTargetTabId();
  const [{ result } = { result: undefined }] =
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractEmbeddedSheetsInPage,
      args: [refs.map((r) => ({ blockId: r.blockId, subId: r.subId }))],
    });
  return (result as Record<string, string[][] | null>) ?? {};
}

/**
 * 注入到 docx 页面 MAIN world 执行。**必须自包含**（不能引用外部变量）。
 * 逐块：按子表 id 在 window.spread.sheets 里找模型；找不到就滚到块的 DOM 锚点
 * （data-record-id）触发懒挂载再轮询；读全单元格后裁掉全空尾行/尾列。
 */
function extractEmbeddedSheetsInPage(
  refs: { blockId: string; subId: string }[]
): Promise<Record<string, string[][] | null>> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const findSheet = (subId: string): any | null => {
    const sp = (window as unknown as { spread?: any }).spread;
    const list = sp?.sheets;
    if (!list) return null;
    for (const s of Array.from(list as any[])) {
      try {
        const id =
          typeof s.id === 'function' ? String(s.id()) : String(s._id_ ?? '');
        if (id === subId) return s;
      } catch {
        /* 单个模型异常忽略，继续找 */
      }
    }
    return null;
  };

  const readGrid = (s: any): string[][] => {
    const R = s.getRowCount();
    const C = s.getColumnCount();
    const g: string[][] = [];
    for (let r = 0; r < R; r++) {
      const row: string[] = [];
      for (let c = 0; c < C; c++) {
        let v = '';
        try {
          v = s.getText(r, c);
        } catch {
          /* 忽略单元格错误 */
        }
        row.push(v == null ? '' : String(v));
      }
      g.push(row);
    }
    // 裁掉全空尾行/尾列
    let lr = -1;
    let lc = -1;
    for (let r = 0; r < g.length; r++)
      for (let c = 0; c < g[r].length; c++)
        if (g[r][c] !== '') {
          if (r > lr) lr = r;
          if (c > lc) lc = c;
        }
    return lr < 0 ? [] : g.slice(0, lr + 1).map((row) => row.slice(0, lc + 1));
  };

  const run = async () => {
    const out: Record<string, string[][] | null> = {};
    for (const { blockId, subId } of refs) {
      let sheet = findSheet(subId);
      if (!sheet) {
        // 懒加载：滚到块的位置触发挂载，再轮询等模型（后台页定时器有节流，窗口留足）
        document
          .querySelector(`[data-record-id="${CSS.escape(blockId)}"]`)
          ?.scrollIntoView();
        for (let i = 0; i < 12 && !sheet; i++) {
          await sleep(700);
          sheet = findSheet(subId);
        }
      }
      if (!sheet) {
        out[blockId] = null;
        continue;
      }
      // 刚挂载可能还在拉数：连续几轮仍全空才当真空表
      let rows: string[][] = [];
      for (let i = 0; i < 8; i++) {
        try {
          rows = readGrid(sheet);
        } catch {
          rows = [];
        }
        if (rows.length > 0 || i >= 4) break;
        await sleep(700);
      }
      out[blockId] = rows;
    }
    return out;
  };

  return run().catch(() => ({}));
}

// ==================== 页面主世界抽取器 ====================

/**
 * 注入到页面 MAIN world 执行。**必须自包含**（不能引用外部变量），
 * 返回值必须可序列化。逻辑：
 *   1. 从 window.spreadApp 拿到有序的 sheet 列表；
 *   2. 逐张切换（合成指针事件点 tab，setActiveSheetById 不会触发数据加载）；
 *   3. 轮询等目标 sheet 激活且有数据；
 *   4. 读全 getText(r,c)，裁掉全空尾行/尾列。
 *
 * 已实测于讯飞白牌（飞书底座）表格 SDK；字段/方法名随 SDK 版本可能漂移。
 */
function extractWorkbookInPage(): Promise<{
  title: string;
  sheets: { id: string; name: string; rows: string[][] }[];
  error?: string;
}> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const EMPTY = { title: '', sheets: [] as { id: string; name: string; rows: string[][] }[] };

  const run = async () => {
    const app = (window as unknown as { spreadApp?: any }).spreadApp;
    if (!app) return { ...EMPTY, error: '未找到表格应用实例（spreadApp），页面可能未加载完成或不是电子表格' };

    let cs: any, spread: any;
    try {
      cs = app.collaborativeSpread;
      spread = app.shell.viewModelManager.spread;
    } catch {
      return { ...EMPTY, error: '表格模型结构不匹配（SDK 版本可能已变化）' };
    }
    const list: { id: string; name: string }[] = (() => {
      try {
        return spread.sheets.map((s: any) => ({ id: String(s.id()), name: String(s.name()) }));
      } catch {
        return [];
      }
    })();
    if (list.length === 0) return { ...EMPTY, error: '未读到任何工作表' };

    const clickTab = (name: string): boolean => {
      const cont: ParentNode = document.querySelector('.sheet-tabs') || document;
      let el =
        [...cont.querySelectorAll('.tab-name')].find((e) => e.textContent?.trim() === name) ||
        [...cont.querySelectorAll('*')].find(
          (e) => e.children.length === 0 && e.textContent?.trim() === name
        );
      if (!el) return false;
      const rc = (el as HTMLElement).getBoundingClientRect();
      const xy = {
        clientX: rc.x + rc.width / 2,
        clientY: rc.y + rc.height / 2,
        bubbles: true,
        cancelable: true,
        view: window,
      };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...xy, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousedown', xy));
      el.dispatchEvent(new PointerEvent('pointerup', { ...xy, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', xy));
      el.dispatchEvent(new MouseEvent('click', xy));
      return true;
    };

    const countTop = (name: string): { ready: boolean; n: number } => {
      const s = cs.getActiveSheet();
      if (s.name() !== name) return { ready: false, n: 0 };
      const R = Math.min(s.getRowCount(), 50);
      const C = s.getColumnCount();
      let n = 0;
      for (let r = 0; r < R; r++)
        for (let c = 0; c < C; c++) {
          let v = '';
          try {
            v = s.getText(r, c);
          } catch { /* 单元格读取失败忽略 */ }
          if (v) n++;
        }
      return { ready: true, n };
    };

    const readActive = (): { id: string; name: string; rows: string[][] } => {
      const s = cs.getActiveSheet();
      const R = s.getRowCount();
      const C = s.getColumnCount();
      const g: string[][] = [];
      for (let r = 0; r < R; r++) {
        const row: string[] = [];
        for (let c = 0; c < C; c++) {
          let v = '';
          try {
            v = s.getText(r, c);
          } catch { /* 忽略单元格错误 */ }
          row.push(v == null ? '' : String(v));
        }
        g.push(row);
      }
      let lr = -1;
      let lc = -1;
      for (let r = 0; r < R; r++)
        for (let c = 0; c < C; c++)
          if (g[r][c] !== '') {
            if (r > lr) lr = r;
            if (c > lc) lc = c;
          }
      const rows = lr < 0 ? [] : g.slice(0, lr + 1).map((row) => row.slice(0, lc + 1));
      return { id: String(s.id()), name: String(s.name()), rows };
    };

    const sheets: { id: string; name: string; rows: string[][] }[] = [];
    for (const { name } of list) {
      clickTab(name);
      for (let i = 0; i < 12; i++) {
        await sleep(700);
        const r = countTop(name);
        if (r.ready && r.n > 0) break;
        if (r.ready && i >= 4) break; // 确实是空表，不死等
      }
      sheets.push(readActive());
    }

    const title = document.title
      .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
      .replace(/\s*[-–—].*$/, '')
      .trim();
    return { title, sheets };
  };

  return run().catch((e) => ({ ...EMPTY, error: '读取表格出错：' + (e?.message || String(e)) }));
}
