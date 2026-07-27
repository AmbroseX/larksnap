import type { DocInfo, Response } from '../../shared/types';
import { t } from '../../shared/i18n';
import { reportProgress } from '../progress';
import { resolveTargetTabId } from '../feishu-proxy';
import { createXlsxDataUrl, type XlsxSheet } from '../xlsx';
import { downloadDataUrl, safeName } from '../download';

/**
 * 多维表格（bitable / base）导出 Excel —— 情况 B「档二：读页面内存」。
 *
 * 背景（实测见 docs/plans/2026-07-20-多维表格导出Excel.md 第十节）：
 * bitable 的记录不走任何可拉取的 REST 接口——clientvars 里 table/base 解压后是
 * 字面量 null，记录只以 gzip+base64 二进制帧走协同 WebSocket 推到页面内存。
 * 所以这里不请求接口，而是**在页面主世界读页面自己的数据模型**（window.bitableStore），
 * 把每张数据表读成二维文本数组，再合成一个多 sheet 的 .xlsx。
 *
 * 单元格 → 文本：优先字段对象的 cellValueToString（文本/人员/链接/单选都给干净串），
 * 没有该方法的（多选等）回退 cellValueToStdValue，取 data[].text 拼接。二者都是
 * 飞书自己的序列化器，不用手写几十种字段类型。
 *
 * ⚠️ 只读页面已加载到内存的数据：超大表受首屏 recordLimit（约 2000 行）限制，
 * 内存里可能只有已加载部分。导出前校验行数，不足则照出但在提示里说明"N/M 行"，
 * 绝不静默截断。
 */

/** 单张数据表的抽取结果 */
interface BitableTable {
  id: string;
  name: string;
  /** 首行为表头（字段名），其后每行一条记录 */
  rows: string[][];
  /** 内存已加载记录数 */
  loaded: number;
  /** 该表记录总数（recordsNum） */
  total: number;
}

interface BitableData {
  title: string;
  tables: BitableTable[];
  error?: string;
}

export async function exportBitable(doc: DocInfo): Promise<Response> {
  try {
    await reportProgress('markdown', 'running', t('progress.bitable.reading'), 20);
    const tabId = await resolveTargetTabId();

    const [{ result } = { result: undefined }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: extractBitableInPage,
      });
    const data = result as BitableData | undefined;

    if (!data || data.error) {
      const msg = data?.error || t('progress.bitable.readFailed');
      await reportProgress('markdown', 'error', msg, 100);
      return { success: false, error: msg };
    }
    // 只导有数据的表（跳过空表/系统表）
    const tables = data.tables.filter((tb) => tb.rows.length > 1);
    if (tables.length === 0) {
      const msg = t('progress.bitable.empty');
      await reportProgress('markdown', 'error', msg, 100);
      return { success: false, error: msg };
    }

    await reportProgress('markdown', 'running', t('progress.bitable.building'), 70);
    const title = data.title || doc.title || doc.token;
    const sheets: XlsxSheet[] = tables.map((tb) => ({ name: tb.name, rows: tb.rows }));

    await reportProgress('markdown', 'running', t('progress.bitable.packing'), 90);
    const url = await createXlsxDataUrl(sheets);
    await downloadDataUrl(url, `${safeName(title)}.xlsx`);

    // 有表被首屏行数上限截断 → 成功但提示只导出了部分行
    const cut = tables.filter((tb) => tb.loaded < tb.total);
    const doneMsg = cut.length
      ? t('progress.bitable.donePartial', {
          n: tables.length,
          loaded: cut.reduce((s, tb) => s + tb.loaded, 0),
          total: cut.reduce((s, tb) => s + tb.total, 0),
        })
      : t('progress.bitable.done', { n: tables.length });
    await reportProgress('markdown', 'success', doneMsg, 100);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportProgress('markdown', 'error', msg, 100);
    return { success: false, error: msg };
  }
}

// ==================== 页面主世界抽取器 ====================

/**
 * 注入到页面 MAIN world 执行。**必须自包含**（不能引用外部变量），返回值必须可序列化。
 * 逻辑：
 *   1. 从 window.bitableStore.services 里找带 modelOperator.base 的服务，拿数据根 base；
 *   2. base.blocks 是数组，每个 block 是一张数据表；跳过无字段的空表；
 *   3. 列顺序取网格视图（views 里 type===1）的 _visibleFieldIds，退回字段自身顺序；
 *   4. 逐记录逐字段读单元格，用字段对象的序列化器转文本。
 *
 * 已实测于讯飞白牌（飞书底座）bitable；字段/方法名随 SDK 版本可能漂移。
 */
function extractBitableInPage(): {
  title: string;
  tables: {
    id: string;
    name: string;
    rows: string[][];
    loaded: number;
    total: number;
  }[];
  error?: string;
} {
  const EMPTY = {
    title: '',
    tables: [] as {
      id: string;
      name: string;
      rows: string[][];
      loaded: number;
      total: number;
    }[],
  };
  const arr = (o: any): any[] =>
    Array.isArray(o) ? o : o && typeof o === 'object' ? Object.values(o) : [];

  try {
    const store = (window as unknown as { bitableStore?: any }).bitableStore;
    if (!store) {
      return {
        ...EMPTY,
        error: '未找到多维表格数据模型（bitableStore），页面可能未加载完成或不是多维表格',
      };
    }
    const svc = arr(store.services).find(
      (s: any) => s && s.modelOperator && s.modelOperator.base
    );
    const base = svc && svc.modelOperator.base;
    if (!base) {
      return { ...EMPTY, error: '多维表格模型结构不匹配（SDK 版本可能已变化）' };
    }

    // 单元格 → 文本：优先 cellValueToString，回退 cellValueToStdValue 取 text 拼接
    const cellToStr = (field: any, cell: any): string => {
      if (!cell || cell.value == null) return '';
      try {
        if (typeof field.cellValueToString === 'function') {
          const s = field.cellValueToString(cell.value);
          if (s != null) return String(s);
        }
      } catch {
        /* 落到 stdValue 兜底 */
      }
      try {
        const std = field.cellValueToStdValue(cell.value);
        const d = (std && std.data) || [];
        return d.map((x: any) => (x && x.text != null ? x.text : '')).join(', ').trim();
      } catch {
        return '';
      }
    };

    const tables: {
      id: string;
      name: string;
      rows: string[][];
      loaded: number;
      total: number;
    }[] = [];

    for (const block of arr(base.blocks)) {
      const fieldList = arr(block.fields);
      if (fieldList.length === 0) continue; // 空/系统表
      const fieldsById: Record<string, any> = {};
      for (const f of fieldList) fieldsById[f.id] = f;

      // 列顺序：网格视图的可见字段 → 退回字段自身顺序
      const views = arr(block.views);
      const grid = views.find((v: any) => v.type === 1) || views[0];
      const orderIds =
        grid && grid._visibleFieldIds && grid._visibleFieldIds.length
          ? Array.from(grid._visibleFieldIds as string[])
          : Object.keys(fieldsById);
      const cols = orderIds.map((id) => fieldsById[id]).filter(Boolean);
      if (cols.length === 0) continue;

      const records = block.records || {};
      const recIds = Object.keys(records);
      const rows: string[][] = [cols.map((f) => String(f.name ?? ''))];
      for (const rid of recIds) {
        const rec = records[rid];
        rows.push(cols.map((f) => cellToStr(f, rec[f.id])));
      }
      tables.push({
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        rows,
        loaded: recIds.length,
        total: Number(block.recordsNum ?? recIds.length),
      });
    }

    const title = document.title
      .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
      .replace(/\s*[-–—].*$/, '')
      .trim();
    return { title, tables };
  } catch (e: any) {
    return { ...EMPTY, error: '读取多维表格出错：' + (e?.message || String(e)) };
  }
}
