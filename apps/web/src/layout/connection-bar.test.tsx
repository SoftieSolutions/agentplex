// @vitest-environment jsdom
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
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { colorForTone } from '../ui/tokens.js';
import { ConnectionBar } from './connection-bar.js';
import { LayoutScreen } from './layout-screen.js';
import { createLayoutStore } from './layout-store.js';

/**
 * The connection, said in the chrome of the screens that are not the list.
 *
 * A session route draws panes and nothing else, so a hub that has gone away
 * used to be invisible there: the terminal simply stopped. The bar is the
 * list's sentence and the list's next step, on the screen that had neither,
 * and the assertions below are about the words the model already owns -- not
 * a second wording -- plus an anchor, because a next step is a place.
 */

declare global {
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

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A hue as jsdom reports it once drawn: an inline hex comes back as
 * `rgb(...)`, so the expected colour goes through the same normalisation
 * rather than through conversion arithmetic written in a test.
 */
function asDrawn(color: string): string {
  const probe = document.createElement('span');
  probe.style.background = color;
  return probe.style.background;
}

describe('the connection bar', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  let tokens: TokenStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    // One storage for the mount, so a token a test writes is one the bar
    // reads back -- a fresh fake per access would swallow the write.
    const storage = fakeStorage();
    tokens = createTokenStore(() => storage);
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
    globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
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

  /** Mounts an element and lets the store's dial reach its socket. */
  async function mount(element: JSX.Element): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      root.render(withProvider(element));
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the bar dialled nothing');
    return socket;
  }

  /** Mounts the bar and walks its store's connection through to a state. */
  async function mountConnected(): Promise<FakeSocket> {
    const socket = await mount(<ConnectionBar store={store} tokens={tokens} />);
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStatePopulated);
    });
    return socket;
  }

  /** The next-action links: the addresses the model can name, and no other. */
  function actionLinks(): HTMLAnchorElement[] {
    return [
      ...container.querySelectorAll<HTMLAnchorElement>(
        'a[href="#settings"], a[href="#/onboarding"]',
      ),
    ];
  }

  function theActionLink(): HTMLAnchorElement {
    const links = actionLinks();
    const only = links[0];
    if (links.length !== 1 || only === undefined) {
      throw new Error(`expected one next action, found ${String(links.length)}`);
    }
    return only;
  }

  /** The bar's tone dot: the round span it draws beside its words. */
  function dotColor(): string {
    const dot = [...container.querySelectorAll('span')].find(
      (span) => span.style.borderRadius === '50%',
    );
    if (dot === undefined) throw new Error('the bar drew no tone dot');
    return dot.style.background;
  }

  /**
   * The innermost element that says something: every ancestor up to the root
   * also contains the words, and comparing two ancestors of each other says
   * nothing about which was drawn first.
   */
  function deepestWith(words: string): HTMLElement {
    const matches = [...container.querySelectorAll<HTMLElement>('*')].filter((element) =>
      element.textContent?.includes(words),
    );
    const deepest = matches.at(-1);
    if (deepest === undefined) throw new Error(`nothing on screen says ${words}`);
    return deepest;
  }

  /** The rendered text, with Mantine's injected stylesheets left out. */
  function copy(): string {
    const clone = container.cloneNode(true) as HTMLElement;
    for (const style of clone.querySelectorAll('style')) style.remove();
    return clone.textContent ?? '';
  }

  it('draws nothing at all while the hub is connected and a state is on screen', async () => {
    await mountConnected();

    expect(copy()).toBe('');
    expect(actionLinks()).toEqual([]);
  });

  it('says the connection is lost in the words the list uses, and marks the state stale', async () => {
    const socket = await mountConnected();

    await act(() => {
      socket.drop();
    });

    expect(copy()).toContain(
      'connection lost; reconnecting. Showing the last state received, which may be stale.',
    );
    expect(dotColor()).toBe(asDrawn(colorForTone('needs-you', 'dark')));
  });

  it('offers nothing to do while a reconnection with a fleet on screen is in flight', async () => {
    tokens.write('the-hub-token');
    const socket = await mountConnected();

    await act(() => {
      socket.drop();
    });

    // The app is already doing the one thing that helps, and the words beside
    // this already say the state may be stale: an action here would be the
    // bar inventing work for somebody.
    expect(actionLinks()).toEqual([]);
  });

  it('names the token when a device that has never had a state loses its dial', async () => {
    const socket = await mount(<ConnectionBar store={store} tokens={tokens} />);

    await act(() => {
      socket.drop();
    });

    expect(copy()).toContain('connection lost; reconnecting');
    const action = theActionLink();
    expect(action.textContent).toBe('Save the hub token in Settings');
    expect(action.getAttribute('href')).toBe('#settings');
  });

  it('sends a failed connection to check the token, and draws it as blocked', async () => {
    tokens.write('the-hub-token');
    const socket = await mountConnected();

    await act(() => {
      // Unreadable in the other direction: the hub says this client sent a
      // frame it could not parse, which no retry can fix.
      socket.deliver(hubFrames.protocolError);
    });

    expect(copy()).toContain('the hub could not read a frame this client sent');
    const action = theActionLink();
    expect(action.textContent).toBe('Check the hub token in Settings');
    expect(action.getAttribute('href')).toBe('#settings');
    expect(dotColor()).toBe(asDrawn(colorForTone('blocked', 'dark')));
  });

  it('is drawn by the layout screen above the panes', async () => {
    const layoutStore = createLayoutStore({ hub: store, timers: createFakeTimers() });
    const socket = await mount(
      <LayoutScreen
        session={null}
        doc={null}
        store={store}
        tokens={tokens}
        layoutStore={layoutStore}
      />,
    );
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStatePopulated);
      socket.deliver(hubFrames.paneLayoutEmpty);
    });
    await act(() => {
      socket.drop();
    });

    const words = deepestWith('connection lost; reconnecting');
    const pane = deepestWith('No session here yet');
    // Above, and not merely present: a notice under the panes is a notice on
    // a screen whose panes are the full height of the viewport.
    expect(words.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
