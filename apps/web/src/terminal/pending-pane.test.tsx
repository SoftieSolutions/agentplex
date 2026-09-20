// @vitest-environment jsdom
import {
  parseClientFrame,
  parseTextFrame,
  serverRegistrationIdSchema,
  storeIdSchema,
  type ClientFrame,
} from '@agentplex/protocol';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubCommand, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { createFakeEmulatorFactory } from './fake-emulator.js';
import { PendingPane } from './pending-pane.js';

/**
 * The pane a start opens, driven by frames a real hub sent.
 *
 * What it owes a person is a sentence, and the sentences are the assertions
 * here: which machine the start went to, and -- the one that matters more --
 * that a start the hub refused stops looking like a start that is slow. A
 * blank rectangle is what both of those look like without the words.
 *
 * The handle the pane is mounted on is chosen to match the captured reply it
 * is being driven by. A client's start handle is the id of its own
 * `session-start` frame, so a pane waiting on the captured start is a pane
 * waiting on the id that reply names.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * A start, as the new-session form builds one.
 *
 * Sent through the store rather than described to the pane, because the handle
 * a pane waits on is the id the store minted for this frame, and what the pane
 * reads is the entry the store filed under it. A test that handed the pane a
 * number the store had never sent would be testing a pane nothing produces.
 */
const START: HubCommand = {
  type: 'session-start',
  storeId: storeIdSchema.parse('store-agentplex'),
  sessionId: null,
  provider: 'claude',
  prompt: null,
  server: null,
  project: null,
};

/** A command that is not a start, for putting a later start on a chosen frame. */
const BROWSE: HubCommand = {
  type: 'directory-list',
  server: serverRegistrationIdSchema.parse('registration-mbp-robert'),
  directory: null,
};

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

/** jsdom has no `ResizeObserver`, and the terminal view watches its own box. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface StoreHarness {
  readonly store: HubStore;
  socket(): FakeSocket;
}

function buildStore(): StoreHarness {
  const sockets = createFakeSocketFactory();
  const store = createHubStore({
    fetchTicket: () => Promise.resolve('ticket-1'),
    createSocket: (ticket) => sockets.create(ticket),
    timers: createFakeTimers(),
    frameIds: createFrameIdCounter(),
  });
  return {
    store,
    socket(): FakeSocket {
      const dialled = sockets.sockets[0];
      if (dialled === undefined) throw new Error('the store dialled nothing');
      return dialled;
    },
  };
}

function sentFrames(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the pane sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

let container: HTMLDivElement;
let root: Root | null = null;
let emulators: ReturnType<typeof createFakeEmulatorFactory>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  installMatchMedia();
  installResizeObserver();
  container = document.createElement('div');
  document.body.append(container);
  emulators = createFakeEmulatorFactory();
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
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      {element}
    </MantineProvider>
  );
}

/**
 * A store whose socket is up, with nothing mounted yet.
 *
 * The subscription is the test's own rather than a pane's: the commands below
 * have to be sent before the pane exists, because a pane waits on the handle a
 * start already has.
 */
async function connect(hub: StoreHarness): Promise<{ socket: FakeSocket; detach: () => void }> {
  const detach = hub.store.subscribe(() => {});
  await act(settle);
  const socket = hub.socket();
  await act(async () => {
    socket.open();
    socket.deliver(hubFrames.welcome);
  });
  return { socket, detach };
}

async function mountPane(startId: number, hub: StoreHarness): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      withProvider(<PendingPane startId={startId} store={hub.store} emulators={emulators} />),
    );
  });
  await act(settle);
}

async function deliver(socket: FakeSocket, frame: string): Promise<void> {
  await act(async () => {
    socket.deliver(frame);
  });
}

/** A start through the store, which is what mints the handle a pane waits on. */
function start(hub: StoreHarness): number {
  const outcome = hub.store.sendCommand(START);
  if (!outcome.accepted) throw new Error(outcome.reason);
  return outcome.id;
}

function words(): string {
  return container.querySelector('[role="status"]')?.textContent ?? '';
}

describe('the pane a start opens', () => {
  it('watches the terminal by the handle it has, before any session exists', async () => {
    const hub = buildStore();
    const { socket, detach } = await connect(hub);
    const handle = start(hub);

    await mountPane(handle, hub);

    // The only address a spawn has: no session id is invented, and no route is
    // entered. The subscribe follows the start frame that minted the handle.
    expect(sentFrames(socket).at(-1)).toEqual({
      type: 'session-subscribe',
      id: 3,
      target: { by: 'start', startId: handle },
    });
    detach();
  });

  it('says it is asking until the hub has answered the start', async () => {
    const hub = buildStore();
    const { detach } = await connect(hub);
    const handle = start(hub);

    await mountPane(handle, hub);

    expect(words()).toBe('starting a session');
    detach();
  });

  it('names the machine the hub picked, once it has said so', async () => {
    const hub = buildStore();
    const { socket, detach } = await connect(hub);
    const handle = start(hub);
    await mountPane(handle, hub);

    await deliver(socket, hubFrames.machineStatePopulated);
    await deliver(socket, hubFrames.sessionStarted);

    expect(words()).toContain('starting on mbp-robert');
    // And why the pane is still this pane while a terminal is already live.
    expect(words()).toContain('becomes the session when the provider names it');
    detach();
  });

  it('becomes the refusal, and stops pretending a terminal is coming', async () => {
    const hub = buildStore();
    const { socket, detach } = await connect(hub);
    // The captured refusal answers frame 6, so the browses are what put this
    // start on it. The fixture carries the id a real hub really replied to.
    hub.store.sendCommand(BROWSE);
    hub.store.sendCommand(BROWSE);
    hub.store.sendCommand(BROWSE);
    hub.store.sendCommand(BROWSE);
    const handle = start(hub);
    await mountPane(handle, hub);

    await deliver(socket, hubFrames.refusal);

    expect(words()).toBe('no server the hub is paired with has that store mounted');
    expect(container.textContent).toContain('Nothing was started here');
    // And the terminal goes with the words. A start the hub refused produces
    // no bytes ever, and a rectangle that went on looking like a terminal
    // would be a pane waiting for output that is not coming.
    expect(emulators.created.at(-1)?.disposed).toBe(true);
    detach();
  });

  it('keeps its own refusal when another start on the same socket succeeds', async () => {
    const hub = buildStore();
    const { socket, detach } = await connect(hub);
    // Frame 2 is the start that will succeed; frame 6 is this pane's, which
    // the captured refusal answers.
    const succeeding = start(hub);
    hub.store.sendCommand(BROWSE);
    hub.store.sendCommand(BROWSE);
    hub.store.sendCommand(BROWSE);
    const handle = start(hub);
    await mountPane(handle, hub);

    await deliver(socket, hubFrames.refusal);
    expect(words()).toBe('no server the hub is paired with has that store mounted');

    // The other start is answered yes, which clears the connection's shared
    // "newest no". This pane reads its own answer, so nothing here moves.
    await deliver(socket, hubFrames.sessionStarted);

    expect(succeeding).not.toBe(handle);
    expect(words()).toBe('no server the hub is paired with has that store mounted');
    expect(container.textContent).toContain('Nothing was started here');
    detach();
  });

  it('shows the terminal of a spawn nobody has named yet', async () => {
    const hub = buildStore();
    const { socket, detach } = await connect(hub);
    const handle = start(hub);
    await mountPane(handle, hub);

    await deliver(socket, hubFrames.sessionStarted);

    // An emulator, fed by the watch the pane declared: output from the moment
    // of the fork, on a session that has no id to be addressed by.
    expect(emulators.created).toHaveLength(1);
    detach();
  });
});
