// @vitest-environment jsdom
import { serverRegistrationIdSchema } from '@agentplex/protocol';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeStorage } from '../auth/fake-storage.js';
import { createTokenStore, type TokenStore } from '../auth/token.js';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { ONBOARDING_HASH } from '../onboarding/onboarding-route.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { createFakePairingOperations } from './fake-pairing-operations.js';
import { discoveredCandidates } from './pairing-form.js';
import { SettingsScreen } from './settings-screen.js';

/**
 * What the settings screen offers when it has nothing to list, and the anchor
 * that makes it reachable at all.
 *
 * The state comes off a real store fed captured hub frames, the way the route
 * feeds it: the screen's empty server list is a rendering of what a hub
 * actually said, not of a hand-written object. The pairing seam is the shared
 * fake, because nothing here submits the form -- `PairingPanel` has its own
 * test, and going through this screen to reach it would prove wiring twice.
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

/** Mantine's inputs observe their own box; jsdom has no layout and no observer. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const PAIRING = createFakePairingOperations({
  answer: { ok: true, registrationId: serverRegistrationIdSchema.parse('registration-1') },
});

/** The route's own wiring, minus the operations this test injects. */
function Settings({ store, tokens }: { store: HubStore; tokens: TokenStore }): JSX.Element {
  const snapshot = useHubSnapshot(store);
  return (
    <SettingsScreen
      snapshot={snapshot}
      tokens={tokens}
      pairing={PAIRING}
      candidates={discoveredCandidates(snapshot.machineState)}
    />
  );
}

describe('the settings screen', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  let tokens: TokenStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    const storage = fakeStorage();
    tokens = createTokenStore(() => storage);
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
    window.location.hash = '';
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  /** Mounts the screen with the dial still in flight, so no state ever arrives. */
  async function mountDialling(): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <Settings store={store} tokens={tokens} />
        </MantineProvider>,
      );
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the screen dialled nothing');
    return socket;
  }

  /** Mounts the screen and walks its store's connection through to a state. */
  async function mountWith(state: string): Promise<FakeSocket> {
    const socket = await mountDialling();
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(state);
    });
    return socket;
  }

  function linkTexts(href: string): (string | null)[] {
    return [...container.querySelectorAll<HTMLAnchorElement>(`a[href="${href}"]`)].map(
      (link) => link.textContent,
    );
  }

  it('is addressable, so the next steps that name it land on it', async () => {
    await mountWith(hubFrames.machineState);

    const root = container.querySelector('#settings');
    if (root === null) throw new Error('the settings screen has no address to land on');
    expect(root.textContent).toContain('Settings');
  });

  it('points an empty server list at the wizard, under the words it already says', async () => {
    await mountWith(hubFrames.machineState);

    expect(container.textContent).toContain('No servers are paired with this hub.');
    // Two anchors to one address, and deliberately: the guide sits under hub
    // access for somebody adding a second machine, and this one is the answer
    // to a list with nothing in it.
    expect(linkTexts(ONBOARDING_HASH)).toEqual(['Open the first-run guide', 'Pair a server']);
  });

  it('invites no pairing once a server is paired', async () => {
    await mountWith(hubFrames.machineStateWithServer);

    expect(linkTexts(ONBOARDING_HASH)).toEqual(['Open the first-run guide']);
  });

  it('blames the connection before the empty list, when the connection is not up', async () => {
    const socket = await mountDialling();

    // The dial ends without a welcome, and this device has never held a state:
    // nothing here proves its credential was ever accepted, so the list being
    // empty says nothing about what the hub has paired.
    await act(() => {
      socket.drop();
    });

    expect(container.textContent).toContain("the hub's first state has not arrived");
    expect(linkTexts('#settings')).toEqual(['Save the hub token in Settings']);
    expect(linkTexts(ONBOARDING_HASH)).toEqual(['Open the first-run guide']);
  });
});
