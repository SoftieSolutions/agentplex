// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { sessionHash } from '../terminal/session-route.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { colorForTone } from '../ui/tokens.js';
import { NotificationListView } from './notification-list.js';
import { notificationList, type NotificationList } from './notification-model.js';
import { listSessions, type SessionListItem } from './session-list-model.js';

/**
 * The list itself, drawn: the rows the bell's panel is made of, with no
 * container around them.
 *
 * Mounted bare on purpose. The popover and the sheet render this one node, so
 * what is pinned here is what a person reads -- the two sections, what a row
 * says and where it goes -- and the containers are tested where they are
 * built. A fact asserted here is a fact in both presentations.
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
const attended = stateFrom(hubFrames.machineStateAttended);
const empty = stateFrom(hubFrames.machineState);

/** The moment the fixtures were reported, so the ages are the real elapsed ones. */
const NOW = 1_756_000_000_000;

function named(items: readonly SessionListItem[], name: string): SessionListItem {
  const found = items.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the fixture has no session called ${name}`);
  return found;
}

describe('the notification list', () => {
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
  });

  function draw(list: NotificationList): void {
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <NotificationListView list={list} scheme="dark" />
      </MantineProvider>
    );
    act(() => {
      root ??= createRoot(container);
      root.render(element);
    });
  }

  function rows(): readonly HTMLAnchorElement[] {
    return [...container.querySelectorAll<HTMLAnchorElement>('a[data-notification-row]')];
  }

  function headings(): readonly HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('h3')];
  }

  function section(which: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`[data-section="${which}"]`);
    if (found === null) throw new Error(`nothing drew the ${which} section`);
    return found;
  }

  /**
   * Everything a person would read. Mantine's provider writes its variables
   * into a `<style>` inside the same container, and a stylesheet is not
   * something the panel says.
   */
  function words(): string {
    const copy = container.cloneNode(true) as HTMLElement;
    for (const sheet of copy.querySelectorAll('style')) sheet.remove();
    return copy.textContent?.trim() ?? '';
  }

  /**
   * A colour as the DOM gives it back. jsdom rewrites a hex into `rgb(...)`,
   * so the token is put through the same rewrite rather than compared raw.
   */
  function asStyled(color: string): string {
    const probe = document.createElement('div');
    probe.style.color = color;
    return probe.style.color;
  }

  it('sends a row where the card sends it, through the same helper', () => {
    const items = listSessions(populated);
    draw(notificationList(items, NOW));

    expect(rows()[0]?.getAttribute('href')).toBe(sessionHash(named(items, 'migrate-db-v9').ref));
    expect(rows()).toHaveLength(2);
  });

  it('says one line and draws no headings when neither section holds anything', () => {
    // Two empty headings would be the panel reporting its own structure. One
    // sentence is the whole answer to the question the bell was pressed to ask.
    draw(notificationList(listSessions(empty), NOW));

    expect(headings()).toEqual([]);
    expect(rows()).toEqual([]);
    expect(words()).toBe('Nothing is waiting on you.');
  });

  it('carries the needs-you tone on the section that needs a person', () => {
    draw(notificationList(listSessions(populated), NOW));

    const heading = section('needs-you').querySelector<HTMLElement>('h3');
    expect(heading?.style.color).toBe(asStyled(colorForTone('needs-you', 'dark')));
  });

  it('heads the first section with the count the bell was marked for', () => {
    draw(notificationList(listSessions(populated), NOW));

    expect(section('needs-you').querySelector('h3')?.textContent).toBe('NEEDS YOU · 2');
  });

  it('gives a row the sentence and the place line the model worked out', () => {
    const list = notificationList(listSessions(populated), NOW);
    draw(list);

    const row = rows()[0];
    expect(row?.textContent).toContain('migrate-db-v9 is awaiting permission');
    expect(row?.textContent).toContain('store-agentplex · mbp-robert · 3m');
  });

  it('draws what has been seen under its own heading, below what has not', () => {
    const asking = listSessions(populated).filter((item) => item.storeId === 'store-universe');
    const seen = listSessions(attended).filter((item) => item.storeId === 'store-agentplex');
    draw(notificationList([...asking, ...seen], NOW));

    expect(headings().map((heading) => heading.textContent)).toEqual(['NEEDS YOU · 1', 'EARLIER']);
    expect(rows().map((row) => row.getAttribute('href'))).toEqual([
      sessionHash(named(asking, 'docs-sweep').ref),
      sessionHash(named(seen, 'migrate-db-v9').ref),
    ]);
  });

  it('heads only the section that has rows, and never says the list is empty beside them', () => {
    draw(notificationList(listSessions(attended), NOW));

    expect(headings().map((heading) => heading.textContent)).toEqual(['EARLIER']);
    expect(words()).not.toContain('Nothing is waiting');
  });

  it('names each section for the rows under it, so the panel reads as two lists', () => {
    draw(notificationList(listSessions(populated), NOW));

    const heading = section('needs-you').querySelector<HTMLElement>('h3');
    expect(section('needs-you').getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(heading?.id).not.toBe('');
  });
});
