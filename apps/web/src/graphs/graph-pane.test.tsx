// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  nodeIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  type ClientFrame,
} from '@agentplex/protocol';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type GraphDocumentView, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { GraphPane, graphPaneWords } from './graph-pane.js';

/**
 * The placeholder a graph address opens until the canvas lands (AGX-145):
 * the name, the draft's number, and what has been published.
 *
 * The document here is the one a real hub answered with, read back through
 * the client's own parser, so what the pane draws is what the hub actually
 * sends and not a shape somebody imagined.
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

function documentView(): GraphDocumentView {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.graphDocument);
  if (!parsed.ok || parsed.value.type !== 'graph-document') {
    throw new Error('the captured frame is not a graph document');
  }
  const { replyTo, nodeId, name, draftVersion, document, published } = parsed.value;
  return { replyTo, nodeId, name, draftVersion, document, published };
}

const GRAPH = nodeIdSchema.parse('hub-10');
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('graphPaneWords', () => {
  it('says which draft this is, what is published, and how big the document is', () => {
    expect(graphPaneWords(documentView())).toEqual({
      version: 'v2 · draft',
      published: 'v1 published',
      shape: '3 nodes · 2 edges',
    });
  });

  it('says when nothing has been published yet', () => {
    const fresh: GraphDocumentView = {
      ...documentView(),
      draftVersion: 1,
      document: { nodes: [], edges: [] },
      published: [],
    };
    expect(graphPaneWords(fresh)).toEqual({
      version: 'v1 · draft',
      published: 'nothing published yet',
      shape: '0 nodes · 0 edges',
    });
  });

  it('lists every published version when there are several', () => {
    const twice: GraphDocumentView = {
      ...documentView(),
      draftVersion: 3,
      published: [
        { version: 1, publishedAt: 1 },
        { version: 2, publishedAt: 2 },
      ],
    };
    expect(graphPaneWords(twice).published).toBe('v1, v2 published');
  });
});

describe('GraphPane', () => {
  let container: HTMLElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
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

  function sent(socket: FakeSocket): ClientFrame[] {
    return socket.sent.map((text) => {
      const parsed = parseTextFrame(parseClientFrame, text);
      if (!parsed.ok) throw new Error(`the pane sent something unreadable: ${parsed.reason}`);
      return parsed.value;
    });
  }

  async function mount(): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      root.render(withProvider(<GraphPane nodeId={GRAPH} store={store} />));
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the pane dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
    });
    return socket;
  }

  it('asks the hub for the graph once it is mounted, and says it is waiting', async () => {
    const socket = await mount();

    expect(sent(socket).filter((frame) => frame.type === 'graph-open')).toEqual([
      { type: 'graph-open', id: expect.any(Number), nodeId: 'hub-10' },
    ]);
    expect(container.textContent).toContain('opening');
  });

  it('draws the name, the draft number and the published versions the hub answered with', async () => {
    const socket = await mount();

    await act(() => {
      socket.deliver(hubFrames.graphDocument);
    });

    const text = container.textContent ?? '';
    expect(text).toContain('release-pipeline');
    expect(text).toContain('v2 · draft');
    expect(text).toContain('v1 published');
    expect(text).toContain('3 nodes · 2 edges');
    expect(text).not.toContain('opening');
  });

  it('draws a refusal to the open in the hub’s words', async () => {
    const socket = await mount();
    const open = sent(socket).find((frame) => frame.type === 'graph-open');
    if (open === undefined) throw new Error('no open was sent');

    await act(() => {
      socket.deliver(
        JSON.stringify({
          type: 'refusal',
          replyTo: open.id,
          code: 'refused',
          message: 'this hub has no graph by that id',
          holder: null,
        }),
      );
    });

    expect(container.textContent).toContain('this hub has no graph by that id');
  });
});
