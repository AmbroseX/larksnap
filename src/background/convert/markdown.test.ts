import { describe, expect, it } from 'vitest';
import { blocksToMarkdown } from './markdown';

// isv 块形状取自私有化部署（xfchat）实抓的 client_vars「文本绘图」小组件，只留关键字段。
function docWithIsv(inner: Record<string, unknown> | undefined) {
  return {
    block_map: {
      root: { id: 'root', data: { type: 'page', children: ['w1'] } },
      w1: {
        id: 'w1',
        data: {
          type: 'isv',
          parent_id: 'root',
          block_type_id: 'blk_631fefbbae02400430b8f9f4',
          manifest: { app_version: '0.0.72', view_type: 'block_h5' },
          data: inner,
        },
      },
    },
    block_sequence: ['root', 'w1'],
  };
}

const SEQUENCE = 'sequenceDiagram\n    actor 用户\n    用户->>前端: 提交<br/>请求\n    alt 成功\n        前端-->>用户: 完成\n    end';

describe('blocksToMarkdown: 文本绘图小组件（isv）', () => {
  it('Mermaid 源码导出成 mermaid 代码块，原文不动', () => {
    const { markdown } = blocksToMarkdown(
      docWithIsv({ data: SEQUENCE, theme: 'default', view: 'chart' }),
      'root'
    );
    expect(markdown).toBe('```mermaid\n' + SEQUENCE + '\n```\n');
  });

  it('不是 Mermaid 的文本导出成不带语言的代码块', () => {
    const { markdown } = blocksToMarkdown(docWithIsv({ data: 'A -> B' }), 'root');
    expect(markdown).toBe('```\nA -> B\n```\n');
  });

  it('没有源码的小组件照旧占位', () => {
    const { markdown } = blocksToMarkdown(docWithIsv(undefined), 'root');
    expect(markdown).toBe('<!-- 暂不支持的块类型: isv -->\n');
  });
});
