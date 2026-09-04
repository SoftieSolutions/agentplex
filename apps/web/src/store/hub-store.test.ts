import { describe, expect, it } from 'vitest';
import {
  parseClientFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  sessionRefSchema,
  storeIdSchema,
  type ClientFrame,
} from '@agentplex/protocol';
import { createFrameIdCounter } from './frame-ids.js';
import { createFakeSocketFactory, type FakeSocket } from './fake-socket.js';
import { createFakeTimers } from './timers.js';
import { createHubStore, type HubCommand, type HubStoreDependencies } from './hub-store.js';
import { hubFrames } from './hub-frames.fixture.js';

/**
 * The store's observable behaviour, driven through its seams: a fake socket a
 * test plays the hub on, fake timers for the backoff, and the captured frames
 * a real hub sent (`hub-frames.fixture.ts`) for everything inbound.
 */

const STORE_ID = storeIdSchema.parse('store-observatory');
const SESSION = sessionRefSchema.parse({
  storeId: 'store-observatory',
  sessionId: 'session-11',
});

const START: HubCommand = {
  type: 'session-start',
  storeId: STORE_ID,
  sessionId: null,
  provider: 'claude',
  prompt: null,
  server: null,
};

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(overrides: Partial<HubStoreDependencies> = {}) {
  const sockets = createFakeSocketFactory();
  const timers = createFakeTimers();
  let nextTicket = 0;
  const store = createHubStore({
    fetchTicket: () => Promise.resolve(`ticket-${(nextTicket += 1)}`),
    createSocket: (ticket) => sockets.create(ticket),
    timers,
    frameIds: createFrameIdCounter(),
    ...overrides,
  });
  return { store, sockets, timers };
}

/** What the store sent, read back through the hub's own parser. */
function sentFrames(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the store sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

type Harness = ReturnType<typeof harness>;

/** Subscribes, and walks the first connection through to established. */
async function establish(h: Harness): Promise<{ socket: FakeSocket; unsubscribe: () => void }> {
  const unsubscribe = h.store.subscribe(() => {});
  await settle();
  const socket = h.sockets.sockets[0];
  if (socket === undefined) throw new Error('no socket was dialled');
  socket.open();
  socket.deliver(hubFrames.welcome);
  return { socket, unsubscribe };
}

/** Fires the retry timer and walks the redial through to a fresh socket. */
async function redial(h: Harness): Promise<FakeSocket> {
  const before = h.sockets.sockets.length;
  h.timers.fireAll();
  await settle();
  const socket = h.sockets.sockets[before];
  if (socket === undefined) throw new Error('the retry did not dial');
  return socket;
}

describe('connection lifecycle', () => {
  it('connects when the first subscriber arrives and not before', async () => {
    const h = harness();
    await settle();
    expect(h.sockets.sockets).toHaveLength(0);
    expect(h.store.getSnapshot().phase).toBe('idle');

    const unsubscribe = h.store.subscribe(() => {});
    expect(h.store.getSnapshot().phase).toBe('connecting');
    await settle();
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.sockets.tickets).toEqual(['ticket-1']);

    const socket = h.sockets.sockets[0];
    socket?.open();
    expect(sentFrames(socket as FakeSocket)).toEqual([
      { type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION },
    ]);
    unsubscribe();
  });

  it('holds one socket for many subscribers and closes when the last leaves', async () => {
    const h = harness();
    const first = h.store.subscribe(() => {});
    const second = h.store.subscribe(() => {});
    await settle();
    expect(h.sockets.sockets).toHaveLength(1);

    first();
    expect(h.sockets.sockets[0]?.closedByStore).toBe(false);
    second();
    expect(h.sockets.sockets[0]?.closedByStore).toBe(true);
    expect(h.store.getSnapshot().phase).toBe('idle');
    // Nothing is looking, so nothing redials.
    expect(h.timers.pending).toBe(0);
  });

  it('a welcome establishes the connection and the machine state lands whole', async () => {
    const h = harness();
    const { socket } = await establish(h);
    expect(h.store.getSnapshot().phase).toBe('connected');
    expect(h.store.getSnapshot().hubId).toBe('hub-1');

    socket.deliver(hubFrames.machineState);
    expect(h.store.getSnapshot().machineState).toEqual(
      (JSON.parse(hubFrames.machineState) as { state: unknown }).state,
    );
  });

  it('notifies subscribers when the snapshot changes', async () => {
    const h = harness();
    let notified = 0;
    h.store.subscribe(() => {
      notified += 1;
    });
    const before = notified;
    await settle();
    h.sockets.sockets[0]?.open();
    h.sockets.sockets[0]?.deliver(hubFrames.welcome);
    expect(notified).toBeGreaterThan(before);
  });
});

describe('reconnecting', () => {
  it('backs off between attempts and resets after a connection holds', async () => {
    const h = harness();
    const { socket } = await establish(h);

    socket.drop();
    expect(h.store.getSnapshot().phase).toBe('reconnecting');
    expect(h.timers.delays).toEqual([500]);

    // The redial reaches a socket that drops before it is established.
    (await redial(h)).drop();
    expect(h.timers.delays).toEqual([500, 1_000]);
    (await redial(h)).drop();
    expect(h.timers.delays).toEqual([500, 1_000, 2_000]);

    // A connection that holds resets the ladder.
    const fourth = await redial(h);
    fourth.open();
    fourth.deliver(hubFrames.welcome);
    expect(h.store.getSnapshot().phase).toBe('connected');
    fourth.drop();
    expect(h.timers.delays).toEqual([500, 1_000, 2_000, 500]);
  });

  it('a failed ticket exchange is an ordinary connect failure, said in words', async () => {
    const h = harness({ fetchTicket: () => Promise.reject(new Error('hub unreachable')) });
    h.store.subscribe(() => {});
    await settle();
    expect(h.sockets.sockets).toHaveLength(0);
    expect(h.store.getSnapshot().phase).toBe('reconnecting');
    expect(h.store.getSnapshot().problem).toContain('could not get a connection ticket');
    expect(h.timers.pending).toBe(1);
  });

  it('a protocol version refusal stops the redialling', async () => {
    const h = harness();
    h.store.subscribe(() => {});
    await settle();
    const socket = h.sockets.sockets[0] as FakeSocket;
    socket.open();
    socket.deliver(hubFrames.refusalProtocolVersion);
    socket.drop();

    expect(h.store.getSnapshot().phase).toBe('failed');
    expect(h.store.getSnapshot().problem).toContain('protocol');
    expect(h.timers.pending).toBe(0);

    const outcome = h.store.sendCommand(START);
    expect(outcome.accepted).toBe(false);
  });
});

describe('commands', () => {
  it('sends a command immediately while connected, with a counter id', async () => {
    const h = harness();
    const { socket } = await establish(h);

    const outcome = h.store.sendCommand(START);
    expect(outcome).toEqual({ accepted: true, id: 2, delivery: 'sent' });
    expect(sentFrames(socket).at(-1)).toEqual({ ...START, id: 2 });
  });

  it('queues commands while down and flushes them, in order, on reconnect', async () => {
    const h = harness();
    const { socket } = await establish(h);
    socket.drop();

    const first = h.store.sendCommand(START);
    const second = h.store.sendCommand({
      type: 'session-stop',
      storeId: SESSION.storeId,
      sessionId: SESSION.sessionId,
    });
    expect(first).toEqual({ accepted: true, id: 2, delivery: 'queued' });
    expect(second).toEqual({ accepted: true, id: 3, delivery: 'queued' });
    expect(h.store.getSnapshot().commandQueue.queued).toBe(2);

    const next = await redial(h);
    next.open();
    next.deliver(hubFrames.welcome);

    const frames = sentFrames(next);
    expect(frames[0]).toEqual({ type: 'hello', id: 4, protocolVersion: PROTOCOL_VERSION });
    expect(frames.slice(1)).toEqual([
      { ...START, id: 2 },
      { type: 'session-stop', storeId: SESSION.storeId, sessionId: SESSION.sessionId, id: 3 },
    ]);
    expect(h.store.getSnapshot().commandQueue.queued).toBe(0);
  });

  it('refuses the command past the bound, in words, and drops nothing silently', async () => {
    const h = harness({ maxQueuedCommands: 2 });
    const { socket } = await establish(h);
    socket.drop();

    expect(h.store.sendCommand(START).accepted).toBe(true);
    expect(h.store.sendCommand(START).accepted).toBe(true);
    const overflow = h.store.sendCommand(START);
    expect(overflow).toEqual({
      accepted: false,
      reason:
        '2 commands are already waiting for the connection to return; this one was not accepted',
    });
    expect(h.store.getSnapshot().commandQueue).toEqual({
      queued: 2,
      capacity: 2,
      overflowed: overflow.accepted ? null : overflow.reason,
    });

    // The two that were accepted still flush; the refused one was refused, not
    // deferred.
    const next = await redial(h);
    next.open();
    next.deliver(hubFrames.welcome);
    expect(sentFrames(next)).toHaveLength(3);
    expect(h.store.getSnapshot().commandQueue.overflowed).toBeNull();
  });

  it("a refusal reply lands in the snapshot with the hub's own words", async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.sendCommand(START);

    socket.deliver(hubFrames.refusal);
    expect(h.store.getSnapshot().lastRefusal).toEqual({
      replyTo: 4,
      code: 'refused',
      message: 'no server the hub is paired with has that store mounted',
      holder: null,
    });
  });

  it('a session-started reply lands in the snapshot, correlated to its command', async () => {
    const h = harness();
    const { socket } = await establish(h);
    const outcome = h.store.sendCommand(START);
    if (!outcome.accepted) throw new Error(outcome.reason);

    // Captured from a real start: the hub names the machine it picked, and the
    // sessionId is null because the provider has not written one yet.
    socket.deliver(hubFrames.sessionStarted);
    expect(h.store.getSnapshot().lastStarted).toEqual({
      replyTo: outcome.id,
      storeId: 'store-agentplex',
      sessionId: null,
      server: 'registration-mbp-robert',
    });
  });

  it('a session-started reply clears the refusal that preceded it', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.sendCommand(START);

    socket.deliver(hubFrames.refusal);
    expect(h.store.getSnapshot().lastRefusal).not.toBeNull();
    socket.deliver(hubFrames.sessionStarted);
    expect(h.store.getSnapshot().lastRefusal).toBeNull();
  });

  it('drops the queue when the last subscriber leaves', async () => {
    const h = harness();
    const { socket, unsubscribe } = await establish(h);
    socket.drop();
    h.store.sendCommand(START);
    expect(h.store.getSnapshot().commandQueue.queued).toBe(1);

    unsubscribe();
    expect(h.store.getSnapshot().commandQueue.queued).toBe(0);
    expect(h.store.getSnapshot().phase).toBe('idle');
  });
});

describe('terminal input', () => {
  it('discards keystrokes while down, says so in words, and never queues them', async () => {
    const h = harness();
    const { socket } = await establish(h);
    socket.drop();

    const first = h.store.sendTerminalInput(SESSION, 'l');
    const second = h.store.sendTerminalInput(SESSION, 's');
    expect(first.delivered).toBe(false);
    expect(second.delivered).toBe(false);

    const view = h.store.getSnapshot().terminalInput;
    expect(view.discarded).toBe(2);
    expect(view.notice).toContain('2 keystrokes were discarded');
    expect(view.notice).toContain('not queued');

    // On reconnect nothing replays: the new socket carries the hello and only
    // the hello, and the notice about a spell that ended is gone.
    const next = await redial(h);
    next.open();
    next.deliver(hubFrames.welcome);
    expect(sentFrames(next)).toHaveLength(1);
    expect(h.store.getSnapshot().terminalInput).toEqual({ discarded: 0, notice: null });
  });

  it('sends keystrokes through the injected encoder while connected', async () => {
    const encoded: string[] = [];
    const h = harness({
      encodeTerminalInput: (ref, data, id) => {
        const text = JSON.stringify({ ref, data, id });
        encoded.push(text);
        return text;
      },
    });
    const { socket } = await establish(h);

    const outcome = h.store.sendTerminalInput(SESSION, 'l');
    expect(outcome).toEqual({ delivered: true });
    expect(socket.sent.at(-1)).toBe(encoded[0]);
  });

  it('says it cannot send terminal input while the protocol has no frame for it', async () => {
    const h = harness();
    await establish(h);
    const outcome = h.store.sendTerminalInput(SESSION, 'l');
    expect(outcome).toEqual({
      delivered: false,
      reason: 'this build cannot send terminal input yet',
    });
  });
});

describe('subscriptions', () => {
  it('replays the layout subscription on every connection and never queues it', async () => {
    const h = harness();
    const unsubscribe = h.store.subscribe(() => {});
    // Interest declared while nothing is connected: nothing enters the command
    // queue, and nothing is sent until there is a connection to say it on.
    h.store.subscribeLayout();
    expect(h.store.getSnapshot().commandQueue.queued).toBe(0);

    await settle();
    const socket = h.sockets.sockets[0] as FakeSocket;
    socket.open();
    socket.deliver(hubFrames.welcome);
    expect(sentFrames(socket).at(-1)).toEqual({ type: 'layout-request', id: 2 });

    socket.deliver(hubFrames.layout);
    expect(h.store.getSnapshot().layout).toEqual([]);

    // Across a drop it is replayed with a fresh id, still bypassing the queue.
    socket.drop();
    expect(h.store.getSnapshot().commandQueue.queued).toBe(0);
    const next = await redial(h);
    next.open();
    next.deliver(hubFrames.welcome);
    expect(sentFrames(next)).toEqual([
      { type: 'hello', id: 3, protocolVersion: PROTOCOL_VERSION },
      { type: 'layout-request', id: 4 },
    ]);
    unsubscribe();
  });

  it('replays the pane layout subscription and keeps the two null levels apart', async () => {
    const h = harness();
    const unsubscribe = h.store.subscribe(() => {});
    h.store.subscribePaneLayout();
    // Not answered yet: the snapshot says so with the outer null.
    expect(h.store.getSnapshot().paneLayout).toBeNull();
    expect(h.store.getSnapshot().commandQueue.queued).toBe(0);

    await settle();
    const socket = h.sockets.sockets[0] as FakeSocket;
    socket.open();
    socket.deliver(hubFrames.welcome);
    expect(sentFrames(socket).at(-1)).toEqual({ type: 'pane-layout-request', id: 2 });

    // Answered: the hub has never stored one, which is an answer, not absence.
    socket.deliver(hubFrames.paneLayoutEmpty);
    expect(h.store.getSnapshot().paneLayout).toEqual({ layout: null });

    // Across a drop it is replayed with a fresh id, still bypassing the queue.
    socket.drop();
    const next = await redial(h);
    next.open();
    next.deliver(hubFrames.welcome);
    expect(sentFrames(next).at(-1)).toEqual({ type: 'pane-layout-request', id: 4 });

    // A stored arrangement arrives as characters the store does not read.
    next.deliver(hubFrames.paneLayout);
    const answered = h.store.getSnapshot().paneLayout;
    expect(answered?.layout).toContain('"kind":"pane"');
    unsubscribe();
  });

  it('sends a pane layout save as a command and settles it on the acknowledgement', async () => {
    const h = harness();
    const { socket, unsubscribe } = await establish(h);

    const outcome = h.store.sendCommand({
      type: 'pane-layout-save',
      layout: '{"v":1,"root":{"kind":"pane","content":{"type":"empty"}}}',
    });
    expect(outcome).toEqual({ accepted: true, id: 2, delivery: 'sent' });
    expect(sentFrames(socket).at(-1)).toEqual({
      type: 'pane-layout-save',
      id: 2,
      layout: '{"v":1,"root":{"kind":"pane","content":{"type":"empty"}}}',
    });

    // The captured acknowledgement names id 5; a drop before it would have
    // worded one unanswered command, so answer the id the fixture carries by
    // sending enough saves to reach it.
    h.store.sendCommand({ type: 'pane-layout-save', layout: '{}' });
    h.store.sendCommand({ type: 'pane-layout-save', layout: '{}' });
    h.store.sendCommand({ type: 'pane-layout-save', layout: '{}' });
    socket.deliver(hubFrames.paneLayoutSaved);
    socket.drop();
    // Three still unanswered, not four: the acknowledged save is settled.
    expect(h.store.getSnapshot().problem).toContain('3 commands');
    unsubscribe();
  });

  it('replays session subscriptions through the injected encoder until unsubscribed', async () => {
    const h = harness({
      encodeSessionSubscription: (ref, id) => JSON.stringify({ subscribe: ref, id }),
    });
    const { socket } = await establish(h);

    const unsubscribe = h.store.subscribeSession(SESSION);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ subscribe: SESSION, id: 2 }));

    socket.drop();
    const next = await redial(h);
    next.open();
    next.deliver(hubFrames.welcome);
    expect(next.sent.at(-1)).toBe(JSON.stringify({ subscribe: SESSION, id: 4 }));

    unsubscribe();
    next.drop();
    const last = await redial(h);
    last.open();
    last.deliver(hubFrames.welcome);
    expect(sentFrames(last)).toHaveLength(1);
  });

  it('tracks session interest even while the protocol has no frame to send', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.subscribeSession(SESSION);
    // Nothing on the wire and nothing queued: the interest waits for the
    // milestone that gives it a frame.
    expect(sentFrames(socket)).toHaveLength(1);
    expect(h.store.getSnapshot().commandQueue.queued).toBe(0);
  });
});

describe('degrading', () => {
  it('drops an unreadable hub frame in words and keeps reading', async () => {
    const h = harness();
    const { socket } = await establish(h);

    socket.deliver('not a frame at all');
    expect(h.store.getSnapshot().phase).toBe('connected');
    expect(h.store.getSnapshot().problem).toContain('could not read');

    socket.deliver(hubFrames.machineState);
    expect(h.store.getSnapshot().machineState).not.toBeNull();
  });

  it('treats a hub protocol-error as final: our next frame would be as unreadable', async () => {
    const h = harness();
    const { socket } = await establish(h);
    socket.deliver(hubFrames.protocolError);
    socket.drop();
    expect(h.store.getSnapshot().phase).toBe('failed');
    expect(h.timers.pending).toBe(0);
  });
});

describe('frame ids', () => {
  it('mints every id from the counter, in order, across reconnects', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.sendCommand(START);
    socket.drop();
    h.store.sendCommand(START);
    const next = await redial(h);
    next.open();
    next.deliver(hubFrames.welcome);

    const ids = [...sentFrames(socket), ...sentFrames(next)]
      .map((frame) => ('id' in frame ? frame.id : null))
      .filter((id): id is number => id !== null);
    // Wire order is not mint order -- the queued command (3) was minted before
    // the redial's hello (4) but sent after it. What the counter guarantees is
    // exactly what shows: every id minted once, none repeated, none random.
    expect(ids).toEqual([1, 2, 4, 3]);
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });
});
