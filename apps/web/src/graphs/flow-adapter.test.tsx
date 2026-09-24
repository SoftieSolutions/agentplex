// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  graphNodeIdSchema,
  parseHubFrame,
  parseTextFrame,
  serverRegistrationIdSchema,
  type GraphDocument,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { setNodeField } from './graph-model.js';
import { fromFlowChange, GraphCanvas, toFlow, type FlowNodeChange } from './flow-adapter.js';
import { installFlowMocks } from './flow-test-setup.js';

/**
 * The one file that speaks React Flow, tested at its two seams: the document
 * in, as nodes and edges the library draws; the library's changes out, as
 * edits to the document. The document is the one a real hub answered an open
 * with, so the layout under test is the layout the mock draws.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function fixtureDocument(): GraphDocument {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.graphDocument);
  if (!parsed.ok || parsed.value.type !== 'graph-document') {
    throw new Error('the captured frame is not a graph document');
  }
  return parsed.value.document;
}

const id = (text: string) => graphNodeIdSchema.parse(text);
const LABELS = new Map([
  [serverRegistrationIdSchema.parse('registration-mbp-robert'), 'mbp-robert'],
]);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('toFlow', () => {
  it('yields one node per document node, carrying its kind, label and position', () => {
    const { nodes } = toFlow(fixtureDocument(), null, LABELS);

    expect(nodes.map((node) => node.id)).toEqual(['start', 'classify', 'review']);
    expect(nodes.map((node) => node.data.kind)).toEqual(['trigger', 'router', 'agent']);
    expect(nodes.map((node) => node.data.label)).toEqual([
      'PR opened',
      'Classify diff',
      'Rust reviewer',
    ]);
    expect(nodes[1]?.position).toEqual({ x: 250, y: 84 });
    expect(nodes.every((node) => node.type === 'card')).toBe(true);
  });

  it('writes the third line of every card from the document and the fleet', () => {
    const { nodes } = toFlow(fixtureDocument(), null, LABELS);
    expect(nodes.map((node) => node.data.subtitle)).toEqual([
      'manual',
      'haiku · 1 route',
      'claude · mbp-robert',
    ]);
  });

  it('marks the selected node and no other', () => {
    const { nodes } = toFlow(fixtureDocument(), id('classify'), LABELS);
    expect(nodes.map((node) => node.selected)).toEqual([false, true, false]);
  });

  it('yields one edge per document edge plus one per router route, labelled by its condition', () => {
    const { edges } = toFlow(fixtureDocument(), null, LABELS);

    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([
      ['start', 'classify'],
      ['classify', 'review'],
      ['classify', 'review'],
    ]);
    expect(edges.map((edge) => edge.label ?? null)).toEqual([null, null, 'language == rust']);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(3);
  });

  it('draws a router’s otherwise as an edge that says so', () => {
    const edit = setNodeField(fixtureDocument(), id('classify'), 'otherwise', 'start');
    if (!edit.ok) throw new Error(edit.problem);

    const { edges } = toFlow(edit.document, null, LABELS);

    expect(edges.at(-1)).toMatchObject({ source: 'classify', target: 'start', label: 'otherwise' });
  });
});

describe('fromFlowChange', () => {
  it('maps a finished position change back to the document', () => {
    const change: FlowNodeChange = {
      type: 'position',
      id: 'start',
      position: { x: 40, y: 92 },
      dragging: false,
    };

    const edit = fromFlowChange(change, fixtureDocument());

    expect(edit?.ok).toBe(true);
    expect(edit?.ok ? edit.document.nodes[0]?.position : null).toEqual({ x: 40, y: 92 });
  });

  it('drops a position change still mid-drag, and one with no position', () => {
    const document = fixtureDocument();
    expect(
      fromFlowChange(
        { type: 'position', id: 'start', position: { x: 1, y: 1 }, dragging: true },
        document,
      ),
    ).toBeNull();
    expect(fromFlowChange({ type: 'position', id: 'start' }, document)).toBeNull();
  });

  it('drops every other kind of change: the document is not where selection or size live', () => {
    const document = fixtureDocument();
    expect(fromFlowChange({ type: 'select', id: 'start', selected: true }, document)).toBeNull();
    expect(
      fromFlowChange(
        { type: 'dimensions', id: 'start', dimensions: { width: 10, height: 10 } },
        document,
      ),
    ).toBeNull();
    expect(fromFlowChange({ type: 'remove', id: 'start' }, document)).toBeNull();
  });

  it('refuses a position change for a node the document does not have', () => {
    const edit = fromFlowChange(
      { type: 'position', id: 'nowhere', position: { x: 1, y: 1 }, dragging: false },
      fixtureDocument(),
    );
    expect(edit?.ok).toBe(false);
  });
});

describe('GraphCanvas', () => {
  let container: HTMLElement;
  let root: Root | null = null;

  beforeAll(() => {
    installFlowMocks();
  });

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  async function mount(
    handlers: Partial<{
      onSelect: (id: unknown) => void;
      onMove: (id: unknown, position: unknown) => void;
      onConnect: (from: unknown, to: unknown) => void;
    }> = {},
  ): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <GraphCanvas
          document={fixtureDocument()}
          selection={null}
          labels={LABELS}
          scheme="dark"
          interactive={false}
          onSelect={handlers.onSelect ?? (() => {})}
          onMove={handlers.onMove ?? (() => {})}
          onConnect={handlers.onConnect ?? (() => {})}
        />,
      );
    });
    await act(settle);
    await act(settle);
  }

  it('draws one card per node with its kind on it', async () => {
    await mount();

    const cards = [...container.querySelectorAll<HTMLElement>('[data-node-card]')];
    expect(cards.map((card) => card.dataset['nodeCard'])).toEqual(['start', 'classify', 'review']);
    expect(cards.map((card) => card.dataset['kind'])).toEqual(['trigger', 'router', 'agent']);
    expect(container.textContent).toContain('ROUTER');
    expect(container.textContent).toContain('Classify diff');
  });

  it('draws the zoom controls: out, the percentage, in, and fit', async () => {
    await mount();

    const bar = container.querySelector('[data-zoom-bar]');
    expect(bar).not.toBeNull();
    expect(bar?.querySelector('[data-zoom="out"]')?.textContent).toBe('−');
    expect(bar?.querySelector('[data-zoom="in"]')?.textContent).toBe('+');
    expect(bar?.querySelector('[data-zoom="fit"]')?.textContent).toBe('fit');
    expect(bar?.querySelector('[data-zoom-label]')?.textContent).toMatch(/^\d+%$/);
  });

  it('reports a click on a card as the selection', async () => {
    const onSelect = vi.fn();
    await mount({ onSelect });

    const card = container.querySelector<HTMLElement>('[data-node-card="classify"]');
    if (card === null) throw new Error('no router card was drawn');
    await act(() => {
      card.click();
    });
    await act(settle);

    expect(onSelect).toHaveBeenLastCalledWith('classify');
  });
});
