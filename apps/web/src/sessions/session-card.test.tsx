// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { SessionCard } from './session-card.js';
import { listSessions, type SessionListItem } from './session-list-model.js';

/**
 * What the card says, on captured state a real hub sent, in two readings.
 *
 * The first is the meta line, on the same captured fleet the sidebar suite
 * uses: the universe store's sessions are in a project the hub's tree named,
 * the agentplex store's are in none. Its store is stood up unconnected on
 * purpose -- nothing asserted there sends a frame, and a card that needed a
 * live connection to say where its session is would be a card that went blank
 * the moment the hub dropped.
 *
 * The second is the card carrying an open request. Three things there are the
 * card's own rather than the controls': the pair is drawn only where there is
 * a request to answer, it sits above the link overlay so that answering is not
 * navigating, and the clock beside the provider counts from the moment the hub
 * heard the request rather than from the session's last activity. The captured
 * state is built for that last one -- the request is three minutes younger
 * than the transcript it interrupted -- so the two readings cannot be confused
 * for each other.
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

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

const populated = stateFrom(hubFrames.machineStatePopulated);

function item(name: string): SessionListItem {
  const found = listSessions(populated).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the fixture has no session called ${name}`);
  return found;
}

/** The moment every age on these renders is measured against. */
const NOW = 1_756_000_000_000;

describe('a session card', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
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

  /** Draws one named session's card and hands back its meta line. */
  function placeLine(name: string): string {
    act(() => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <SessionCard item={item(name)} scheme="dark" now={NOW} store={store} />
        </MantineProvider>,
      );
    });
    const header = container.querySelector('article > div');
    const place = header?.lastElementChild ?? null;
    if (place === null) throw new Error(`the card for ${name} drew no meta line`);
    return place.textContent ?? '';
  }

  it('reads the project the row carries, beside the machine', () => {
    expect(placeLine('docs-sweep')).toBe('universe · gpu-box-01');
  });

  it('keeps the machine alone form on a session the tree places in no project', () => {
    expect(placeLine('fix-auth-refresh')).toBe('store-agentplex · mbp-robert');
  });

  it('draws no separator with nothing in front of it', () => {
    expect(placeLine('spike-wasm')).not.toMatch(/^\s*·/);
  });
});

/**
 * Three minutes after the hub heard the request, and six after the session
 * itself last said anything. One card, two ages, and only one of them is what
 * "waiting" means here.
 */
const WAITING_NOW = 1_756_000_180_000;

describe('a session card holding an open request', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  /** The list around the card, as far as the store is concerned. */
  let watching: (() => void) | null = null;

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
    window.location.hash = '';
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    watching?.();
    watching = null;
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

  /** Walks the store's connection through to a captured state. */
  async function fleet(state: string): Promise<void> {
    watching = store.subscribe(() => {});
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(state);
    });
  }

  function items(): readonly SessionListItem[] {
    const state = store.getSnapshot().machineState;
    if (state === null) throw new Error('no machine state arrived');
    return listSessions(state);
  }

  async function mountCard(row: SessionListItem): Promise<void> {
    await act(() => {
      root = createRoot(container);
      root.render(
        withProvider(<SessionCard item={row} scheme="dark" now={WAITING_NOW} store={store} />),
      );
    });
  }

  /** The card mounted on the one captured session that is asking. */
  async function mountAsking(): Promise<SessionListItem> {
    await fleet(hubFrames.machineStateApproval);
    const row = items().find((candidate) => candidate.approval !== null);
    if (row === undefined) throw new Error('the captured state holds no open request');
    await mountCard(row);
    return row;
  }

  /**
   * The card's own text. Mantine's provider writes its stylesheet into the
   * same container, so the words on the card are read off the card.
   */
  function cardText(): string {
    const card = container.querySelector('article');
    if (card === null) throw new Error('no card was drawn');
    return card.textContent ?? '';
  }

  function allowButton(name: string): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="allow ${name}"]`);
    if (found === null) throw new Error('the card drew no Allow');
    return found;
  }

  it('draws Allow and Deny where a request is open', async () => {
    const row = await mountAsking();

    expect(allowButton(row.name).textContent).toBe('Allow');
    expect(container.querySelector(`button[aria-label="deny ${row.name}"]`)?.textContent).toBe(
      'Deny',
    );
  });

  it('draws neither on a session asking for nothing', async () => {
    await fleet(hubFrames.machineStatePopulated);
    const quiet = items().find((candidate) => candidate.approval === null);
    if (quiet === undefined) throw new Error('every captured session is asking');

    await mountCard(quiet);

    // Including every codex session, which has no permission hook to ask
    // through and so never carries a request at all.
    expect(container.querySelector('button[aria-label^="allow "]')).toBeNull();
    expect(container.querySelector('button[aria-label^="deny "]')).toBeNull();
  });

  it('keeps Allow out of the link that opens the session', async () => {
    const row = await mountAsking();
    const link = container.querySelector('a[href^="#/session/"]');

    // The overlay covers the card; a button inside an anchor is neither valid
    // nor separately operable.
    expect(link?.contains(allowButton(row.name))).toBe(false);
  });

  it('does not navigate when Allow is pressed', async () => {
    const row = await mountAsking();

    await act(() => {
      allowButton(row.name).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(window.location.hash).toBe('');
  });

  it('counts the waiting clock from the moment the hub heard the request', async () => {
    await mountAsking();

    // The captured session last wrote its transcript six minutes ago and the
    // hub heard the request three minutes ago. What a person is waiting on is
    // the request, and it is the hub's clock against this render's clock --
    // neither of them the provider's.
    expect(cardText()).toContain('waiting 3m');
    expect(cardText()).not.toContain('6m');
  });
});
