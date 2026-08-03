import { describe, expect, it } from 'vitest';
import { decodeText, renderInline } from './apool';

// 数据取自私有化部署（xfchat）实抓的 client_vars，形状原样保留。

/** 行内提及文档：正文只有一个占位空格，标题和 URL 都在 inline-component 里 */
const MENTION_DOC = {
  apool: {
    numToAttrib: {
      '0': ['link-id', '5c25c71f-d68e-422e-b939-cbd769af8cd0'],
      '1': ['author', '7459258065024451446'],
      '2': [
        'inline-component',
        JSON.stringify({
          id: '6ce714a1-25bb-4612-811e-dded2823fc43',
          type: 'mention_doc',
          data: {
            file_type: 22,
            token: 'doxrziFZ4pcekKeOKKnaHZ10czf',
            raw_url: 'https://yf2ljykclb.xfchat.iflytek.com/docx/doxrziFZ4pcekKeOKKnaHZ10czf',
            title: '测试larksnap文档',
          },
        }),
      ],
    },
  },
  initialAttributedTexts: {
    attribs: { '0': '*1*2*0+1' },
    text: { '0': ' ' },
  },
};

describe('行内组件（提及文档）', () => {
  it('取 inline-component 的 title + raw_url，渲染成普通链接', () => {
    expect(renderInline(decodeText(MENTION_DOC))).toBe(
      '[测试larksnap文档](https://yf2ljykclb.xfchat.iflytek.com/docx/doxrziFZ4pcekKeOKKnaHZ10czf)'
    );
  });

  it('link-id 是内部编号不是 URL，不能当链接（它排在 inline-component 之后，会覆盖真 URL）', () => {
    const nodes = decodeText(MENTION_DOC);
    expect(nodes[0].link).not.toContain('5c25c71f');
  });

  it('没有 raw_url 的提及（如 @人）只留标题文本', () => {
    const mentionUser = {
      apool: {
        numToAttrib: {
          '0': [
            'inline-component',
            JSON.stringify({ type: 'mention_user', data: { name: '张三' } }),
          ],
        },
      },
      initialAttributedTexts: { attribs: { '0': '*0+1' }, text: { '0': ' ' } },
    };
    expect(renderInline(decodeText(mentionUser))).toBe('张三');
  });

  it('组件 JSON 认不出时保持原样，不丢内容', () => {
    const broken = {
      apool: { numToAttrib: { '0': ['inline-component', '{不是JSON'] } },
      initialAttributedTexts: { attribs: { '0': '*0+2' }, text: { '0': 'ab' } },
    };
    expect(renderInline(decodeText(broken))).toBe('ab');
  });
});

describe('普通超链接不受影响', () => {
  it('link 属性是真 URL 时照常渲染', () => {
    const linked = {
      apool: { numToAttrib: { '0': ['link', 'https://example.com/a?b=1'] } },
      initialAttributedTexts: { attribs: { '0': '*0+4' }, text: { '0': '飞书官网' } },
    };
    expect(renderInline(decodeText(linked))).toBe('[飞书官网](https://example.com/a?b=1)');
  });

  it('link 值不像 URL（枚举号/uuid）时忽略，只留文本', () => {
    const bogus = {
      apool: { numToAttrib: { '0': ['link', 'abc-123'] } },
      initialAttributedTexts: { attribs: { '0': '*0+2' }, text: { '0': '文字' } },
    };
    expect(renderInline(decodeText(bogus))).toBe('文字');
  });
});
