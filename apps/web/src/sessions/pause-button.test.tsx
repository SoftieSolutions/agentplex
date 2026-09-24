// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  type ClientFrame,
  type MachineState,
  type SessionHolder,
} from '@agentplex/protocol';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import type { FrameIds } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { colorForTone } from '../ui/tokens.js';
import { PauseButton } from './pause-button.js';
import { PAUSE_REQUESTED_WORDS } from './pause-model.js';

/**
 * The button on a store walked through to a captured state, with the holders
 * a real fleet published deciding what it offers, and the captured replies
 * deciding what it says afterwards.
 *
 * The frame ids are injected so that the command this button sends carries
 * the id the captured reply answers. A real client's ids are whatever its
 * counter reached; the correlation rule is by `replyTo`, and that is the rule
 * under test.
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

const withPaused = stateFrom(hubFrames.machineStatePaused);

function holderOf(sessionId: string): SessionHolder | null {
  for (const store of withPaused.stores) {
    for (const row of store.sessions) {
      if (row.descriptor.sessionId === sessionId) return row.holder;
    }
  }
  throw new Error(`the fixture has no session ${sessionId}`);
}

const ref = (sessionId: string) =>
  sessionRefSchema.parse({ storeId: 'store-agentplex', sessionId });

function sentFrames(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the button sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

/** jsdom normalises an inline hex colour to this form. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String(value >> 16)}, ${String((value >> 8) & 255)}, ${String(value & 255)})`;
}

describe('the pause button', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  let watching: (() => void) | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      // Hello takes 1; the first command takes the id the captured pause
      // reply answers, the second the id the captured resume answers.
      frameIds: idsOf([1, 7, 8]),
    });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    watching?.();
    watching = null;
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

  async function connected(): Promise<FakeSocket> {
    watching = store.subscribe(() => {});
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStatePaused);
    });
    return socket;
  }

  async function mountOn(sessionId: string, holder = holderOf(sessionId)): Promise<void> {
    await act(() => {
      root = createRoot(container);
      root.render(
        withProvider(
          <PauseButton store={store} sessionRef={ref(sessionId)} holder={holder} scheme="dark" />,
        ),
      );
    });
  }

  function button(): HTMLButtonElement | null {
    return container.querySelector('button');
  }

  async function press(): Promise<void> {
    await act(() => {
      button()?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('offers Pause on a held session, busy or not, and sends the session alone', async () => {
    const socket = await connected();
    await mountOn('session-fix-auth');
    expect(button()?.textContent).toBe('Pause');
    expect(button()?.getAttribute('aria-label')).toBe('pause session-fix-auth');

    await press();

    expect(sentFrames(socket).at(-1)).toEqual({
      type: 'session-pause',
      id: 7,
      storeId: 'store-agentplex',
      sessionId: 'session-fix-auth',
    });
    expect(button()?.textContent).toBe('Pausing');
    expect(button()?.disabled).toBe(true);
  });

  it('stops waiting when the captured pause reply answers its frame', async () => {
    const socket = await connected();
    await mountOn('session-fix-auth');
    await press();

    await act(() => {
      socket.deliver(hubFrames.sessionPaused);
    });

    expect(button()?.disabled).toBe(false);
  });

  it('offers Resume on a paused holder and sends a resume', async () => {
    const socket = await connected();
    await mountOn('session-docs-index');
    expect(button()?.textContent).toBe('Resume');
    expect(button()?.getAttribute('aria-label')).toBe('resume session-docs-index');

    await press();

    expect(sentFrames(socket).at(-1)).toEqual({
      type: 'session-resume',
      id: 7,
      storeId: 'store-agentplex',
      sessionId: 'session-docs-index',
    });
    expect(button()?.textContent).toBe('Resuming');
  });

  it('says the boundary sentence beside Resume while a pause is only requested', async () => {
    await connected();
    const held = holderOf('session-fix-auth');
    if (held === null) throw new Error('fix-auth is not held');
    await mountOn('session-fix-auth', { ...held, pause: 'requested' });

    expect(button()?.textContent).toBe('Resume');
    const note = container.querySelector('[role="status"]');
    expect(note?.textContent).toBe(PAUSE_REQUESTED_WORDS);
    expect((note as HTMLElement | null)?.style.color).toBe(rgb(colorForTone('paused', 'dark')));
  });

  it('shows a refusal in the blocked tone beside the button, leaving the session as it was', async () => {
    const socket = await connected();
    await mountOn('session-docs-index');
    await press();

    // The captured refusal answers frame 4; this control asked with 7. It
    // must not be read as this button's. A refusal that does answer 7 is.
    await act(() => {
      socket.deliver(hubFrames.refusalHeldBusy);
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(button()?.disabled).toBe(true);

    const refusal = JSON.parse(hubFrames.refusal) as { replyTo: number };
    await act(() => {
      socket.deliver(JSON.stringify({ ...refusal, replyTo: 7 }));
    });
    const status = container.querySelector<HTMLElement>('[role="status"]');
    expect(status?.textContent).toBe('no server the hub is paired with has that store mounted');
    expect(status?.style.color).toBe(rgb(colorForTone('blocked', 'dark')));
    // Still Resume: the holder still says paused, and a refusal changed nothing.
    expect(button()?.textContent).toBe('Resume');
    expect(button()?.disabled).toBe(false);
  });

  it('draws nothing for a session nobody is running', async () => {
    await connected();
    await mountOn('session-spike-wasm', null);

    expect(button()).toBeNull();
  });
});
