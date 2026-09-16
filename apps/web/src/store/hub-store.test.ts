import { describe, expect, it } from 'vitest';
import {
  docNameSchema,
  nodeIdSchema,
  parseClientFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  serverRegistrationIdSchema,
  sessionRefSchema,
  storeIdSchema,
  type CatalogueQuery,
  type ClientFrame,
  type FrameId,
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
  project: null,
};

const STOP: HubCommand = {
  type: 'session-stop',
  storeId: SESSION.storeId,
  sessionId: SESSION.sessionId,
};

/**
 * A browse of one machine's roots, which is how a picker starts.
 *
 * A command and not a subscription: somebody asked a question once, and nothing
 * re-asks it on a reconnection.
 */
const BROWSE: HubCommand = {
  type: 'directory-list',
  server: 'registration-mbp-robert' as never,
  directory: null,
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
      replyTo: 6,
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

  it('reads a directory listing the hub actually sent, correlated to its browse', async () => {
    const h = harness();
    const { socket } = await establish(h);
    // Two browses, because `directory-listing` is answered on the same channel
    // as a start and the ids are what keep the two apart. The first command is
    // the start above so that the reply below cannot be matched by position.
    h.store.sendCommand(START);
    const roots = h.store.sendCommand(BROWSE);
    if (!roots.accepted) throw new Error(roots.reason);

    // Captured from a real server answering out of real configuration: the
    // roots listing carries no directory and its entries are the roots
    // themselves, absolute.
    socket.deliver(hubFrames.directoryRoots);
    expect(h.store.getSnapshot().lastListing).toEqual({
      replyTo: roots.id,
      directory: null,
      roots: ['/Users/robert/code'],
      entries: [{ name: '/Users/robert/code', kind: 'directory' }],
      truncated: false,
    });

    // And one step down, where an entry is a single segment and the kinds the
    // server reports include the one it will not follow.
    socket.deliver(hubFrames.directoryListing);
    expect(h.store.getSnapshot().lastListing).toMatchObject({
      directory: '/Users/robert/code',
      entries: [
        { name: '.config', kind: 'directory' },
        { name: 'agentplex', kind: 'directory' },
        { name: 'notes.md', kind: 'file' },
        { name: 'scratch', kind: 'other' },
      ],
    });
  });

  it('a directory listing clears the refusal that preceded it', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.sendCommand(START);
    h.store.sendCommand(BROWSE);

    socket.deliver(hubFrames.refusal);
    expect(h.store.getSnapshot().lastRefusal).not.toBeNull();
    socket.deliver(hubFrames.directoryRoots);
    expect(h.store.getSnapshot().lastRefusal).toBeNull();
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

  it('a session-stopped reply is kept whole, not dropped for its side effects', async () => {
    const h = harness();
    const { socket } = await establish(h);

    // Captured from a real stop: the reply names the session it landed on and
    // the machine the hub resolved it to, neither of which the client sent.
    socket.deliver(hubFrames.sessionStopped);
    expect(h.store.getSnapshot().lastStopped).toEqual({
      replyTo: 6,
      storeId: 'store-agentplex',
      sessionId: 'session-migrate-db',
      server: 'registration-mbp-robert',
    });
  });

  it('a session-stopped reply clears the refusal that preceded it', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.sendCommand(STOP);

    socket.deliver(hubFrames.refusalHeldBusy);
    expect(h.store.getSnapshot().lastRefusal).not.toBeNull();
    socket.deliver(hubFrames.sessionStopped);
    expect(h.store.getSnapshot().lastRefusal).toBeNull();
  });

  it('keeps the holder a refusal names, which is what makes it more than a no', async () => {
    const h = harness();
    const { socket } = await establish(h);

    socket.deliver(hubFrames.refusalHeldStoppable);
    expect(h.store.getSnapshot().lastRefusal?.holder).toEqual({
      server: 'registration-mbp-robert',
      stoppable: true,
    });
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

describe('requests', () => {
  const A_PAIRING = {
    type: 'server-pair',
    label: 'gpu-box-01',
    address: 'wss://gpu-box-01.example:8443',
    token: 'the-token-the-server-printed',
  } as const;

  it('sends now and never queues, because a queued one holds a credential', async () => {
    // The rule this path exists for: a pair frame carries the token a server
    // printed, and a queue is a place for it to sit in memory with nobody
    // watching it for as long as the tab is open.
    const h = harness();
    const { socket } = await establish(h);
    socket.drop();

    const outcome = await h.store.request(A_PAIRING);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('nothing was sent');
    expect(h.store.getSnapshot().commandQueue.queued).toBe(0);
  });

  it('does not replay one after a reconnection, the way a subscription is', async () => {
    const h = harness();
    const { socket } = await establish(h);
    socket.drop();
    await h.store.request(A_PAIRING);

    const next = await redial(h);
    next.open();
    next.deliver(hubFrames.welcome);

    expect(sentFrames(next).map((frame) => frame.type)).toEqual(['hello']);
    for (const text of next.sent) expect(text).not.toContain('the-token-the-server-printed');
  });

  it('answers whoever asked when the connection goes before the hub does', async () => {
    const h = harness();
    const { socket } = await establish(h);

    const answer = h.store.request(A_PAIRING);
    socket.drop();

    await expect(answer).resolves.toMatchObject({ ok: false });
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

/**
 * The project frames, and the tree frames beside them.
 *
 * What the store does beyond remembering an answer is ask for the layout
 * again, and it does that on one frame only: `catalogue-changed`, which the
 * hub broadcasts after every change to the tree whoever made it. It used to
 * ask on each reply instead, which had the shape of the problem wrong in both
 * directions -- the client that made the change got two asks once the
 * broadcast existed, and every other tab got none at all.
 *
 * It asks only when something is watching the tree: a re-ask nobody is
 * listening for is a frame sent for nothing.
 */
describe('projects and the tree', () => {
  const CREATE: HubCommand = {
    type: 'project-create',
    name: 'agentplex',
    directory: '/Users/robert/code/agentplex',
  };

  it('keeps the answer with the node id the project will be named by', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.sendCommand(CREATE);

    socket.deliver(hubFrames.projectCreated);

    expect(h.store.getSnapshot().lastProjectCreated).toEqual({ replyTo: 5, nodeId: 'hub-5' });
    expect(h.store.getSnapshot().lastRefusal).toBeNull();
  });

  it('asks for the tree again when the hub says the tree changed', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.subscribeLayout();
    const before = sentFrames(socket).length;

    socket.deliver(hubFrames.catalogueChanged);

    expect(sentFrames(socket).slice(before)).toEqual([{ type: 'layout-request', id: 3 }]);
  });

  it('asks for nothing when no screen is watching the tree', async () => {
    const h = harness();
    const { socket } = await establish(h);
    const before = sentFrames(socket).length;

    socket.deliver(hubFrames.catalogueChanged);

    expect(sentFrames(socket).slice(before)).toEqual([]);
  });

  it('asks nothing on a reply, because the broadcast is what says the tree moved', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.subscribeLayout();
    const before = sentFrames(socket).length;

    for (const frame of [
      hubFrames.projectCreated,
      hubFrames.nodeCreated,
      hubFrames.nodeRenamed,
      hubFrames.nodeMoved,
      hubFrames.nodeRemoved,
      hubFrames.nodeRemovalForgotten,
    ]) {
      socket.deliver(frame);
    }

    expect(sentFrames(socket).slice(before)).toEqual([]);
  });

  it('keeps the id of a folder it made, and nothing for the four edits that make none', async () => {
    const h = harness();
    const { socket } = await establish(h);

    socket.deliver(hubFrames.nodeCreated);
    expect(h.store.getSnapshot().lastTreeChange).toEqual({ replyTo: 8, nodeId: 'hub-7' });

    socket.deliver(hubFrames.nodeMoved);
    expect(h.store.getSnapshot().lastTreeChange).toEqual({ replyTo: 9, nodeId: null });

    socket.deliver(hubFrames.nodeRemoved);
    expect(h.store.getSnapshot().lastTreeChange).toEqual({ replyTo: 11, nodeId: null });

    socket.deliver(hubFrames.nodeRemovalForgotten);
    expect(h.store.getSnapshot().lastTreeChange).toEqual({ replyTo: 12, nodeId: null });
  });

  it('keeps the machine on a refusal that names one, so a stop can be offered', async () => {
    const h = harness();
    const { socket } = await establish(h);

    socket.deliver(hubFrames.refusalHolder);

    expect(h.store.getSnapshot().lastRefusal).toEqual({
      replyTo: 10,
      code: 'refused',
      message: 'this session is still running; stop it first, and then remove it',
      holder: { server: 'registration-mbp-robert', stoppable: false },
    });

    // A later yes clears it: the last thing the hub said is no longer a no.
    socket.deliver(hubFrames.nodeRemoved);
    expect(h.store.getSnapshot().lastRefusal).toBeNull();
  });

  it('queues a tree edit while the connection is down, like any other once-only intent', async () => {
    const h = harness();
    h.store.subscribe(() => {});
    await settle();

    const outcome = h.store.sendCommand({ type: 'node-remove', nodeId: 'hub-2' as never });

    expect(outcome).toMatchObject({ accepted: true, delivery: 'queued' });
    const socket = h.sockets.sockets[0] as FakeSocket;
    socket.open();
    socket.deliver(hubFrames.welcome);
    expect(sentFrames(socket).at(-1)).toEqual({ type: 'node-remove', id: 1, nodeId: 'hub-2' });
  });

  it('reads the document node the hub put under that project', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.subscribeLayout();

    socket.deliver(hubFrames.layoutWithProject);

    const layout = h.store.getSnapshot().layout ?? [];
    expect(layout.filter((node) => node.kind === 'doc')).toEqual([
      {
        id: 'hub-6',
        parentId: 'hub-5',
        kind: 'doc',
        position: 0,
        // The file's name, and `named` because the user typed it: nothing
        // discovered a document, so nothing may retitle one.
        name: 'plan.md',
        named: true,
        // A document anchors no session. It is a file on a machine, and the
        // anchor is the tree's pointer at a transcript.
        anchor: null,
      },
    ]);
  });

  it('reads a tree with a project in it, exactly as the hub sent it', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.subscribeLayout();

    socket.deliver(hubFrames.layoutWithProject);

    const layout = h.store.getSnapshot().layout ?? [];
    expect(layout.filter((node) => node.kind === 'project')).toEqual([
      {
        id: 'hub-5',
        parentId: null,
        kind: 'project',
        position: 2,
        name: 'agentplex (main checkout)',
        named: true,
        anchor: null,
      },
    ]);
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

/**
 * The catalogue query: the one request on this store shaped as a promise.
 *
 * Everything else here is intent whose answer belongs on the screen that asked,
 * and this is a read whose caller has to do something with the answer before it
 * can draw: keep the cursor, append to what it has, decide whether to ask
 * again. So the correlation the store already does -- id out, `replyTo` back --
 * is what settles the promise, and the page lands in the snapshot as well for
 * the re-issue that has no caller.
 */
/**
 * A captured frame re-addressed to the id this store actually minted.
 *
 * `replyTo` is the envelope's correlation id and not a word the hub said about
 * the world, and it is the only field touched. The capture drives a long
 * conversation and its ids are wherever that conversation reached; a test that
 * had to mint fourteen frames to line them up would be a test about counting.
 * Everything the store reads off the page is exactly what the hub sent.
 */
function addressedTo(frame: string, replyTo: FrameId): string {
  return JSON.stringify({ ...(JSON.parse(frame) as Record<string, unknown>), replyTo });
}

/** The id of the last frame this store put on the wire. */
function lastSentId(socket: FakeSocket): FrameId {
  const sent = sentFrames(socket).at(-1);
  if (sent === undefined || !('id' in sent)) throw new Error('nothing with an id was sent');
  return sent.id;
}

const CATALOGUE: CatalogueQuery = {
  view: 'list',
  groupBy: 'server',
  sort: { key: 'name', direction: 'asc' },
  filter: {},
  cursor: null,
  limit: 1,
};

describe('the catalogue query', () => {
  it('answers the caller that asked with the page the hub sent', async () => {
    const h = harness();
    const { socket } = await establish(h);

    const asking = h.store.queryCatalogue(CATALOGUE);
    expect(sentFrames(socket).at(-1)).toMatchObject({ type: 'catalogue-query', groupBy: 'server' });

    socket.deliver(addressedTo(hubFrames.cataloguePagePartial, lastSentId(socket)));
    const page = await asking;

    // The session row rode along whole, which is what "the client joins
    // nothing" means: the page carries the same reading the machine state does.
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.session?.source).toBe('registration-mbp-robert');
    expect(page.items[0]?.group).toEqual({
      key: 'registration-mbp-robert',
      label: 'mbp-robert',
      unfiled: false,
    });
    expect(page.nextCursor).not.toBeNull();
    expect(h.store.getSnapshot().catalogue).toEqual(page);
  });

  it('reads a tree page as the hub sent it, parents before children and the depth on the row', async () => {
    const h = harness();
    const { socket } = await establish(h);

    const asking = h.store.queryCatalogue({
      ...CATALOGUE,
      view: 'tree',
      groupBy: 'none',
      limit: 2,
    });
    socket.deliver(addressedTo(hubFrames.catalogueTreePagePartial, lastSentId(socket)));
    const first = await asking;

    expect(first.total).toBe(6);
    expect(first.nextCursor).not.toBeNull();

    const resuming = h.store.queryCatalogue({
      ...CATALOGUE,
      view: 'tree',
      groupBy: 'none',
      cursor: first.nextCursor,
    });
    socket.deliver(addressedTo(hubFrames.catalogueTreePage, lastSentId(socket)));
    const rest = await resuming;

    // A container and its child, on one page and in that order: the hub runs
    // the cut forward rather than back, so a page boundary never falls between
    // a parent and its first child -- which is what lets the client indent off
    // the depth on the row instead of walking a parent chain it may not hold.
    const folder = rest.items.findIndex((item) => item.kind === 'folder');
    const child = rest.items.findIndex((item) => item.kind === 'project');
    expect(folder).toBeGreaterThanOrEqual(0);
    expect(child).toBe(folder + 1);
    expect(rest.items[child]?.parentId).toBe(rest.items[folder]?.id);
    expect(rest.items[child]?.depth).toBe(1);
    // The list view drops containers; this is the view that does not.
    expect(rest.items.some((item) => item.session !== null)).toBe(true);
  });

  it('rejects with the hub sentence when the cursor has gone stale', async () => {
    const h = harness();
    const { socket } = await establish(h);

    const asking = h.store.queryCatalogue(CATALOGUE);
    socket.deliver(addressedTo(hubFrames.refusalStaleCursor, lastSentId(socket)));

    await expect(asking).rejects.toThrow(/stale/);
    // And the sentence is on the snapshot too, like every other no.
    expect(h.store.getSnapshot().lastRefusal?.code).toBe('bad-request');
  });

  it('rejects at once while the connection is down rather than queueing a read of now', async () => {
    const h = harness();
    const { socket } = await establish(h);
    const before = sentFrames(socket).length;
    socket.drop();

    await expect(h.store.queryCatalogue(CATALOGUE)).rejects.toThrow();
    expect(sentFrames(socket).slice(before)).toEqual([]);
    expect(h.store.getSnapshot().commandQueue.queued).toBe(0);
  });

  it('tells a caller the answer is not coming when the connection drops under it', async () => {
    const h = harness();
    const { socket } = await establish(h);

    const asking = h.store.queryCatalogue(CATALOGUE);
    socket.drop();

    await expect(asking).rejects.toThrow(/dropped/);
  });

  it('re-issues the last question from the first page when the tree changes', async () => {
    const h = harness();
    const { socket } = await establish(h);
    const unwatch = h.store.subscribeCatalogue();

    const asking = h.store.queryCatalogue(CATALOGUE);
    socket.deliver(addressedTo(hubFrames.cataloguePagePartial, lastSentId(socket)));
    const first = await asking;
    const before = sentFrames(socket).length;

    socket.deliver(hubFrames.catalogueChanged);

    const reissued = sentFrames(socket).slice(before);
    expect(reissued).toHaveLength(1);
    // From the first page and never from the cursor the last one handed back:
    // that cursor was minted at the version that just moved, and the hub
    // refuses one from before a change by design.
    expect(first.nextCursor).not.toBeNull();
    expect(reissued[0]).toMatchObject({ type: 'catalogue-query', cursor: null });

    unwatch();
  });

  it('asks nothing on a change when no screen is watching the catalogue', async () => {
    const h = harness();
    const { socket } = await establish(h);

    const asking = h.store.queryCatalogue(CATALOGUE);
    socket.deliver(addressedTo(hubFrames.cataloguePagePartial, lastSentId(socket)));
    await asking;
    const before = sentFrames(socket).length;

    socket.deliver(hubFrames.catalogueChanged);

    expect(sentFrames(socket).slice(before)).toEqual([]);
  });

  it('asks the question again on a reconnection, because the version may have moved', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.subscribeCatalogue();
    const asking = h.store.queryCatalogue(CATALOGUE);
    socket.deliver(addressedTo(hubFrames.cataloguePage, lastSentId(socket)));
    await asking;

    socket.drop();
    const next = await redial(h);
    next.open();
    next.deliver(hubFrames.welcome);

    expect(sentFrames(next).filter((frame) => frame.type === 'catalogue-query')).toHaveLength(1);
  });
});

/**
 * The document frames, and what the store owes an editor that has not been
 * written yet.
 *
 * AGX-243 is the editor; what is here is the three commands and the three
 * answers, kept as the hub sent them. There is no behaviour beyond remembering:
 * a create puts a node in the tree and `catalogue-changed` is what says so, to
 * every client rather than only to the one that asked, and a save changes no
 * row the layout carries at all.
 */
describe('documents', () => {
  const CREATE: HubCommand = {
    type: 'doc-create',
    // The project the captured fixtures were made in, so the ids in this
    // suite are the ones a real hub minted rather than ones invented here.
    projectId: nodeIdSchema.parse('hub-5'),
    server: serverRegistrationIdSchema.parse('registration-mbp-robert'),
    name: docNameSchema.parse('plan.md'),
    content: '# Plan\n',
  };

  it('sends a create as a command, so a blink queues it rather than dropping it', async () => {
    const h = harness();
    const { socket } = await establish(h);

    const outcome = h.store.sendCommand(CREATE);

    expect(outcome).toEqual({ accepted: true, id: 2, delivery: 'sent' });
    expect(sentFrames(socket).at(-1)).toEqual({ ...CREATE, id: 2 });
  });

  it('keeps the answer with the node the document will be named by', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.sendCommand(CREATE);

    socket.deliver(hubFrames.docCreated);

    expect(h.store.getSnapshot().lastDocCreated).toEqual({ replyTo: 8, nodeId: 'hub-6' });
    expect(h.store.getSnapshot().lastRefusal).toBeNull();
  });

  it('asks nothing on a create, because the broadcast is what says the tree moved', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.subscribeLayout();
    const before = sentFrames(socket).length;

    socket.deliver(hubFrames.docCreated);

    // The same as a project create, and for the same reason: `catalogue-changed`
    // is on its way to every client, this one included.
    expect(sentFrames(socket).slice(before)).toEqual([]);
  });

  it('keeps the machine\u2019s write time from a save, and asks for no tree', async () => {
    const h = harness();
    const { socket } = await establish(h);
    h.store.subscribeLayout();
    const before = sentFrames(socket).length;

    socket.deliver(hubFrames.docSaved);

    expect(h.store.getSnapshot().lastDocSaved).toEqual({ replyTo: 9, updatedAt: 3 });
    // A save changed a file on a machine and the hub's note of when. It changed
    // no node, so the tree is the same tree.
    expect(sentFrames(socket).slice(before)).toEqual([]);
  });

  it('keeps a document whole, exactly as the hub sent it', async () => {
    const h = harness();
    const { socket } = await establish(h);

    socket.deliver(hubFrames.docContent);

    expect(h.store.getSnapshot().lastDocContent).toEqual({
      replyTo: 10,
      content: '# Plan\n\n- read the failing test\n- fix the refresh loop\n- write it up\n',
      updatedAt: 3,
    });
  });

  it('forgets a document it is holding when the connection goes', async () => {
    const h = harness();
    const { socket, unsubscribe } = await establish(h);
    socket.deliver(hubFrames.docContent);
    expect(h.store.getSnapshot().lastDocContent).not.toBeNull();

    unsubscribe();

    // The file may be edited on its own machine while nothing here is
    // connected, so characters kept across a disconnection would be a copy
    // this store cannot vouch for.
    expect(h.store.getSnapshot().lastDocContent).toBeNull();
  });

  it('renders a refusal for a document whose machine is away, like any other no', async () => {
    const h = harness();
    const { socket } = await establish(h);

    socket.deliver(hubFrames.refusal);

    expect(h.store.getSnapshot().lastRefusal).toMatchObject({ code: 'refused', holder: null });
  });
});
