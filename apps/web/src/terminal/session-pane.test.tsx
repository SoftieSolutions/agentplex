// @vitest-environment jsdom
import {
  parseClientFrame,
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
  return [...container.querySelectorAll('[role="status"]')].at(-1)?.textContent ?? '';
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

  it('draws the one tab that is built, selected, and nothing for the rest', async () => {
    const hub = buildStore();
    await mountOn(hub);
    await connect(hub);

    expect(tabLabels()).toEqual(['Terminal']);
    // Not a disabled Transcript, not a greyed Diff: a tab nobody can open is
    // a promise the screen cannot keep, and the strip is a list rather than a
    // fixed set of four.
    expect(container.textContent).not.toContain('Transcript');
    expect(container.textContent).not.toContain('Approvals');
    expect(container.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('true');
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
