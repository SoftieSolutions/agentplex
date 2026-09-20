// @vitest-environment jsdom
import { parseClientFrame, parseTextFrame, type ClientFrame } from '@agentplex/protocol';
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
import { parseSessionHash } from '../terminal/session-route.js';
import { SessionListScreen } from './session-list-screen.js';

/**
 * The two affordances a card carries, on a list built from a real hub's state:
 * the card opens its session, and a session something is holding offers a
 * stop. Everything inbound here is captured output -- the fleet state, the
 * refusal a real hub answered a real stop with, the reply it sent when one
 * landed -- and everything outbound is read back through the hub's own parser.
 *
 * The screen's other job with no cards on it is here too: what a person can do
 * about an empty list or a connection that is not up. Those are assertions
 * about anchors and not about click handlers on purpose -- the next step is a
 * place, so it has to be openable in a new tab and readable in a status bar.
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

/**
 * Mantine's popover-backed controls observe their target's box; jsdom has no
 * layout and no observer. A stub that reports nothing is enough -- nothing
 * here asserts on a measurement.
 */
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

/** The moment every age on these renders is measured against. */
const NOW = 1_756_000_000_000;

describe('the session list', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  /** This device's credential store: empty unless a test writes to it. */
  let tokens: TokenStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    // One storage for the mount, so a token a test writes is one the screen
    // reads back -- a fresh fake per access would swallow the write.
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

  /** Mounts the screen and walks its store's connection through to a state. */
  async function mountWith(state: string): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(<SessionListScreen store={store} tokens={tokens} now={() => NOW} />),
      );
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the screen dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(state);
    });
    return socket;
  }

  /** What the store sent, read back through the hub's own parser. */
  function sentFrames(socket: FakeSocket): ClientFrame[] {
    return socket.sent.map((text) => {
      const parsed = parseTextFrame(parseClientFrame, text);
      if (!parsed.ok) throw new Error(`the store sent something unreadable: ${parsed.reason}`);
      return parsed.value;
    });
  }

  function cardLinks(): HTMLAnchorElement[] {
    return [...container.querySelectorAll<HTMLAnchorElement>('a[href^="#/session/"]')];
  }

  function stopButtons(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="stop "]')];
  }

  function theStopButton(): HTMLButtonElement {
    const buttons = stopButtons();
    const only = buttons[0];
    if (buttons.length !== 1 || only === undefined) {
      throw new Error(`expected one stop button, found ${String(buttons.length)}`);
    }
    return only;
  }

  /** Mounts the screen and leaves the dial in flight, so no state ever arrives. */
  async function mountDialling(): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(<SessionListScreen store={store} tokens={tokens} now={() => NOW} />),
      );
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the screen dialled nothing');
    return socket;
  }

  /**
   * The next-action links: the two addresses the model can name, and nothing
   * else the screen happens to draw an anchor for.
   */
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

  async function click(target: Element): Promise<void> {
    await act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('makes every card a link to its own session', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    // Six sessions across two stores in the captured fleet, six addresses.
    expect(cardLinks().map((link) => link.getAttribute('href'))).toEqual([
      '#/session/store-agentplex/session-migrate-db',
      '#/session/store-universe/session-docs-sweep',
      '#/session/store-agentplex/session-fix-auth',
      '#/session/store-universe/session-bench-tokenizer',
      '#/session/store-universe/session-train-lora',
      '#/session/store-agentplex/session-spike-wasm',
    ]);
  });

  it('names the session it opens, so the link is reachable by name', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    const link = cardLinks().find((candidate) => candidate.getAttribute('aria-label') !== null);
    expect(link?.getAttribute('aria-label')).toBe('open migrate-db-v9');
  });

  it('writes an address the session route itself reads back', async () => {
    await mountWith(hubFrames.machineStatePopulated);
    const link = cardLinks()[0];
    if (link === undefined) throw new Error('the list drew no card link');

    // Through the route's own parser and not a string comparison: what makes
    // the card open a session is that the address it writes is one that
    // module says addresses that session. jsdom performs no navigation, so
    // this is the whole of the contract that can be checked here.
    expect(parseSessionHash(link.getAttribute('href') ?? '')).toEqual({
      storeId: 'store-agentplex',
      sessionId: 'session-migrate-db',
    });
  });

  it('offers a stop only where the hub published a stoppable holder', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    // One of the six. The working session on the same machine is held too, and
    // its holder says mid-turn, so it gets nothing.
    expect(stopButtons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'stop session-migrate-db',
    ]);
  });

  it('keeps the stop out of the link, so the button is operable on its own', async () => {
    await mountWith(hubFrames.machineStatePopulated);
    const button = theStopButton();

    // The card is a stretched link rather than a wrapper, which is the whole
    // reason: a button inside an anchor is neither valid nor reachable.
    expect(cardLinks().some((link) => link.contains(button))).toBe(false);
  });

  it('sends a stop that names the session and nothing else', async () => {
    const socket = await mountWith(hubFrames.machineStatePopulated);

    await click(theStopButton());

    expect(sentFrames(socket).filter((frame) => frame.type === 'session-stop')).toEqual([
      {
        type: 'session-stop',
        id: 4,
        storeId: 'store-agentplex',
        sessionId: 'session-migrate-db',
      },
    ]);
  });

  it('does not navigate when the stop inside the card is pressed', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await click(theStopButton());

    expect(window.location.hash).toBe('');
  });

  it('disables the button while the stop is in flight', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await click(theStopButton());

    expect(theStopButton().disabled).toBe(true);
    expect(theStopButton().textContent).toBe('Stopping');
  });

  it('says why beside the button when the hub refuses the stop', async () => {
    const socket = await mountWith(hubFrames.machineStatePopulated);
    await click(theStopButton());

    // The race the hub refuses on purpose: the holder went mid-turn between
    // the button being drawn and the button being pressed. Captured from a
    // real hub answering a real stop, and it answers frame 4 -- the stop this
    // card just sent, after the layout and the catalogue page this screen asks
    // for on connecting.
    await act(() => {
      socket.deliver(hubFrames.refusalHeldBusy);
    });

    expect(container.textContent).toContain(
      'that session is mid-turn; stopping it now could leave an edit half applied',
    );
    // Still offered: the session is still running, and this attempt is what
    // did not stop it.
    expect(theStopButton().disabled).toBe(false);
  });

  it('says what a landed stop landed on, whoever asked for it', async () => {
    const socket = await mountWith(hubFrames.machineStatePopulated);

    // Nothing on this screen asked: the reply answers frame 6, which this
    // store never sent. A stop from another tab is exactly this.
    await act(() => {
      socket.deliver(hubFrames.sessionStopped);
    });

    expect(container.textContent).toContain('stopped migrate-db-v9 on mbp-robert');
  });

  it('names the token beside the notice when nothing is stored and no state has arrived', async () => {
    const socket = await mountDialling();

    // The dial ends without a welcome: the store retries, and this device has
    // never had a state, so nothing here proves its credential was accepted.
    await act(() => {
      socket.drop();
    });

    expect(container.textContent).toContain('connection lost; reconnecting');
    const action = theActionLink();
    expect(action.textContent).toBe('Save the hub token in Settings');
    expect(action.getAttribute('href')).toBe('#settings');
  });

  it('sends a device with a token and no fleet to check what it typed', async () => {
    tokens.write('the-hub-token');
    const socket = await mountDialling();
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStatePopulated);
      // Unreadable in the other direction: the hub says this client sent a
      // frame it could not parse, which no retry can fix.
      socket.deliver(hubFrames.protocolError);
    });

    const action = theActionLink();
    expect(action.textContent).toBe('Check the hub token in Settings');
    expect(action.getAttribute('href')).toBe('#settings');
  });

  it('points an empty fleet at the wizard, under the words it already says', async () => {
    await mountWith(hubFrames.machineState);

    expect(container.textContent).toContain('no sessions in any store yet');
    const action = theActionLink();
    expect(action.textContent).toBe('Pair a server');
    expect(action.getAttribute('href')).toBe('#/onboarding');
  });

  it('asks a paired server with no store for one, rather than for another server', async () => {
    await mountWith(hubFrames.machineStateWithServer);

    expect(container.textContent).toContain('no sessions in any store yet');
    const action = theActionLink();
    expect(action.textContent).toBe('Mount a store on a paired server');
    expect(action.getAttribute('href')).toBe('#settings');
  });

  it('names no next step while there are sessions on screen', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    expect(actionLinks()).toEqual([]);
  });
});
