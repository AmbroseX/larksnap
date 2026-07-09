/**
 * 小红书卡片的中间表示（§四）：从 Block 树转来的极简节点模型。
 *
 * 不用 Markdown 的原因：分页要按"块"度量高度，且要保留行内样式。
 * 这些类型同时被 SW（组装）和 offscreen 页（渲染）引用，只有类型没有代码。
 */

export type XhsNodeType =
  | 'heading'
  | 'paragraph'
  | 'image'
  | 'quote'
  | 'code'
  | 'bullet'
  | 'ordered'
  | 'divider'
  | 'table'
  | 'placeholder';

export interface XhsNode {
  type: XhsNodeType;
  /** heading 层级 1-3（更深的标题压到 3） */
  level?: number;
  /** 行内内容渲染成的 HTML 片段（inlineToHtml 产物）；placeholder 为提示文案 */
  html?: string;
  /** image 节点：指向图片映射的 key（box… token） */
  imageToken?: string;
  /** 列表嵌套深度（0 起） */
  depth?: number;
  /** ordered 列表项在同层的序号（1 起） */
  ordinal?: number;
  /** code 块语言标注 */
  language?: string;
  /** table 节点：单元格 HTML 二维数组（首行视作表头） */
  rows?: string[][];
}

/** SW → offscreen 的渲染请求 */
export interface XhsRenderRequest {
  /** 文档标题（第一张卡顶部展示） */
  title: string;
  nodes: XhsNode[];
  /** token → dataURL；下载失败为 null（渲染为占位灰块，绝不能塞在线 URL，见 §十-2） */
  imageMap: Record<string, string | null>;
  /** 主题 id，缺省用默认主题 */
  themeId?: string;
}

/** offscreen → SW 的渲染结果 */
export interface XhsRenderResult {
  /** 每张卡片的 PNG dataURL，按卡片顺序 */
  pngs: string[];
}

/** offscreen → SW 的渲染进度（fire-and-forget） */
export interface XhsRenderProgress {
  done: number;
  total: number;
}

/** SW → 侧边栏的导出结果：只出图不落盘，预览确认后由侧边栏打包下载 */
export interface XhsExportResult {
  title: string;
  /** 每张卡片的 PNG dataURL */
  pngs: string[];
}
