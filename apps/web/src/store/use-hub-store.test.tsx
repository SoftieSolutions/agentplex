// @vitest-environment jsdom
import { act, Profiler, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  parseHubFrame,
  parseTextFrame,
  sessionIdSchema,
  sessionRefSchema,
  storeIdSchema,
  type MachineState,
  type SessionHolder,
} from '@agentplex/protocol';
import { ApprovalControls } from '../sessions/approval-controls.js';
import { AttentionControls } from '../sessions/attention-controls.js';
import { PauseButton } from '../sessions/pause-button.js';
import { listSessions, type SessionListItem } from '../sessions/session-list-model.js';
import { StopButton } from '../sessions/stop-button.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { createFakeSocketFactory, type FakeSocket } from './fake-socket.js';
import type { FrameIds } from './frame-ids.js';
import { hubFrames } from './hub-frames.fixture.js';
import { mintClientInstance } from './client-instance.js';
import { createHubStore, type HubStore } from './hub-store.js';
import { createFakeTimers } from './timers.js';
import { shallowEqual, useHubSelector, useHubSnapshot } from './use-hub-store.js';

/**
 * What a component re-renders for, counted in commits.
 *
 * The frame that matters is terminal output, because it is the one that
 * arrives at the speed an agent prints. Every test here pairs the component
 * under test with one that reads the whole snapshot, so that a count which
 * stays still is a component declining a publication rather than a frame that
 * never published: a chunk that moves no fact publishes nothing, and a test
 * built on one would pass for every implementation.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

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

/** Ids in the order given, then counting on: hello takes the first. */
function idsOf(sequence: readonly number[]): FrameIds {
  let index = 0;
  let last = sequence.at(-1) ?? 0;
  return {
    next() {
      const fixed = sequence[index];
      index += 1;
      if (fixed !== undefined) return frameIdSchema.parse(fixed);
      last += 1;
      return frameIdSchema.parse(last);
    },
  };
}

const populated = stateFrom(hubFrames.machineStatePopulated);

/**
 * The captured session with an open request, as the list hands it to a card.
 * Read off the fixture rather than the store: the controls take the row as a
 * prop, and what is under test is what they select from the store on top.
 */
function askingItem(): SessionListItem {
  const item = listSessions(stateFrom(hubFrames.machineStateApproval)).find(
    (candidate) => candidate.approval !== null,
  );
  if (item === undefined) throw new Error('the captured state holds no open request');
  return item;
}

function holderOf(sessionId: string): SessionHolder | null {
  for (const store of populated.stores) {
    for (const row of store.sessions) {
      if (row.descriptor.sessionId === sessionId) return row.holder;
    }
  }
  throw new Error(`the fixture has no session ${sessionId}`);
}

/** What the captured terminal frames were captured watching. */
const CAPTURED_TARGET = {
  by: 'session',
  storeId: storeIdSchema.parse('store-work'),
  sessionId: sessionIdSchema.parse('session-build'),
} as const;

/** The session the captured `session-stopped` reply names, and whose holder is stoppable. */
const STOPPED = sessionRefSchema.parse({
  storeId: 'store-agentplex',
  sessionId: 'session-migrate-db',
});

/** Reads the whole snapshot, and so commits on every publication. */
function WholeSnapshot({ store }: { readonly store: HubStore }): JSX.Element {
  const snapshot = useHubSnapshot(store);
  return <span>{snapshot.terminals.size}</span>;
}

/** Selects a fresh object on every call, equal in content every time. */
function FreshSelection({ store }: { readonly store: HubStore }): JSX.Element {
  const selected = useHubSelector(store, (snapshot) => ({ phase: snapshot.phase }), shallowEqual);
  return <span>{selected.phase}</span>;
}

describe('what a hub selector re-renders for', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  let watching: (() => void) | null = null;
  let stopWatchingTerminal: (() => void) | null = null;
  let commits: Map<string, number>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    commits = new Map();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      instance: mintClientInstance(),
      timers: createFakeTimers(),
      // Hello takes 1, the terminal subscription the id the captured
      // `session-subscribed` answers, and the stop the id the captured
      // `session-stopped` answers.
      frameIds: idsOf([1, 2, 6]),
    });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    stopWatchingTerminal?.();
    stopWatchingTerminal = null;
    watching?.();
    watching = null;
    container.remove();
  });

  function counted(id: string, element: JSX.Element): JSX.Element {
    return (
      <Profiler
        id={id}
        onRender={(profiled) => {
          commits.set(profiled, (commits.get(profiled) ?? 0) + 1);
        }}
      >
        {element}
      </Profiler>
    );
  }

  function count(id: string): number {
    return commits.get(id) ?? 0;
  }

  /** Connected, with a stoppable fleet published and the captured terminal attached. */
  async function attached(): Promise<FakeSocket> {
    watching = store.subscribe(() => {});
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStatePopulated);
      stopWatchingTerminal = store.watchTerminal(CAPTURED_TARGET);
      socket.deliver(hubFrames.sessionSubscribed);
    });
    return socket;
  }

  async function mount(element: JSX.Element): Promise<void> {
    await act(() => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          {element}
        </MantineProvider>,
      );
    });
  }

  it('leaves a stop button alone for terminal output, and commits for its own answer', async () => {
    const socket = await attached();
    await mount(
      <>
        {counted('whole', <WholeSnapshot store={store} />)}
        {counted(
          'stop',
          <StopButton
            store={store}
            sessionRef={STOPPED}
            holder={holderOf('session-migrate-db')}
            scheme="dark"
          />,
        )}
      </>,
    );
    await act(() => {
      container
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('button')?.textContent).toBe('Stopping');

    const whole = count('whole');
    const stop = count('stop');
    // The first chunk on an attached terminal: it moves a fact (this pane has
    // now printed), so the snapshot is published and a whole-snapshot reader
    // commits. The stop button has nothing of it to draw.
    await act(() => {
      socket.deliver(hubFrames.terminalOutput);
    });
    expect(count('whole')).toBe(whole + 1);
    expect(count('stop')).toBe(stop);

    await act(() => {
      socket.deliver(hubFrames.sessionStopped);
    });
    expect(count('stop')).toBe(stop + 1);
    expect(container.querySelector('button')?.textContent).toBe('Stop');
  });

  it('leaves every leaf control alone for terminal output', async () => {
    const socket = await attached();
    const item = askingItem();
    await mount(
      <>
        {counted('whole', <WholeSnapshot store={store} />)}
        {counted(
          'pause',
          <PauseButton
            store={store}
            sessionRef={STOPPED}
            holder={holderOf('session-migrate-db')}
            scheme="dark"
          />,
        )}
        {counted('attention', <AttentionControls item={item} store={store} scheme="dark" />)}
        {counted(
          'approval',
          <ApprovalControls
            approval={item.approval}
            name={item.name}
            store={store}
            scheme="dark"
            project={{ kind: 'unplaced' }}
          />,
        )}
      </>,
    );
    // Each of them drew something, so a count that stays still is a control
    // declining the publication rather than one that rendered nothing.
    for (const label of ['pause', 'mute', 'allow']) {
      expect(container.querySelector(`button[aria-label^="${label} "]`)).not.toBeNull();
    }

    const before = new Map(commits);
    await act(() => {
      socket.deliver(hubFrames.terminalOutput);
    });
    expect(count('whole')).toBe((before.get('whole') ?? 0) + 1);
    for (const id of ['pause', 'attention', 'approval']) {
      expect({ id, commits: count(id) }).toEqual({ id, commits: before.get(id) });
    }
  });

  it('answers an equal selection with the value it already had', async () => {
    const socket = await attached();
    await mount(
      <>
        {counted('whole', <WholeSnapshot store={store} />)}
        {counted('fresh', <FreshSelection store={store} />)}
      </>,
    );

    const whole = count('whole');
    const fresh = count('fresh');
    await act(() => {
      socket.deliver(hubFrames.terminalOutput);
    });
    expect(count('whole')).toBe(whole + 1);
    expect(count('fresh')).toBe(fresh);
    expect(container.textContent).toContain('connected');
  });
});

describe('shallowEqual', () => {
  it('compares own fields by identity, one level down', () => {
    const shared = { nested: true };
    expect(shallowEqual({ kind: 'idle' }, { kind: 'idle' })).toBe(true);
    expect(shallowEqual({ a: 1, b: shared }, { a: 1, b: shared })).toBe(true);
    expect(shallowEqual({ a: 1, b: { nested: true } }, { a: 1, b: { nested: true } })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(shallowEqual({ kind: 'refused', words: 'no' }, { kind: 'refused', words: 'not' })).toBe(
      false,
    );
    expect(shallowEqual(null, null)).toBe(true);
    expect(shallowEqual({ kind: 'idle' }, null)).toBe(false);
  });
});
