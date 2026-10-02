// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import {
  DEFAULT_SHAPE,
  NO_PAGES,
  pageAdopted,
  withFilter,
  type CataloguePages,
} from '../catalogue/catalogue-model.js';
import { fakeCatalogueStore, type FakeCatalogueStore } from '../catalogue/fake-catalogue-store.js';
import { appSessionFiltersStore } from '../sessions/session-filters-store.js';
import { SessionListScreen } from '../sessions/session-list-screen.js';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIds } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import {
  settingsSections,
  type Destination,
  type SettingsSection,
  type SettingsSectionEntry,
} from './destinations.js';
import { Sidebar } from './sidebar.js';

/**
 * The filter row where it is actually mounted: over whichever tab is showing,
 * with the tab deciding what the letters narrow and whose narrowings the
 * popover beside them carries.
 *
 * The row itself, the popover and every count in it are `sidebar-filter`'s and
 * are pinned next door. What only this mounting can answer is the wiring: that
 * the box is named for the tab under it, that the tree's letters stay the
 * tree's, and that the sessions' letters reach the cards in the content region
 * as well as the rows in the column -- which is the whole claim of one
 * narrowings store, and cannot be shown by either surface alone. So the
 * sidebar and the list screen are mounted side by side over one hub store,
 * which is how the shell mounts them.
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

/** Mantine's controls observe their box; jsdom has no layout and no observer. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/**
 * React tracks an input's value itself, so assigning `input.value` and firing
 * an event is a change React has already decided did not happen. The setter
 * off the prototype is the one the tracker does not intercept.
 */
function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('no value setter on HTMLInputElement');
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Lets a promise the render started settle. */
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

/** A page of the tree as a hub really answered one. */
function heldPages(text: string): CataloguePages {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'catalogue-page') {
    throw new Error('the fixture is not a catalogue page');
  }
  const { items, nextCursor, total, version } = parsed.value;
  return pageAdopted(NO_PAGES, { items, nextCursor, total, version }, 'replace');
}

const populated = stateFrom(hubFrames.machineStatePopulated);

/** The moment every age in this column is measured against. */
const NOW = 1_756_000_000_000;

describe('the sidebar filter row, mounted', () => {
  let column: HTMLDivElement;
  let main: HTMLDivElement;
  let columnRoot: Root | null = null;
  let mainRoot: Root | null = null;
  let store: HubStore;
  let catalogue: FakeCatalogueStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    column = document.createElement('div');
    main = document.createElement('div');
    document.body.append(column, main);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
    });
  });

  afterEach(async () => {
    await act(async () => {
      columnRoot?.unmount();
      mainRoot?.unmount();
    });
    columnRoot = null;
    mainRoot = null;
    column.remove();
    main.remove();
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

  /**
   * The two surfaces the shell draws side by side, over one hub store and so
   * over one set of narrowings.
   *
   * `state` is handed to the sidebar as the shell hands it, and delivered down
   * the socket as well because the list screen reads its own.
   */
  interface Place {
    readonly destination: Destination;
    readonly address: Destination;
    readonly section: SettingsSection;
    readonly sections: readonly SettingsSectionEntry[];
  }

  const ON_THE_LIST: Place = {
    destination: 'sessions',
    address: 'sessions',
    section: 'connections',
    sections: settingsSections(true),
  };

  async function mount(
    state: MachineState | null = populated,
    place: Place = ON_THE_LIST,
  ): Promise<void> {
    catalogue = fakeCatalogueStore(heldPages(hubFrames.catalogueTreePage));
    await act(async () => {
      columnRoot = createRoot(column);
      columnRoot.render(
        withProvider(
          <Sidebar
            store={store}
            state={state}
            layout={[]}
            catalogue={catalogue}
            machine={null}
            onPickMachine={() => {}}
            destination={place.destination}
            address={place.address}
            section={place.section}
            sections={place.sections}
            scheme="dark"
            now={() => NOW}
          />,
        ),
      );
      mainRoot = createRoot(main);
      mainRoot.render(withProvider(<SessionListScreen store={store} machine={null} />));
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the list screen dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      if (state !== null) socket.deliver(hubFrames.machineStatePopulated);
    });
  }

  /**
   * The one box the row draws, whichever tab it is over: the input beside the
   * popover trigger, and never a second one further down the column. The panel
   * below used to draw its own, and two boxes over one tree would be two
   * answers to what is typed.
   */
  function box(): HTMLInputElement {
    const every = [...column.querySelectorAll<HTMLInputElement>('input[aria-label^="Filter "]')];
    const only = every[0];
    if (every.length !== 1 || only === undefined) {
      throw new Error(`expected one filter box, found ${String(every.length)}`);
    }
    return only;
  }

  /** The popover's trigger, or `null` where the row drew none. */
  function trigger(): HTMLButtonElement | null {
    return column.querySelector<HTMLButtonElement>('button[aria-label="Filters"]');
  }

  /**
   * The `N filters` line, with the sessions' `- M hidden` after it on that
   * tab, or `null` where the row drew none.
   */
  function summary(): string | null {
    const found = [...column.querySelectorAll('span')].find((span) =>
      /^\d+ filters?/.test(span.textContent ?? ''),
    );
    return found?.textContent ?? null;
  }

  async function type(text: string): Promise<void> {
    const input = box();
    await act(() => {
      typeInto(input, text);
    });
  }

  async function showSessions(): Promise<void> {
    const tab = column.querySelector<HTMLInputElement>('input[value="sessions"]');
    if (tab === null) throw new Error('the sidebar offers no Sessions tab');
    await act(() => {
      tab.click();
    });
  }

  /** What the sidebar's own rows are called, in the order it drew them. */
  function rowNames(): string[] {
    return [...column.querySelectorAll<HTMLElement>('a[aria-label^="open "]')].map((row) =>
      (row.getAttribute('aria-label') ?? '').replace('open ', ''),
    );
  }

  /** What the cards in the content region are called. */
  function cardNames(): string[] {
    return [...main.querySelectorAll<HTMLElement>('[aria-label^="open "]')].map((card) =>
      (card.getAttribute('aria-label') ?? '').replace('open ', ''),
    );
  }

  it('names the box for the tab under it, and draws one box either way', async () => {
    await mount();
    expect(box().getAttribute('aria-label')).toBe('Filter tree');

    await showSessions();

    expect(box().getAttribute('aria-label')).toBe('Filter sessions');
  });

  it("counts the catalogue's narrowings on the Projects tab and the sessions' on the other", async () => {
    await mount();
    await act(() => {
      appSessionFiltersStore(store).set({ machine: 'registration-mbp-robert' });
    });

    // The session narrowing narrows nothing on this tab -- with a session or a
    // document open beside the tree there are no cards to narrow -- so the
    // popover here is the catalogue's and counts none of it.
    expect(trigger()).not.toBeNull();
    expect(trigger()?.textContent).toBe('');
    expect(summary()).toBeNull();
    box();

    await act(() => {
      catalogue.reshape(withFilter(DEFAULT_SHAPE, { field: 'provider', value: 'codex' }));
    });

    expect(trigger()?.textContent).toBe('1');
    expect(summary()).toBe('1 filter');

    await showSessions();

    expect(summary()).toBe('1 filter · 3 hidden');
    box();
  });

  it('narrows the tree with the letters typed on the Projects tab', async () => {
    await mount();

    await type('plan');

    // The document matched and its project is where it is; the folder in
    // HOME, the session inside it and the session at the top are the three
    // nodes the box took away.
    expect(column.textContent).toContain('plan.md');
    expect(column.textContent).not.toContain('spike-wasm');
    expect(column.textContent).toContain('3 hidden by filter');
  });

  it('leaves the cards alone while the letters belong to the tree', async () => {
    await mount();
    const before = cardNames();
    expect(before).toContain('spike-wasm');

    await type('plan');

    // Two boxes, two things narrowed: the tree's letters are the sidebar's own
    // and never reach the narrowings store, or the Projects tab would be
    // hiding cards through a badge that counts none of it.
    expect(cardNames()).toEqual(before);
  });

  it('narrows the rows and the cards together with the letters on the Sessions tab', async () => {
    await mount();
    await showSessions();
    expect(rowNames().length).toBeGreaterThan(1);
    expect(cardNames()).toContain('docs-sweep');

    await type('bench');

    // One store, read by the column and by the content region at the same
    // moment: this is the whole of why the narrowings were moved off the list
    // screen, and the only place both readings are on screen at once.
    expect(rowNames()).toEqual(['bench-tokenizer']);
    expect(cardNames()).toEqual(['bench-tokenizer']);
  });

  it('measures both readings against the one clock it was handed', async () => {
    await mount();
    await showSessions();
    await act(() => {
      appSessionFiltersStore(store).set({ updatedWithin: '1h' });
    });

    // The captured fleet against the fixed moment: one session was written two
    // hours ago and is the one the window takes away. Without a clock to
    // inject, this row and the list under it would each read `Date.now` and
    // the fixture would age out of every window the day it was captured.
    expect(rowNames()).not.toContain('spike-wasm');
    expect(rowNames()).toHaveLength(5);
    expect(summary()).toBe('1 filter · 1 hidden');
  });

  it('draws no row at all before the hub has answered with a fleet', async () => {
    // There is nothing to narrow and nothing to count: a box over "waiting for
    // the hub" is a control offering to filter a sentence.
    await mount(null);

    expect(column.querySelector('input[aria-label="Filter tree"]')).toBeNull();
    expect(trigger()).toBeNull();
    expect(column.textContent).toContain('waiting for the hub');

    await showSessions();

    expect(column.querySelector('input[aria-label="Filter sessions"]')).toBeNull();
    expect(trigger()).toBeNull();
  });

  describe('while the address is a settings one', () => {
    function inSettings(sections: readonly SettingsSectionEntry[]): Place {
      return { destination: 'settings', address: 'settings', section: 'connections', sections };
    }

    function sectionLinks(): HTMLAnchorElement[] {
      return [
        ...column.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings sections"] a'),
      ];
    }

    it('draws the settings sections in place of the fleet controls', async () => {
      await mount(populated, inSettings(settingsSections(true)));

      expect(sectionLinks().map((link) => link.getAttribute('href'))).toEqual([
        '#/settings/connections',
        '#/settings/preferences',
        '#/settings/developer',
      ]);
      expect(sectionLinks().map((link) => link.getAttribute('aria-current'))).toEqual([
        'page',
        null,
        null,
      ]);
      // The machine selector, the tabs, the filter row and the rows under it
      // narrow a fleet, and nothing in settings is a reading of one.
      expect(column.querySelector('[aria-label="What the sidebar shows"]')).toBeNull();
      expect(column.querySelector('input[aria-label^="Filter "]')).toBeNull();
      // The selector's trigger and the filters popover's are the column's only
      // buttons; the section choices are links.
      expect(column.querySelector('button')).toBeNull();
      expect(rowNames()).toEqual([]);
    });

    it('offers only the sections it is handed', async () => {
      await mount(populated, inSettings(settingsSections(false)));

      expect(sectionLinks().map((link) => link.textContent)).toEqual([
        'Connections',
        'Preferences',
      ]);
    });

    it('keeps the foot nav, with Settings current', async () => {
      await mount(populated, inSettings(settingsSections(true)));

      const current = column.querySelectorAll('nav[aria-label="Destinations"] a[aria-current]');
      expect([...current].map((link) => link.textContent)).toEqual(['Settings']);
    });
  });
});
