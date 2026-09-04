import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, sessionRefSchema } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  DEFAULT_TREE,
  parsePaneLayout,
  serializePaneLayout,
  sessionPane,
  type LayoutTree,
} from './tree.js';

const SESSION = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-1' });

/** A tree this build writes, for round trips. */
const ARRANGED: LayoutTree = {
  kind: 'split',
  direction: 'row',
  ratio: 0.3,
  first: sessionPane(SESSION),
  second: {
    kind: 'split',
    direction: 'column',
    ratio: 0.5,
    first: { kind: 'pane', content: { type: 'empty' } },
    second: sessionPane(sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-2' })),
  },
};

describe('parsePaneLayout on answers with no layout in them', () => {
  it('reads the hub never having stored one as the default layout', () => {
    expect(parsePaneLayout(null)).toEqual(DEFAULT_TREE);
  });

  it('reads characters that are not JSON as the default layout', () => {
    expect(parsePaneLayout('definitely not a layout')).toEqual(DEFAULT_TREE);
  });

  it('reads JSON that is not the envelope as the default layout', () => {
    expect(parsePaneLayout('[1,2,3]')).toEqual(DEFAULT_TREE);
    expect(parsePaneLayout('{"weather":"fine"}')).toEqual(DEFAULT_TREE);
    expect(parsePaneLayout('{"v":"one","root":{}}')).toEqual(DEFAULT_TREE);
  });
});

describe('parsePaneLayout on layouts', () => {
  it('round-trips what this build writes', () => {
    expect(parsePaneLayout(serializePaneLayout(ARRANGED))).toEqual(ARRANGED);
  });

  it('reads what the hub actually answers for a stored layout', () => {
    // The captured frame, so this parser is held to what a real hub sends
    // rather than to what this file imagines.
    const parsed = parseTextFrame(parseHubFrame, hubFrames.paneLayout);
    if (!parsed.ok || parsed.value.type !== 'pane-layout') {
      throw new Error('the fixture is not a pane-layout frame');
    }
    expect(parsePaneLayout(parsed.value.layout)).toEqual({
      kind: 'pane',
      content: { type: 'empty' },
    });
  });

  it('clamps a ratio nobody could see a pane behind, and defaults one that is not a number', () => {
    const skewed = serializePaneLayout({ ...ARRANGED, ratio: 0.999 });
    const parsed = parsePaneLayout(skewed);
    expect(parsed.kind === 'split' && parsed.ratio).toBe(0.95);

    const wordy =
      '{"v":1,"root":{"kind":"split","direction":"row","ratio":"wide",' +
      '"first":{"kind":"pane","content":{"type":"empty"}},' +
      '"second":{"kind":"pane","content":{"type":"empty"}}}}';
    const defaulted = parsePaneLayout(wordy);
    expect(defaulted.kind === 'split' && defaulted.ratio).toBe(0.5);
  });
});

describe('parsePaneLayout degrading a node it cannot read', () => {
  it('costs an unknown pane type itself, not the tree', () => {
    const withStranger =
      '{"v":1,"root":{"kind":"split","direction":"row","ratio":0.5,' +
      '"first":{"kind":"pane","content":{"type":"session","session":' +
      '{"storeId":"store-work","sessionId":"session-1"}}},' +
      '"second":{"kind":"pane","content":{"type":"hologram","spin":0.5}}}}';
    const tree = parsePaneLayout(withStranger);
    expect(tree.kind).toBe('split');
    if (tree.kind !== 'split') return;
    // The readable half is read.
    expect(tree.first).toEqual(sessionPane(SESSION));
    // The strange half is a placeholder that kept what arrived.
    expect(tree.second.kind === 'pane' && tree.second.content.type).toBe('unknown');
  });

  it('writes an unknown node back out verbatim, so a save never launders it', () => {
    const strangerNode = '{"kind":"pane","content":{"type":"hologram","spin":0.5}}';
    const text =
      '{"v":1,"root":{"kind":"split","direction":"row","ratio":0.5,' +
      `"first":{"kind":"pane","content":{"type":"empty"}},"second":${strangerNode}}}`;
    const saved = serializePaneLayout(parsePaneLayout(text));
    expect(JSON.parse(saved)).toEqual(JSON.parse(text));
  });

  it('degrades a session pane whose ref does not parse, rather than showing a guess', () => {
    const halfRef =
      '{"v":1,"root":{"kind":"pane","content":{"type":"session","session":{"storeId":"s"}}}}';
    const tree = parsePaneLayout(halfRef);
    expect(tree.kind === 'pane' && tree.content.type).toBe('unknown');
  });

  it('degrades a split with a direction this build has no axis for', () => {
    const diagonal =
      '{"v":1,"root":{"kind":"split","direction":"diagonal","ratio":0.5,' +
      '"first":{"kind":"pane","content":{"type":"empty"}},' +
      '"second":{"kind":"pane","content":{"type":"empty"}}}}';
    const tree = parsePaneLayout(diagonal);
    expect(tree.kind === 'pane' && tree.content.type).toBe('unknown');
  });

  it('caps depth rather than following a hostile blob down', () => {
    const leaf = '{"kind":"pane","content":{"type":"empty"}}';
    let node = leaf;
    for (let level = 0; level < 40; level += 1) {
      node = `{"kind":"split","direction":"row","ratio":0.5,"first":${node},"second":${leaf}}`;
    }
    // Parsed without throwing is the assertion; the deep nodes cost themselves.
    expect(() => parsePaneLayout(`{"v":1,"root":${node}}`)).not.toThrow();
  });
});
