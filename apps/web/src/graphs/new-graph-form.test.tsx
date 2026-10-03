// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOME_PROJECT_ID,
  nodeIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  type ClientFrame,
  type HubFrame,
} from '@agentplex/protocol';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIds } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { graphHash } from './graph-route.js';
import { NewGraphForm } from './new-graph-form.js';

/**
 * The New graph form: a name and a project, a create on the wire, and the
 * graph route entered when the hub names the node. The tree with a project
 * in it is the one a real hub sent, HOME included, so the project picker's
 * one option is a row the hub actually lists and HOME is the node it leaves
 * out.
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

function capturedLayout(): Extract<HubFrame, { type: 'layout' }> {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.layoutWithProject);
  if (!parsed.ok || parsed.value.type !== 'layout') {
    throw new Error('the fixture is not a layout frame');
  }
  return parsed.value;
}

/**
 * The captured tree with HOME and nothing else: every node outside HOME taken
 * away, the rest exactly as the hub sent them. Every hub's tree holds HOME
 * since migration 0020, so this is what a hub with no project of its own
 * sends.
 */
function layoutWithOnlyHome(): string {
  const frame = capturedLayout();
  const nodes = frame.nodes.filter(
    (node) => node.id === HOME_PROJECT_ID || node.parentId === HOME_PROJECT_ID,
  );
  return JSON.stringify({ ...frame, nodes });
}

/**
 * The captured tree with a second project beside the one the capture made: a
 * copy of the captured project node under its own id and name, so every field
 * but those is what the hub sent.
 */
function layoutWithTwoProjects(): string {
  const frame = capturedLayout();
  const captured = frame.nodes.find((node) => node.id === 'hub-5');
  if (captured === undefined) throw new Error('the capture made no project');
  const second = { ...captured, id: nodeIdSchema.parse('hub-90'), position: 2, name: 'scratch' };
  return JSON.stringify({ ...frame, nodes: [...frame.nodes, second] });
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function sent(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the form sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

describe('NewGraphForm', () => {
  let container: HTMLElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  let navigated: string[];
  let closed: number;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
    });
    navigated = [];
    closed = 0;
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

  /**
   * The form open on a hub that sent `layout`: by default the captured tree,
   * which holds HOME and the one project the capture made.
   */
  async function mount(layout: string = hubFrames.layoutWithProject): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(
          <NewGraphForm
            store={store}
            opened
            onClose={() => {
              closed += 1;
            }}
            scheme="dark"
            navigate={(hash) => navigated.push(hash)}
          />,
        ),
      );
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the form dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(layout);
    });
    return socket;
  }

  function nameInput(): HTMLInputElement {
    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Name"]');
    if (input === null) throw new Error('no name field');
    return input;
  }

  function createButton(): HTMLButtonElement {
    const button = [...document.body.querySelectorAll('button')].find(
      (each) => each.textContent === 'Create graph',
    );
    if (button === undefined) throw new Error('no Create graph button');
    return button;
  }

  async function type(text: string): Promise<void> {
    await act(() => {
      const input = nameInput();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('names the one project in words rather than as a choice, and blocks until a name is typed', async () => {
    // HOME is in the tree and is not counted: the hub takes no graph under it,
    // so the one project there is to choose is the one the capture made.
    await mount();

    expect(document.body.textContent).toContain('in agentplex (main checkout)');
    expect(document.body.querySelector('[aria-label="Project"]')).toBeNull();
    expect(createButton().disabled).toBe(true);
    expect(document.body.textContent).toContain('give the graph a name');
  });

  it('sends the create for the project with the trimmed name', async () => {
    const socket = await mount();
    await type('  release-pipeline ');

    expect(createButton().disabled).toBe(false);
    await act(() => {
      createButton().click();
    });

    expect(sent(socket).at(-1)).toEqual({
      type: 'graph-create',
      id: expect.any(Number),
      projectId: 'hub-5',
      name: 'release-pipeline',
    });
    expect(createButton().disabled).toBe(true);
  });

  it('opens the graph route and closes when the hub names the node', async () => {
    const socket = await mount();
    await type('release-pipeline');
    await act(() => {
      createButton().click();
    });
    const create = sent(socket).at(-1);
    if (create === undefined || create.type !== 'graph-create') throw new Error('no create');

    await act(() => {
      socket.deliver(
        JSON.stringify({ type: 'graph-created', replyTo: create.id, nodeId: 'hub-10' }),
      );
    });

    expect(navigated).toEqual([graphHash(nodeIdSchema.parse('hub-10'))]);
    expect(closed).toBe(1);
  });

  it('shows a refusal in the hub’s words', async () => {
    const socket = await mount();
    await type('release-pipeline');
    await act(() => {
      createButton().click();
    });
    const create = sent(socket).at(-1);
    if (create === undefined || create.type !== 'graph-create') throw new Error('no create');

    await act(() => {
      socket.deliver(
        JSON.stringify({
          type: 'refusal',
          replyTo: create.id,
          code: 'refused',
          message: 'a graph by that name is already in this project',
          holder: null,
        }),
      );
    });

    expect(document.body.textContent).toContain('a graph by that name is already in this project');
    expect(navigated).toEqual([]);
  });

  it('says there is nowhere to put a graph while the tree has no project', async () => {
    await mount(hubFrames.layout);

    expect(document.body.textContent).toContain('no project');
    expect(createButton().disabled).toBe(true);
  });

  it('says the same while HOME is the only project, because the hub takes no graph there', async () => {
    await mount(layoutWithOnlyHome());
    await type('release-pipeline');

    expect(document.body.textContent).toContain(
      'the tree has no project yet, and a graph belongs to one',
    );
    expect(document.body.textContent).not.toContain('in HOME');
    expect(createButton().disabled).toBe(true);
  });

  it('offers the projects a graph can live in, and HOME is not one of them', async () => {
    await mount(layoutWithTwoProjects());

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Project"]');
    if (input === null) throw new Error('the form drew no project chooser');
    await act(() => {
      input.click();
    });
    const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(['agentplex (main checkout)', 'scratch']);
  });
});
