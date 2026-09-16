// @vitest-environment jsdom
import { parseClientFrame, parseTextFrame, type ClientFrame } from '@agentplex/protocol';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCatalogueStore } from '../catalogue/catalogue-store.js';
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
 * The screen is mounted beside the interest the chrome declares in the
 * catalogue rather than alone. Until AGX-122 this screen drew the tree itself
 * and so asked the catalogue question itself; the sidebar asks it now, before
 * anything on this screen is pressed, and the captured refusal answers the
 * frame a stop is under that numbering. Standing the interest up here keeps
 * this suite asserting about the cards rather than about how many frames the
 * chrome around them happens to send.
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
  /** The chrome's standing catalogue interest, taken away after each test. */
  let chrome: (() => void) | null = null;

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
      frameIds: createFrameIdCounter(),
    });
    chrome = createCatalogueStore({ hub: store }).subscribe(() => {});
    window.location.hash = '';
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    chrome?.();
    chrome = null;
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
      root.render(withProvider(<SessionListScreen store={store} now={() => NOW} />));
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
    // card just sent, after the layout this screen asks for on connecting and
    // the catalogue page the chrome asks for beside it.
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
});
