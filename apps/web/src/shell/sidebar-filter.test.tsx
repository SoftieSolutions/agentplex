// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import {
  createSessionFiltersStore,
  type SessionFiltersStore,
} from '../sessions/session-filters-store.js';
import { NO_FILTERS } from '../sessions/session-list-model.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { SidebarFilter } from './sidebar-filter.js';

/**
 * The filter row and the popover behind it, drawn over captured fleets.
 *
 * What is asserted here is what only a render can answer: which sections the
 * snapshot earns, what the badge and the line say, and what pressing a control
 * writes. The numbers themselves are `session-list-model`'s and are pinned by
 * its own suite -- this one reads them back off the row to catch a badge
 * counting one thing while the line counts another.
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

/**
 * A box for every element and a viewport to put it in.
 *
 * jsdom lays nothing out: every rect is zero-sized and the document element
 * reports a 0x0 viewport, so floating-ui's hide middleware finds the popover's
 * target clipped out of view and Mantine draws the dropdown `display: none`.
 * A focus trap cannot see into that, and a suite that skipped this would call
 * the trap broken over the absence of layout rather than over the code. The
 * numbers are arbitrary -- nothing here asserts on a measurement, only on
 * there being one.
 */
function installLayout(): void {
  for (const [name, size] of [
    ['clientWidth', 1024],
    ['clientHeight', 768],
  ] as const) {
    Object.defineProperty(document.documentElement, name, { value: size, configurable: true });
  }
  Element.prototype.getBoundingClientRect = function box(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: 120,
      height: 30,
      top: 0,
      left: 0,
      right: 120,
      bottom: 30,
      toJSON: () => ({}),
    };
  };
}

/** Lets a promise the click started settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One animation frame. Mantine places a popover with a floating-ui measurement
 * and opens it through a transition, so the dropdown reaches the document a
 * frame after the click that asked for it rather than in the same flush.
 */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
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

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

/** Two machines, two stores, two providers, one project, four statuses. */
const populated = stateFrom(hubFrames.machineStatePopulated);
/** One machine, one store, one provider, two statuses. */
const single = stateFrom(hubFrames.machineStateSingle);

/** The moment every window on these renders is measured against. */
const NOW = 1_756_000_000_000;

describe('the sidebar filter row', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let filters: SessionFiltersStore;
  let typed: string[];

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    installLayout();
    container = document.createElement('div');
    document.body.append(container);
    filters = createSessionFiltersStore();
    typed = [];
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function draw(state: MachineState = populated, text = '', popover = true): void {
    act(() => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <SidebarFilter
            state={state}
            filters={filters}
            machine={null}
            label="Filter sessions"
            text={text}
            onText={(value) => typed.push(value)}
            popover={popover}
            scheme="dark"
            now={() => NOW}
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

  /**
   * Opens the popover the way a person does, and waits for it to land.
   *
   * The trigger is focused before it is pressed because that is what pressing
   * it means for a keyboard: `dispatchEvent` moves no focus by itself, and
   * without the focus on the button there is nothing for the dropdown to hand
   * back when it closes.
   */
  async function open(): Promise<void> {
    trigger().focus();
    await click(trigger());
    await act(settle);
    await act(frame);
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

  function controlsIn(section: string): HTMLButtonElement[] {
    return [
      ...document.body.querySelectorAll<HTMLButtonElement>(
        `[role="group"][aria-label="${section}"] button`,
      ),
    ];
  }

  function named(section: string, label: string): HTMLButtonElement {
    const found = controlsIn(section).find((button) => button.textContent === label);
    if (found === undefined) throw new Error(`${section} offers no ${label}`);
    return found;
  }

  /** The `N filters - M hidden` line, or `null` when the row drew none. */
  function summary(): string | null {
    const found = [...container.querySelectorAll('span')].find((span) =>
      (span.textContent ?? '').endsWith(' hidden'),
    );
    return found?.textContent ?? null;
  }

  /** Lets the document catch up with something that finishes on a timer. */
  async function until(done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50 && !done(); attempt += 1) {
      await act(settle);
      await act(frame);
    }
  }

  function buttonSaying(text: string): HTMLButtonElement {
    const found = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === text,
    );
    if (found === undefined) throw new Error(`nothing says ${text}`);
    return found;
  }

  it('draws no badge and no line while nothing is narrowed', () => {
    draw();

    expect(trigger().textContent).toBe('');
    expect(summary()).toBeNull();
  });

  it('counts the narrowings on the badge and says what they hid', () => {
    // A machine and a status: two controls, whatever each narrowed to. They
    // leave one session of the six standing, and the line is what a person
    // reads to know the other five are a choice and not an empty fleet.
    filters.set({ machine: 'registration-mbp-robert', chip: 'needs-you' });
    draw();

    expect(trigger().textContent).toBe('2');
    expect(summary()).toBe('2 filters · 5 hidden');
  });

  it('leaves the search out of the count, since the box says what it is doing', () => {
    filters.set({ search: 'db' });
    draw();

    expect(trigger().textContent).toBe('');
    expect(summary()).toBeNull();
  });

  it('clears every narrowing and leaves the machine selector standing', async () => {
    filters.set({
      chip: 'needs-you',
      machine: 'registration-mbp-robert',
      updatedWithin: '1h',
      search: 'db',
      server: 'registration-mbp-robert',
    });
    draw();

    await click(buttonSaying('Clear'));

    expect(filters.getSnapshot()).toEqual({ ...NO_FILTERS, server: 'registration-mbp-robert' });
    expect(summary()).toBeNull();
  });

  it('draws a section only where the snapshot offers a choice', async () => {
    draw();
    await open();

    // No Project: the captured fleet puts one store's sessions in `universe`
    // and the other's in no project, which is one option and not a choice.
    expect(sections()).toEqual(['Status', 'Machine', 'Store', 'Provider', 'Last updated']);
  });

  it('draws neither machine, store nor provider over a one-machine fleet', async () => {
    draw(single);
    await open();

    expect(sections()).toEqual(['Status', 'Last updated']);
  });

  it('offers the states the fleet is in, and neither Blocked nor Done', async () => {
    draw();
    await open();

    // Nothing reports a blocked agent and nothing retains a finished session,
    // so both pills the mockup draws would narrow to nothing at every moment.
    expect(controlsIn('Status').map((pill) => pill.textContent)).toEqual([
      'Needs you',
      'Running',
      'Idle',
      'Unknown',
    ]);
  });

  it('writes the pill it was pressed into the narrowings, and takes it off again', async () => {
    draw();
    await open();

    await click(named('Status', 'Running'));
    expect(filters.getSnapshot().chip).toBe('running');

    await click(named('Status', 'Running'));
    expect(filters.getSnapshot().chip).toBeNull();
  });

  it('writes the window it was pressed, and Any takes it off', async () => {
    draw();
    await open();

    await click(named('Last updated', '24h'));
    expect(filters.getSnapshot().updatedWithin).toBe('24h');

    await click(named('Last updated', 'Any'));
    expect(filters.getSnapshot().updatedWithin).toBeNull();
  });

  it('closes on the footer button without narrowing anything further', async () => {
    draw();
    await open();
    const before = filters.getSnapshot();

    // The mockup's `Show 3`: the narrowings took effect as they were chosen,
    // so this is the dismissal saying what it is leaving behind.
    await click(buttonSaying('Show 6'));

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    // The dropdown leaves through a transition, so it is waited for rather
    // than assumed gone in the flush that closed it.
    await until(() => sections().length === 0);
    expect(sections()).toEqual([]);
    expect(filters.getSnapshot()).toBe(before);
  });

  it('puts the focus inside the dropdown, so its controls can be reached', async () => {
    draw();
    await open();

    // The dropdown is portalled to the end of the body, so a focus left on the
    // trigger is a Tab out of the popover and past every control in it. These
    // five narrowings have no other surface at this width.
    expect(dropdown().contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and gives the focus back to the trigger', async () => {
    draw();
    await open();
    const focused = document.activeElement;
    if (focused === null) throw new Error('nothing holds the focus');

    await press(focused, 'Escape');

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    // Mantine hands the focus back on a timer, so it is waited for rather than
    // asserted in the flush that closed the dropdown.
    await until(() => document.activeElement === trigger());
    expect(document.activeElement).toBe(trigger());
  });

  it('names the trigger in words and says whether the popover is open', async () => {
    draw();

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await open();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('draws the box alone where the popover was not asked for', () => {
    // Everything the popover holds narrows sessions. Over a reading that is
    // not the sessions there is nothing for it to narrow that a person can
    // see, so the trigger, the badge and the line all go with it and the box
    // -- which narrows whatever is under it -- stays.
    filters.set({ machine: 'registration-mbp-robert', chip: 'needs-you' });
    draw(populated, '', false);

    expect(container.querySelector('button[aria-label="Filters"]')).toBeNull();
    expect(summary()).toBeNull();
    expect(container.querySelector('input[aria-label="Filter sessions"]')).not.toBeNull();
  });

  it('carries the name it was given on the box, and hands the typing back', () => {
    draw(populated, 'mig');

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter sessions"]');
    if (input === null) throw new Error('the row drew no box');
    expect(input.value).toBe('mig');

    act(() => {
      typeInto(input, 'migr');
    });
    expect(typed).toEqual(['migr']);
  });
});
