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
import { colorForRole } from '../ui/tokens.js';
import { setNodeField } from './graph-model.js';
import {
  deriveNodes,
  fromFlowChange,
  GraphCanvas,
  toFlow,
  type FlowNodeChange,
} from './flow-adapter.js';
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

/** The document a real hub answered the open of a graph that fans out and joins with. */
function branchesDocument(): GraphDocument {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.graphDocumentBranches);
  if (!parsed.ok || parsed.value.type !== 'graph-document') {
    throw new Error('the captured frame is not a graph document');
  }
  return parsed.value.document;
}

/** A colour as the browser serialises it, so a hex from the tokens compares with a style read back. */
function serialised(color: string): string {
  const probe = document.createElement('div');
  probe.style.color = color;
  return probe.style.color;
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

  it('marks every node whose run step is in flight, and none when no step is', () => {
    const { nodes } = toFlow(fixtureDocument(), null, LABELS, 'dark', new Set([id('review')]));
    expect(nodes.map((node) => node.data.running)).toEqual([false, false, true]);

    const idle = toFlow(fixtureDocument(), null, LABELS, 'dark', new Set());
    expect(idle.nodes.map((node) => node.data.running)).toEqual([false, false, false]);
  });

  it('marks two cards running at once when a run has fanned out', () => {
    const { nodes } = toFlow(
      branchesDocument(),
      null,
      LABELS,
      'dark',
      new Set([id('rust'), id('ts')]),
    );
    expect(nodes.filter((node) => node.data.running).map((node) => node.id)).toEqual([
      'rust',
      'ts',
    ]);
  });

  it('carries a JOIN as a card of its kind, with an edge in from each branch', () => {
    const { nodes, edges } = toFlow(branchesDocument(), null, LABELS);
    expect(nodes.map((node) => [node.id, node.data.kind])).toEqual([
      ['start', 'trigger'],
      ['rust', 'agent'],
      ['ts', 'agent'],
      ['both', 'join'],
    ]);
    expect(edges.filter((edge) => edge.target === 'both').map((edge) => edge.source)).toEqual([
      'rust',
      'ts',
    ]);
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

  it('colours every arrowhead from the tokens, so no library grey escapes', () => {
    const { edges } = toFlow(fixtureDocument(), null, LABELS, 'light');
    expect(edges.map((edge) => edge.markerEnd)).toEqual(
      edges.map(() => expect.objectContaining({ color: colorForRole('textFaint', 'light') })),
    );
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

describe('deriveNodes', () => {
  it('keeps what the library measured of a node it already had', () => {
    const document = fixtureDocument();
    const previous = toFlow(document, null, LABELS).nodes.map((node) =>
      node.id === 'start' ? { ...node, measured: { width: 170, height: 64 } } : node,
    );

    const nodes = deriveNodes(document, id('start'), LABELS, 'dark', new Set(), previous);

    expect(nodes[0]?.measured).toEqual({ width: 170, height: 64 });
    expect(nodes[0]?.selected).toBe(true);
    expect(nodes[1]?.measured).toBeUndefined();
  });

  it('leaves a node mid-drag where the pointer has it rather than where the document does', () => {
    const document = fixtureDocument();
    const previous = toFlow(document, null, LABELS).nodes.map((node) =>
      node.id === 'classify' ? { ...node, dragging: true, position: { x: 999, y: 333 } } : node,
    );

    const nodes = deriveNodes(document, null, LABELS, 'dark', new Set(), previous);

    // The document says 250, 84; the drop is what will tell it otherwise, and
    // until then a frame from the hub must not snap the card back.
    expect(nodes[1]?.position).toEqual({ x: 999, y: 333 });
    expect(nodes[1]?.dragging).toBe(true);
    expect(nodes[0]?.position).toEqual({ x: 0, y: 0 });
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
      onEdit: (edit: unknown) => void;
      onConnect: (from: unknown, to: unknown) => void;
    }> = {},
    selection: ReturnType<typeof id> | null = null,
    drawn: GraphDocument = fixtureDocument(),
    running: ReadonlySet<ReturnType<typeof id>> = new Set(),
  ): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <GraphCanvas
          document={drawn}
          selection={selection}
          labels={LABELS}
          scheme="dark"
          interactive={false}
          running={running}
          onSelect={handlers.onSelect ?? (() => {})}
          onEdit={handlers.onEdit ?? (() => {})}
          onConnect={handlers.onConnect ?? (() => {})}
        />,
      );
    });
    await act(settle);
    await act(settle);
  }

  it('sets the connection line and the default arrowhead from the tokens', async () => {
    await mount();

    const canvas = container.querySelector<HTMLElement>('[data-graph-canvas]');
    expect(canvas?.style.getPropertyValue('--xy-connectionline-stroke')).toBe(
      colorForRole('accent', 'dark'),
    );
  });

  it('does not remove a selected card on Backspace: removal is the inspector’s, by name', async () => {
    await mount({}, id('classify'));
    expect(container.querySelectorAll('[data-node-card]')).toHaveLength(3);

    await act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    await act(settle);

    expect(container.querySelectorAll('[data-node-card]')).toHaveLength(3);
  });

  it('draws one card per node with its kind on it', async () => {
    await mount();

    const cards = [...container.querySelectorAll<HTMLElement>('[data-node-card]')];
    expect(cards.map((card) => card.dataset['nodeCard'])).toEqual(['start', 'classify', 'review']);
    expect(cards.map((card) => card.dataset['kind'])).toEqual(['trigger', 'router', 'agent']);
    expect(container.textContent).toContain('ROUTER');
    expect(container.textContent).toContain('Classify diff');
  });

  it('draws a JOIN as the mock’s 44px circle with the join glyph, a handle each side', async () => {
    await mount({}, null, branchesDocument());

    const join = container.querySelector<HTMLElement>('[data-node-card="both"]');
    if (join === null) throw new Error('no join card was drawn');
    expect(join.dataset['kind']).toBe('join');
    expect(join.style.width).toBe('44px');
    expect(join.style.height).toBe('44px');
    expect(join.style.borderRadius).toBe('50%');
    expect(join.style.background).toBe(serialised(colorForRole('surface', 'dark')));
    expect(join.style.border).toBe(`1px solid ${serialised(colorForRole('borderStrong', 'dark'))}`);
    const glyph = join.querySelector<HTMLElement>('[data-join-glyph]');
    expect(glyph?.textContent).toBe('⋈');
    expect(glyph?.style.fontSize).toBe('15px');
    expect(glyph?.style.color).toBe(serialised(colorForRole('textSecondary', 'dark')));
    // Nothing of the rectangular card: no kind line, no label, no third line.
    expect(join.textContent).toBe('⋈');
    expect(join.getAttribute('aria-label')).toBe('JOIN Both reviews');
    expect(join.querySelector('.react-flow__handle-left')).not.toBeNull();
    expect(join.querySelector('.react-flow__handle-right')).not.toBeNull();
  });

  it('draws both branch cards running at once, and the join at rest until it is reached', async () => {
    await mount({}, null, branchesDocument(), new Set([id('rust'), id('ts')]));

    const running = [...container.querySelectorAll<HTMLElement>('[data-running="true"]')];
    expect(running.map((card) => card.dataset['nodeCard'])).toEqual(['rust', 'ts']);
    for (const card of running) expect(card.textContent).toContain('running');
    expect(
      container.querySelector<HTMLElement>('[data-node-card="both"]')?.dataset['running'],
    ).toBeUndefined();
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
