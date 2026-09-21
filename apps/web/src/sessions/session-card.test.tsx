// @vitest-environment jsdom
import { act } from 'react';
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
 * The card's meta line, on the same captured fleet the sidebar suite uses: the
 * universe store's sessions are in a project the hub's tree named, the
 * agentplex store's are in none.
 *
 * The store is stood up unconnected on purpose. Nothing asserted here sends a
 * frame -- the stop and the attention controls have their own suites -- and a
 * card that needed a live connection to say where its session is would be a
 * card that went blank the moment the hub dropped.
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
