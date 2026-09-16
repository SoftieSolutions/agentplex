import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { parseInline, parseMarkdown } from './markdown.js';

/**
 * The preview parser, including the document a real hub sent back from a real
 * machine's disk: the fixture's content is the markdown somebody would write
 * at an agent, and the preview has to hold it.
 */

function contentFrom(text: string): string {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'doc-content') {
    throw new Error('the fixture is not a doc-content frame');
  }
  return parsed.value.content;
}

describe('blocks', () => {
  it('reads the document the hub answered with', () => {
    expect(parseMarkdown(contentFrom(hubFrames.docContent))).toEqual([
      { kind: 'heading', level: 1, spans: [{ kind: 'text', text: 'Plan' }] },
      {
        kind: 'list',
        ordered: false,
        items: [
          [{ kind: 'text', text: 'read the failing test' }],
          [{ kind: 'text', text: 'fix the refresh loop' }],
          [{ kind: 'text', text: 'write it up' }],
        ],
      },
    ]);
  });

  it('keeps a fenced block verbatim, markup and all', () => {
    const blocks = parseMarkdown('```\n**not bold** <b>not a tag</b>\n```');
    expect(blocks).toEqual([{ kind: 'code', text: '**not bold** <b>not a tag</b>' }]);
  });

  it('ends an unclosed fence at the end of the document', () => {
    expect(parseMarkdown('```\nstill shown')).toEqual([{ kind: 'code', text: 'still shown' }]);
  });

  it('reads quotes, rules and numbered lists', () => {
    expect(parseMarkdown('> quoted\n\n---\n\n1. first\n2. second')).toEqual([
      { kind: 'quote', spans: [{ kind: 'text', text: 'quoted' }] },
      { kind: 'rule' },
      {
        kind: 'list',
        ordered: true,
        items: [[{ kind: 'text', text: 'first' }], [{ kind: 'text', text: 'second' }]],
      },
    ]);
  });

  it('joins the lines of one paragraph and separates two', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'one two' }] },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'three' }] },
    ]);
  });

  it('caps a heading at six hashes and keeps a seventh as text', () => {
    expect(parseMarkdown('####### deep')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: '####### deep' }] },
    ]);
  });
});

describe('spans', () => {
  it('reads code, bold and italic', () => {
    expect(parseInline('a `b` **c** *d* _e_')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'code', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', text: 'c' },
      { kind: 'text', text: ' ' },
      { kind: 'em', text: 'd' },
      { kind: 'text', text: ' ' },
      { kind: 'em', text: 'e' },
    ]);
  });

  it('keeps an unmatched marker as the character it is', () => {
    expect(parseInline('2 * 3 and a `backtick')).toEqual([
      { kind: 'text', text: '2 * 3 and a `backtick' },
    ]);
  });

  it('reads nothing as markup inside a code span', () => {
    expect(parseInline('`**not bold**`')).toEqual([{ kind: 'code', text: '**not bold**' }]);
  });

  it('leaves a tag and a link as their own characters', () => {
    // Nothing here becomes HTML and nothing becomes an href: the renderer puts
    // every one of these characters on screen as a text node.
    expect(parseInline('<script>alert(1)</script>')).toEqual([
      { kind: 'text', text: '<script>alert(1)</script>' },
    ]);
    expect(parseInline('[click](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[click](javascript:alert(1))' },
    ]);
  });
});
