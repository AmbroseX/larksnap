import JSZip from 'jszip';

/**
 * 最小多 sheet .xlsx 生成器（零新依赖，复用已有的 JSZip）。
 *
 * xlsx 本质就是一个按 OOXML 约定组织的 zip。这里只做"多张表、纯文本单元格"
 * 这一件事——多维表格导出用不到公式/样式/数字格式，所有单元格一律按内联字符串
 * （t="inlineStr"）写，省掉 sharedStrings 和 styles 的复杂度（KISS）。
 *
 * 若日后要支持数字/日期的原生类型，再在此扩展，不影响调用方。
 */

/** 一张工作表：名字 + 二维文本单元格（第一行通常是表头，但本模块不作区分） */
export interface XlsxSheet {
  name: string;
  rows: string[][];
}

/** 组装为 .xlsx，返回 data URL（供 chrome.downloads.download） */
export async function createXlsxDataUrl(sheets: XlsxSheet[]): Promise<string> {
  const safe = normalizeSheetNames(sheets);
  const zip = new JSZip();

  zip.file('[Content_Types].xml', contentTypesXml(safe.length));
  zip.file('_rels/.rels', rootRelsXml());
  zip.file('xl/workbook.xml', workbookXml(safe));
  zip.file('xl/_rels/workbook.xml.rels', workbookRelsXml(safe.length));
  safe.forEach((sh, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh.rows));
  });

  const base64 = await zip.generateAsync({
    type: 'base64',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`;
}

// ==================== XML 分片 ====================

function contentTypesXml(n: number): string {
  const sheets = Array.from(
    { length: n },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets +
    `</Types>`
  );
}

function rootRelsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`
  );
}

function workbookXml(sheets: XlsxSheet[]): string {
  const items = sheets
    .map(
      (sh, i) =>
        `<sheet name="${xmlEsc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${items}</sheets></workbook>`
  );
}

function workbookRelsXml(n: number): string {
  const rels = Array.from(
    { length: n },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels +
    `</Relationships>`
  );
}

/** 一张表的 sheetN.xml：逐行逐格写内联字符串 */
function sheetXml(rows: string[][]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((val, c) => {
          const v = val ?? '';
          if (v === '') return '';
          const ref = `${colLetter(c)}${r + 1}`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

// ==================== 工具 ====================

/** 列号 → 字母（0→A, 25→Z, 26→AA…） */
export function colLetter(n: number): string {
  let s = '';
  let x = n;
  do {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

/** XML 文本转义 + 剔除 xlsx 不允许的控制字符（否则 Excel 报文件损坏） */
function xmlEsc(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 规整 sheet 名：Excel 限制——≤31 字符、不能含 []:*?/\、不能为空、同名要去重。
 * 返回新数组（不改入参），只替换 name。
 */
export function normalizeSheetNames(sheets: XlsxSheet[]): XlsxSheet[] {
  const used = new Set<string>();
  return sheets.map((sh, idx) => {
    let name = (sh.name || '').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
    if (!name) name = `Sheet${idx + 1}`;
    let candidate = name;
    let i = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = `(${i++})`;
      candidate = name.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return { name: candidate, rows: sh.rows };
  });
}
