import type TurndownService from 'turndown';

/**
 * 表格规则（002.1b）：不用 gfm 表格插件——它处理不了 rowspan/colspan、
 * 单元格内换行和嵌套结构。思路参考 MarkSnip：
 *   - 每个单元格用 mini-Turndown 递归转换（粗体/链接/行内代码保得住）
 *   - rowspan/colspan 按跨度补占位格，保证每行列数一致不串列
 *   - 单元格内换行输出 <br>（GFM 表格里只能这么表达）
 *   - 纯布局表格（无表格语义）不产表格语法，按普通内容展开
 */

/** 数据表判定：有 th / caption，或至少 2×2 的行列结构才算 */
function isDataTable(table: HTMLTableElement): boolean {
  if (table.querySelector('th, caption')) return true;
  const rows = table.rows;
  return rows.length >= 2 && (rows[0]?.cells.length ?? 0) >= 2;
}

/** 单元格内容 → 单行文本：mini-Turndown 转换后压平换行、转义竖线 */
function cellText(cell: HTMLTableCellElement, mini: TurndownService): string {
  const md = mini.turndown(cell.innerHTML).trim();
  // 换行压成 <br>（连同 turndown 硬换行留下的行尾双空格一起吃掉），竖线转义防串列
  return md.replace(/ *\r?\n+/g, '<br>').replace(/\|/g, '\\|');
}

/** 把表格铺成矩阵，rowspan/colspan 展开为占位空格 */
function toGrid(table: HTMLTableElement, mini: TurndownService): string[][] {
  const grid: (string | null)[][] = [];
  const rows = Array.from(table.querySelectorAll('tr')).filter(
    (tr) => tr.closest('table') === table
  );
  rows.forEach((tr, r) => {
    grid[r] = grid[r] ?? [];
    let c = 0;
    for (const cell of Array.from(tr.cells)) {
      while (grid[r][c] != null) c++;
      const colspan = Math.max(1, cell.colSpan || 1);
      const rowspan = Math.max(1, cell.rowSpan || 1);
      for (let j = 0; j < rowspan; j++) {
        for (let i = 0; i < colspan; i++) {
          grid[r + j] = grid[r + j] ?? [];
          grid[r + j][c + i] = j === 0 && i === 0 ? cellText(cell, mini) : '';
        }
      }
      c += colspan;
    }
  });
  // 列数取最大值补齐，null 洞填空串
  const cols = Math.max(0, ...grid.map((row) => row.length));
  return grid.map((row) =>
    Array.from({ length: cols }, (_, i) => row[i] ?? '')
  );
}

export function addTableRule(
  td: TurndownService,
  createMini: () => TurndownService
): void {
  // 已由 table 规则整体接管的子节点直接吞掉，防止内容重复输出
  td.addRule('table-cells-consumed', {
    filter: ['thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption'],
    replacement: (content) => content,
  });

  td.addRule('table-gfm', {
    filter: 'table',
    replacement: (content, node) => {
      const table = node as HTMLTableElement;
      // 布局表格：不产表格语法，直接放行已转换的内容
      if (!isDataTable(table)) return `\n\n${content.trim()}\n\n`;

      const grid = toGrid(table, createMini());
      if (grid.length === 0 || grid[0].length === 0) return '';

      const header = grid[0];
      const sep = header.map(() => '---');
      const lines = [
        `| ${header.join(' | ')} |`,
        `| ${sep.join(' | ')} |`,
        ...grid.slice(1).map((row) => `| ${row.join(' | ')} |`),
      ];
      const caption = table.querySelector('caption')?.textContent?.trim();
      return `\n\n${caption ? `${caption}\n\n` : ''}${lines.join('\n')}\n\n`;
    },
  });
}
