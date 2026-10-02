// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { CatalogueFilters } from './catalogue-filters.js';
import {
  DEFAULT_SHAPE,
  NO_PAGES,
  pageAdopted,
  withFilter,
  withoutNarrowings,
  withSort,
  withView,
  type CataloguePages,
  type CatalogueShape,
} from './catalogue-model.js';
import { fakeCatalogueStore, type FakeCatalogueStore } from './fake-catalogue-store.js';

/**
 * The Projects tab's filter row: the box it is handed, and beside it the
 * popover holding the catalogue's sort and narrowings.
 *
 * What is asserted is what only a render can answer: which sections the shape
 * and the fleet earn, what the badge and the line say, and what pressing a
 * control hands the store. What a reshape then asks the hub is
 * `catalogue-store`'s subject, and the counting rule is the model's; this
 * reads both back off the row to catch a badge counting one thing while the
 * line counts another.
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
 * Mantine's popover measures its target's box; jsdom has no layout and no
 * observer. A stub that reports nothing is enough -- nothing here asserts on a
 * measurement.
 */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** Lets a promise the click started settle. */
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

/** Two machines, two providers, four statuses. */
const populated = stateFrom(hubFrames.machineStatePopulated);

/** The captured tree page, whose `total` is 6. */
const TREE_PAGE = heldPages(hubFrames.catalogueTreePage);

/** A machine, a provider, a status and a reversed sort: everything at once. */
const NARROWED: CatalogueShape = withFilter(
  withFilter(
    withFilter(withSort(DEFAULT_SHAPE, 'updatedAt', 'desc'), {
      field: 'server',
      value: 'registration-mbp-robert',
    }),
    { field: 'provider', value: 'codex' },
  ),
  { field: 'status', value: 'idle' },
);

describe('the catalogue filter row', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let fake: FakeCatalogueStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
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

  /**
   * `env="test"` is Mantine's own answer to jsdom: the popover skips hiding a
   * dropdown it cannot measure, the transition renders on `mounted`, and the
   * portal renders in place. `sidebar-filter.test.tsx` has the longer note.
   */
  function draw(
    state: MachineState | null = populated,
    shape: CatalogueShape = DEFAULT_SHAPE,
    pages: CataloguePages = TREE_PAGE,
  ): void {
    fake = fakeCatalogueStore(pages, shape);
    act(() => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
          env="test"
        >
          <CatalogueFilters
            catalogue={fake}
            state={state}
            scheme="dark"
            box={<input aria-label="Filter tree" />}
          />
        </MantineProvider>,
      );
    });
  }

  async function click(target: Element): Promise<void> {
    await act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  function trigger(): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>('button[aria-label="Filters"]');
    if (found === null) throw new Error('the row drew no popover trigger');
    return found;
  }

  /** Opens the popover the way a person does: focused, then pressed. */
  async function open(): Promise<void> {
    trigger().focus();
    await click(trigger());
    await act(settle);
  }

  async function press(target: Element, key: string): Promise<void> {
    await act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  }

  function dropdown(): HTMLElement {
    const found = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (found === null) throw new Error('the popover drew no dropdown');
    return found;
  }

  /** Every section the popover drew, by the name it gave each one, in order. */
  function sections(): (string | null)[] {
    return [...document.body.querySelectorAll('[role="group"]')].map((group) =>
      group.getAttribute('aria-label'),
    );
  }

  /** The `N filters` line, or `null` when the row drew none. */
  function summary(): string | null {
    const found = [...container.querySelectorAll('span')].find((span) =>
      /^\d+ filters?/.test(span.textContent ?? ''),
    );
    return found?.textContent ?? null;
  }

  /** Waits for something that finishes on a timer, a macrotask at a time. */
  async function until(done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50 && !done(); attempt += 1) {
      await act(settle);
    }
  }

  function buttonSaying(text: string): HTMLButtonElement {
    const found = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === text,
    );
    if (found === undefined) throw new Error(`nothing says ${text}`);
    return found;
  }

  /** Picks an option out of one of the popover's selects. */
  async function choose(label: string, option: string): Promise<void> {
    const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (input === null) throw new Error(`the popover drew no ${label} chooser`);
    await act(() => {
      input.click();
    });
    await until(() => document.body.querySelector('[role="option"]') !== null);
    const found = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent === option,
    );
    if (found === undefined) throw new Error(`${label} offers no ${option}`);
    await act(() => {
      found.click();
    });
  }

  it('names the trigger in words and draws the box it was handed beside it', () => {
    draw();

    expect(trigger().getAttribute('aria-label')).toBe('Filters');
    expect(container.querySelectorAll('input[aria-label="Filter tree"]')).toHaveLength(1);
    expect(trigger().textContent).toBe('');
    expect(summary()).toBeNull();
  });

  it('puts the focus inside the dropdown, so its controls can be reached', async () => {
    draw();
    await open();

    expect(dropdown().contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and gives the focus back to the trigger', async () => {
    draw();
    await open();
    const focused = document.activeElement;
    if (focused === null) throw new Error('nothing holds the focus');

    await press(focused, 'Escape');

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await until(() => document.activeElement === trigger());
    expect(document.activeElement).toBe(trigger());
  });

  it('offers the sort, and the narrowings the fleet offers, in the tree view', async () => {
    draw();
    await open();

    // No grouping: in a tree the containment is the grouping.
    expect(sections()).toEqual(['Sort by', 'Provider', 'Status']);
  });

  it('offers the sort alone before the hub has answered with a fleet', async () => {
    draw(null);
    await open();

    expect(sections()).toEqual(['Sort by']);
  });

  it('offers the grouping in the list view', async () => {
    draw(populated, withView(DEFAULT_SHAPE, 'list'));
    await open();

    expect(sections()).toEqual(['Sort by', 'Group by', 'Provider', 'Status']);
  });

  it('keeps a held narrowing reachable after the fleet stops offering it', async () => {
    // With no fleet the options are empty, but the shape still narrows by a
    // provider and the badge counts it: the section stays so that what is
    // counted is something somebody can see and clear.
    draw(null, withFilter(DEFAULT_SHAPE, { field: 'provider', value: 'codex' }));
    expect(trigger().textContent).toBe('1');
    await open();

    expect(sections()).toEqual(['Sort by', 'Provider']);
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Provider"]');
    expect(input?.value).toBe('codex');
  });

  it('flips the direction of the sort', async () => {
    draw();
    await open();

    const direction = document.body.querySelector('button[aria-label^="Sorted "]');
    if (direction === null) throw new Error('the popover offers no direction');
    expect(direction.textContent).toBe('A first');

    await click(direction);

    expect(fake.reshapes.map((shape) => shape.sort.direction)).toEqual(['desc']);
  });

  it('narrows by the provider picked, and counts it on the badge and the line', async () => {
    draw();
    await open();

    await choose('Provider', 'codex');

    expect(fake.reshapes).toEqual([
      withFilter(DEFAULT_SHAPE, { field: 'provider', value: 'codex' }),
    ]);
    expect(trigger().textContent).toBe('1');
    // No hidden count: the hub's total is already the narrowed answer, so
    // there is no second number for the line to state.
    expect(summary()).toBe('1 filter');
  });

  it('clears the provider and the status from the footer and leaves the rest', async () => {
    draw(populated, NARROWED);
    expect(trigger().textContent).toBe('2');
    await open();

    await click(buttonSaying('Clear all'));

    expect(fake.reshapes).toEqual([withoutNarrowings(NARROWED)]);
    expect(fake.reshapes[0]?.filter.server).toBe('registration-mbp-robert');
    expect(fake.reshapes[0]?.sort).toEqual({ key: 'updatedAt', direction: 'desc' });
  });

  it('clears the same narrowings from the line under the row', async () => {
    draw(populated, NARROWED);
    expect(summary()).toBe('2 filters');

    await click(buttonSaying('Clear'));

    expect(fake.reshapes).toEqual([withoutNarrowings(NARROWED)]);
    expect(summary()).toBeNull();
  });

  it('says how many the answer holds on the dismissal, and closes without asking', async () => {
    draw();
    await open();

    await click(buttonSaying('Show 6'));

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(fake.reshapes).toEqual([]);
  });

  it('says no number on the dismissal before the hub has answered', async () => {
    draw(populated, DEFAULT_SHAPE, NO_PAGES);
    await open();

    await click(buttonSaying('Show'));

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(fake.reshapes).toEqual([]);
  });
});
