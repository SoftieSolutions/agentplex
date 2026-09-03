import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  hubIdSchema,
  nodeIdSchema,
  nodeKindSchema,
  sessionIdSchema,
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
} from '../../shared/fake-message-socket.js';
import { createLogger } from '../../shared/logger.js';
import { createFakeTimers, type FakeTimers } from '../../shared/timers.js';
import type {
  ServerConnectionPhase,
  ServerConnectionReport,
} from '../connections/server-connection.js';
import { serverAddressSchema } from '../pairing/server-address.js';
import { createReducer, type Reducer } from '../state/reducer.js';
import { startClientBroadcast, type ClientBroadcast } from './client-broadcast.js';

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
    title: null,
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
  readonly state: Reducer;
  readonly timers: FakeTimers;
  readonly broadcast: ClientBroadcast;
}

/**
 * The stored layout, as a function the harness can be given.
 *
 * The tree itself is the node-tree suites' subject; what this file is about is
 * where the answer goes and what happens when the read fails, so the seam is
 * filled with a value or a throw rather than a database.
 */
function harness(readLayout: () => Promise<Layout> = async () => []): Harness {
  const state = createReducer({ logger });
  const timers = createFakeTimers();
  const broadcast = startClientBroadcast({ hubId: HUB_ID, state, timers, logger, readLayout });
  return { state, timers, broadcast };
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

function attach(broadcast: ClientBroadcast): Client {
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
    expect(latest(client)).toEqual({ version: 0, stores: [], servers: [] });
  });

  it('is sent the state as it is now, not as it was when the hub started', async () => {
    const { state, broadcast, timers } = harness();
    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    state.applySessions({
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
