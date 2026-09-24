// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  graphNodeIdSchema,
  nodeIdSchema,
  parseHubFrame,
  parseTextFrame,
  serverRegistrationIdSchema,
  storeIdSchema,
  type GraphDocument,
  type GraphNode,
  type GraphNodeKind,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { addNode, setNodeField, type GraphEdit } from './graph-model.js';
import { NodeInspector, type InspectorMachine } from './node-inspector.js';

/**
 * The inspector: the selected node's fields, one control each, every change
 * an edit of the document through the model. The document is the one a real
 * hub answered with, so the ROUTER and the AGENT under test are the ones the
 * mock draws.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Mantine consults the media query for its colour scheme; jsdom has none. */
function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/** Mantine's popover-backed controls observe their target's box; jsdom has no observer. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** The autosizing prompt waits on the font set; jsdom ships none. */
function installFontFaceSet(): void {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
}

function fixtureDocument(): GraphDocument {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.graphDocument);
  if (!parsed.ok || parsed.value.type !== 'graph-document') {
    throw new Error('the captured frame is not a graph document');
  }
  return parsed.value.document;
}

function nodeNamed(document: GraphDocument, id: string): GraphNode {
  const node = document.nodes.find((each) => each.id === id);
  if (node === undefined) throw new Error(`the fixture has no node ${id}`);
  return node;
}

const MACHINES: readonly InspectorMachine[] = [
  {
    registrationId: serverRegistrationIdSchema.parse('registration-mbp-robert'),
    label: 'mbp-robert',
    words: 'connected',
  },
  {
    registrationId: serverRegistrationIdSchema.parse('registration-gpu-box-01'),
    label: 'gpu-box-01',
    words: 'stale · unreachable',
  },
];
const STORES = [storeIdSchema.parse('store-agentplex'), storeIdSchema.parse('store-shared')];

describe('NodeInspector', () => {
  let container: HTMLElement;
  let root: Root | null = null;
  let edits: ((document: GraphDocument) => GraphEdit)[];

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    installFontFaceSet();
    container = document.createElement('div');
    document.body.append(container);
    edits = [];
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function withProvider(element: JSX.Element): JSX.Element {
    return (
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
        {element}
      </MantineProvider>
    );
  }

  async function mount(node: GraphNode | null, document = fixtureDocument()): Promise<void> {
    root = createRoot(container);
    await show(node, document);
  }

  /** Renders into the root that is already there: the same inspector, another node. */
  async function show(node: GraphNode | null, document = fixtureDocument()): Promise<void> {
    await act(async () => {
      root?.render(
        withProvider(
          <NodeInspector
            node={node}
            document={document}
            machines={MACHINES}
            stores={STORES}
            scheme="dark"
            onEdit={(edit) => edits.push(edit)}
          />,
        ),
      );
    });
  }

  /** Runs the last edit the inspector asked for against the document and returns what it made. */
  function applied(document = fixtureDocument()): GraphDocument {
    const edit = edits.at(-1);
    if (edit === undefined) throw new Error('the inspector asked for no edit');
    const result = edit(document);
    if (!result.ok) throw new Error(`the edit was refused: ${result.problem}`);
    return result.document;
  }

  function input(label: string): HTMLInputElement | HTMLTextAreaElement {
    const found = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[aria-label="${label}"]`,
    );
    if (found === null) throw new Error(`no control is labelled ${label}`);
    return found;
  }

  function radio(value: string): HTMLInputElement {
    const found = container.querySelector<HTMLInputElement>(
      `input[type="radio"][value="${value}"]`,
    );
    if (found === null) throw new Error(`no segment is worth ${value}`);
    return found;
  }

  function buttons(): string[] {
    return [...container.querySelectorAll('button')].map((button) => button.textContent ?? '');
  }

  it('asks for a selection when there is none', async () => {
    await mount(null);
    expect(container.textContent).toContain('Select a node');
    expect(container.querySelectorAll('input')).toHaveLength(0);
  });

  it('names the selected kind and shows the label as the first field', async () => {
    await mount(nodeNamed(fixtureDocument(), 'classify'));
    expect(container.textContent).toContain('ROUTER · SELECTED');
    expect(input('Label').value).toBe('Classify diff');
  });

  it('draws a ROUTER as its model, its routes in order with an add affordance, placement and retry', async () => {
    await mount(nodeNamed(fixtureDocument(), 'classify'));

    expect(input('Model').value).toBe('haiku');
    const routes = [...container.querySelectorAll<HTMLElement>('[data-route]')];
    expect(routes.map((row) => row.dataset['route'])).toEqual(['0']);
    expect(input('Route 1 condition').value).toBe('language == rust');
    expect(input('Route 1 target').value).toBe('Rust reviewer');
    expect(buttons()).toContain('+ add route');
    expect(radio('cheapest').checked).toBe(true);
    expect(radio('pin').checked).toBe(false);
    expect(input('Retry max').value).toBe('0');
    expect(input('Retry backoff').value).toBe('1');
  });

  it('draws an AGENT as its prompt, provider, store, placement and retry', async () => {
    await mount(nodeNamed(fixtureDocument(), 'review'));

    expect(container.textContent).toContain('AGENT · SELECTED');
    expect(input('Prompt').value).toBe('Review the Rust in this change.');
    expect(input('Provider').value).toBe('claude');
    expect(input('Store').value).toBe('store-agentplex');
    expect(radio('pin').checked).toBe(true);
    expect(input('Machine').value).toBe('mbp-robert');
    expect(input('Retry max').value).toBe('2');
    expect(input('Retry backoff').value).toBe('30');
  });

  it('draws a TRIGGER with its source and no fields that are not its own', async () => {
    await mount(nodeNamed(fixtureDocument(), 'start'));
    expect(container.textContent).toContain('TRIGGER · SELECTED');
    expect(container.textContent).toContain('manual');
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    expect(container.querySelector('[aria-label="Prompt"]')).toBeNull();
  });

  it('keeps a LAST OUTPUT slot that is empty until a run has happened', async () => {
    await mount(nodeNamed(fixtureDocument(), 'classify'));
    expect(container.textContent).toContain('LAST OUTPUT');
    const slot = container.querySelector('[data-last-output]');
    expect(slot).not.toBeNull();
    expect(slot?.textContent).toBe('');
  });

  it('adds a route through the model when the add affordance is pressed', async () => {
    await mount(nodeNamed(fixtureDocument(), 'classify'));

    const add = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '+ add route',
    );
    if (add === undefined) throw new Error('no add route button');
    await act(() => {
      add.click();
    });

    const router = nodeNamed(applied(), 'classify');
    expect(router.kind === 'router' ? router.routes : null).toHaveLength(2);
  });

  it('pins the first machine when Pin machine is chosen, and lets go of it on Cheapest', async () => {
    await mount(nodeNamed(fixtureDocument(), 'classify'));

    await act(() => {
      radio('pin').click();
    });
    expect(nodeNamed(applied(), 'classify').placement).toEqual({
      kind: 'pin',
      server: 'registration-mbp-robert',
    });

    await mount(nodeNamed(fixtureDocument(), 'review'));
    await act(() => {
      radio('cheapest').click();
    });
    expect(nodeNamed(applied(), 'review').placement).toEqual({ kind: 'cheapest' });
  });

  it('commits a typed label as an edit', async () => {
    await mount(nodeNamed(fixtureDocument(), 'classify'));

    const label = input('Label');
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(label, 'Sort the diff');
      label.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(nodeNamed(applied(), 'classify').label).toBe('Sort the diff');
  });

  it('offers to remove the node', async () => {
    await mount(nodeNamed(fixtureDocument(), 'review'));

    const remove = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Remove node',
    );
    if (remove === undefined) throw new Error('no remove button');
    await act(() => {
      remove.click();
    });

    expect(applied().nodes.map((node) => node.id)).toEqual(['start', 'classify']);
  });

  /** Two nodes of one kind, differing in the field under test, in one document. */
  function twoOfAKind(
    kind: GraphNodeKind,
    field: string,
    first: unknown,
    second: unknown,
  ): { document: GraphDocument; a: GraphNode; b: GraphNode } {
    const seed = { storeId: STORES[0] ?? null, graph: nodeIdSchema.parse('hub-11') };
    let document = fixtureDocument();
    const ids: string[] = [];
    for (const value of [first, second]) {
      const added = addNode(document, kind, { x: 0, y: 0 }, seed);
      if (!added.ok) throw new Error(added.problem);
      const id = added.document.nodes.at(-1)?.id;
      if (id === undefined) throw new Error('nothing was added');
      const set = setNodeField(added.document, id, field, value);
      if (!set.ok) throw new Error(set.problem);
      document = set.document;
      ids.push(id);
    }
    const [a, b] = ids.map((id) => nodeNamed(document, id));
    if (a === undefined || b === undefined) throw new Error('two nodes were not made');
    return { document, a, b };
  }

  function type(control: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(control, text);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it.each([
    ['action', 'Action', 'name', 'lint', 'deploy', 'deploy'],
    ['human', 'Approvers', 'approvers', ['ana'], ['ben', 'cy'], 'ben, cy'],
    ['subgraph', 'Graph', 'graph', 'hub-11', 'hub-12', 'hub-12'],
  ] as const)(
    'shows the newly selected %s node’s %s, not the half-typed text of the one before',
    async (kind, label, field, first, second, shown) => {
      const { document, a, b } = twoOfAKind(kind, field, first, second);
      await mount(a, document);
      await act(() => {
        type(input(label), 'half-typed');
      });
      expect(input(label).value).toBe('half-typed');
      const before = edits.length;

      await show(b, document);

      expect(input(label).value).toBe(shown);
      // Leaving the field commits nothing: the text that was typed belonged to
      // the other node, and B's value is what the field holds.
      await act(() => {
        input(label).dispatchEvent(new FocusEvent('blur'));
      });
      expect(edits).toHaveLength(before);
    },
  );

  it('reorders a route with its up and down controls', async () => {
    const withTwo = (() => {
      const document = fixtureDocument();
      const router = nodeNamed(document, 'classify');
      if (router.kind !== 'router') throw new Error('not a router');
      return {
        ...document,
        nodes: document.nodes.map((node) =>
          node.id === 'classify' && node.kind === 'router'
            ? {
                ...node,
                routes: [
                  ...node.routes,
                  { condition: 'only *.md', to: graphNodeIdSchema.parse('start') },
                ],
              }
            : node,
        ),
      };
    })();
    await mount(nodeNamed(withTwo, 'classify'), withTwo);

    const up = container.querySelector<HTMLButtonElement>(
      '[data-route="1"] [aria-label="Move route 2 up"]',
    );
    if (up === null) throw new Error('no up control on the second route');
    await act(() => {
      up.click();
    });

    const router = nodeNamed(applied(withTwo), 'classify');
    expect(router.kind === 'router' ? router.routes.map((route) => route.condition) : null).toEqual(
      ['only *.md', 'language == rust'],
    );
  });
});
