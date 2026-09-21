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
import { sessionHash } from '../terminal/session-route.js';
import { SessionCard } from './session-card.js';
import { SessionRow } from './session-row.js';
import { listSessions, type SessionListItem } from './session-list-model.js';

/**
 * The row is the card's other reading, so almost every test here is a
 * comparison against the card rather than a list of strings typed out again.
 * The two things the ticket asks of it -- nothing on the row that the card
 * lacks, nothing the card offers missing from the row -- are one assertion
 * each when the card is rendered beside it from the same item: the words the
 * two show, and the controls the two offer.
 *
 * Spelling the expected words out instead would make this suite agree with
 * itself rather than with the card, and the failure it exists to catch is a
 * fact drifting onto one of the two forms alone.
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
/** The same fleet after one prompt was acknowledged and another session muted. */
const attended = stateFrom(hubFrames.machineStateAttended);

function item(state: MachineState, name: string): SessionListItem {
  const found = listSessions(state).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the fixture has no session called ${name}`);
  return found;
}

/** The moment every age on these renders is measured against. */
const NOW = 1_756_000_000_000;

/** Every word a subtree actually puts on the screen, order-independent. */
function shownWords(root: Element): readonly string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const words: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? '';
    if (text !== '') words.push(text);
  }
  return [...words].sort();
}

/** What a screen reader calls every control in a subtree, order-independent. */
function controlNames(root: Element): readonly string[] {
  return [...root.querySelectorAll('button')]
    .map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '')
    .sort();
}

describe('a session row', () => {
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

  /**
   * One session drawn both ways, side by side, from one item and one clock --
   * and with the same `actions` node in both slots, because the screen passes
   * the same node menu to whichever form is showing.
   */
  function draw(
    state: MachineState,
    name: string,
    moment: number = NOW,
  ): { readonly card: Element; readonly row: Element } {
    const chosen = item(state, name);
    const actions = (
      <button type="button" aria-label={`node menu ${chosen.name}`}>
        More
      </button>
    );
    act(() => {
      root?.unmount();
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <div id="card">
            <SessionCard item={chosen} scheme="dark" now={moment} store={store} actions={actions} />
          </div>
          <div id="row">
            <SessionRow item={chosen} scheme="dark" now={moment} store={store} actions={actions} />
          </div>
        </MantineProvider>,
      );
    });
    const card = container.querySelector('#card');
    const row = container.querySelector('#row');
    if (card === null || row === null) throw new Error('neither form rendered');
    return { card, row };
  }

  /** The row element itself, inside the wrapper the harness renders it in. */
  function article(row: Element): Element {
    const found = row.querySelector('article');
    if (found === null) throw new Error('the row drew no element');
    return found;
  }

  it.each([
    ['one waiting on a human', populated, 'migrate-db-v9'],
    ['one whose prompt has been seen', attended, 'migrate-db-v9'],
    ['a muted one', attended, 'docs-sweep'],
    ['a quiet one with nothing to press', populated, 'spike-wasm'],
  ])('says what the card says about %s, and no more', (_label, state, name) => {
    const { card, row } = draw(state, name);
    expect(shownWords(row)).toEqual(shownWords(card));
    expect(controlNames(row)).toEqual(controlNames(card));
  });

  it('draws the facts the mockup names, on the one line', () => {
    const { row } = draw(populated, 'migrate-db-v9');
    const text = article(row).textContent ?? '';
    // The name, the place line through `placeLabel`, the summary line, the
    // provider, and the age off the injected clock. The summary is this
    // session's activity rather than its directory, because its provider
    // recorded one: the directory is still on the item, still what the filter
    // matches, and no longer the line -- what the agent is doing beats where
    // it is doing it on the one line a row has.
    expect(text).toContain('migrate-db-v9');
    expect(text).toContain('store-agentplex · mbp-robert');
    expect(text).toContain("printf 'hello' > probe.txt failed with exit status 1");
    expect(text).toContain('codex');
    expect(text).toContain('waiting 3m');
  });

  /**
   * The other shape, on the same fleet: a session whose provider recorded no
   * activity keeps drawing the directory it always drew.
   */
  it('keeps the directory on the line for a session with no activity', () => {
    const { row } = draw(populated, 'bench-tokenizer');
    expect(article(row).textContent ?? '').toContain('/mnt/volumes/universe/bench');
  });

  it('reads the age off the clock it is handed rather than a wall clock', () => {
    const { row } = draw(populated, 'migrate-db-v9', NOW + 7_200_000);
    expect(article(row).textContent ?? '').toContain('waiting 2h');
  });

  it('offers the card’s controls by the names the card gives them', () => {
    const { row } = draw(populated, 'migrate-db-v9');
    expect(controlNames(row)).toEqual([
      'acknowledge migrate-db-v9',
      'mute migrate-db-v9',
      'node menu migrate-db-v9',
      'stop session-migrate-db',
    ]);
  });

  it('opens the session the card opens, through one link over the whole row', () => {
    const { card, row } = draw(populated, 'migrate-db-v9');
    const links = [...article(row).querySelectorAll('a')];
    // One link and not one per fact: a row of four anchors is four tab stops
    // to the same place.
    expect(links).toHaveLength(1);
    const link = links.at(0);
    expect(link?.getAttribute('href')).toBe(sessionHash(item(populated, 'migrate-db-v9').ref));
    expect(link?.getAttribute('href')).toBe(card.querySelector('a')?.getAttribute('href'));
    expect(link?.getAttribute('aria-label')).toBe('open migrate-db-v9');
  });

  it('keeps every control above the overlay, so pressing one never navigates', () => {
    const { row } = draw(populated, 'migrate-db-v9');
    const element = article(row);
    // The overlay covers the row, so a control the row wants pressed has to be
    // in the positioned box that sits over it -- the node menu included.
    const controls = element.querySelector(':scope > [style*="position: relative"]');
    expect(controls).not.toBeNull();
    const buttons = [...element.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(controls?.contains(button)).toBe(true);
    }
  });

  it('truncates a fact that does not fit rather than wrapping or scrolling', () => {
    const { row } = draw(populated, 'migrate-db-v9');
    const style = article(row).getAttribute('style') ?? '';
    expect(style).toContain('flex-wrap: nowrap');
    expect(style).toContain('overflow: hidden');
    // Four facts on the line -- name, place, summary, provider and age -- and
    // every one of them ends in an ellipsis rather than on a second line.
    const texts = [...article(row).querySelectorAll('p')];
    expect(texts).toHaveLength(4);
    for (const text of texts) {
      expect(text.getAttribute('data-truncate')).toBe('end');
    }
  });
});
