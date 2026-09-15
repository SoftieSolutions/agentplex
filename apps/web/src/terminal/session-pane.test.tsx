// @vitest-environment jsdom
import { sessionRefSchema } from '@agentplex/protocol';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeSocketFactory, type FakeSocketFactory } from '../store/fake-socket.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { createFakeEmulatorFactory, type FakeEmulator } from './fake-emulator.js';
import { FindBar } from './find-bar.js';
import { SessionPane } from './session-pane.js';

/**
 * The pane's own chrome as the user meets it: the find bar, opened by the
 * chord on a real pane and driven through the fake emulator, and the stop in
 * the header, drawn off a captured hub state.
 *
 * The fake is the point. What the bar owes anybody is that the question it
 * asks is the question that was typed and the answer it draws is the answer
 * it was given -- whether the answer is right is the emulator's business, and
 * `xterm-emulator.test.ts` holds it to that against real captured bytes. So
 * this file asserts on what the pane asked the seam for and on what it
 * rendered, and never on a buffer.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const SESSION = sessionRefSchema.parse({ storeId: 'store-observatory', sessionId: 'session-11' });

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
 * A store that never reaches a hub: the pane declares its interest in a
 * session on mount, and this lets that go somewhere harmless. Nothing in this
 * file asserts on a frame.
 */
function buildStore(): HubStore {
  return connectableStore().store;
}

/** The same store, with the socket kept so a test can play the hub on it. */
function connectableStore(): { store: HubStore; sockets: FakeSocketFactory } {
  const sockets = createFakeSocketFactory();
  const store = createHubStore({
    fetchTicket: () => Promise.resolve('ticket-1'),
    createSocket: (ticket) => sockets.create(ticket),
    timers: createFakeTimers(),
    frameIds: createFrameIdCounter(),
  });
  return { store, sockets };
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

describe('a session pane', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let emulators: ReturnType<typeof createFakeEmulatorFactory>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
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
    await mount(<SessionPane sessionRef={SESSION} store={buildStore()} emulators={emulators} />);
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

  function summary(): string {
    return container.querySelector('[role="status"]')?.textContent ?? '';
  }

  /**
   * The chord, from inside the pane: the registry is consulted by a
   * capture-phase handler on the pane's root, so the event has to be
   * dispatched on something the pane contains. The steer input is a fair
   * stand-in for wherever the user's focus happens to be.
   */
  async function pressChord(key: string): Promise<void> {
    const somewhereInThePane = container.querySelector('[aria-label="steer the agent"]');
    if (somewhereInThePane === null) throw new Error('the pane rendered no steer input');
    await act(() => {
      somewhereInThePane.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
  }

  async function press(target: Element, key: string): Promise<void> {
    await act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  }

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
    await rerender(<SessionPane sessionRef={SESSION} store={buildStore()} emulators={rebuilt} />);

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

  /**
   * A pane on a store that has been walked through to a captured hub state,
   * so the header draws off the same holders a real fleet published.
   */
  async function mountPaneOn(sessionId: string): Promise<void> {
    const { store, sockets } = connectableStore();
    await mount(
      <SessionPane
        sessionRef={sessionRefSchema.parse({ storeId: 'store-agentplex', sessionId })}
        store={store}
        emulators={emulators}
      />,
    );
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the pane dialled nothing');
    await act(() => {
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
