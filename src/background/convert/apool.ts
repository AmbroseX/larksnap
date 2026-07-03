import type { InlineNode } from '../../shared/types';

/**
 * apool / changeset 解码器 —— P-decode 的文本抽取核心（§5.1）。
 *
 * 飞书 `client_vars` 正文是 Etherpad 风格的 attributed text：
 *   - `initialAttributedTexts.text`   ：每行纯文本（按行号 key）
 *   - `initialAttributedTexts.attribs` ：每行的属性操作串，如 `"*0+h"`
 *   - `apool.numToAttrib`              ：属性号 → [key, value]，如 `["bold","true"]`
 *
 * 操作串语法（Etherpad）：`*N`=应用属性号 N（base36），`+M`=接下来 M 个字符
 * （base36，`|L` 为跨行前缀，忽略其计数即可）。本解码器把它解成"纯文本 + 行内标记"。
 *
 * ⚠️ apool 的具体 key 名（bold/italic/link…）随部署可能有出入，这里用关键字匹配
 * 兜底；精确字段以"导出诊断信息"实测为准（§5.7）。
 */

type NumToAttrib = Record<string, [string, string]>;

interface AttributedTexts {
  text?: Record<string, string> | string;
  attribs?: Record<string, string> | string;
}

interface TextData {
  initialAttributedTexts?: AttributedTexts;
  apool?: { numToAttrib?: NumToAttrib };
}

/** 把一组属性号应用到一段文本，生成 InlineNode */
function makeNode(
  text: string,
  attrNums: number[],
  numToAttrib: NumToAttrib
): InlineNode {
  const node: InlineNode = { text };
  for (const n of attrNums) {
    const pair = numToAttrib[String(n)];
    if (!pair) continue;
    const key = (pair[0] || '').toLowerCase();
    const val = pair[1];
    if (key.includes('bold')) node.bold = true;
    else if (key.includes('italic')) node.italic = true;
    else if (key.includes('strike')) node.strike = true;
    else if (key.includes('inline') && key.includes('code')) node.inlineCode = true;
    else if (key === 'code' || key.includes('codeinline')) node.inlineCode = true;
    else if (key.includes('equation')) node.equation = val;
    else if (key.includes('link') || key.includes('href') || key.includes('url')) {
      node.link = decodeLinkValue(val);
    }
  }
  return node;
}

/** 链接值可能是 URL、JSON 或被编码，尽力还原为可用 URL */
function decodeLinkValue(val: string): string {
  if (!val) return val;
  try {
    const decoded = decodeURIComponent(val);
    const m = decoded.match(/https?:\/\/[^\s"']+/);
    return m ? m[0] : decoded;
  } catch {
    return val;
  }
}

/** 解码单行 attributed text 为 InlineNode[] */
function decodeLine(
  text: string,
  attribs: string,
  numToAttrib: NumToAttrib
): InlineNode[] {
  if (!attribs) return text ? [{ text }] : [];
  const nodes: InlineNode[] = [];
  let idx = 0;
  let pending: number[] = [];
  const re = /(\*[0-9a-z]+|\|[0-9a-z]+|\+[0-9a-z]+|=[0-9a-z]+|-[0-9a-z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attribs))) {
    const op = m[0];
    const code = op[0];
    const num = op.slice(1);
    if (code === '*') {
      pending.push(parseInt(num, 36));
    } else if (code === '+') {
      const len = parseInt(num, 36);
      const chunk = text.slice(idx, idx + len);
      idx += len;
      if (chunk) nodes.push(makeNode(chunk, pending, numToAttrib));
      pending = [];
    } else {
      // `|`(行计数前缀)、`=`、`-` 不消费 pending 文本属性映射，重置
      if (code !== '|') pending = [];
    }
  }
  if (idx < text.length) nodes.push({ text: text.slice(idx) });
  return nodes;
}

/** 把 text 对象/字符串归一为按行号排序的数组 */
function toLines(
  v: Record<string, string> | string | undefined
): string[] {
  if (v == null) return [];
  if (typeof v === 'string') return [v];
  return Object.keys(v)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => v[k] ?? '');
}

/**
 * 解码一个文本类块的正文（`data.text`）为 InlineNode[]。
 * 多行以换行拆分由上层块渲染处理，这里把各行节点顺序拼接（行间插入换行文本节点）。
 */
export function decodeText(textData: unknown): InlineNode[] {
  const data = (textData ?? {}) as TextData;
  const iat = data.initialAttributedTexts ?? {};
  const numToAttrib = data.apool?.numToAttrib ?? {};
  const texts = toLines(iat.text);
  const attribsArr = toLines(iat.attribs);

  const out: InlineNode[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (i > 0) out.push({ text: '\n' });
    out.push(...decodeLine(texts[i], attribsArr[i] ?? '', numToAttrib));
  }
  return mergeAdjacent(out);
}

/** 合并相邻同属性节点，减少碎片 */
function mergeAdjacent(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (
      last &&
      !last.link &&
      !n.link &&
      !last.equation &&
      !n.equation &&
      last.bold === n.bold &&
      last.italic === n.italic &&
      last.strike === n.strike &&
      last.inlineCode === n.inlineCode
    ) {
      last.text += n.text;
    } else {
      out.push({ ...n });
    }
  }
  return out;
}

/** 把 InlineNode[] 渲染为 Markdown 行内文本 */
export function renderInline(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      let t = n.text;
      if (t === '\n') return '  \n'; // 软换行
      if (n.equation) return `$${n.equation.trim()}$`;
      if (n.inlineCode) return '`' + t.replace(/`/g, '\\`') + '`';
      if (n.bold) t = `**${t}**`;
      if (n.italic) t = `*${t}*`;
      if (n.strike) t = `~~${t}~~`;
      if (n.link) t = `[${t}](${n.link})`;
      return t;
    })
    .join('');
}

/** 取 InlineNode[] 的纯文本（用于代码块/标题去样式场景）；公式取 LaTeX 源码 */
export function plainText(nodes: InlineNode[]): string {
  return nodes.map((n) => n.equation ?? n.text).join('');
}
