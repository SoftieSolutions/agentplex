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
import { listSessions, type SessionListItem } from './session-list-model.js';
import { SessionCard } from './session-card.js';
import { SessionRow } from './session-row.js';
import { SessionSummaryLine } from './session-summary-line.js';

/**
 * The one line under a session's name, on the captured fleet that holds both
 * shapes of it: two sessions whose provider recorded an activity -- a Claude
 * tool name and a command codex parsed -- and two whose provider recorded
 * none, one of which has no working directory either and so falls all the way
 * back to its status in words.
 *
 * Both forms of the list draw it, so both forms are asserted here rather than
 * the component alone: the card and the row are one promise about what a
 * session says it is doing, and a suite that only rendered the component would
 * pass with the row still drawing the old string.
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

describe('the summary line', () => {
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

  function render(what: React.ReactNode): void {
    act(() => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          {what}
        </MantineProvider>,
      );
    });
  }

  /** The line as the component itself draws it, off one captured item. */
  function lineFor(name: string): string {
    const found = item(name);
    render(<SessionSummaryLine activity={found.activity} text={found.summary} scheme="dark" />);
    return container.querySelector('p')?.textContent ?? '';
  }

  it('draws the activity when the provider recorded one', () => {
    expect(lineFor('fix-auth-refresh')).toBe('Bash');
    expect(lineFor('migrate-db-v9')).toBe("printf 'hello' > probe.txt failed with exit status 1");
  });

  it('falls back to the working directory when it recorded none', () => {
    expect(lineFor('bench-tokenizer')).toBe('/mnt/volumes/universe/bench');
  });

  it('falls back to the status in words when there is no directory either', () => {
    expect(lineFor('spike-wasm')).toBe('idle');
  });

  it('draws the activity in its collapsed form: one line, cut with an ellipsis', () => {
    render(
      <SessionSummaryLine
        activity={item('fix-auth-refresh').activity}
        text="unused"
        scheme="dark"
      />,
    );
    expect(container.querySelector('p')?.getAttribute('data-truncate')).toBe('end');
  });

  it('quotes a command left to right, as the widget does', () => {
    render(
      <SessionSummaryLine activity={item('migrate-db-v9').activity} text="unused" scheme="dark" />,
    );
    expect(container.querySelector('[dir="ltr"]')?.textContent).toBe("printf 'hello' > probe.txt");
  });

  /** The fallback is a directory, not a command: it carries no quoted run. */
  it('draws the fallback as the line it always was', () => {
    render(
      <SessionSummaryLine activity={null} text="/Users/robert/code/agentplex" scheme="dark" />,
    );
    const line = container.querySelector('p');
    expect(line?.textContent).toBe('/Users/robert/code/agentplex');
    expect(line?.getAttribute('data-truncate')).toBe('end');
    expect(line?.querySelector('[dir="ltr"]')).toBeNull();
  });

  /** Both forms of the list, on one session of each shape. */
  function cardLine(name: string): string {
    render(<SessionCard item={item(name)} scheme="dark" now={NOW} store={store} />);
    const drawn = container.querySelector('article > p');
    return drawn?.textContent ?? '';
  }

  function rowLine(name: string): string {
    render(<SessionRow item={item(name)} scheme="dark" now={NOW} store={store} />);
    // The row lays its summary out in a box of its own, which is the one
    // paragraph on the line that is not a direct child of the article.
    const drawn = [...container.querySelectorAll('article div > p')].at(-1);
    return drawn?.textContent ?? '';
  }

  it('is the line the card draws, for a session with an activity and one without', () => {
    expect(cardLine('migrate-db-v9')).toBe("printf 'hello' > probe.txt failed with exit status 1");
    expect(cardLine('spike-wasm')).toBe('idle');
  });

  it('is the line the row draws, for a session with an activity and one without', () => {
    expect(rowLine('migrate-db-v9')).toBe("printf 'hello' > probe.txt failed with exit status 1");
    expect(rowLine('bench-tokenizer')).toBe('/mnt/volumes/universe/bench');
  });
});
