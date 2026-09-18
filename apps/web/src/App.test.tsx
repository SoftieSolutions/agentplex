// @vitest-environment jsdom
import { sessionRefSchema } from '@agentplex/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fakeStorage } from './auth/fake-storage.js';
import { createTokenStore, type TokenStore } from './auth/token.js';
import { createBrowserDependencies } from './store/browser.js';
import { createOnboardingDismissal, type OnboardingDismissal } from './onboarding/dismissal.js';
import { ONBOARDING_HASH } from './onboarding/onboarding-route.js';
import { createFakeSocketFactory, type FakeSocketFactory } from './store/fake-socket.js';
import { hubFrames } from './store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from './store/hub-store.js';
import { createFakeTimers } from './store/timers.js';
import { sessionHash } from './terminal/session-route.js';

/**
 * The page as the user meets it: one hub store, built the way `main.tsx`
 * builds it, and every route on it. What this suite pins is that the token
 * typed into Settings is the token every screen dials with -- the session
 * screen most of all, because it mounts on a route of its own and used to
 * bring a store of its own along.
 *
 * It is also where the first-run gate is pinned, because the gate is a
 * decision about which whole screen the page is: the wizard, the app, or
 * neither yet. That is only visible from the root, so it is asserted here
 * rather than on a component that cannot see the alternative.
 *
 * The platform is faked at the seams the real page fills: the ticket exchange
 * is a recording `fetch`, the socket is the store's fake, the storage is a
 * map. React needs a document to mount into, hence jsdom for this file alone.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const STORED_TOKEN = 'the-token-typed-on-the-device';
const SESSION = sessionRefSchema.parse({ storeId: 'store-observatory', sessionId: 'session-11' });

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

/**
 * Mantine's popover-backed controls in the session list observe their target's
 * box; jsdom has no layout and no observer. Nothing here asserts on a
 * measurement, so one that reports nothing is enough.
 */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

interface Page {
  readonly tokens: TokenStore;
  readonly hub: HubStore;
  readonly dismissal: OnboardingDismissal;
  readonly sockets: FakeSocketFactory;
  /** The Authorization header of each ticket exchange, in order. */
  readonly exchanges: readonly string[];
}

/** The page's store, composed the way `main.tsx` composes it. */
function buildPage(): Page {
  const storage = fakeStorage();
  const tokens = createTokenStore(() => storage);
  const sockets = createFakeSocketFactory();
  const exchanges: string[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    exchanges.push(new Headers(init?.headers).get('authorization') ?? '');
    return Promise.resolve(Response.json({ ticket: 'ticket-1', expiresInMs: 10_000 }));
  };
  const hub = createHubStore({
    ...createBrowserDependencies({ tokens, fetch }),
    createSocket: (ticket) => sockets.create(ticket),
    timers: createFakeTimers(),
  });
  return {
    tokens,
    hub,
    dismissal: createOnboardingDismissal(() => storage),
    sockets,
    exchanges,
  };
}

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the page', () => {
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
    window.location.hash = '';
  });

  async function mount(page: Page): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      // No StrictMode: its simulated remount would subscribe, hang up and
      // dial again, and the count of dials is part of what is asserted.
      root.render(<App hub={page.hub} tokens={page.tokens} dismissal={page.dismissal} />);
    });
    await act(settle);
  }

  /** The hub answering: the socket opens, greets, and reports one whole state. */
  async function hubAnswers(page: Page, state: string): Promise<void> {
    const socket = page.sockets.sockets[0];
    if (socket === undefined) throw new Error('the page dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(state);
    });
  }

  /** The wizard's one sentence, which no other screen says. */
  const HERO = 'Every agent session, every machine, one place.';

  /** The settings panel's first heading, which the wizard replaces rather than joins. */
  const SETTINGS = 'Hub access';

  function text(): string {
    return container.textContent ?? '';
  }

  it('dials the session route with the token saved through the token store', async () => {
    const page = buildPage();
    page.tokens.write(STORED_TOKEN);
    window.location.hash = sessionHash(SESSION);

    await mount(page);

    expect(page.exchanges).toEqual([`Bearer ${STORED_TOKEN}`]);
    expect(page.sockets.tickets).toEqual(['ticket-1']);
  });

  it('dials the session list with the same token', async () => {
    const page = buildPage();
    page.tokens.write(STORED_TOKEN);

    await mount(page);

    expect(page.exchanges).toEqual([`Bearer ${STORED_TOKEN}`]);
    expect(page.sockets.tickets).toEqual(['ticket-1']);
  });

  it('opens on the wizard when the hub reports no server paired', async () => {
    const page = buildPage();
    page.tokens.write(STORED_TOKEN);

    await mount(page);
    await hubAnswers(page, hubFrames.machineState);

    // The wizard instead of the app, not above it: a first-time reader who has
    // nothing paired has nothing to do on the list or in the pairing form that
    // the wizard is not already walking them through, and two pairing controls
    // on one screen is two places to get it wrong.
    expect(text()).toContain(HERO);
    expect(text()).not.toContain(SETTINGS);
  });

  it('draws the app, and a way back to the wizard, once a server is paired', async () => {
    const page = buildPage();
    page.tokens.write(STORED_TOKEN);

    await mount(page);
    await hubAnswers(page, hubFrames.machineStateWithServer);

    expect(text()).not.toContain(HERO);
    expect(text()).toContain(SETTINGS);
    // The auto-show stops the moment a server exists, so the only way back is
    // an address. Settings carries it, because that is where a reader who
    // wants to add a machine already is.
    const link = container.querySelector('a[href="#/onboarding"]');
    expect(link?.textContent).toBe('Open the first-run guide');
  });

  it('draws neither the wizard nor a conclusion before the hub has answered', async () => {
    const page = buildPage();
    page.tokens.write(STORED_TOKEN);

    await mount(page);
    // Greeted but not yet told anything: the window in which an empty fleet
    // and an unanswered hub look identical from the state alone. Deciding
    // from it here would flash the wizard at every operator on every load,
    // so the list's own waiting line is what is drawn instead.
    const socket = page.sockets.sockets[0];
    if (socket === undefined) throw new Error('the page dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
    });

    expect(text()).not.toContain(HERO);
    expect(text()).toContain('waiting for the first state from the hub');
  });

  it('shows the wizard to whoever typed its address, paired fleet or not', async () => {
    const page = buildPage();
    page.tokens.write(STORED_TOKEN);
    window.location.hash = ONBOARDING_HASH;

    await mount(page);
    await hubAnswers(page, hubFrames.machineStateWithServer);

    expect(text()).toContain(HERO);
  });

  it('hands the page back once this device dismisses the wizard', async () => {
    const page = buildPage();
    page.tokens.write(STORED_TOKEN);

    await mount(page);
    await hubAnswers(page, hubFrames.machineState);
    expect(text()).toContain(HERO);

    // The dismissal is an external store, so the page follows it without a
    // remount and without an effect mirroring it into state.
    await act(() => {
      page.dismissal.dismiss();
    });

    expect(text()).not.toContain(HERO);
    expect(text()).toContain(SETTINGS);
  });
});
