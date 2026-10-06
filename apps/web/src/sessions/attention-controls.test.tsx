// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  type ClientFrame,
  type MachineState,
} from '@agentplex/protocol';
import { MAX_REMEMBERED_ANSWERS } from '../store/answers.js';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import type { FrameIds } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { mintClientInstance } from '../store/client-instance.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { AttentionControls } from './attention-controls.js';
import { listSessions, type SessionListItem } from './session-list-model.js';

/**
 * The attention controls on a store walked through to a captured state, with
 * the captured replies deciding when a control stops waiting.
 *
 * The frame ids are injected so that the mute this control sends carries the
 * id the captured unmute answers; the correlation is by `replyTo`, and that is
 * the rule under test.
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

const attended = stateFrom(hubFrames.machineStateAttended);

function item(name: string): SessionListItem {
  const found = listSessions(attended).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the fixture has no session called ${name}`);
  return found;
}

function sentFrames(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the control sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

describe('the attention controls', () => {
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
      instance: mintClientInstance(),
      timers: createFakeTimers(),
      // Hello takes 1; the first command takes the id the captured unmute
      // answers.
      frameIds: idsOf([1, 5]),
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
      socket.deliver(hubFrames.machineStateAttended);
    });
    return socket;
  }

  async function mountOn(name: string): Promise<void> {
    await act(() => {
      root = createRoot(container);
      root.render(
        withProvider(<AttentionControls item={item(name)} store={store} scheme="dark" />),
      );
    });
  }

  function unmute(): HTMLButtonElement | null {
    return container.querySelector('button[aria-label="unmute docs-sweep"]');
  }

  async function pressUnmute(): Promise<void> {
    await act(() => {
      unmute()?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('waits on the unmute it sent, and stops when the captured reply answers it', async () => {
    const socket = await connected();
    await mountOn('docs-sweep');
    await pressUnmute();

    expect(sentFrames(socket).at(-1)).toEqual({
      type: 'session-mute',
      id: 5,
      storeId: 'store-universe',
      sessionId: 'session-docs-sweep',
      muted: false,
    });
    expect(unmute()?.disabled).toBe(true);

    await act(() => {
      socket.deliver(hubFrames.sessionUnmuted);
    });
    expect(unmute()?.disabled).toBe(false);
  });

  it('is enabled again once later replies have pushed its answer out', async () => {
    // The control keeps the id it unmuted with after the answer arrives, and
    // this one's row is still the one it was drawn from. Sixty-five other
    // answers push the unmute's out of the bounded map; an id nobody still
    // owes an answer to is nothing to wait for.
    const socket = await connected();
    await mountOn('docs-sweep');
    await pressUnmute();
    await act(() => {
      socket.deliver(hubFrames.sessionUnmuted);
    });

    const saved = JSON.parse(hubFrames.docSaved) as Record<string, unknown>;
    await act(() => {
      for (let n = 0; n <= MAX_REMEMBERED_ANSWERS; n += 1) {
        socket.deliver(JSON.stringify({ ...saved, replyTo: 100 + n }));
      }
    });

    expect(unmute()?.textContent).toBe('Unmute');
    expect(unmute()?.disabled).toBe(false);
  });

  it('is enabled again when the connection drops before the hub answers', async () => {
    const socket = await connected();
    await mountOn('docs-sweep');
    await pressUnmute();
    expect(unmute()?.disabled).toBe(true);

    await act(() => {
      socket.drop();
    });

    expect(unmute()?.disabled).toBe(false);
  });
});
