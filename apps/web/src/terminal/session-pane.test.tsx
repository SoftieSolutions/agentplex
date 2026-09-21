// @vitest-environment jsdom
import {
  activitySchema,
  approvalIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  TERMINAL_INPUT_MAX_CHARS,
  type ClientFrame,
} from '@agentplex/protocol';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { NO_CLIPBOARD_HERE, type Clipboard } from './clipboard.js';
import { createFakeClipboard, createRefusingClipboard } from './fake-clipboard.js';
import { createFakeEmulatorFactory, type FakeEmulator } from './fake-emulator.js';
import { FindBar } from './find-bar.js';
import { SessionPane } from './session-pane.js';

/**
 * The pane as the user meets it: the find bar opened by the chord, and the
 * terminal driven by frames a real hub actually sent.
 *
 * The fake emulator is the point of the first half. What the bar owes anybody
 * is that the question it asks is the question that was typed and the answer
 * it draws is the answer it was given -- whether the answer is right is the
 * emulator's business, and `xterm-emulator.test.ts` holds it to that against
 * real captured bytes. So this file asserts on what the pane asked the seam
 * for and on what it rendered, and never on a buffer.
 *
 * The captured frames are the point of the second half. The sentences a pane
 * shows about how much of a session it is not showing are exactly the ones a
 * hand-written fixture would get flatteringly right, so the numbers behind
 * them come off a hub that really did drop something.
 *
 * The stop in the header is the third, and it is captured for the same reason:
 * whether the control is offered is a published holder's answer rather than a
 * status this pane reads, so the state it is drawn off is one a real fleet
 * sent.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * The session the captured hub frames were captured watching.
 *
 * Not an arbitrary pair: the fixtures in `hub-frames.fixture.ts` are what a
 * real hub said about this session, and a pane driven by them has to be a
 * pane watching it. The subscribe a mounted pane sends is the second frame on
 * its socket, which is the id those replies name.
 */
const SESSION = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-build' });

/**
 * Mantine consults the media query for its colour scheme, xterm for its own
 * reasons, and the pane header consults `(pointer: coarse)` to decide whether
 * to draw a paste control. jsdom implements none of them.
 *
 * Local to this file and driven by a predicate rather than a global fixture:
 * the one thing worth asserting about the control is that it appears for a
 * finger and not for a mouse, and a stub that answered every query the same
 * way could only ever show one of those.
 */
function installMatchMedia(matches: (query: string) => boolean = () => false): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/** A device whose pointer is a finger, and nothing else about it. */
const COARSE_POINTER = (query: string): boolean => query === '(pointer: coarse)';

/**
 * A store on a socket the test plays the hub on.
 *
 * The pane declares its interest in a session on mount; most of this file
 * lets that go somewhere harmless, and the tests at the bottom drive the
 * other end of it with the captured frames.
 */
interface StoreHarness {
  readonly store: HubStore;
  /** The socket the store dialled, once `settle` has let the ticket resolve. */
  socket(): FakeSocket;
}

function buildStore(): StoreHarness {
  const sockets = createFakeSocketFactory();
  const store = createHubStore({
    fetchTicket: () => Promise.resolve('ticket-1'),
    createSocket: (ticket) => sockets.create(ticket),
    timers: createFakeTimers(),
    frameIds: createFrameIdCounter(),
  });
  return {
    store,
    socket(): FakeSocket {
      const dialled = sockets.sockets[0];
      if (dialled === undefined) throw new Error('the store dialled nothing');
      return dialled;
    },
  };
}

/** What the pane put on the wire, read back through the hub's own parser. */
function sentFrames(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the pane sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

/**
 * jsdom has no `ResizeObserver`, and the pane watches its own box with one.
 *
 * A stub that observes nothing and fires nothing: what the watch does with an
 * observation is `resize.test.ts`'s question, asked against a seam, and what
 * the browser's observer does is the browser's. This is here so that mounting
 * a pane under jsdom is not a `ReferenceError`.
 */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

let container: HTMLDivElement;
let root: Root | null = null;
let emulators: ReturnType<typeof createFakeEmulatorFactory>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  installMatchMedia();
  installResizeObserver();
  container = document.createElement('div');
  document.body.append(container);
  emulators = createFakeEmulatorFactory();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
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

async function mount(element: JSX.Element): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    // No StrictMode: its simulated remount would build a second emulator
    // and the count of what the bar asked the first one is the assertion.
    root.render(withProvider(element));
  });
  await act(settle);
}

/**
 * The same root rendering again, which is what a prop changing under a
 * mounted pane looks like. A second `createRoot` would be a new tree with
 * no state to keep, and a test of what survives a change would be asserting
 * about a component that was never there.
 */
async function rerender(element: JSX.Element): Promise<void> {
  const live = root;
  if (live === null) throw new Error('nothing is mounted to render again');
  await act(async () => {
    live.render(withProvider(element));
  });
  await act(settle);
}

async function mountPane(): Promise<void> {
  await mount(
    <SessionPane sessionRef={SESSION} store={buildStore().store} emulators={emulators} />,
  );
}

function emulator(): FakeEmulator {
  const built = emulators.created[0];
  if (built === undefined) throw new Error('the pane built no emulator');
  return built;
}

function findInput(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[aria-label="find in this pane"]');
}

function control(label: string): HTMLElement {
  const button = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (button === null) throw new Error(`no control labelled ${label}`);
  return button;
}

/**
 * The find bar's count. The last live region in the pane and not the first:
 * the header's attachment indicator is one too, and it is above the bar in
 * document order.
 */
function summary(): string {
  // The last live region the terminal column holds, which is the find bar's
  // count. The context panel beside it has one of its own -- the APPROVALS
  // block mounts a status region before it has words -- and a query over the
  // whole pane would have started reading the panel's the moment that block
  // landed.
  const panel = container.querySelector('[aria-label="session context"]');
  return (
    [...container.querySelectorAll('[role="status"]')]
      .filter((region) => panel === null || !panel.contains(region))
      .at(-1)?.textContent ?? ''
  );
}

/** The word in the header's attachment chip, which is the first live region. */
function attachment(): string {
  return container.querySelector('[role="status"]')?.textContent ?? '';
}

/**
 * The chord, from inside the pane: the registry is consulted by a
 * capture-phase handler on the pane's root, so the event has to be
 * dispatched on something the pane contains. The steer input is a fair
 * stand-in for wherever the user's focus happens to be.
 */
function dispatchChord(key: string): void {
  const somewhereInThePane = container.querySelector('[aria-label="steer the agent"]');
  if (somewhereInThePane === null) throw new Error('the pane rendered no steer input');
  somewhereInThePane.dispatchEvent(
    new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true, bubbles: true }),
  );
}

async function pressChord(key: string): Promise<void> {
  await act(() => {
    dispatchChord(key);
  });
}

/**
 * Something that starts a clipboard promise, and the settling of it, inside
 * one `act`.
 *
 * Both halves together, and not a press followed by a flush: what a chord
 * begins here finishes a microtask later, in a `.then` React knows nothing
 * about, and an update that lands between two acts is the one React warns
 * about having rendered outside a test's knowledge.
 */
async function settleAfter(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await settle();
  });
}

async function press(target: Element, key: string): Promise<void> {
  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('the find bar in a session pane', () => {
  it('is not there until the chord asks for it', async () => {
    await mountPane();

    expect(findInput()).toBeNull();
  });

  it('opens on Ctrl+Shift+F with the caret already in it', async () => {
    await mountPane();

    await pressChord('F');

    const input = findInput();
    expect(input).not.toBeNull();
    // The ref callback focused it; nobody has to click the thing they just
    // asked for by name.
    expect(document.activeElement).toBe(input);
  });

  it('searches as the user types, incrementally and without regard to case', async () => {
    await mountPane();
    await pressChord('F');
    const input = findInput();
    if (input === null) throw new Error('the chord opened no find bar');

    await act(() => {
      typeInto(input, 'refresh');
    });

    expect(emulator().search.searches).toEqual([
      { direction: 'next', query: 'refresh', options: { caseSensitive: false, incremental: true } },
    ]);
  });

  it('shows the count the emulator reported, in the place the user is looking', async () => {
    await mountPane();
    await pressChord('F');
    const input = findInput();
    if (input === null) throw new Error('the chord opened no find bar');
    await act(() => {
      typeInto(input, 'refresh');
    });

    await act(() => {
      emulator().search.report({ index: 2, count: 12 });
    });

    expect(summary()).toBe('3 of 12');

    await act(() => {
      emulator().search.report({ index: -1, count: 0 });
    });

    expect(summary()).toBe('no matches');
  });

  it('steps with Enter and with the buttons, and stops being incremental once it does', async () => {
    await mountPane();
    await pressChord('F');
    const input = findInput();
    if (input === null) throw new Error('the chord opened no find bar');
    await act(() => {
      typeInto(input, 'refresh');
    });

    await press(input, 'Enter');
    await act(() => {
      control('previous match').click();
    });
    await act(() => {
      control('next match').click();
    });

    expect(emulator().search.searches.slice(1)).toEqual([
      {
        direction: 'next',
        query: 'refresh',
        options: { caseSensitive: false, incremental: false },
      },
      {
        direction: 'previous',
        query: 'refresh',
        options: { caseSensitive: false, incremental: false },
      },
      {
        direction: 'next',
        query: 'refresh',
        options: { caseSensitive: false, incremental: false },
      },
    ]);
  });

  it('re-runs the search when case sensitivity is turned on', async () => {
    await mountPane();
    await pressChord('F');
    const input = findInput();
    if (input === null) throw new Error('the chord opened no find bar');
    await act(() => {
      typeInto(input, 'refresh');
    });

    await act(() => {
      control('match case').click();
    });

    expect(emulator().search.searches.at(-1)).toEqual({
      direction: 'next',
      query: 'refresh',
      options: { caseSensitive: true, incremental: false },
    });
    expect(control('match case').getAttribute('aria-pressed')).toBe('true');
  });

  it('clears rather than searches when the query is emptied', async () => {
    await mountPane();
    await pressChord('F');
    const input = findInput();
    if (input === null) throw new Error('the chord opened no find bar');
    await act(() => {
      typeInto(input, 'refresh');
    });

    await act(() => {
      typeInto(input, '');
    });

    expect(emulator().search.cleared).toBe(1);
    expect(emulator().search.searches).toHaveLength(1);
    expect(summary()).toBe('');
  });

  it('closes on Escape, taking the highlights and the caret with it', async () => {
    await mountPane();
    await pressChord('F');
    const input = findInput();
    if (input === null) throw new Error('the chord opened no find bar');
    const focusedBefore = emulator().focused;

    await press(input, 'Escape');

    expect(findInput()).toBeNull();
    expect(emulator().search.cleared).toBe(1);
    // The caret goes back where the chord took it from.
    expect(emulator().focused).toBe(focusedBefore + 1);
    // And nothing is left listening to an emulator that outlives the bar.
    expect(emulator().search.listening).toBe(0);
  });

  it('closes when the emulator under it is torn down and rebuilt', async () => {
    // A scheme change is what does this in the running app: the emulator is
    // built from the scheme, so changing one disposes the other. Here the
    // factory is swapped instead, which is the same rebuild through the same
    // seam and does not need a provider to change its mind mid-test.
    await mountPane();
    await pressChord('F');
    expect(findInput()).not.toBeNull();

    const rebuilt = createFakeEmulatorFactory();
    await rerender(
      <SessionPane sessionRef={SESSION} store={buildStore().store} emulators={rebuilt} />,
    );

    expect(rebuilt.created).toHaveLength(1);
    expect(findInput()).toBeNull();
  });

  it('closes on the close control too', async () => {
    await mountPane();
    await pressChord('F');

    await act(() => {
      control('close the find bar').click();
    });

    expect(findInput()).toBeNull();
  });

  it('says what it could not search when the pane has dropped output', async () => {
    // The pane owns its feed and a test cannot push half a megabyte through
    // it to make it drop anything, so the bar is mounted directly on a feed
    // that says it has. The sentence itself is `searchScopeNotice`, held to
    // its wording in presentation.test.ts; what this pins is that the bar
    // asks and draws it.
    const search = createFakeEmulatorFactory().create(document.createElement('div')).search;
    await mount(
      <FindBar search={() => search} truncated={() => true} scheme="dark" onClose={() => {}} />,
    );

    expect(container.textContent).toContain('so a miss is not proof of absence');
  });
});

/** The hub accepting the connection, which is what sends the subscribe. */
async function connect(hub: StoreHarness): Promise<FakeSocket> {
  const socket = hub.socket();
  await act(async () => {
    socket.open();
    socket.deliver(hubFrames.welcome);
  });
  return socket;
}

async function deliver(socket: FakeSocket, frame: string): Promise<void> {
  await act(async () => {
    socket.deliver(frame);
  });
}

const WATCHED = {
  by: 'session' as const,
  storeId: SESSION.storeId,
  sessionId: SESSION.sessionId,
};

describe('a pane fed by the hub', () => {
  async function mountOn(hub: StoreHarness): Promise<void> {
    await mount(<SessionPane sessionRef={SESSION} store={hub.store} emulators={emulators} />);
  }

  it('asks to watch the session it is pointed at, and gives the watch back', async () => {
    const hub = buildStore();
    // Something else on the page is looking at the hub, so closing this pane
    // closes a pane and not the connection. With nothing else looking the
    // socket goes with the last subscriber and the detach is the close, which
    // is the same detach by the hub's own rule -- so the case worth asserting
    // is the one where the connection outlives the pane.
    const looking = hub.store.subscribe(() => {});
    await act(settle);
    await mountOn(hub);
    const socket = await connect(hub);

    expect(sentFrames(socket).at(-1)).toEqual({
      type: 'session-subscribe',
      id: 2,
      target: WATCHED,
    });

    await act(async () => {
      root?.unmount();
    });
    root = null;

    // Detaching closes nothing: the count this gives back is the one the
    // server evicts terminals by, and the agent goes on working unwatched.
    expect(sentFrames(socket).at(-1)).toEqual({
      type: 'session-unsubscribe',
      id: 3,
      target: WATCHED,
    });
    looking();
  });

  it('writes arriving output to the emulator and to nothing else', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await deliver(socket, hubFrames.sessionSubscribed);

    await deliver(socket, hubFrames.terminalOutput);

    const written = emulator().written;
    expect(written.map((chunk) => new TextDecoder().decode(chunk))).toEqual(['building\r\n']);
    // Bytes go to the emulator and never into what React renders.
    expect(container.textContent).not.toContain('building');
  });

  it('says nothing about completeness while it is showing the whole session', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);

    await deliver(socket, hubFrames.sessionSubscribed);

    expect(container.textContent).not.toContain('showing less than everything');
  });

  it('says how much of the beginning it never had', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);

    await deliver(socket, hubFrames.sessionSubscribedTruncated);

    // The number is the hub's, off a terminal that really evicted that much.
    expect(container.textContent).toContain(
      'showing less than everything: the first 3.0 MB this session printed was gone before this pane attached',
    );
  });

  it('says what this connection dropped, in its own clause', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await deliver(socket, hubFrames.sessionSubscribed);

    await deliver(socket, hubFrames.terminalOutputDropped);

    expect(container.textContent).toContain('did not fit down this connection and were dropped');
    // And not the other clause: the session's history is intact, the link is
    // not, and those are two different things to do something about.
    expect(container.textContent).not.toContain('before this pane attached');
  });

  it('tells the find bar the same fact, so a miss is not read as absence', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await deliver(socket, hubFrames.sessionSubscribedTruncated);

    await pressChord('F');

    // The bar's bound is the pane's: it searches what reached this pane, and
    // what reached this pane is missing the first three megabytes.
    expect(container.textContent).toContain('so a miss is not proof of absence');
  });

  it('sends what the steer bar was given, as the keystrokes it is', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await deliver(socket, hubFrames.sessionSubscribed);

    const steer = container.querySelector<HTMLInputElement>('[aria-label="steer the agent"]');
    if (steer === null) throw new Error('the pane rendered no steer input');
    steer.value = 'look at the failing test';
    await press(steer, 'Enter');

    expect(sentFrames(socket).at(-1)).toEqual({
      type: 'terminal-input',
      id: 3,
      target: WATCHED,
      // The Enter is the whole of what makes this a steer rather than a
      // half-typed line: there is no steer frame, and the caption says so.
      data: 'look at the failing test\r',
    });
    expect(steer.value).toBe('');
  });

  it('tells the session how big the viewer is when the emulator settles on a grid', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await deliver(socket, hubFrames.sessionSubscribed);

    await act(async () => {
      emulator().resizeTo({ cols: 100, rows: 30 });
    });

    expect(sentFrames(socket).at(-1)).toEqual({
      type: 'terminal-resize',
      id: 3,
      target: WATCHED,
      size: { cols: 100, rows: 30 },
    });
  });

  it('repeats the hub refusing this terminal, which a blank rectangle cannot', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);

    await deliver(socket, hubFrames.refusalTerminal);

    // A machine that is asleep and an agent that is quiet draw the same
    // rectangle. The name is the whole of the difference.
    expect(container.textContent).toContain('the hub said no: the hub cannot reach mbp-robert');
  });

  it('does not go on telling a machine the hub cannot reach how big it is', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);

    // The captured refusal answers this pane's subscribe: the session is not
    // held by a server the hub has a connection to.
    await deliver(socket, hubFrames.refusalTerminal);

    // The pane goes on being a pane -- it is laid out, the divider beside it
    // is dragged, the window is resized -- and the emulator goes on settling
    // on grids.
    await act(async () => {
      emulator().resizeTo({ cols: 100, rows: 30 });
      emulator().resizeTo({ cols: 120, rows: 40 });
      emulator().resizeTo({ cols: 140, rows: 50 });
    });

    // None of which is a frame. The size is remembered against the watch and
    // replayed after the subscribe that does attach; a resize for a terminal
    // this connection is not watching is one the hub can only refuse again,
    // and a pane that sent one per grid would be asking to be told no at the
    // rate its own divider moves.
    expect(sentFrames(socket).filter((frame) => frame.type === 'terminal-resize')).toEqual([]);
    // One sentence, from the one refusal.
    expect(container.textContent).toContain('the hub said no: the hub cannot reach mbp-robert');
  });
});

/**
 * The stop in the pane's header, drawn off a captured hub state.
 *
 * A pane on a store walked through to that state, so the header answers from
 * the same holders a real fleet published rather than from a status this file
 * made up. The session is named per test because the interesting cases differ
 * only in which one the pane is pointed at.
 */
describe('the stop in a session pane header', () => {
  async function mountPaneOn(sessionId: string): Promise<void> {
    const hub = buildStore();
    await mount(
      <SessionPane
        sessionRef={sessionRefSchema.parse({ storeId: 'store-agentplex', sessionId })}
        store={hub.store}
        emulators={emulators}
      />,
    );
    const socket = hub.socket();
    await act(async () => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStatePopulated);
    });
  }

  function stopButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('button[aria-label^="stop "]');
  }

  it('offers a stop in the header when the holder says the session can be stopped', async () => {
    await mountPaneOn('session-migrate-db');

    expect(stopButton()?.getAttribute('aria-label')).toBe('stop session-migrate-db');
  });

  it('offers none for a holder that is mid-turn', async () => {
    // Working, held, and `stoppable: false`: the one case where the status
    // would say yes and the published fact says no.
    await mountPaneOn('session-fix-auth');

    expect(stopButton()).toBeNull();
  });

  it('offers none for a session nothing is running', async () => {
    await mountPaneOn('session-spike-wasm');

    expect(stopButton()).toBeNull();
  });

  it('offers none for a session the state does not describe at all', async () => {
    await mountPaneOn('session-that-is-not-there');

    expect(stopButton()).toBeNull();
  });
});

/**
 * Copy and paste, through the two seams that make them testable at all.
 *
 * The clipboard is injected because no suite can grant a clipboard permission
 * or dismiss a browser's prompt, and because the case worth testing hardest is
 * the one where the browser says no -- which is the ordinary case on a hub
 * read over plain HTTP. The emulator is injected for the reasons the find bar
 * already relies on. What the fake emulator deliberately does not do is decide
 * what a paste looks like: it hands back exactly the text it was given, so
 * every assertion here is about the pane's own route from the clipboard to a
 * frame. Whether that text should have been wrapped in bracketed-paste markers
 * is xterm's answer, held to a captured pty in `xterm-emulator.test.ts`.
 */
describe('copy and paste in a pane', () => {
  interface Harness {
    readonly hub: StoreHarness;
    /** The socket, once the hub has accepted the connection. */
    socket(): FakeSocket;
  }

  async function mountWith(clipboard: Clipboard): Promise<Harness> {
    const hub = buildStore();
    await mount(
      <SessionPane
        sessionRef={SESSION}
        store={hub.store}
        emulators={emulators}
        clipboard={clipboard}
      />,
    );
    return { hub, socket: () => hub.socket() };
  }

  /** Mounted, connected and subscribed: a pane that can actually send. */
  async function mountLive(clipboard: Clipboard): Promise<FakeSocket> {
    const harness = await mountWith(clipboard);
    const socket = await connect(harness.hub);
    await deliver(socket, hubFrames.sessionSubscribed);
    return socket;
  }

  /** The chord, and the microtask the clipboard promise settles on. */
  async function pressClipboardChord(key: string): Promise<void> {
    await settleAfter(() => {
      dispatchChord(key);
    });
  }

  /** Every terminal-input frame the pane has sent, in order. */
  function inputData(socket: FakeSocket): string[] {
    return sentFrames(socket)
      .filter((frame) => frame.type === 'terminal-input')
      .map((frame) => frame.data);
  }

  describe('copying', () => {
    it('puts the selection on the clipboard', async () => {
      const clipboard = createFakeClipboard();
      await mountWith(clipboard);
      emulator().select('refresh token rotates (212ms)');

      await pressClipboardChord('C');

      expect(clipboard.text).toBe('refresh token rotates (212ms)');
    });

    it('says so rather than copying nothing when nothing is selected', async () => {
      const clipboard = createFakeClipboard('something already here');
      await mountWith(clipboard);

      await pressClipboardChord('C');

      // The clipboard is untouched -- a copy with an empty selection that
      // overwrote what was on it would lose the user something.
      expect(clipboard.writes).toBe(0);
      expect(clipboard.text).toBe('something already here');
      expect(container.textContent).toContain('nothing is selected in this pane');
    });

    it('repeats what the browser said when it refused', async () => {
      await mountWith(createRefusingClipboard('Write permission denied.'));
      emulator().select('a line worth keeping');

      await pressClipboardChord('C');

      expect(container.textContent).toContain(
        'could not copy to the clipboard: Write permission denied.',
      );
    });

    it('sends nothing: a copy is not a thing that crosses the wire', async () => {
      const socket = await mountLive(createFakeClipboard());
      emulator().select('a line worth keeping');
      const before = socket.sent.length;

      await pressClipboardChord('C');

      expect(socket.sent.length).toBe(before);
    });
  });

  describe('pasting', () => {
    it('hands what the clipboard held to the emulator, as a paste and not as writes', async () => {
      await mountWith(createFakeClipboard('git commit --amend'));

      await pressClipboardChord('V');

      expect(emulator().pasted).toEqual(['git commit --amend']);
      // Not written: a paste is input, and what appears on the screen is
      // whatever the program at the far end echoes back.
      expect(emulator().written).toEqual([]);
    });

    it('sends what the emulator made of it, as terminal input', async () => {
      const socket = await mountLive(createFakeClipboard('git commit --amend'));

      await pressClipboardChord('V');

      expect(sentFrames(socket).at(-1)).toEqual({
        type: 'terminal-input',
        id: 3,
        target: WATCHED,
        data: 'git commit --amend',
      });
    });

    it('cuts a paste too long for one frame into frames, in order', async () => {
      // Two frames and a little: what a pasted file looks like. The ends are
      // distinguishable so that a swapped pair is a failure and not a
      // coincidence, which is the whole property a pty depends on -- it has no
      // notion of a message boundary and will run whatever order it is given.
      const paste = `head${'x'.repeat(TERMINAL_INPUT_MAX_CHARS * 2)}tail`;
      const socket = await mountLive(createFakeClipboard(paste));

      await pressClipboardChord('V');

      const sent = inputData(socket);
      expect(sent).toHaveLength(3);
      expect(sent.join('')).toBe(paste);
      for (const frame of sent) expect(frame.length).toBeLessThanOrEqual(TERMINAL_INPUT_MAX_CHARS);
    });

    it('says the clipboard was empty rather than doing nothing visible', async () => {
      await mountWith(createFakeClipboard(''));

      await pressClipboardChord('V');

      expect(emulator().pasted).toEqual([]);
      expect(container.textContent).toContain('the clipboard is empty');
    });

    it('names the origin when the page was given no clipboard at all', async () => {
      // The plain-HTTP case, which is most hubs: `navigator.clipboard` is not
      // there to refuse anything, so the sentence has to name the origin
      // rather than blame a permission nobody was asked for.
      await mountWith(createRefusingClipboard(NO_CLIPBOARD_HERE));

      await pressClipboardChord('V');

      expect(emulator().pasted).toEqual([]);
      expect(container.textContent).toContain('could not paste from the clipboard');
      expect(container.textContent).toContain('secure context');
    });

    it('discards a paste made while the connection is down, and counts it once', async () => {
      // Never queued: a paste replayed into a session against a screen the
      // user was not looking at is the rule the store is built around. What
      // this pins is that one paste is one discard -- cutting it into frames
      // must not turn a single refusal into a count of them.
      const paste = `head${'x'.repeat(TERMINAL_INPUT_MAX_CHARS * 2)}tail`;
      await mountWith(createFakeClipboard(paste));

      await pressClipboardChord('V');

      expect(container.textContent).toContain('the connection is down: 1 keystroke was discarded');
      expect(container.textContent).toContain('nothing typed here will replay when it returns');
    });

    it('clears the last complaint once the clipboard answers', async () => {
      const clipboard = createFakeClipboard('');
      await mountWith(clipboard);
      await pressClipboardChord('V');
      expect(container.textContent).toContain('the clipboard is empty');

      clipboard.text = 'now there is something';
      await pressClipboardChord('V');

      expect(container.textContent).not.toContain('the clipboard is empty');
      expect(emulator().pasted).toEqual(['now there is something']);
    });
  });

  describe('the paste control in the header', () => {
    function pasteButton(): HTMLElement | null {
      return container.querySelector<HTMLElement>('[aria-label="paste into the terminal"]');
    }

    it('is not drawn where there is a keyboard to press the chord on', async () => {
      // The default stub answers false to everything, which is a mouse.
      await mountWith(createFakeClipboard('git commit --amend'));

      expect(pasteButton()).toBeNull();
    });

    it('is drawn where the pointer is a finger, because there is no chord there', async () => {
      // A PWA on a phone home screen has no Ctrl and no Cmd: without this
      // control there is no way at all to get text into a session from the
      // device this client is mainly for.
      installMatchMedia(COARSE_POINTER);
      await mountWith(createFakeClipboard('git commit --amend'));

      expect(pasteButton()).not.toBeNull();
    });

    it('pastes what the chord would have pasted', async () => {
      installMatchMedia(COARSE_POINTER);
      const socket = await mountLive(createFakeClipboard('git commit --amend'));

      await settleAfter(() => {
        pasteButton()?.click();
      });

      expect(emulator().pasted).toEqual(['git commit --amend']);
      expect(inputData(socket)).toEqual(['git commit --amend']);
    });

    it('shows a refusal beside itself rather than swallowing it', async () => {
      installMatchMedia(COARSE_POINTER);
      await mountWith(createRefusingClipboard('Read permission denied.'));

      await settleAfter(() => {
        pasteButton()?.click();
      });

      expect(container.textContent).toContain(
        'could not paste from the clipboard: Read permission denied.',
      );
      // And the control is still there to try again with.
      expect(pasteButton()).not.toBeNull();
    });
  });
});

/**
 * The frame the context panel mounts into (mockups 7c and 7d): the pane's body
 * is a row, the terminal is the flexible half of it, and the panel is the fixed
 * column on the right.
 *
 * Two things are worth holding here rather than in `context-panel.test.tsx`,
 * because they are the pane's and not the panel's. That no panel is drawn while
 * no block has been built -- this ticket ships the frame and nothing to put in
 * it, so on today's data the screen is unchanged. And that the terminal still
 * gets a box of its own to fit against: the fit addon measures the element
 * `TerminalView` renders and subtracts the terminal element's padding and
 * nothing else (AGX-248), so a wrapper that padded the way in, or a column that
 * could not shrink, would be a grid drawn to a width the pane does not have.
 */
describe('the body of a session pane', () => {
  function contextPanel(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[aria-label="session context"]');
  }

  /**
   * The box the emulator is built into, found by the one declaration only that
   * box carries.
   *
   * There is no test id on it and there should not be: `touch-action: none` is
   * load-bearing on that element for the reasons `terminal-view.tsx` argues, it
   * is the only element in a pane that has it, and a locator that stops finding
   * it is a locator pointing at a pane whose terminal box has been rearranged --
   * which is exactly when these assertions need to be read again.
   */
  function terminalBox(): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('div')].filter(
      (element) => getComputedStyle(element).touchAction === 'none',
    );
    const box = found[0];
    if (box === undefined || found.length !== 1) {
      throw new Error(`expected one terminal box in the pane, found ${found.length}`);
    }
    return box;
  }

  /** What an element's own padding costs it, on the two sides that differ. */
  function padding(element: HTMLElement): number[] {
    const style = getComputedStyle(element);
    return [Number.parseFloat(style.paddingTop), Number.parseFloat(style.paddingLeft)];
  }

  it('draws the panel for the one block every session has', async () => {
    await mountPane();

    // The panel is no longer conditional on a session having been started with
    // a prompt: the standing policy is a fact about every session, including
    // the answer "this session is in no project, so every request reaches you",
    // and that is the answer somebody opening the panel came for.
    const panel = contextPanel();
    expect(panel).not.toBeNull();
    expect(
      [...container.querySelectorAll('section')].map((node) => node.getAttribute('aria-label')),
    ).toEqual(['Approvals']);
  });

  it('leaves the terminal a column that can shrink and no padding to be fitted around', async () => {
    await mountPane();
    const box = terminalBox();

    // The column the terminal is in: `min-width: 0` is what lets a fixed 300px
    // column beside it actually take those pixels, rather than overflow the
    // pane while the terminal keeps fitting to a width it no longer has.
    const column = box.parentElement;
    if (column === null) throw new Error('the terminal box has no column around it');
    expect(getComputedStyle(column).minWidth).toBe('0px');

    // And the box the addon measures, plus everything between it and the pane
    // root, is padding-free. The pane's inset is on the terminal element
    // inside, which is the only one the addon subtracts.
    for (
      let element: HTMLElement | null = box;
      element !== null && element !== container;
      element = element.parentElement
    ) {
      expect(padding(element)).toEqual([0, 0]);
    }
  });
});

/**
 * The strip across the top of the pane, and the word beside it.
 *
 * Two claims worth holding to a real socket rather than to a prop. The strip
 * draws the tabs that exist -- one -- and says nothing about the three the
 * mockup shows and nobody has built. And "Attached" is a claim about that
 * socket and the subscription on it, so every stage of a connection is walked
 * here with the hub's own frames: dialled, welcomed, answered, and dropped.
 */
describe('the session tab strip', () => {
  async function mountOn(hub: StoreHarness): Promise<void> {
    await mount(<SessionPane sessionRef={SESSION} store={hub.store} emulators={emulators} />);
  }

  function tabLabels(): string[] {
    return [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? '');
  }

  it('draws the tabs that are built, with Terminal first and selected', async () => {
    const hub = buildStore();
    await mountOn(hub);
    await connect(hub);

    expect(tabLabels()).toEqual(['Terminal', 'Transcript']);
    // Not a disabled Diff, not a greyed Approvals: a tab nobody can open is a
    // promise the screen cannot keep, and the strip is a list rather than a
    // fixed set of four. Asked of the strip rather than of the pane, because
    // the panel beside it now has an APPROVALS heading of its own and that is
    // a block about the standing policy, not a tab.
    expect(tabLabels()).not.toContain('Diff');
    expect(tabLabels()).not.toContain('Approvals');
    // Terminal is the default because it is first -- `activeTab` falls back to
    // `tabs[0]` -- so the ordering is the rule rather than a flag somewhere.
    expect(container.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('points each tab at the panel it shows, with ids no second pane can share', async () => {
    const hub = buildStore();
    await mountOn(hub);
    await connect(hub);

    const [terminalTab, transcriptTab] = [...container.querySelectorAll('[role="tab"]')];
    const controls = terminalTab?.getAttribute('aria-controls') ?? '';
    expect(controls.length).toBeGreaterThan(0);
    expect(transcriptTab?.getAttribute('aria-controls')).not.toBe(controls);
    // The panel the selected tab names is the one that is mounted, and it
    // names the tab back.
    const panel = container.querySelector(`#${CSS.escape(controls)}`);
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(terminalTab?.getAttribute('id'));
  });

  it('claims attachment only once the hub has answered the watch', async () => {
    const hub = buildStore();
    await mountOn(hub);

    // Dialled, and nothing has answered yet.
    expect(attachment()).toBe('Connecting');

    const socket = await connect(hub);
    // The socket is up and the subscribe is out. The terminal is not this
    // pane's to show until the hub says it is.
    expect(attachment()).toBe('Attaching');

    await deliver(socket, hubFrames.sessionSubscribed);

    expect(attachment()).toBe('Attached');
  });

  it('says the connection went, rather than what the last frame said', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await deliver(socket, hubFrames.sessionSubscribed);
    expect(attachment()).toBe('Attached');

    // The watch record still says attached until the store tears it down;
    // the word is read off the connection first for exactly this moment.
    await act(async () => {
      socket.drop();
    });

    expect(attachment()).toBe('Reconnecting');
  });

  it('stops claiming attachment once the hub says nothing is feeding this pane', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await deliver(socket, hubFrames.sessionSubscribed);
    expect(attachment()).toBe('Attached');

    // The socket is still up: this is the hub ending one subscription on it,
    // not the connection going. So nothing else in the pane changes phase, and
    // the chip is the only thing that can say the terminal stopped being fed.
    await deliver(socket, hubFrames.sessionSubscriptionEnded);

    expect(attachment()).toBe('Detached');
    // Both, and this is the pairing worth holding to a real frame: the
    // sentence says what happened and what to do, and a chip still reading
    // "Attached" beside it would contradict it in the reassuring direction --
    // a user would believe the word and read the sentence as stale.
    expect(container.textContent).toContain('stopped answering');
    expect(container.textContent).not.toContain('Attached');
  });

  it('says a connection that is not coming back is gone', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = hub.socket();

    // A hub that speaks another protocol version refuses the hello itself:
    // down for a reason redialling cannot fix, and the one phase that is not
    // a wait for something.
    await act(async () => {
      socket.open();
      socket.deliver(hubFrames.refusalProtocolVersion);
    });

    expect(attachment()).toBe('Dropped');
  });
});

/**
 * The bar above the terminal, drawn off a captured hub state.
 *
 * The state is the one a real fleet published, and the session is named per
 * test, because every case here is the same bar pointed at a different row:
 * one in a project with a title, one the tree places nowhere, one the provider
 * never named, one that carries a model and one that does not. A hand-written
 * row could be given whichever of those five shapes made the assertion pass;
 * this file has to take the shapes the capture happens to hold, which is why
 * the fallbacks are asserted against `store-agentplex` and `session-train-lora`
 * rather than against names invented here.
 *
 * What each part is made of is `presentation.test.ts`'s question. What this
 * one asks is whether the header draws those answers where the mockup puts
 * them, with the roles the mockup draws them in, and without inventing a
 * separator or a segment of its own.
 */
describe('the header above a session', () => {
  async function mountHeaderOn(storeId: string, sessionId: string): Promise<void> {
    const hub = buildStore();
    await mount(
      <SessionPane
        sessionRef={sessionRefSchema.parse({ storeId, sessionId })}
        store={hub.store}
        emulators={emulators}
      />,
    );
    const socket = hub.socket();
    await act(async () => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStatePopulated);
    });
  }

  /**
   * The breadcrumb as a person reads it, separators and all.
   *
   * The whole string rather than the segments, because the failure this is
   * here for is a separator with nothing on one side of it -- which is exactly
   * what a list of segments cannot show.
   */
  function crumbText(): string {
    return container.querySelector('[data-crumbs]')?.textContent ?? '';
  }

  /** Each crumb with the role it was drawn in, in document order. */
  function crumbs(): { readonly text: string; readonly role: string | null }[] {
    return [...container.querySelectorAll('[data-crumb]')].map((crumb) => ({
      text: crumb.textContent ?? '',
      role: crumb.getAttribute('data-crumb'),
    }));
  }

  /** The word beside the status dot, and whether that dot is animated. */
  function status(): { readonly word: string; readonly live: boolean } {
    const badge = container.querySelector('[data-status]');
    if (badge === null) throw new Error('the header drew no status');
    return { word: badge.textContent ?? '', live: badge.querySelector('[data-live]') !== null };
  }

  /** The metadata line, or '' when the header drew none. */
  function metadata(): string {
    return container.querySelector('[data-metadata]')?.textContent ?? '';
  }

  it('names the project, then the session, and says which of the two to read first', async () => {
    await mountHeaderOn('store-universe', 'session-bench-tokenizer');

    expect(crumbs()).toEqual([
      { text: 'universe', role: 'muted' },
      { text: 'bench-tokenizer', role: 'emphatic' },
    ]);
    // One separator, between the two and at neither end: the bar reads as a
    // sentence about where this session is, and a trailing slash would promise
    // a crumb that is not coming.
    expect(crumbText()).toBe('universe / bench-tokenizer');
  });

  it('keeps the project when the provider never named the session', async () => {
    await mountHeaderOn('store-universe', 'session-train-lora');

    // The fallbacks are independent, which is the whole of why this case is
    // not `store-universe / session-train-lora`: the hub's tree really does
    // place this session in `universe`, and saying so is worth more than
    // keeping a pair of identifiers together.
    expect(crumbText()).toBe('universe / session-train-lora');
    expect(crumbText()).not.toContain('null');
  });

  it('falls back to the store when the tree places the session nowhere', async () => {
    await mountHeaderOn('store-agentplex', 'session-fix-auth');

    expect(crumbs()).toEqual([
      { text: 'store-agentplex', role: 'muted' },
      { text: 'fix-auth-refresh', role: 'emphatic' },
    ]);
  });

  it('draws the route itself for a session the state does not describe', async () => {
    await mountHeaderOn('store-agentplex', 'session-that-is-not-there');

    // The same bar a pane whose row has not arrived draws, which is the point
    // of taking both fallbacks off the route: an empty crumb and the word
    // `null` are the two things a header must never show.
    expect(crumbText()).toBe('store-agentplex / session-that-is-not-there');
    expect(status().word).toBe('not reported');
  });

  it('says in a word what the session is doing, and animates the one that is live', async () => {
    await mountHeaderOn('store-universe', 'session-bench-tokenizer');

    expect(status()).toEqual({ word: 'working', live: true });
    // And the rule the dot names is in the document: a marked dot with no
    // keyframes behind it animates nothing, and no assertion about the dot
    // alone could tell the difference.
    expect(document.head.textContent).toContain('@keyframes agx-pulse');
  });

  it('says the words the list says, and animates nothing that is not working', async () => {
    await mountHeaderOn('store-universe', 'session-docs-sweep');

    // `awaiting input` and not `awaiting-input`: the header and the list read
    // the same field through the same mapping, so one screen cannot start
    // spelling a status differently from the other.
    expect(status()).toEqual({ word: 'awaiting input', live: false });
  });

  it('leaves the model out of the metadata line when the descriptor names none', async () => {
    await mountHeaderOn('store-universe', 'session-bench-tokenizer');

    // Provider, machine, working directory, and nothing at all between the
    // first two: a placeholder there would claim something is missing, where
    // the truth is that this transcript never named a model.
    expect(metadata()).toBe('claude · gpu-box-01 · /mnt/volumes/universe/bench');
  });

  it('puts the model after the provider when the descriptor states one', async () => {
    await mountHeaderOn('store-agentplex', 'session-fix-auth');

    expect(metadata()).toBe('claude · claude-opus-5 · mbp-robert · /Users/robert/code/agentplex');
  });

  it('draws nothing it cannot do, and nothing it cannot know', async () => {
    await mountHeaderOn('store-universe', 'session-bench-tokenizer');

    // Pause, hand off and replay are each their own milestone, and a button
    // that cannot do its job must not be drawn. The multiplexer segment the
    // mockup shows is not built at all: no frame says whether a session runs
    // under one, so the bar says nothing rather than guessing.
    expect(container.textContent).not.toContain('Pause');
    expect(container.textContent).not.toContain('Hand off');
    expect(container.textContent).not.toContain('Replay');
    expect(container.textContent).not.toContain('tmux');
  });
});

/**
 * The context panel beside the terminal, and the one block built for it.
 *
 * The state is the captured one, with a task stated on the row this pane is
 * pointed at. Every row in the fixture carries `task: null` and honestly so --
 * the capture's one prompted start is a spawn whose id the fake provider never
 * writes, and a fixture is captured output or it is nothing -- so the task is
 * stated here, on a copy, the way this file states any other fact it needs.
 * What comes back still goes through the store's own parser, so a state that
 * stopped being a machine-state frame fails here rather than arriving as
 * nothing.
 */
describe('the task beside a session', () => {
  const TASKED = 'session-fix-auth';

  function statingTask(frame: string, sessionId: string, task: string): string {
    const parsed = parseTextFrame(parseHubFrame, frame);
    if (!parsed.ok) throw new Error(`the fixture is unreadable: ${parsed.reason}`);
    if (parsed.value.type !== 'machine-state') throw new Error('that fixture is not a state frame');
    const state = parsed.value.state;
    return JSON.stringify({
      type: 'machine-state',
      state: {
        ...state,
        stores: state.stores.map((store) => ({
          ...store,
          sessions: store.sessions.map((row) =>
            row.descriptor.sessionId === sessionId ? { ...row, task } : row,
          ),
        })),
      },
    });
  }

  async function mountPaneOn(sessionId: string, state: string): Promise<void> {
    const hub = buildStore();
    await mount(
      <SessionPane
        sessionRef={sessionRefSchema.parse({ storeId: 'store-agentplex', sessionId })}
        store={hub.store}
        emulators={emulators}
      />,
    );
    const socket = hub.socket();
    await act(async () => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(state);
    });
  }

  function panel(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[aria-label="session context"]');
  }

  function taskBlock(): HTMLElement | null {
    return container.querySelector<HTMLElement>('section[aria-label="Task"]');
  }

  const PROMPT = 'Fix the auth refresh race when two tabs refresh at once, then PR against main.';

  it('shows what the session was started to do, beside the terminal', async () => {
    await mountPaneOn(TASKED, statingTask(hubFrames.machineStatePopulated, TASKED, PROMPT));

    const block = taskBlock();
    expect(block?.querySelector('h2')?.textContent).toBe('Task');
    expect(block?.textContent).toContain(PROMPT);
  });

  it('draws no task block at all for a session the hub holds no task for', async () => {
    // An adopted session: the hub found it on a machine rather than starting
    // it, so there is no prompt anybody typed. Not an empty block -- a TASK
    // heading with nothing under it is a promise this screen cannot keep, and
    // the first thing a reader would do is look for the sentence that is
    // missing. The panel itself stays, because the block below it is about the
    // policy and every session has one of those.
    await mountPaneOn(TASKED, hubFrames.machineStatePopulated);

    expect(taskBlock()).toBeNull();
    expect(panel()).not.toBeNull();
  });

  it('says nothing about a task for a session the state does not describe at all', async () => {
    await mountPaneOn('session-that-is-not-there', hubFrames.machineStatePopulated);

    expect(taskBlock()).toBeNull();
  });

  it('draws no panel in the phone form, task or no task', async () => {
    // 7e draws no phone form for this panel and a 300px column on a 390px
    // screen is not one. The pane reads the shell's single breakpoint, so this
    // is the same rule the chrome around it is already obeying.
    window.innerWidth = 390;
    try {
      await mountPaneOn(TASKED, statingTask(hubFrames.machineStatePopulated, TASKED, PROMPT));

      expect(panel()).toBeNull();
      // Not hidden with a style: the prompt is not in the page at all, so it
      // is not in a page search or in what a screen reader walks.
      expect(container.textContent).not.toContain('Fix the auth refresh race');
    } finally {
      window.innerWidth = 1024;
    }
  });
});

/**
 * The Approvals tab: the second tab this pane has ever had, and the reason the
 * strip took a list rather than drawing a control.
 *
 * The state is the captured approval frame with more requests stated on a
 * parsed copy of it. A fixture is captured output, so a session holding three
 * open requests is stated here rather than typed into the capture, and what is
 * stated goes back through the store's own parser -- a state that stopped being
 * a machine-state frame fails here rather than arriving as nothing.
 *
 * The two claims that are the pane's rather than the tab's: the tab exists only
 * while something is asking, with the count on it, and the pane falls back to
 * the Terminal when the last request settles under a person who is looking at
 * the tab. An empty Approvals tab is the blank screen this app keeps refusing
 * to draw.
 */
describe('the Approvals tab in a session pane', () => {
  const ASKING = '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde';

  /**
   * The captured state with a stated number of open requests on the session
   * that is asking, listed newest first.
   *
   * Newest first deliberately: the order the tab draws them in is a rule, and
   * a row that arrived already sorted would let a tab that did nothing pass.
   * The ids go through the wire's own parser; everything else about each
   * request is the captured one, with the command named so the order is
   * readable in an assertion.
   */
  function statingApprovals(count: number): string {
    const parsed = parseTextFrame(parseHubFrame, hubFrames.machineStateApproval);
    if (!parsed.ok) throw new Error(`the fixture is unreadable: ${parsed.reason}`);
    if (parsed.value.type !== 'machine-state') throw new Error('that fixture is not a state frame');
    const state = parsed.value.state;
    const [captured] = state.stores
      .flatMap((store) => store.sessions)
      .flatMap((row) => row.approvals);
    if (captured === undefined) throw new Error('the captured state holds no open request');
    const approvals = Array.from({ length: count }, (_unused, index) => ({
      ...captured,
      approvalId: approvalIdSchema.parse(`approval-${String(count - index)}`),
      proposal: `request ${String(count - index)}`,
      requestedAt: captured.requestedAt + (count - index) * 60_000,
    }));
    return JSON.stringify({
      type: 'machine-state',
      state: {
        ...state,
        stores: state.stores.map((store) => ({
          ...store,
          sessions: store.sessions.map((row) =>
            row.descriptor.sessionId === ASKING ? { ...row, approvals } : row,
          ),
        })),
      },
    });
  }

  async function mountAsking(state: string): Promise<FakeSocket> {
    const hub = buildStore();
    await mount(
      <SessionPane
        sessionRef={sessionRefSchema.parse({ storeId: 'store-agentplex', sessionId: ASKING })}
        store={hub.store}
        emulators={emulators}
      />,
    );
    const socket = hub.socket();
    await act(async () => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(state);
    });
    return socket;
  }

  function tabLabels(): string[] {
    return [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? '');
  }

  function selectedTab(): string {
    const selected = container.querySelector('[role="tab"][aria-selected="true"]');
    return selected?.textContent ?? '';
  }

  async function openApprovals(): Promise<void> {
    const tab = container.querySelector<HTMLElement>('[role="tab"][data-tab-id="approvals"]');
    if (tab === null) throw new Error('the strip offers no Approvals tab');
    await act(() => {
      tab.click();
    });
  }

  function proposals(): string[] {
    return [...container.querySelectorAll('li pre')].map((node) => node.textContent ?? '');
  }

  /** Whether the terminal is the thing under the strip, by its own box. */
  function terminalDrawn(): boolean {
    return [...container.querySelectorAll<HTMLElement>('div')].some(
      (element) => getComputedStyle(element).touchAction === 'none',
    );
  }

  it('offers no Approvals tab for a session that is asking for nothing', async () => {
    // Every row in the populated capture is holding no request, which is every
    // codex session always -- there is no permission hook to ask through -- and
    // every quiet claude one.
    await mountAsking(hubFrames.machineStatePopulated);

    // The strip, not the pane: the context panel's APPROVALS block is drawn
    // whatever a session is asking, because it is about the standing policy
    // rather than about a request.
    expect(tabLabels()).toEqual(['Terminal', 'Transcript']);
  });

  it('offers it with the count on it while requests are open', async () => {
    await mountAsking(statingApprovals(3));

    // The badge is the mockup's `3`: the strip places a tab's own words, and
    // this is the first tab that has any.
    expect(tabLabels()).toEqual(['Terminal', 'Transcript', 'Approvals3']);
  });

  it('opens on the Terminal all the same', async () => {
    await mountAsking(statingApprovals(3));

    expect(selectedTab()).toBe('Terminal');
    expect(terminalDrawn()).toBe(true);
    expect(proposals()).toEqual([]);
  });

  it('lists every open request oldest first once the tab is chosen', async () => {
    await mountAsking(statingApprovals(3));

    await openApprovals();

    expect(selectedTab()).toBe('Approvals3');
    expect(proposals()).toEqual(['request 1', 'request 2', 'request 3']);
  });

  it('falls back to the terminal when the last request settles under it', async () => {
    const socket = await mountAsking(statingApprovals(1));
    await openApprovals();
    expect(proposals()).toEqual(['request 1']);

    // The agent stopped asking: the hub reports the session with nothing
    // pending, so the tab a person is standing on stops existing.
    await deliver(socket, statingApprovals(0));

    // Not an empty Approvals tab, which would be a heading over the absence of
    // the thing it names. The strip answers a request for a tab it no longer
    // holds with the first one it does, which is the Terminal.
    expect(tabLabels()).toEqual(['Terminal', 'Transcript']);
    expect(selectedTab()).toBe('Terminal');
    expect(proposals()).toEqual([]);
    expect(terminalDrawn()).toBe(true);
  });

  it('gives the terminal back its box when the Terminal tab is chosen again', async () => {
    await mountAsking(statingApprovals(2));
    await openApprovals();

    // The emulator goes with its element, which is the one lifetime it can
    // correctly have. What it was showing does not go with it: the feed belongs
    // to the watched target and not to this pane, so the emulator the return
    // builds is handed the same feed and replays it.
    expect(terminalDrawn()).toBe(false);

    const tab = container.querySelector<HTMLElement>('[role="tab"][data-tab-id="terminal"]');
    if (tab === null) throw new Error('the strip offers no Terminal tab');
    await act(() => {
      tab.click();
    });

    expect(terminalDrawn()).toBe(true);
    expect(proposals()).toEqual([]);
    expect(emulators.created).toHaveLength(2);
  });
});

/**
 * The Transcript tab, as a person meets it: press the tab, the pane asks, the
 * answer is drawn in the same widgets a card uses collapsed.
 *
 * The frames are the captured ones, so what the tab draws is what a real hub
 * actually sent rather than a shape written here.
 */
describe('the transcript tab', () => {
  async function mountOn(hub: StoreHarness): Promise<void> {
    await mount(<SessionPane sessionRef={SESSION} store={hub.store} emulators={emulators} />);
  }

  function tab(label: string): HTMLElement {
    const found = [...container.querySelectorAll('[role="tab"]')].find(
      (element) => element.textContent === label,
    );
    if (found === undefined) throw new Error(`no ${label} tab is drawn`);
    return found as HTMLElement;
  }

  async function press(element: HTMLElement): Promise<void> {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(settle);
  }

  function status(): string {
    return container.querySelector('[data-transcript-status]')?.textContent ?? '';
  }

  function widgetKinds(): string[] {
    return [...container.querySelectorAll('[data-activity]')].map(
      (element) => element.getAttribute('data-activity') ?? '',
    );
  }

  it('asks for the transcript when the tab is first shown, and says it is reading', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);

    await press(tab('Transcript'));

    const asked = sentFrames(socket).filter((frame) => frame.type === 'session-transcript');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      storeId: SESSION.storeId,
      sessionId: SESSION.sessionId,
      count: 200,
    });
    expect(status()).toContain('Reading this session');
  });

  it('draws each activity the hub answered with, in the full widget form', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await press(tab('Transcript'));

    // The captured answer: four commands, oldest first, and a hub that said
    // there are more behind them. Four of one kind because that is what an
    // adapter derives out of a captured Claude transcript -- a tool name, the
    // tool's input being redacted in every capture -- and the fixture is what
    // a hub really sent rather than what would have made a livelier screen.
    await deliver(socket, hubFrames.sessionTranscript);

    expect(widgetKinds()).toEqual(['command', 'command', 'command', 'command']);
    expect(container.textContent).toContain('Bash');
    expect(status()).toContain('Showing the last 4');
  });

  it('draws the kinds no adapter emits yet, each in its own widget', async () => {
    // Hand-built, and parsed through `activitySchema` before they go anywhere,
    // which is what keeps them honest: the shapes are the schema's rather than
    // this test's, and the frame they ride is one the store's own parser took.
    //
    // Hand-built because no provider fixture in this repository holds them --
    // Claude Code's captured tool inputs are redacted and no codex capture has
    // a file change in it -- so the captured client fixture carries commands
    // and nothing else, on purpose. AGX-263 re-captures provider fixtures with
    // tool inputs; when it lands these kinds reach the fixture the way the
    // commands did, and this test goes back to being about widgets alone.
    const activities = [
      { kind: 'narration', text: 'reading the failing test before changing anything' },
      { kind: 'edit', path: 'src/auth/refresh.ts', added: 18, removed: 4 },
      { kind: 'tests', passed: 118, failed: 1 },
      { kind: 'approval', text: 'may I write to src/auth/refresh.ts' },
      { kind: 'plain', text: 'a line this adapter could not classify' },
    ].map((activity) => activitySchema.parse(activity));

    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await press(tab('Transcript'));
    const asked = sentFrames(socket).find((frame) => frame.type === 'session-transcript');
    if (asked === undefined) throw new Error('the pane asked for no transcript');

    await deliver(
      socket,
      JSON.stringify({
        type: 'session-transcript-read',
        replyTo: asked.id,
        activities,
        olderExist: false,
      }),
    );

    expect(widgetKinds()).toEqual(['narration', 'edit', 'tests', 'approval', 'plain']);
    expect(container.textContent).toContain('src/auth/refresh.ts');
    expect(container.textContent).toContain('118');
  });

  it('unmounts the terminal rather than hiding it, and replays it on the way back', async () => {
    // A hidden terminal measures zero and would send a zero-width resize
    // across two machines. The feed is the store's, so coming back is a
    // replay rather than a blank pane.
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await deliver(socket, hubFrames.sessionSubscribed);
    const before = emulators.created.length;
    expect(before).toBeGreaterThan(0);

    await press(tab('Transcript'));
    expect(container.querySelector('[data-testid="terminal"]')).toBeNull();
    expect(emulator().disposed).toBe(true);

    await press(tab('Terminal'));

    // A second emulator, fed from the same feed the store kept: the bytes
    // that arrived while the tab was away are not this pane's to have lost.
    expect(emulators.created.length).toBe(before + 1);
  });

  it('asks again when Refresh is pressed, and keeps the old answer until the new one lands', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await press(tab('Transcript'));
    await deliver(socket, hubFrames.sessionTranscript);

    const refresh = container.querySelector('button[aria-label^="read this session"]');
    await press(refresh as HTMLElement);

    expect(sentFrames(socket).filter((frame) => frame.type === 'session-transcript')).toHaveLength(
      2,
    );
    // The first read's answer is not the second read's answer, so the tab says
    // it is reading rather than showing a history as of before the press.
    expect(status()).toContain('Reading this session');
    expect(widgetKinds()).toEqual([]);
  });

  it('shows the hub’s own words when the read was refused', async () => {
    const hub = buildStore();
    await mountOn(hub);
    const socket = await connect(hub);
    await press(tab('Transcript'));
    const asked = sentFrames(socket).find((frame) => frame.type === 'session-transcript');
    if (asked === undefined) throw new Error('the pane asked for no transcript');

    await deliver(
      socket,
      JSON.stringify({
        type: 'refusal',
        replyTo: asked.id,
        code: 'refused',
        message: 'no server with that store mounted is connected right now',
        holder: null,
      }),
    );

    expect(status()).toBe('no server with that store mounted is connected right now');
  });

  it('mounts the status region before it has anything to say', async () => {
    // A `role="status"` that appears with its words is a region nothing was
    // watching when they arrived.
    const hub = buildStore();
    await mountOn(hub);
    await connect(hub);
    await press(tab('Transcript'));

    expect(container.querySelector('[data-transcript-status]')?.getAttribute('role')).toBe(
      'status',
    );
  });
});
