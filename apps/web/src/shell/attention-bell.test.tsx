// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  type ClientFrame,
  type MachineState,
} from '@agentplex/protocol';
import { notificationList, type NotificationList } from '../sessions/notification-model.js';
import { listSessions } from '../sessions/session-list-model.js';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { sessionHash } from '../terminal/session-route.js';
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
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  /** A standing interest, so the store dials the way a mounted shell makes it. */
  let interest: (() => void) | null = null;

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
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    interest?.();
    interest = null;
    container.remove();
    // A row is a real anchor and jsdom follows it, so the address moved.
    window.location.hash = '';
  });

  function draw(list: NotificationList, form: ShellForm = 'wide', which: HubStore = store): void {
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <AttentionBell list={list} store={which} form={form} scheme="dark" />
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

  /**
   * Waits for a container that has been dismissed to actually leave the
   * document. Both of them fade out over a duration rather than unmounting in
   * the flush that asked, so this polls up to a second instead of sleeping for
   * whichever of the two durations is longer.
   */
  async function untilClosed(): Promise<void> {
    for (let attempt = 0; attempt < 40 && openedPanel() !== null; attempt += 1) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    }
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

  /** The header's bulk control, wherever the open container put it. */
  function markAllRead(): HTMLButtonElement {
    const found = panel().querySelector<HTMLButtonElement>('button[data-mark-all-read]');
    if (found === null) throw new Error('the panel offered no bulk control');
    return found;
  }

  /** The header's status line, which is there whether or not it has anything to say. */
  function refusalRegion(): HTMLElement | null {
    return panel().querySelector<HTMLElement>('[data-mark-all-read-refusal]');
  }

  /** What it said about an attempt that did not go through, if anything. */
  function refusal(): string {
    return refusalRegion()?.textContent ?? '';
  }

  /**
   * Opens the store's connection, so what the control sends goes out as frames
   * rather than into the queue a down socket fills.
   */
  async function connect(): Promise<FakeSocket> {
    interest = store.subscribe(() => {});
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
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

  it('closes the popover when a row is followed, and still goes where it says', async () => {
    const asking = twoWaiting.needsYou[0];
    if (asking === undefined) throw new Error('the fixture has nothing asking');
    draw(twoWaiting, 'wide');
    await press();
    const row = rows()[0];
    if (row === undefined) throw new Error('the panel drew no rows');

    await act(() => {
      row.click();
    });
    await untilClosed();

    // The address is the hash, so the page does not remount and nothing else
    // would ever take this panel down: a session opened under a dropdown that
    // is still covering the content is the reading of it nobody asked for.
    expect(openedPanel()).toBeNull();
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    // And it is still a link to the same session, through the helper the card
    // uses: closing the panel is something the row does on the way, not
    // instead of going.
    expect(row.getAttribute('href')).toBe(sessionHash(asking.item.ref));
  });

  it('closes the sheet the same way, where it is the whole screen', async () => {
    // Worse on a phone than on a desk: the sheet holds the focus trap and the
    // scroll lock, so a row that left it standing would hand somebody a
    // terminal they can neither reach nor scroll.
    draw(twoWaiting, 'phone');
    await press();
    const row = rows()[0];
    if (row === undefined) throw new Error('the sheet drew no rows');

    await act(() => {
      row.click();
    });
    await untilClosed();

    expect(openedPanel()).toBeNull();
  });

  it('marks the listed sessions read: one acknowledgement each, and no mute', async () => {
    const socket = await connect();
    draw(twoWaiting, 'wide');
    await press();

    await act(() => {
      markAllRead().click();
    });

    // Exactly the sessions the section listed, in the order it listed them.
    // A bulk control that reached past what it drew would be acknowledging
    // prompts nobody was shown.
    expect(
      sentFrames(socket)
        .filter((frame) => frame.type === 'session-acknowledge')
        .map((frame) => `${frame.storeId}/${frame.sessionId}`),
    ).toEqual(
      twoWaiting.needsYou.map((row) => `${row.item.ref.storeId}/${row.item.ref.sessionId}`),
    );
    // Muting is a per-session decision, and marking read is not a way to make
    // one: a muted session is not in this list at all.
    expect(sentFrames(socket).filter((frame) => frame.type === 'session-mute')).toEqual([]);
    expect(refusal()).toBe('');
  });

  it('leaves a muted session’s mute alone, because it never listed it', async () => {
    const socket = await connect();
    // The attended fixture is the same fleet with a mute standing on it.
    const attended = notificationList(listSessions(stateFrom(hubFrames.machineStateAttended)), NOW);
    draw(attended, 'wide');
    await press();

    await act(() => {
      markAllRead().click();
    });

    const muted = listSessions(stateFrom(hubFrames.machineStateAttended)).filter(
      (item) => item.muted,
    );
    expect(muted.length).toBeGreaterThan(0);
    const reached = sentFrames(socket).map((frame) =>
      frame.type === 'session-acknowledge' ? `${frame.storeId}/${frame.sessionId}` : '',
    );
    for (const item of muted) {
      expect(reached).not.toContain(`${item.ref.storeId}/${item.ref.sessionId}`);
    }
    expect(sentFrames(socket).filter((frame) => frame.type === 'session-mute')).toEqual([]);
  });

  it('has the header’s status line open before there is anything to put in it', async () => {
    // The same argument the bell's own live region is mounted on, three lines
    // above it in the file: a region inserted along with its first sentence is
    // a region nothing was watching, so the one announcement worth making --
    // that the button did not do what it looks like it did -- is the one that
    // would be missed.
    draw(twoWaiting, 'wide');

    await press();

    expect(refusalRegion()).not.toBeNull();
    expect(refusal()).toBe('');
  });

  it('says so in words when the store refuses, rather than assuming it went', async () => {
    // A queue of one, and nothing dialled: the first acknowledgement is taken
    // and the second overflows. The refusal is the whole point -- a control
    // that reported success it had not been given would leave a person sure
    // they had cleared a list that is still asking.
    const refusing = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
      maxQueuedCommands: 1,
    });
    draw(twoWaiting, 'wide', refusing);
    await press();

    await act(() => {
      markAllRead().click();
    });

    // The header's own count of what did not go, and the store's words for
    // why, passed through rather than restated.
    expect(refusal()).toContain('1 session was not marked read');
    expect(refusal()).toContain('this one was not accepted');
  });

  it('offers nothing to mark when nothing is asking', async () => {
    draw(nothingWaiting, 'wide');

    await press();

    // Drawn and dead rather than gone: the header keeps its shape, the way the
    // bell itself stays on screen at a count of zero.
    expect(markAllRead().disabled).toBe(true);
  });

  it('carries the same control into the sheet, because there is one header', async () => {
    draw(twoWaiting, 'phone');

    await press();

    expect(markAllRead().disabled).toBe(false);
  });
});
