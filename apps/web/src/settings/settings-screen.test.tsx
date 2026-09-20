// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeStorage } from '../auth/fake-storage.js';
import { createTokenStore } from '../auth/token.js';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubSnapshot, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { createFakePairingOperations } from './fake-pairing-operations.js';
import { SettingsRoute } from './settings-route.js';
import { SettingsScreen } from './settings-screen.js';

/**
 * That the screen carries the controls it is the home of, and what it says
 * when it has nothing to list, which is what a new install has.
 *
 * The appearance control is asserted here rather than only in its own suite
 * because its own suite mounts it directly: without this, deleting the
 * section from the screen would leave every test green and the light scheme
 * unreachable again, which is the bug AGX-126 was filed about.
 *
 * The snapshot the unpaired suite draws is a real store's, walked through a
 * fake socket on captured frames rather than assembled here: the paired-server
 * list is read off a machine state, and a state written by hand would be a
 * claim about what a hub sends rather than a record of one.
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

/** The appearance control measures its own indicator; jsdom has no layout. */
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

/**
 * The seam, answering a refusal. Nothing below submits the form -- these
 * assertions are about what the screen says with nothing paired -- so the
 * answer is the one that records no registration this fleet does not have.
 */
const NO_PAIRING = createFakePairingOperations({
  answer: { ok: false, reason: 'no test here pairs anything' },
});

describe('the settings screen', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    const sockets = createFakeSocketFactory();
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

  it('carries the appearance control, which is the only place the light scheme is reachable from', async () => {
    const storage = fakeStorage();
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
          <SettingsRoute store={store} tokens={createTokenStore(() => storage)} />
        </MantineProvider>,
      );
    });

    const group = container.querySelector('[aria-label="Appearance"]');
    expect(group).not.toBeNull();
    expect([...(group?.querySelectorAll('input') ?? [])].map((input) => input.value)).toEqual([
      'dark',
      'light',
      'system',
    ]);
  });
});

describe('the settings screen with nothing paired', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
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

  /** A real store's snapshot, after the hub has answered with one state. */
  async function snapshotOn(state: string): Promise<HubSnapshot> {
    const sockets = createFakeSocketFactory();
    const store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
    const detach = store.subscribe(() => {});
    await settle();
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    socket.open();
    socket.deliver(hubFrames.welcome);
    socket.deliver(state);
    const snapshot = store.getSnapshot();
    detach();
    return snapshot;
  }

  async function draw(state: string): Promise<void> {
    const snapshot = await snapshotOn(state);
    const storage = fakeStorage();
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <SettingsScreen
          snapshot={snapshot}
          tokens={createTokenStore(() => storage)}
          pairing={NO_PAIRING}
          candidates={[]}
        />
      </MantineProvider>
    );
    await act(async () => {
      root = createRoot(container);
      root.render(element);
    });
  }

  it('names the form above it and the installer that produces a server to pair', async () => {
    await draw(hubFrames.machineState);

    const words = container.textContent ?? '';
    expect(words).toContain('No servers are paired with this hub');
    // Both halves of the answer: the form on this screen for a server that is
    // already running, and the installer for the case where none is.
    expect(words).toContain('Pair one above');
    expect(words).toContain('install.sh --role=server');
    // No host, in either command. Where the bootstrap is fetched from is a
    // fact about a deployment, and inventing one here would be the screen
    // making it up.
    expect(words).not.toContain('https://');
  });

  it('sends the operator to the identity file, because nothing prints the token', async () => {
    await draw(hubFrames.machineState);

    const words = container.textContent ?? '';
    // `install.sh` writes no token by design (scripts/install.sh) and
    // `agentplex setup` never prints one (describe-outcome.ts, pinned by
    // setup-command.test.ts). A screen that said either hands you one would be
    // sending somebody to look for something that is not there.
    expect(words).toContain('agentplex setup');
    expect(words).toContain('identity file');
    expect(words).toContain('the pairing token is in it');
    expect(words).toContain('never printed');
  });

  it('says nothing about pairing before the hub has answered at all', async () => {
    const storage = fakeStorage();
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <SettingsScreen
          snapshot={await snapshotOn(hubFrames.pong)}
          tokens={createTokenStore(() => storage)}
          pairing={NO_PAIRING}
          candidates={[]}
        />
      </MantineProvider>
    );
    await act(async () => {
      root = createRoot(container);
      root.render(element);
    });

    // An empty list and a list that has not arrived are two different facts,
    // and only the first one has a next action.
    expect(container.textContent).toContain('the hub');
    expect(container.textContent).not.toContain('install.sh');
  });

  it('drops the guidance the moment a server is paired', async () => {
    await draw(hubFrames.machineStateWithServer);

    expect(container.textContent).not.toContain('No servers are paired');
    expect(container.textContent).toContain('gpu-box-01');
  });
});
