// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { notificationList, type NotificationList } from '../sessions/notification-model.js';
import { listSessions } from '../sessions/session-list-model.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { AttentionBell, PANEL_WIDTH } from './attention-bell.js';
import type { ShellForm } from './shell-form.js';

/**
 * The bell and what it opens: the chrome's standing answer to "is anything
 * waiting on me", and the panel that answers it in full.
 *
 * Both chromes hand the shell's one bell node to their actions slot, so what
 * is pinned here is what it draws for a fleet and which container it opens in
 * -- not where it sits, which is `app-shell.test.tsx` for the wide form and
 * `mobile-chrome.test.tsx` for the phone.
 *
 * The rows themselves are `notification-list.test.tsx`. What is asserted here
 * is that both containers hold that one list, so a fact proved there is a fact
 * in a popover and in a sheet.
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
 * The popover measures its target and the sheet traps focus in its own box;
 * jsdom has no layout and no observer. A stub that reports nothing is enough --
 * nothing here asserts on a measurement.
 */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** Lets a promise chain inside the floating placement settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One animation frame. Both containers place themselves with a floating-ui
 * measurement and open through a transition, so what a click asks for reaches
 * the document a frame later rather than in the same flush.
 */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
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
const empty = stateFrom(hubFrames.machineState);

/** The moment the fixtures were reported, so the ages are the real elapsed ones. */
const NOW = 1_756_000_000_000;

/** Two sessions asking, which is what the populated fixture holds. */
const twoWaiting = notificationList(listSessions(populated), NOW);
/** One, by taking the fleet's other store away. */
const oneWaiting = notificationList(
  listSessions(populated).filter((item) => item.storeId === 'store-universe'),
  NOW,
);
const nothingWaiting = notificationList(listSessions(empty), NOW);

describe('the attention bell', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

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

  function draw(list: NotificationList, form: ShellForm = 'wide'): void {
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <AttentionBell list={list} form={form} scheme="dark" />
      </MantineProvider>
    );
    act(() => {
      // Re-rendered into the same root rather than mounted again, so a test
      // can move the count the way the fleet does and the region that has to
      // survive the move actually survives it.
      root ??= createRoot(container);
      root.render(element);
    });
  }

  function bell(): HTMLButtonElement {
    const control = container.querySelector<HTMLButtonElement>('button[data-attention-bell]');
    if (control === null) throw new Error('nothing drew a bell');
    return control;
  }

  /** Lets a container that has just been asked for reach the document. */
  async function flush(): Promise<void> {
    await act(settle);
    await act(frame);
    await act(settle);
  }

  /** Presses it the way a person does, and waits for what that opens. */
  async function press(): Promise<void> {
    await act(() => {
      bell().click();
    });
    await flush();
  }

  /**
   * The panel, wherever it landed. Both containers portal out of the shell, so
   * the document is the haystack, and both are a dialog: that is the one thing
   * a popover and a sheet have to agree on.
   */
  function panel(): HTMLElement {
    const found = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (found === null) throw new Error('nothing opened');
    return found;
  }

  function openedPanel(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[role="dialog"]');
  }

  function rows(): readonly HTMLAnchorElement[] {
    return [...panel().querySelectorAll<HTMLAnchorElement>('a[data-notification-row]')];
  }

  /** The mark on the bell, which exists only when something is asking. */
  function mark(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-needs-you]');
  }

  function announcement(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-attention-bell] + [role="status"]');
  }

  it('is a control and not an address, and says whether it is open', async () => {
    // It was an anchor to the session list while there was no panel to open.
    // There is one now, so the tap belongs to the bell: an anchor that opened
    // a panel would navigate on a middle click and on a keyboard Enter alike.
    draw(twoWaiting);
    expect(bell().getAttribute('href')).toBeNull();
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(openedPanel()).toBeNull();

    await press();

    expect(bell().getAttribute('aria-expanded')).toBe('true');
  });

  it('says the count in its name, in the words every surface uses', () => {
    draw(twoWaiting);
    expect(bell().getAttribute('aria-label')).toBe('2 sessions need you');

    draw(oneWaiting);
    expect(bell().getAttribute('aria-label')).toBe('1 session needs you');
  });

  it('is still named when nothing is waiting, because it is still drawn', () => {
    draw(nothingWaiting);

    expect(bell().getAttribute('aria-label')).toBe('Nothing needs you');
  });

  it('marks itself when something is asking, and draws no number', () => {
    draw(twoWaiting);

    // The mockup's mark is a bare dot: the number is the tab title's job and
    // the panel's, and a two-digit badge on a 32px control is a smudge.
    expect(mark()).not.toBeNull();
    expect(bell().textContent).toBe('');
  });

  it('draws no mark at all when nothing is waiting', () => {
    draw(nothingWaiting);

    expect(mark()).toBeNull();
  });

  it('reads the count out when it changes, from a region that was already there', () => {
    // Mounted at every count and empty at zero: a live region inserted along
    // with its first number is a region nothing was watching, so the first
    // session to start asking -- the announcement worth making -- is the one
    // that would be missed.
    draw(nothingWaiting);
    expect(announcement()?.textContent).toBe('');

    draw(twoWaiting);
    expect(announcement()?.textContent).toBe('2 sessions need you');
  });

  it('opens the list as the mockup’s 340px card at desk widths', async () => {
    draw(twoWaiting, 'wide');

    await press();

    expect(panel().style.width).toBe(`${PANEL_WIDTH}px`);
    expect(rows()).toHaveLength(2);
  });

  it('opens the same list as a sheet on a phone, headed with the count', async () => {
    draw(twoWaiting, 'phone');

    await press();

    // Mockup 6c: the sheet leads with the section the bell was marked for, and
    // the number on that heading is what the mark stands for.
    expect(panel().querySelector('h3')?.textContent).toBe('NEEDS YOU · 2');
    expect(rows()).toHaveLength(2);
  });

  it('heads both containers the same way, because there is one panel', async () => {
    draw(twoWaiting, 'wide');
    await press();
    const wide = panel().querySelector('h2')?.textContent;

    // The same bell, still open, in the other form of the shell.
    draw(twoWaiting, 'phone');
    await flush();
    const phone = panel().querySelector('h2')?.textContent;

    expect(wide).toBe('Notifications');
    expect(phone).toBe(wide);
  });

  it('gives a fingertip a 44px target on a phone and a 32px one on a desk', () => {
    // The floor `start-session-button.tsx` states, and the box mockup 7e draws
    // around the same 18px glyph.
    draw(twoWaiting, 'phone');
    expect(bell().style.width).toBe('44px');
    expect(bell().style.height).toBe('44px');

    draw(twoWaiting, 'wide');
    expect(bell().style.width).toBe('32px');
  });

  it('still opens when nothing is waiting, and says so in one line', async () => {
    // A control that answers nothing when it is quiet is one nobody learns to
    // trust: the answer "nothing" is an answer.
    draw(nothingWaiting, 'wide');

    await press();

    expect(rows()).toEqual([]);
    expect(panel().textContent).toContain('Nothing is waiting on you.');
  });
});
