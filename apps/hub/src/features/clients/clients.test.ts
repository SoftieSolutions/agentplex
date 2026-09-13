import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  hubIdSchema,
  nodeIdSchema,
  nodeKindSchema,
  sessionIdSchema,
  startIdSchema,
  storeIdSchema,
  type HubFrame,
  type Layout,
  type LayoutNode,
  type MachineState,
  type ServerRegistrationId,
  type SessionDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  type FakeMessageSocket,
  createFakeTimers,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import { closure, CLOSE_NORMAL, createLogger } from '@agentplex/node-shared';
import { readyProvider } from '@agentplex/providers/testing';
import type { ServerConnectionPhase, ServerConnectionReport } from '../servers/servers.js';
import { serverAddressSchema } from '../pairing/pairing.js';
import { createFleetState, type FleetState } from '../fleet-state/fleet-state.js';
import { createClients, type Clients } from './clients.js';
import { createFakeSessions, type FakeSessions } from '../sessions/fake-sessions.js';
import { createFakeTerminal, type FakeTerminal } from '../terminal/fake-terminal.js';

/**
 * The pipeline, with the real reducer above it and fake sockets below.
 *
 * Nothing is mocked. The reducer is the one the hub runs, the frames go through
 * the protocol's own parser on the way back in, and the only thing replaced is
 * the wire and the clock. What is being asserted is the ticket: every client
 * gets the whole state, they get the same one, a client that arrives late gets
 * it too, a refusal reaches only the client that asked, and a burst of changes
 * is one frame carrying the newest.
 */

const START = 1_756_000_000_000;
const HUB_ID = hubIdSchema.parse('hub-1');

const logger = createLogger('error', () => {});

function store(id: string): StoreId {
  return storeIdSchema.parse(id);
}

function connection(
  label: string,
  phase: ServerConnectionPhase,
  stores: readonly string[],
): ServerConnectionReport {
  return {
    registrationId: `registration-${label}` as ServerRegistrationId,
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    providers: [readyProvider()],
    stores: stores.map(store),
    connectedSince: phase === 'connected' ? START : null,
    staleSince: phase === 'stale' ? START + 1_000 : null,
    lastConnectedAt: phase === 'connecting' ? null : START,
    failedAttempts: phase === 'stale' ? 1 : 0,
    problem: null,
    staleReason: phase === 'stale' ? 'unreachable' : null,
  };
}

function session(id: string): SessionDescriptor {
  return {
    storeId: store('store-work'),
    sessionId: sessionIdSchema.parse(id),
    provider: 'claude',
    status: 'idle',
    updatedAt: START,
    cwd: '/srv/work',
    branch: null,
    title: null,
    uncommitted: null,
  };
}

/** One node, so an answered layout is distinguishable from an empty one. */
const folderNode: LayoutNode = {
  id: nodeIdSchema.parse('node-1'),
  parentId: null,
  kind: nodeKindSchema.parse('folder'),
  position: 0,
  name: 'this week',
  named: true,
  anchor: null,
};

interface Harness {
  readonly state: FleetState;
  readonly timers: FakeTimers;
  readonly broadcast: Clients;
  /** The session control this broadcast was built on, for tests that drive it. */
  readonly sessions: FakeSessions;
  /** The relay it hands terminal frames to, which records rather than answers. */
  readonly terminal: FakeTerminal;
}

/**
 * The stored layout, as a function the harness can be given.
 *
 * The tree itself is the node-tree suites' subject; what this file is about is
 * where the answer goes and what happens when the read fails, so the seam is
 * filled with a value or a throw rather than a database.
 */
function harness(
  readLayout: () => Promise<Layout> = async () => [],
  sessions: FakeSessions = createFakeSessions(),
  paneLayout: {
    read?: () => Promise<string | null>;
    write?: (layout: string) => Promise<void>;
  } = {},
): Harness {
  const state = createFleetState({ logger });
  const timers = createFakeTimers();
  const terminal = createFakeTerminal();
  const broadcast = createClients({
    hubId: HUB_ID,
    state,
    timers,
    logger,
    readLayout,
    readPaneLayout: paneLayout.read ?? (async () => null),
    writePaneLayout: paneLayout.write ?? (async () => undefined),
    sessions,
    terminal,
  });
  return { state, timers, broadcast, sessions, terminal };
}

/**
 * A client on a socket, driven by hand.
 *
 * Frames it received are read back through the protocol's parser rather than
 * `JSON.parse`, because a frame this pipeline sends that a client cannot parse
 * has not been sent in any sense that matters.
 */
interface Client {
  readonly socket: FakeMessageSocket;
  hello(protocolVersion?: number): Promise<void>;
  say(frame: Record<string, unknown>): Promise<void>;
  readonly received: readonly HubFrame[];
  readonly states: readonly MachineState[];
}

function attach(broadcast: Clients): Client {
  const socket = createFakeMessageSocket();
  broadcast.attach(socket);

  const client: Client = {
    socket,
    async hello(protocolVersion = PROTOCOL_VERSION): Promise<void> {
      await client.say({ type: 'hello', id: 1, protocolVersion });
    },
    async say(frame: Record<string, unknown>): Promise<void> {
      socket.receive(JSON.stringify(frame));
      // The fake delivers asynchronously, as a real socket does. One turn is
      // enough: everything the connection does with a frame it does inline.
      await Promise.resolve();
    },
    get received(): readonly HubFrame[] {
      return socket.sent.map((text) => {
        const parsed = parseTextFrame(parseHubFrame, text);
        if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
        return parsed.value;
      });
    },
    get states(): readonly MachineState[] {
      return client.received
        .filter((frame) => frame.type === 'machine-state')
        .map((frame) => frame.state);
    },
  };

  return client;
}

/** The last state a client was sent, or a failure that says it was sent none. */
function latest(client: Client): MachineState {
  const state = client.states.at(-1);
  if (state === undefined) throw new Error('this client was never sent a state');
  return state;
}

describe('a client that has just said hello', () => {
  it('is welcomed and then sent the whole state, unasked', async () => {
    const { broadcast } = harness();
    const client = attach(broadcast);
    await client.hello();

    expect(client.received.map((frame) => frame.type)).toEqual(['welcome', 'machine-state']);
    expect(latest(client)).toEqual({ version: 0, stores: [], servers: [], candidates: [] });
  });

  it('is sent the state as it is now, not as it was when the hub started', async () => {
    const { state, broadcast, timers } = harness();
    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    state.applySessions({
      holding: [],
      registrationId: `registration-workshop` as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });
    timers.fireAll();

    // Attached after everything above happened. This is the late joiner, and
    // the whole point of a whole-state frame: there is no backlog to replay.
    const late = attach(broadcast);
    await late.hello();

    const seen = latest(late);
    expect(seen.version).toBe(state.snapshot().version);
    expect(seen.servers.map((server) => server.label)).toEqual(['workshop']);
    expect(seen.stores[0]?.sessions.map((row) => row.descriptor.sessionId)).toEqual(['session-1']);
  });

  it('is sent nothing before it has said hello', async () => {
    const { state, broadcast, timers } = harness();
    const client = attach(broadcast);

    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    timers.fireAll();
    await Promise.resolve();

    expect(client.socket.sent).toEqual([]);
  });
});

describe('two clients', () => {
  it('are sent the identical characters, change after change', async () => {
    const { state, broadcast, timers } = harness();
    const one = attach(broadcast);
    const two = attach(broadcast);
    await one.hello();
    await two.hello();

    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    timers.fireAll();
    state.applyConnection(connection('laptop', 'stale', ['store-work']));
    timers.fireAll();
    state.applySessions({
      holding: [],
      registrationId: `registration-workshop` as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1'), session('session-2')],
      reportedAt: START,
    });
    timers.fireAll();

    // Character for character rather than deep-equal on the parsed values: the
    // two clients were sent the same frames, in the same order, with the same
    // fields in the same places. `slice(1)` drops the welcome, which is the one
    // frame that is legitimately per-client -- it names the hello it answers.
    expect(one.socket.sent.slice(1)).toEqual(two.socket.sent.slice(1));
    expect(latest(one)).toEqual(latest(two));
    expect(latest(one).version).toBe(state.snapshot().version);
  });

  it('converge even when one of them arrived halfway through', async () => {
    const { state, broadcast, timers } = harness();
    const early = attach(broadcast);
    await early.hello();

    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    timers.fireAll();

    const late = attach(broadcast);
    await late.hello();

    state.applySessions({
      holding: [],
      registrationId: `registration-workshop` as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });
    timers.fireAll();

    expect(latest(early)).toEqual(latest(late));
  });

  it('never send a state backwards to a client that already has a newer one', async () => {
    const { state, broadcast, timers } = harness();
    state.applyConnection(connection('workshop', 'connected', ['store-work']));

    // A flush is scheduled and has not run. A client that says hello now is
    // sent the current state directly, and the flush must not follow it with
    // the same version again.
    const client = attach(broadcast);
    await client.hello();
    timers.fireAll();

    const versions = client.states.map((seen) => seen.version);
    expect(versions).toEqual([...versions].sort((left, right) => left - right));
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('a burst of changes', () => {
  it('is one frame carrying the newest state, never a queue of stale ones', async () => {
    const { state, broadcast, timers } = harness();
    const client = attach(broadcast);
    await client.hello();
    const before = client.states.length;

    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    state.applyConnection(connection('laptop', 'connected', ['store-home']));
    state.applySessions({
      holding: [],
      registrationId: `registration-workshop` as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });

    // Three changes, one scheduled flush: the changes are not queued, only the
    // fact that something changed is.
    expect(timers.pending).toBe(1);
    timers.fireAll();

    expect(client.states.length - before).toBe(1);
    const seen = latest(client);
    expect(seen.version).toBe(state.snapshot().version);
    expect(seen.servers.map((server) => server.label)).toEqual(['laptop', 'workshop']);
    expect(seen.stores.flatMap((view) => view.sessions).length).toBe(1);
  });

  it('does not wake a client when a scan changed nothing', async () => {
    const { state, broadcast, timers } = harness();
    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    const report = {
      registrationId: `registration-workshop` as ServerRegistrationId,
      storeId: store('store-work'),
      sessions: [session('session-1')],
      holding: [],
      reportedAt: START,
    };
    state.applySessions(report);
    timers.fireAll();

    const client = attach(broadcast);
    await client.hello();
    const before = client.states.length;

    // The same scan again. The reducer holds its version, so there is nothing
    // to schedule and nothing to send.
    state.applySessions({ ...report, reportedAt: START + 30_000 });
    expect(timers.pending).toBe(0);
    timers.fireAll();

    expect(client.states.length).toBe(before);
  });
});

describe('the stored layout', () => {
  /**
   * The whole reason a layout is a reply and not a broadcast. Two people with
   * the same hub open have one machine state between them and one tree each;
   * pushing one person's arrangement to every socket would rearrange the other
   * person's screen the moment either of them asked.
   */
  it('reaches the client that asked and no other', async () => {
    const { broadcast } = harness(async () => [folderNode]);
    const asker = attach(broadcast);
    const bystander = attach(broadcast);
    await asker.hello();
    await bystander.hello();
    const bystanderSaw = bystander.received.length;

    await asker.say({ type: 'layout-request', id: 2 });

    expect(asker.received.filter((frame) => frame.type === 'layout')).toEqual([
      { type: 'layout', replyTo: 2, nodes: [folderNode] },
    ]);
    // Nothing at all reached the other client: not the layout, and not a state
    // frame either, because one client asking changed nothing about the world.
    expect(bystander.received.length).toBe(bystanderSaw);
  });

  it('answers an empty tree as an answer rather than as a refusal', async () => {
    const { broadcast } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'layout-request', id: 2 });

    expect(client.received.at(-1)).toEqual({ type: 'layout', replyTo: 2, nodes: [] });
  });

  /**
   * A database that would not answer is the hub's failure, not the client's
   * request being wrong, so it is `internal` -- which is the code that says
   * retrying may work. What went wrong inside the hub's database is logged and
   * not sent.
   */
  it('refuses as internal when the tree cannot be read, and stays open', async () => {
    const { broadcast } = harness(() => Promise.reject(new Error('database is locked')));
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'layout-request', id: 2 });

    expect(client.received.at(-1)).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'internal',
      message: 'the hub could not read its layout',
      holder: null,
    });
    expect(client.socket.closure).toBeNull();
  });
});

describe('the stored pane layout', () => {
  // Deliberately a shape no current client writes: the contract under test is
  // that the hub carries the characters without reading them, so a newer
  // client's pane type crosses this build untouched.
  const FUTURE_LAYOUT = '{"v":9,"root":{"kind":"hologram","spin":0.5}}';

  it('answers the save back verbatim, to the asking client and no other', async () => {
    let stored: string | null = null;
    const { broadcast } = harness(async () => [], createFakeSessions(), {
      read: async () => stored,
      write: async (layout) => {
        stored = layout;
      },
    });
    const asker = attach(broadcast);
    const bystander = attach(broadcast);
    await asker.hello();
    await bystander.hello();
    const bystanderSaw = bystander.received.length;

    await asker.say({ type: 'pane-layout-save', id: 2, layout: FUTURE_LAYOUT });
    await asker.say({ type: 'pane-layout-request', id: 3 });

    expect(asker.received.at(-2)).toEqual({ type: 'pane-layout-saved', replyTo: 2 });
    expect(asker.received.at(-1)).toEqual({
      type: 'pane-layout',
      replyTo: 3,
      layout: FUTURE_LAYOUT,
    });
    // One person's arrangement of one screen: nothing reached the other tab.
    expect(bystander.received.length).toBe(bystanderSaw);
  });

  it('answers null before anything was ever saved, which is an answer, not a refusal', async () => {
    const { broadcast } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'pane-layout-request', id: 2 });

    expect(client.received.at(-1)).toEqual({ type: 'pane-layout', replyTo: 2, layout: null });
  });

  it('refuses as internal when the row cannot be written, and stays open', async () => {
    const { broadcast } = harness(async () => [], createFakeSessions(), {
      write: () => Promise.reject(new Error('database is locked')),
    });
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'pane-layout-save', id: 2, layout: FUTURE_LAYOUT });

    expect(client.received.at(-1)).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'internal',
      message: 'the hub could not store the pane layout',
      holder: null,
    });
    expect(client.socket.closure).toBeNull();
  });
});

describe('a refusal', () => {
  it('leaves the connection open, because being told no is an answer', async () => {
    const { broadcast } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'layout-request', id: 2 });
    expect(client.socket.closure).toBeNull();

    await client.say({ type: 'ping', id: 3 });
    expect(client.received.at(-1)).toEqual({ type: 'pong', replyTo: 3 });
  });

  it('answers a client that speaks another protocol, then closes', async () => {
    const { broadcast } = harness();
    const client = attach(broadcast);
    await client.hello(PROTOCOL_VERSION + 1);

    expect(client.received).toEqual([
      {
        type: 'refusal',
        replyTo: 1,
        code: 'protocol-version',
        message: `this hub speaks protocol ${PROTOCOL_VERSION}, not ${PROTOCOL_VERSION + 1}`,
        holder: null,
      },
    ]);
    expect(client.socket.closure?.code).toBe(1008);
  });

  it('refuses a frame that arrives before hello, and never state', async () => {
    const { broadcast } = harness();
    const client = attach(broadcast);

    await client.say({ type: 'ping', id: 1 });

    expect(client.received).toEqual([
      {
        type: 'refusal',
        replyTo: 1,
        code: 'bad-request',
        message: 'the first frame on a connection is a hello',
        holder: null,
      },
    ]);
    expect(client.states).toEqual([]);
  });

  it('says it could not read a frame with an unsolicited error, having no id to name', async () => {
    const { broadcast } = harness();
    const client = attach(broadcast);

    client.socket.receive('{not json');
    await Promise.resolve();

    expect(client.received.map((frame) => frame.type)).toEqual(['protocol-error']);
    expect(client.socket.closure?.code).toBe(1008);
  });
});

/**
 * The four terminal frames, and what this file is responsible for about them.
 *
 * Before the switch was exhaustive they did something worse than fail: they
 * parsed, matched no case, and fell out of the bottom. The client was left
 * holding a frame id nothing would ever answer, with no log line, no reply and
 * no type error anywhere to say so. They were refused in words next, and now
 * they are handed to the relay -- which is where every question about what the
 * answer should be belongs. What is asserted here is the socket's half: the
 * frame reaches the relay, under this connection's own identity, with the id
 * that has to be replied to, and only once this peer has said hello.
 */
describe('a terminal frame', () => {
  const TARGET = {
    by: 'session' as const,
    storeId: storeIdSchema.parse('store-work'),
    sessionId: sessionIdSchema.parse('session-1'),
  };

  it('hands a subscribe to the relay, with the frame it has to answer', async () => {
    const { broadcast, terminal } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'session-subscribe', id: 2, target: TARGET });

    expect(terminal.subscribed).toMatchObject([{ replyTo: 2, target: TARGET }]);
    // Nothing is answered here. The reply is the relay's, and it is written
    // where the server's own answer is read -- see `terminal.ts` for why a
    // promise in between would reorder a terminal.
    expect(client.received.map((frame) => frame.type)).toEqual(['welcome', 'machine-state']);
  });

  it('hands an unsubscribe, an input and a resize over as they arrived', async () => {
    const { broadcast, terminal } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'session-unsubscribe', id: 2, target: TARGET });
    await client.say({ type: 'terminal-input', id: 3, target: TARGET, data: 'yes\r' });
    await client.say({
      type: 'terminal-resize',
      id: 4,
      target: TARGET,
      size: { cols: 96, rows: 30 },
    });

    expect(terminal.unsubscribed).toMatchObject([{ replyTo: 2, target: TARGET }]);
    expect(terminal.typed).toMatchObject([{ replyTo: 3, target: TARGET, data: 'yes\r' }]);
    expect(terminal.resized).toMatchObject([{ replyTo: 4, size: { cols: 96, rows: 30 } }]);
  });

  it('names one watcher for the life of the connection, however many frames', async () => {
    const { broadcast, terminal } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'session-subscribe', id: 2, target: TARGET });
    await client.say({ type: 'terminal-input', id: 3, target: TARGET, data: 'ls\r' });

    // One identity, because it is what the relay files a subscription under: a
    // fresh handle per frame would be a new client every time somebody typed.
    expect(terminal.typed[0]?.client).toBe(terminal.subscribed[0]?.client);
  });

  it('tells the relay when the socket goes, so the watch is given back', async () => {
    const { broadcast, terminal } = harness();
    const client = attach(broadcast);
    await client.hello();
    await client.say({ type: 'session-subscribe', id: 2, target: TARGET });

    client.socket.closeFromPeer(closure(CLOSE_NORMAL, 'the tab was closed'));
    await Promise.resolve();

    // A socket closing is a detach, and it is the only path a client that
    // crashed ever takes. Without this the server would go on counting an
    // audience that left, and its eviction rule would be choosing between
    // terminals that all claim to be watched.
    expect(terminal.forgotten).toEqual([terminal.subscribed[0]?.client]);
  });

  const frames: readonly Record<string, unknown>[] = [
    { type: 'session-subscribe', target: TARGET },
    { type: 'session-unsubscribe', target: TARGET },
    { type: 'terminal-input', target: TARGET, data: 'yes\r' },
    { type: 'terminal-resize', target: TARGET, size: { cols: 96, rows: 30 } },
  ];

  it.each(frames)('refuses $type before hello, and relays nothing', async (frame) => {
    const { broadcast, terminal } = harness();
    const client = attach(broadcast);

    await client.say({ ...frame, id: 1 });

    expect(client.received.at(-1)).toMatchObject({
      type: 'refusal',
      replyTo: 1,
      code: 'bad-request',
      message: 'the first frame on a connection is a hello',
    });
    expect(terminal.subscribed).toEqual([]);
    expect(terminal.unsubscribed).toEqual([]);
    expect(terminal.typed).toEqual([]);
    expect(terminal.resized).toEqual([]);
  });
});

describe('starting and stopping a session', () => {
  const STORE = 'store-work';
  const SESSION = 'session-1';

  it('answers the client that asked, and names where the session landed', async () => {
    const sessions = createFakeSessions({
      outcome: {
        ok: true,
        storeId: store(STORE),
        sessionId: sessionIdSchema.parse(SESSION),
        server: 'registration-workshop' as ServerRegistrationId,
        startId: startIdSchema.parse('start-2f9c'),
      },
    });
    const { broadcast } = harness(async () => [], sessions);
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: STORE,
      sessionId: SESSION,
      provider: 'claude',
      prompt: null,
      server: null,
    });

    expect(client.received.at(-1)).toEqual({
      type: 'session-started',
      replyTo: 2,
      storeId: STORE,
      sessionId: SESSION,
      server: 'registration-workshop',
    });
    // The frame reaches the control as a request, with the override it carried.
    expect(sessions.starts).toEqual([
      {
        storeId: STORE,
        sessionId: SESSION,
        provider: 'claude',
        prompt: null,
        server: null,
      },
    ]);
  });

  it('passes a refusal back to that client alone, with the holder on it', async () => {
    const sessions = createFakeSessions({
      outcome: {
        ok: false,
        code: 'refused',
        problem: 'that session is already running on workshop',
        holder: { server: 'registration-workshop' as ServerRegistrationId, stoppable: false },
      },
    });
    const { broadcast } = harness(async () => [], sessions);
    const asking = attach(broadcast);
    const watching = attach(broadcast);
    await asking.hello();
    await watching.hello();

    await asking.say({
      type: 'session-start',
      id: 2,
      storeId: STORE,
      sessionId: SESSION,
      provider: 'claude',
      prompt: null,
      server: null,
    });

    expect(asking.received.at(-1)).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
      message: 'that session is already running on workshop',
      holder: { server: 'registration-workshop', stoppable: false },
    });
    // Nobody else is told that somebody was refused: their view of the world
    // has not changed, and a refusal is a reply.
    expect(watching.received.map((frame) => frame.type)).toEqual(['welcome', 'machine-state']);
  });

  it('takes a stop that names a session and nothing else', async () => {
    const sessions = createFakeSessions({
      outcome: {
        ok: true,
        storeId: store(STORE),
        sessionId: sessionIdSchema.parse(SESSION),
        server: 'registration-workshop' as ServerRegistrationId,
        startId: startIdSchema.parse('start-2f9c'),
      },
    });
    const { broadcast } = harness(async () => [], sessions);
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'session-stop', id: 2, storeId: STORE, sessionId: SESSION });

    expect(sessions.stops).toEqual([{ storeId: STORE, sessionId: SESSION }]);
    expect(client.received.at(-1)).toMatchObject({
      type: 'session-stopped',
      replyTo: 2,
      server: 'registration-workshop',
    });
  });

  it('refuses a start that arrives before hello, and starts nothing', async () => {
    const sessions = createFakeSessions();
    const { broadcast } = harness(async () => [], sessions);
    const client = attach(broadcast);

    await client.say({
      type: 'session-start',
      id: 1,
      storeId: STORE,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: null,
    });

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
    expect(sessions.starts).toEqual([]);
    expect(client.socket.closure).not.toBeNull();
  });
});

describe('the broadcast lifecycle', () => {
  it('forgets a client whose socket closed, and stops sending to it', async () => {
    const { state, broadcast, timers } = harness();
    const staying = attach(broadcast);
    const leaving = attach(broadcast);
    await staying.hello();
    await leaving.hello();
    expect(broadcast.attached).toBe(2);

    leaving.socket.closeFromPeer({ code: 1000, reason: 'tab closed' });
    await Promise.resolve();
    expect(broadcast.attached).toBe(1);

    const sentToLeaver = leaving.socket.sent.length;
    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    timers.fireAll();

    expect(leaving.socket.sent.length).toBe(sentToLeaver);
    expect(latest(staying).servers).toHaveLength(1);
  });

  it('closes every client when the hub stops, and publishes nothing after', async () => {
    const { state, broadcast, timers } = harness();
    const one = attach(broadcast);
    const two = attach(broadcast);
    await one.hello();
    await two.hello();

    broadcast.stop();

    expect(one.socket.closure?.reason).toBe('the hub is stopping');
    expect(two.socket.closure?.reason).toBe('the hub is stopping');
    expect(broadcast.attached).toBe(0);

    const sent = one.socket.sent.length;
    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    timers.fireAll();
    expect(one.socket.sent.length).toBe(sent);
  });

  it('costs one client its own state, not everybody theirs, when its socket throws', async () => {
    const { state, broadcast, timers } = harness();
    const broken = attach(broadcast);
    const working = attach(broadcast);
    await broken.hello();
    await working.hello();

    // A real socket can throw on send -- a `ws` in CLOSING does. The rule the
    // reducer applies to its listeners applies here: one dying tab must not
    // stop the rest of the fleet being told.
    const failing = broken.socket as { send: (text: string) => void };
    failing.send = () => {
      throw new Error('socket is closing');
    };

    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    timers.fireAll();

    expect(latest(working).servers).toHaveLength(1);
  });
});
