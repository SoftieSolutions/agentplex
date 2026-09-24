// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  nodeIdSchema,
  parseClientFrame,
  parseTextFrame,
  type ClientFrame,
  type LayoutNode,
} from '@agentplex/protocol';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { FOLDER_KIND, GRAPH_KIND, PROJECT_KIND } from '../tree/node-kinds.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { installFlowMocks } from './flow-test-setup.js';
import { GraphScreen, graphHeading, otherGraph } from './graph-screen.js';

/**
 * The graph screen whole: the header mockup 6d draws, the canvas, the
 * inspector, and the round trip from an edit through Save to the frame the
 * hub receives. Driven over the real hub store and a fake socket with the
 * fixture a real hub answered, so what the header says and what Save sends
 * are read off frames a hub actually produces.
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

/** The autosizing prompt waits on the font set; jsdom ships none. */
function installFontFaceSet(): void {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
}

const GRAPH = nodeIdSchema.parse('hub-10');
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const frame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

function sent(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the screen sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

function node(partial: Partial<LayoutNode> & Pick<LayoutNode, 'id' | 'kind'>): LayoutNode {
  return {
    parentId: null,
    position: 0,
    name: null,
    named: false,
    anchor: null,
    ...partial,
  };
}

describe('graphHeading', () => {
  const project = node({
    id: nodeIdSchema.parse('hub-5'),
    kind: PROJECT_KIND,
    name: 'orchard',
    named: true,
  });
  const graph = node({
    id: GRAPH,
    kind: GRAPH_KIND,
    parentId: project.id,
    name: 'release-pipeline',
    named: true,
  });

  it('names the project the graph sits under, and the graph', () => {
    expect(graphHeading([project, graph], GRAPH, 'release-pipeline')).toEqual({
      project: 'orchard',
      name: 'release-pipeline',
    });
  });

  it('claims no project while the tree does not list the graph', () => {
    expect(graphHeading([project], GRAPH, 'release-pipeline')).toEqual({
      project: null,
      name: 'release-pipeline',
    });
    expect(graphHeading(null, GRAPH, null)).toEqual({ project: null, name: null });
  });

  it('walks up through a folder to the project', () => {
    const folder = node({
      id: nodeIdSchema.parse('hub-7'),
      kind: FOLDER_KIND,
      parentId: project.id,
    });
    const nested = { ...graph, parentId: folder.id };
    expect(graphHeading([project, folder, nested], GRAPH, 'x').project).toBe('orchard');
  });

  it('offers another graph in the tree for a SUB-GRAPH to pin, and none when this is the only one', () => {
    const second = node({ id: nodeIdSchema.parse('hub-11'), kind: GRAPH_KIND, name: 'tests' });
    expect(otherGraph([project, graph, second], GRAPH)).toBe('hub-11');
    expect(otherGraph([project, graph], GRAPH)).toBeNull();
    expect(otherGraph(null, GRAPH)).toBeNull();
  });
});

describe('GraphScreen', () => {
  let container: HTMLElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

  beforeAll(() => {
    installFlowMocks();
  });

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installFontFaceSet();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
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

  async function mount(): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      root.render(withProvider(<GraphScreen nodeId={GRAPH} store={store} />));
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the screen dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStatePopulated);
    });
    return socket;
  }

  /** Opened, and told the graph has never run, which is what frees Run. */
  async function opened(): Promise<FakeSocket> {
    const socket = await mount();
    await act(() => {
      socket.deliver(hubFrames.graphDocument);
    });
    await act(settle);
    const read = sent(socket).find((each) => each.type === 'graph-run-read');
    if (read === undefined || read.type !== 'graph-run-read') throw new Error('no read was sent');
    const none = JSON.parse(hubFrames.graphRunLatestNone) as object;
    await act(() => {
      socket.deliver(JSON.stringify({ ...none, replyTo: read.id, nodeId: 'hub-10' }));
    });
    await act(settle);
    return socket;
  }

  function button(words: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find(
      (each) => each.textContent === words,
    );
    if (found === undefined) throw new Error(`no button says ${words}`);
    return found;
  }

  function card(id: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`[data-node-card="${id}"]`);
    if (found === null) throw new Error(`no card for ${id}`);
    return found;
  }

  it('asks for the graph and says it is opening until the hub answers', async () => {
    const socket = await mount();

    expect(sent(socket).filter((each) => each.type === 'graph-open')).toHaveLength(1);
    expect(container.textContent).toContain('opening');
  });

  it('draws the header the mock draws: the name, the draft chip, Publish, Run, and Simulate not built yet', async () => {
    await opened();

    const header = container.querySelector('[data-graph-header]');
    expect(header?.textContent).toContain('release-pipeline');
    expect(header?.textContent).toContain('v2 · draft');
    expect(button('Publish v2').disabled).toBe(false);
    expect(button('Save').disabled).toBe(true);

    const simulate = button('Simulate');
    expect(simulate.disabled).toBe(true);
    expect(simulate.title).toContain('not available yet');
    expect(simulate.title).not.toMatch(/AGX-/);
    // The fixture's graph has v1 published, which is what Run runs.
    expect(button('Run').disabled).toBe(false);
    expect(container.querySelector('[data-run-strip]')).toBeNull();
  });

  it('holds Run until the hub has said where the graph’s run stands', async () => {
    const socket = await mount();
    await act(() => {
      socket.deliver(hubFrames.graphDocument);
    });
    await act(settle);

    // Published, but the read is out: the hub may be running this graph now.
    expect(button('Run').disabled).toBe(true);
    expect(sent(socket).filter((each) => each.type === 'graph-run-read')).toHaveLength(1);
  });

  it('draws a run the hub reports as stale while the connection is being remade, and not live', async () => {
    const socket = await opened();
    await act(() => {
      socket.deliver(hubFrames.graphRunStateRunning);
    });
    await act(settle);
    expect(container.querySelector('[data-run-strip]')?.textContent).toContain('live');
    expect(card('review').dataset['running']).toBe('true');

    await act(() => {
      socket.close();
    });
    await act(settle);

    const strip = container.querySelector<HTMLElement>('[data-run-strip]');
    expect(strip?.textContent).toContain('run #1 · reconnecting · step 3/3');
    expect(strip?.dataset['runTone']).toBe('idle');
    expect(card('review').dataset['running']).toBeUndefined();
    expect(button('Run').disabled).toBe(true);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Cancel')).toBe(
      false,
    );
  });

  it('keeps Run disabled, and says why, while nothing is published', async () => {
    const socket = await mount();
    const answer = JSON.parse(hubFrames.graphDocument) as { published: unknown[] };
    await act(() => {
      socket.deliver(JSON.stringify({ ...answer, published: [] }));
    });
    await act(settle);

    expect(button('Run').disabled).toBe(true);
    expect(button('Run').title).toContain('Publish');
  });

  it('runs the graph: the strip reads the run live, the executing card is drawn running, and Cancel ends it', async () => {
    const socket = await opened();

    await act(() => {
      button('Run').click();
    });
    const run = sent(socket).find((each) => each.type === 'graph-run');
    if (run === undefined || run.type !== 'graph-run') throw new Error('no run was sent');
    expect(run).toMatchObject({ nodeId: 'hub-10', input: {} });
    expect(button('Run').disabled).toBe(true);

    // The hub's yes, addressed to this screen's frame, then the run as the
    // hub captured it parked at the AGENT step.
    const started = JSON.parse(hubFrames.graphRunStarted) as { replyTo: number };
    await act(() => {
      socket.deliver(JSON.stringify({ ...started, replyTo: run.id }));
      socket.deliver(hubFrames.graphRunStateRunning);
    });
    await act(settle);

    const strip = container.querySelector('[data-run-strip]');
    expect(strip?.textContent).toContain('run #1 · live · step 3/3');
    expect(card('review').dataset['running']).toBe('true');
    expect(card('classify').dataset['running']).toBeUndefined();
    expect(button('Run').disabled).toBe(true);

    // The inspector reads the selected node's step out of the same run.
    await act(() => {
      card('classify').click();
    });
    await act(settle);
    expect(container.textContent).toContain('LAST OUTPUT · run #1');
    expect(container.querySelector('[data-last-output]')?.textContent).toContain(
      'route 1 to review',
    );

    await act(() => {
      button('Cancel').click();
    });
    const cancel = sent(socket).find((each) => each.type === 'graph-run-cancel');
    expect(cancel).toMatchObject({ runId: 'hub-11' });
    await act(() => {
      socket.deliver(hubFrames.graphRunStateCancelled);
    });
    await act(settle);

    expect(container.querySelector('[data-run-strip]')?.textContent).toContain(
      'run #1 · cancelled · step 3/3',
    );
    expect(card('review').dataset['running']).toBeUndefined();
    expect(button('Run').disabled).toBe(false);
  });

  it('takes Allow and Deny away while a waiting run is stale: the person may have answered meanwhile', async () => {
    const socket = await opened();
    const waiting = JSON.parse(hubFrames.graphRunStateWaiting) as { nodeId: string };
    await act(() => {
      socket.deliver(JSON.stringify({ ...waiting, nodeId: GRAPH }));
      socket.deliver(hubFrames.machineStateGraphRunWaiting);
    });
    await act(settle);
    expect(container.querySelector('[data-run-approval]')).not.toBeNull();

    await act(() => {
      socket.close();
    });
    await act(settle);

    const strip = container.querySelector<HTMLElement>('[data-run-strip]');
    expect(strip?.textContent).toContain('run #1 · reconnecting · step 2/2');
    expect(strip?.dataset['runTone']).toBe('idle');
    expect(container.querySelector('[data-run-approval]')).toBeNull();
  });

  it('draws Allow and Deny under the strip while the run waits on a person, and answers for the run', async () => {
    const socket = await opened();
    await act(() => {
      button('Run').click();
    });
    const run = sent(socket).find((each) => each.type === 'graph-run');
    if (run === undefined || run.type !== 'graph-run') throw new Error('no run was sent');

    // The hub's yes, addressed to this screen's frame; the run as the hub
    // captured it parked at the HUMAN node, filed under this screen's graph;
    // and the state carrying the request the hub raised for it, which is what
    // the pair of buttons reads.
    const started = JSON.parse(hubFrames.graphRunStartedWaiting) as { replyTo: number };
    const waiting = JSON.parse(hubFrames.graphRunStateWaiting) as { nodeId: string };
    await act(() => {
      socket.deliver(JSON.stringify({ ...started, replyTo: run.id }));
      socket.deliver(JSON.stringify({ ...waiting, nodeId: GRAPH }));
      socket.deliver(hubFrames.machineStateGraphRunWaiting);
    });
    await act(settle);

    expect(container.querySelector('[data-run-strip]')?.textContent).toContain(
      'run #1 · waiting on a person · step 2/2',
    );
    expect(button('Run').disabled).toBe(true);
    const block = container.querySelector<HTMLElement>('[data-run-approval]');
    expect(block).not.toBeNull();
    // The request's words, and nothing a person would need to open elsewhere.
    expect(block?.textContent).toContain('Approve merge');
    expect(block?.textContent).toContain('robert, ana');

    const allow = container.querySelector<HTMLButtonElement>('[aria-label="allow Approve merge"]');
    if (allow === null) throw new Error('no Allow for the waiting node');
    await act(() => {
      allow.click();
    });

    const decided = sent(socket).find((each) => each.type === 'approval-decide');
    expect(decided).toMatchObject({
      type: 'approval-decide',
      subject: { kind: 'graphRun', nodeId: 'approve' },
      decision: 'grant',
    });
    // Nothing of the request goes back, and no rule is offered for a run.
    expect(decided).not.toHaveProperty('proposal');
    expect(container.querySelector('[aria-label^="always allow"]')).toBeNull();
  });

  it('draws the canvas with a card per node and the zoom controls', async () => {
    await opened();

    const cards = [...container.querySelectorAll<HTMLElement>('[data-node-card]')];
    expect(cards.map((each) => each.dataset['kind'])).toEqual(['trigger', 'router', 'agent']);
    const fit = container.querySelector<HTMLButtonElement>('[data-zoom="fit"]');
    expect(fit).not.toBeNull();
    await act(() => {
      fit?.click();
    });
    expect(container.querySelector('[data-zoom-label]')?.textContent).toMatch(/^\d+%$/);
  });

  it('shows the inspector for the card that was clicked', async () => {
    await opened();
    expect(container.textContent).toContain('Select a node');

    await act(() => {
      card('classify').click();
    });
    await act(settle);

    expect(container.textContent).toContain('ROUTER · SELECTED');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Model"]')?.value).toBe('haiku');
  });

  it('marks the draft dirty on an edit, and Save sends the document with its positions', async () => {
    const socket = await opened();
    await act(() => {
      card('classify').click();
    });
    await act(settle);

    const pin = container.querySelector<HTMLInputElement>('input[type="radio"][value="pin"]');
    if (pin === null) throw new Error('no Pin machine segment');
    await act(() => {
      pin.click();
    });

    expect(container.textContent).toContain('unsaved');
    expect(button('Save').disabled).toBe(false);

    await act(() => {
      button('Save').click();
    });

    const save = sent(socket).find((each) => each.type === 'graph-save');
    if (save === undefined || save.type !== 'graph-save') throw new Error('no save was sent');
    expect(save.nodeId).toBe('hub-10');
    expect(save.document.nodes.map((each) => each.position)).toEqual([
      { x: 0, y: 0 },
      { x: 250, y: 84 },
      { x: 500, y: 62 },
    ]);
    // Pin takes the first machine the fleet lists, which in this fixture is
    // the GPU box; the selector beside the segment is where another is chosen.
    expect(save.document.nodes[1]?.placement).toEqual({
      kind: 'pin',
      server: 'registration-gpu-box-01',
    });

    await act(() => {
      socket.deliver(
        JSON.stringify({ type: 'graph-saved', replyTo: save.id, version: 2, updatedAt: 1 }),
      );
    });
    expect(container.textContent).not.toContain('unsaved');
  });

  it('sends a publish for the draft', async () => {
    const socket = await opened();

    await act(() => {
      button('Publish v2').click();
    });

    expect(sent(socket).filter((each) => each.type === 'graph-publish')).toEqual([
      { type: 'graph-publish', id: expect.any(Number), nodeId: 'hub-10' },
    ]);
  });

  it('shows a refusal in the hub’s words', async () => {
    const socket = await opened();
    await act(() => {
      button('Publish v2').click();
    });
    const publish = sent(socket).find((each) => each.type === 'graph-publish');
    if (publish === undefined || publish.type !== 'graph-publish') throw new Error('no publish');

    await act(() => {
      socket.deliver(
        JSON.stringify({
          type: 'refusal',
          replyTo: publish.id,
          code: 'refused',
          message: 'no action of that name exists on this build',
          holder: null,
        }),
      );
    });

    expect(container.textContent).toContain('no action of that name exists on this build');
  });

  it('adds a node of a chosen kind from the Add node menu', async () => {
    await opened();

    await act(() => {
      button('Add node').click();
    });
    await act(settle);
    await act(frame);
    await act(settle);
    const action = document.body.querySelector<HTMLElement>('[data-add-node="action"]');
    if (action === null) throw new Error('the menu offered no ACTION');
    await act(() => {
      action.click();
    });
    await act(settle);
    await act(settle);

    const cards = [...container.querySelectorAll<HTMLElement>('[data-node-card]')];
    expect(cards.map((each) => each.dataset['kind'])).toEqual([
      'trigger',
      'router',
      'agent',
      'action',
    ]);
    expect(container.textContent).toContain('unsaved');
  });
});
