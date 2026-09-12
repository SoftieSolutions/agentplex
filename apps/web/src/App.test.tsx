// @vitest-environment jsdom
import { sessionRefSchema } from '@agentplex/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fakeStorage } from './auth/fake-storage.js';
import { createTokenStore, type TokenStore } from './auth/token.js';
import { createBrowserDependencies } from './store/browser.js';
import { createFakeSocketFactory, type FakeSocketFactory } from './store/fake-socket.js';
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

interface Page {
  readonly tokens: TokenStore;
  readonly hub: HubStore;
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
  return { tokens, hub, sockets, exchanges };
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
      root.render(<App hub={page.hub} tokens={page.tokens} />);
    });
    await act(settle);
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
});
