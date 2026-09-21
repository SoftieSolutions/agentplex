import { describe, expect, it } from 'vitest';
import {
  APPROVAL_PROPOSAL_MAX_CHARS,
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
  serverAddressSchema,
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
import { createFleetState, type FleetState } from '../fleet-state/fleet-state.js';
import { createClients, type Clients } from './clients.js';
import { createFakeApprovals, type FakeApprovals } from '../approvals/fake-approvals.js';
import {
  createFakeApprovalPolicy,
  type FakeApprovalPolicy,
} from '../approval-policy/fake-approval-policy.js';
import { createFakeAttention, type FakeAttention } from '../attention/fake-attention.js';
import { createFakePairing, type FakePairing } from '../pairing/fake-pairing.js';
import { createFakeSessions, type FakeSessions } from '../sessions/fake-sessions.js';
import { createFakeProjects, type FakeProjects } from '../projects/fake-projects.js';
import { createFakeCatalogue, type FakeCatalogue } from '../catalogue/fake-catalogue.js';
import { createFakeDocs, type FakeDocs } from '../docs/fake-docs.js';
import { createFakeTerminal, type FakeTerminal } from '../terminal/fake-terminal.js';
import { createFakePush, FAKE_PUSH_PUBLIC_KEY, type FakePush } from '../push/fake-push.js';

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
    draining: null,
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
  /** The attention rows this broadcast writes through, for the two new frames. */
  readonly attention: FakeAttention;
  /** The pairing table this broadcast writes through, for the pairing frames. */
  readonly pairing: FakePairing;
  /** Every time the supervisor was told the pairing table had changed. */
  readonly syncs: () => number;
  /** The browse this broadcast was built on, for the same reason. */
  readonly projects: FakeProjects;
  /** The tree this broadcast was built on, for the same reason. */
  readonly catalogue: FakeCatalogue;
  /** The documents this broadcast was built on, for the same reason. */
  readonly docs: FakeDocs;
  /** The relay it hands terminal frames to, which records rather than answers. */
  readonly terminal: FakeTerminal;
  /** The open requests it hands decisions to, answered by hand. */
  readonly approvals: FakeApprovals;
  /** The subscriptions this broadcast writes through, or `null` for no push. */
  readonly push: FakePush | null;
  readonly approvalPolicy: FakeApprovalPolicy;
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
  pairing: FakePairing = createFakePairing(),
  projects: FakeProjects = createFakeProjects(),
  catalogue: FakeCatalogue = createFakeCatalogue(),
  docs: FakeDocs = createFakeDocs(),
  attention: FakeAttention = createFakeAttention(),
  approvals: FakeApprovals = createFakeApprovals(),
  push: FakePush | null = createFakePush(),
  approvalPolicy: FakeApprovalPolicy = createFakeApprovalPolicy(),
): Harness {
  const state = createFleetState({ logger });
  const timers = createFakeTimers();
  let syncs = 0;
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
    attention,
    approvals,
    approvalPolicy,
    pairing,
    syncServers: async () => {
      syncs += 1;
    },
    projects,
    catalogue,
    docs,
    terminal,
    push,
  });
  return {
    state,
    timers,
    broadcast,
    sessions,
    attention,
    approvals,
    approvalPolicy,
    pairing,
    syncs: () => syncs,
    projects,
    catalogue,
    docs,
    terminal,
    push,
  };
}

/**
 * The harness with only its push seam chosen.
 *
 * A wrapper rather than a ninth default typed out at every call site: the
 * push tests care about one of the ten seams and nothing about the other
 * nine, and a row of `undefined` at each one reads as if it meant something.
 */
function pushHarness(push: FakePush | null): Harness {
  return harness(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    push,
  );
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
      project: null,
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
        project: null,
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
      project: null,
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
      project: null,
    });

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
    expect(sessions.starts).toEqual([]);
    expect(client.socket.closure).not.toBeNull();
  });
});

/**
 * Acknowledging and muting, as this socket sees them.
 *
 * What the rows actually do is the attention feature's own suite, against a
 * real schema. What is asked here is the part only a connection can answer:
 * which client is told, in what words, and that the whole row comes back
 * however the change was asked for.
 */
describe('acknowledging and muting a session', () => {
  const STORE = 'store-work';
  const SESSION = 'session-1';

  it('answers the acknowledgement with the whole row, to the client that asked', async () => {
    // Two numbers, kept apart: a mute is stamped off the hub's clock, and an
    // acknowledgement records the session's own last activity. A fake that
    // used one for both could not fail a test that conflated them.
    const attention = createFakeAttention({ now: 1_756_000_000_000, through: 1_755_999_820_000 });
    const { broadcast } = harness(
      async () => [],
      createFakeSessions(),
      {},
      createFakePairing(),
      createFakeProjects(),
      createFakeCatalogue(),
      createFakeDocs(),
      attention,
    );
    const asking = attach(broadcast);
    const watching = attach(broadcast);
    await asking.hello();
    await watching.hello();

    await asking.say({ type: 'session-acknowledge', id: 2, storeId: STORE, sessionId: SESSION });

    expect(asking.received.at(-1)).toEqual({
      type: 'session-attention',
      replyTo: 2,
      storeId: STORE,
      sessionId: SESSION,
      acknowledgedThrough: 1_755_999_820_000,
      mutedAt: null,
    });
    expect(attention.acknowledged).toEqual([{ storeId: STORE, sessionId: SESSION }]);
    // Nobody else asked. The change itself reaches the other clients on the
    // session row of the next state, which is the one place any of them reads
    // attention from.
    expect(watching.received.some((frame) => frame.type === 'session-attention')).toBe(false);
  });

  it('carries the state a mute wants rather than a toggle, and answers the row', async () => {
    const attention = createFakeAttention({ now: 1_756_000_000_000, through: 1_755_999_820_000 });
    const { broadcast } = harness(
      async () => [],
      createFakeSessions(),
      {},
      createFakePairing(),
      createFakeProjects(),
      createFakeCatalogue(),
      createFakeDocs(),
      attention,
    );
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'session-mute',
      id: 2,
      storeId: STORE,
      sessionId: SESSION,
      muted: true,
    });
    expect(client.received.at(-1)).toMatchObject({
      type: 'session-attention',
      replyTo: 2,
      mutedAt: 1_756_000_000_000,
    });

    await client.say({
      type: 'session-mute',
      id: 3,
      storeId: STORE,
      sessionId: SESSION,
      muted: false,
    });
    expect(client.received.at(-1)).toMatchObject({
      type: 'session-attention',
      replyTo: 3,
      mutedAt: null,
    });
    expect(attention.mutes).toEqual([
      { ref: { storeId: STORE, sessionId: SESSION }, muted: true },
      { ref: { storeId: STORE, sessionId: SESSION }, muted: false },
    ]);
  });

  it('passes a refusal back as a reply, leaving the socket open', async () => {
    const attention = createFakeAttention();
    attention.refuseWith({
      ok: false,
      code: 'refused',
      problem: 'this hub knows no session by that id',
    });
    const { broadcast } = harness(
      async () => [],
      createFakeSessions(),
      {},
      createFakePairing(),
      createFakeProjects(),
      createFakeCatalogue(),
      createFakeDocs(),
      attention,
    );
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'session-acknowledge', id: 2, storeId: STORE, sessionId: 'ghost' });

    expect(client.received.at(-1)).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
      message: 'this hub knows no session by that id',
      holder: null,
    });
    expect(client.socket.closure).toBeNull();
  });

  it('refuses either frame before a hello, like everything else on this socket', async () => {
    const attention = createFakeAttention();
    const { broadcast } = harness(
      async () => [],
      createFakeSessions(),
      {},
      createFakePairing(),
      createFakeProjects(),
      createFakeCatalogue(),
      createFakeDocs(),
      attention,
    );
    const client = attach(broadcast);

    await client.say({
      type: 'session-mute',
      id: 1,
      storeId: STORE,
      sessionId: SESSION,
      muted: true,
    });

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', replyTo: 1 });
    expect(attention.mutes).toEqual([]);
    expect(client.socket.closure).not.toBeNull();
  });
});

/**
 * The project frames, as this socket sees them.
 *
 * What the rows actually do is the projects feature's own suite, against a real
 * schema, and end to end in `tests/hub-server`. What is asked here is the part
 * only a connection can answer: which client is told, in what words, and that a
 * refusal is a reply rather than a closed socket.
 */
describe('making and renaming a project', () => {
  it('answers the client that asked with the node id it will name it by', async () => {
    const { broadcast, projects } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'project-create',
      id: 2,
      name: 'agentplex',
      directory: '/srv/work/agentplex',
    });

    expect(projects.created).toEqual([
      { nodeId: 'project-1', name: 'agentplex', directory: '/srv/work/agentplex' },
    ]);
    expect(client.received.at(-1)).toEqual({
      type: 'project-created',
      replyTo: 2,
      nodeId: 'project-1',
    });
  });

  /**
   * A blank name is a refusal in words and not a closed connection.
   *
   * The wire schema bounds a name's length and judges nothing else, precisely
   * so that this case can be answered: a parser that refused it would refuse
   * the frame, and a frame the hub cannot read has an id the hub cannot reply
   * to. See `layout.ts` for the argument.
   */
  it('refuses a blank name in a sentence, leaving the connection open', async () => {
    const { broadcast } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'project-create', id: 2, name: '   ', directory: '/srv/work' });

    expect(client.received.at(-1)).toMatchObject({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
      holder: null,
    });
    expect(client.socket.closure).toBeNull();
  });

  it('passes the duplicate refusal back, naming nothing else', async () => {
    const { broadcast } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'project-create', id: 2, name: 'one', directory: '/srv/work' });
    await client.say({ type: 'project-create', id: 3, name: 'two', directory: '/srv/work' });

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', replyTo: 3, code: 'refused' });
  });

  it('refuses a project frame that arrives before hello, and makes nothing', async () => {
    const { broadcast, projects } = harness();
    const client = attach(broadcast);

    await client.say({ type: 'project-create', id: 1, name: 'agentplex', directory: '/srv/work' });

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
    expect(projects.created).toEqual([]);
    expect(client.socket.closure).not.toBeNull();
  });
});

describe('editing the tree', () => {
  it('makes a folder and answers the id the client could not have worked out', async () => {
    const { broadcast, catalogue } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'node-create-folder', id: 2, parentId: null, name: 'this week' });

    expect(catalogue.asked).toEqual([
      { act: 'create-folder', request: { parentId: null, name: 'this week' } },
    ]);
    expect(client.received.at(-1)).toEqual({
      type: 'node-created',
      replyTo: 2,
      nodeId: 'folder-1',
    });
  });

  it('renames any node through the one frame that names the act rather than a kind', async () => {
    const { broadcast, catalogue } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'node-rename', id: 2, nodeId: 'node-1', name: 'the checkout' });

    expect(catalogue.asked).toEqual([{ act: 'rename', nodeId: 'node-1', name: 'the checkout' }]);
    expect(client.received.at(-1)).toEqual({ type: 'node-renamed', replyTo: 2 });
  });

  it('moves a node and answers the word for the act', async () => {
    const { broadcast, catalogue } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'node-move',
      id: 2,
      nodeId: 'node-1',
      parentId: 'node-folder',
      position: 3,
    });

    expect(catalogue.asked).toEqual([
      { act: 'move', nodeId: 'node-1', placement: { parentId: 'node-folder', position: 3 } },
    ]);
    expect(client.received.at(-1)).toEqual({ type: 'node-moved', replyTo: 2 });
  });

  it('removes a node', async () => {
    const { broadcast, catalogue } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'node-remove', id: 2, nodeId: 'node-1' });

    expect(catalogue.asked).toEqual([{ act: 'remove', nodeId: 'node-1' }]);
    expect(client.received.at(-1)).toEqual({ type: 'node-removed', replyTo: 2 });
  });

  it('forgets a removal, addressed by the session and never by a node', async () => {
    const { broadcast, catalogue } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'node-forget-removal',
      id: 2,
      storeId: 'store-work',
      sessionId: 'session-1',
    });

    expect(catalogue.asked).toEqual([
      { act: 'forget-removal', ref: { storeId: 'store-work', sessionId: 'session-1' } },
    ]);
    expect(client.received.at(-1)).toEqual({ type: 'node-removal-forgotten', replyTo: 2 });
  });

  /**
   * The refusal that leads somewhere. Every other no on this direction carries
   * `holder: null`; a removal refused because a session is still running names
   * the machine, so the client can offer the stop rather than only a sentence.
   */
  it('passes a removal refusal back whole, holder and all, to the client that asked', async () => {
    const { broadcast, catalogue } = harness();
    const client = attach(broadcast);
    const bystander = attach(broadcast);
    await client.hello();
    await bystander.hello();
    catalogue.refuseWith({
      ok: false,
      code: 'refused',
      problem: 'this session is still running; stop it first, and then remove it',
      holder: { server: 'registration-workshop' as ServerRegistrationId, stoppable: true },
    });

    await client.say({ type: 'node-remove', id: 2, nodeId: 'node-1' });

    expect(client.received.at(-1)).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
      message: 'this session is still running; stop it first, and then remove it',
      holder: { server: 'registration-workshop', stoppable: true },
    });
    // A refusal is a reply. The other client did not ask, and nothing about
    // the world changed because this one was told no.
    expect(bystander.received.map((frame) => frame.type)).toEqual(['welcome', 'machine-state']);
  });

  it('answers internal, not refused, when the tree itself throws', async () => {
    const { broadcast, catalogue } = harness();
    const client = attach(broadcast);
    await client.hello();
    catalogue.failWith(new Error('database is locked'));

    await client.say({ type: 'node-remove', id: 2, nodeId: 'node-1' });
    await Promise.resolve();

    // `refused` says the hub understood and declined, which invites nothing;
    // `internal` says it broke and retrying may work, which is true here. What
    // broke inside the database is not sent -- it is not a client's to render.
    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', replyTo: 2, code: 'internal' });
  });

  it('refuses a tree frame that arrives before hello, and edits nothing', async () => {
    const { broadcast, catalogue } = harness();
    const client = attach(broadcast);

    await client.say({ type: 'node-remove', id: 1, nodeId: 'node-1' });

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
    expect(catalogue.asked).toEqual([]);
    expect(client.socket.closure).not.toBeNull();
  });
});

describe('the document frames', () => {
  const PROJECT = 'project-1';

  /**
   * A hello, a project, and a document in it.
   *
   * The project is made through the same socket rather than put in the fake by
   * hand, because that is the order a client does it in: a document is created
   * in a project the client has just been handed the id of.
   */
  async function withDocument(): Promise<{ harness: Harness; client: Client; nodeId: string }> {
    const held = harness();
    const client = attach(held.broadcast);
    await client.hello();
    await client.say({ type: 'project-create', id: 2, name: 'agentplex', directory: '/srv/work' });
    await client.say({
      type: 'doc-create',
      id: 3,
      projectId: PROJECT,
      server: 'registration-attic',
      name: 'plan.md',
      content: '# Plan\n',
    });
    const created = client.received.at(-1);
    if (created?.type !== 'doc-created') throw new Error('the create was not answered');
    return { harness: held, client, nodeId: created.nodeId };
  }

  it('answers a create with the node the document will be named by', async () => {
    const { harness: held, nodeId } = await withDocument();

    expect(held.docs.created).toEqual([
      {
        nodeId,
        projectId: PROJECT,
        server: 'registration-attic',
        name: 'plan.md',
        content: '# Plan\n',
      },
    ]);
  });

  it('answers a save with the machine\u2019s write time and not the hub\u2019s', async () => {
    const { client, nodeId } = await withDocument();

    await client.say({ type: 'doc-save', id: 4, nodeId, content: '# Plan\n\n- one more\n' });

    const saved = client.received.at(-1);
    expect(saved).toMatchObject({ type: 'doc-saved', replyTo: 4 });
    if (saved?.type !== 'doc-saved') return;
    // Whatever the far end said. The hub relays it rather than stamping its
    // own receipt, which would be this number plus two machines' latency.
    expect(saved.updatedAt).toBe(1_756_000_000_001);
  });

  it('answers an open with the document whole', async () => {
    const { client, nodeId } = await withDocument();

    await client.say({ type: 'doc-open', id: 4, nodeId });

    expect(client.received.at(-1)).toEqual({
      type: 'doc-content',
      replyTo: 4,
      content: '# Plan\n',
      updatedAt: 1_756_000_000_000,
    });
  });

  it('refuses an open in words when the machine that has it is away', async () => {
    const { harness: held, client, nodeId } = await withDocument();
    held.docs.refuseWith({
      code: 'refused',
      problem: 'attic is not connected right now, and the hub holds no copy of its documents',
    });

    await client.say({ type: 'doc-open', id: 4, nodeId });

    expect(client.received.at(-1)).toEqual({
      type: 'refusal',
      replyTo: 4,
      code: 'refused',
      message: 'attic is not connected right now, and the hub holds no copy of its documents',
      // A document has no live process to name, so `holder` is null, like every
      // refusal but a session's.
      holder: null,
    });
    expect(client.socket.closure).toBeNull();
  });

  it('refuses a document frame that arrives before hello, and writes nothing', async () => {
    const { broadcast, docs } = harness();
    const client = attach(broadcast);

    await client.say({ type: 'doc-open', id: 1, nodeId: 'doc-1' });

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
    expect(docs.opened).toEqual([]);
    expect(client.socket.closure).not.toBeNull();
  });

  it('closes on a name the protocol will not take, because the frame has no id to answer', async () => {
    const { broadcast, docs } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'doc-create',
      id: 2,
      projectId: PROJECT,
      server: 'registration-attic',
      name: '../escape.md',
      content: '',
    });

    // The name is the one string that ends up joined onto a path, so it is a
    // parser and not a judgement: an unreadable frame is a protocol error and
    // a closed socket, and nothing reached the feature.
    expect(client.received.at(-1)).toMatchObject({ type: 'protocol-error', code: 'bad-request' });
    expect(docs.created).toEqual([]);
    expect(client.socket.closure).not.toBeNull();
  });
});

describe('reading part of the catalogue', () => {
  const A_QUERY = {
    view: 'list' as const,
    groupBy: 'server' as const,
    sort: { key: 'name' as const, direction: 'asc' as const },
    filter: { search: 'auth' },
    cursor: null,
    limit: 25,
  };

  it('passes the whole question down and answers the page to the client that asked', async () => {
    const { broadcast, catalogue } = harness();
    catalogue.answerPageWith({
      ok: true,
      items: [],
      nextCursor: 'the-next-cursor',
      total: 340,
      version: 7,
    });
    const client = attach(broadcast);
    const bystander = attach(broadcast);
    await client.hello();
    await bystander.hello();
    const bystanderSaw = bystander.received.length;

    await client.say({ type: 'catalogue-query', id: 2, ...A_QUERY });

    // Every parameter reached the feature that owns the rows. This file's job
    // is the socket: nothing here decides an order or cuts a page.
    expect(catalogue.queried).toEqual([A_QUERY]);
    expect(client.received.at(-1)).toEqual({
      type: 'catalogue-page',
      replyTo: 2,
      items: [],
      nextCursor: 'the-next-cursor',
      total: 340,
      version: 7,
    });
    // A page is one person's question, sorted the way they asked: nothing about
    // the world changed because somebody read their own catalogue.
    expect(bystander.received.length).toBe(bystanderSaw);
  });

  /**
   * The one refusal a client acts on. `bad-request` and not `refused`, because
   * the frame named something this hub cannot serve -- a position in an order
   * that has moved -- rather than a state of the world saying no; and what the
   * client does about it is ask for the first page again.
   */
  it('passes a stale cursor refusal through with the sentence that says so', async () => {
    const { broadcast, catalogue } = harness();
    catalogue.answerPageWith({
      ok: false,
      code: 'bad-request',
      problem: 'that cursor is stale: ask for the first page again',
    });
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'catalogue-query', id: 2, ...A_QUERY, cursor: 'an-old-cursor' });

    expect(client.received.at(-1)).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'bad-request',
      message: 'that cursor is stale: ask for the first page again',
      holder: null,
    });
    expect(client.socket.closure).toBeNull();
  });

  it('refuses as internal when the catalogue cannot be read, and stays open', async () => {
    const { broadcast, catalogue } = harness();
    catalogue.failWith(new Error('database is locked'));
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'catalogue-query', id: 2, ...A_QUERY });

    expect(client.received.at(-1)).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'internal',
      message: 'the hub could not read its catalogue',
      holder: null,
    });
    expect(client.socket.closure).toBeNull();
  });
});

describe('the word that the tree changed', () => {
  it('reaches every established client, unasked, carrying the version', async () => {
    const { broadcast, catalogue } = harness();
    const one = attach(broadcast);
    const two = attach(broadcast);
    await one.hello();
    await two.hello();

    catalogue.change();

    for (const client of [one, two]) {
      expect(client.received.at(-1)).toEqual({ type: 'catalogue-changed', version: 1 });
    }
  });

  it('is not sent to a socket that has not said hello', async () => {
    const { broadcast, catalogue } = harness();
    const quiet = attach(broadcast);

    catalogue.change();

    expect(quiet.socket.sent).toEqual([]);
  });

  /**
   * Not coalesced, which is the one place this differs from the state. The
   * state is read at flush time, so waiting a turn buys a newer reading; this
   * carries a version and no content, so a delay would buy nothing and cost
   * the promptness that is the whole reason it exists.
   */
  it('is one frame per change rather than one frame per turn of the loop', async () => {
    const { broadcast, catalogue } = harness();
    const client = attach(broadcast);
    await client.hello();

    catalogue.change();
    catalogue.change();
    catalogue.change();

    expect(
      client.received
        .filter((frame) => frame.type === 'catalogue-changed')
        .map((frame) => frame.version),
    ).toEqual([1, 2, 3]);
  });

  it('costs one client its own word, not everybody theirs, when its socket throws', async () => {
    const { broadcast, catalogue } = harness();
    const broken = attach(broadcast);
    const working = attach(broadcast);
    await broken.hello();
    await working.hello();
    const failing = broken.socket as { send: (text: string) => void };
    failing.send = () => {
      throw new Error('socket is closing');
    };

    catalogue.change();

    expect(working.received.at(-1)).toEqual({ type: 'catalogue-changed', version: 1 });
  });

  it('stops when the broadcast does, so a late change reaches nobody', async () => {
    const { broadcast, catalogue } = harness();
    const client = attach(broadcast);
    await client.hello();
    const sent = client.socket.sent.length;

    broadcast.stop();
    catalogue.change();

    expect(client.socket.sent.length).toBe(sent);
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

/**
 * Pairing, over the socket a person's browser is on.
 *
 * The subject is the connection: which frame comes back, what it carries, and
 * what the hub was told to do in between. The table itself is tested against a
 * migrated schema, and the whole path -- a client pairing a real server end
 * that the hub then dials -- is in `tests/hub-server`.
 */
async function settle(): Promise<void> {
  // A pairing handler awaits a write and then a sync. Turns rather than a
  // timer: everything here resolves immediately, and the only question is how
  // many microtasks deep the answer is.
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

const A_PAIRING = {
  type: 'server-pair',
  id: 2,
  label: 'gpu-box-01',
  address: 'wss://gpu-box-01.example:8443',
  token: 'printed-by-the-server',
};

describe('a client that pairs a server', () => {
  it('is answered with the hub’s own name for the pairing', async () => {
    const { broadcast, pairing } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say(A_PAIRING);
    await settle();

    expect(client.received.at(-1)).toEqual({
      type: 'server-paired',
      replyTo: 2,
      registrationId: 'registration-1',
    });
    expect(pairing.registered).toEqual([
      {
        label: 'gpu-box-01',
        address: 'wss://gpu-box-01.example:8443',
        token: 'printed-by-the-server',
      },
    ]);
  });

  it('tells the supervisor to re-read the table, so the dial needs no restart', async () => {
    const { broadcast, syncs } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say(A_PAIRING);
    await settle();

    expect(syncs()).toBe(1);
  });

  it('has told it before it answers, so a paired server is already being dialled', async () => {
    // The ordering, not just the fact. A client told `server-paired` and then
    // shown a state with no such server would be reading a screen that
    // contradicts the answer it just got.
    const { broadcast, syncs } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say(A_PAIRING);
    await settle();

    const paired = client.received.findIndex((frame) => frame.type === 'server-paired');
    expect(paired).toBeGreaterThan(-1);
    expect(syncs()).toBe(1);
  });

  it('refuses an address it will not dial, in the parser’s own words', async () => {
    const { broadcast, pairing, syncs } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ ...A_PAIRING, address: 'ws://gpu-box-01.example:8443' });
    await settle();

    const answer = client.received.at(-1);
    expect(answer).toMatchObject({ type: 'refusal', replyTo: 2, code: 'bad-request' });
    if (answer?.type !== 'refusal') return;
    expect(answer.message).toContain('wss://');
    // Nothing was written and nothing was dialled: a refusal is the whole of
    // what happened.
    expect(pairing.registered).toEqual([]);
    expect(syncs()).toBe(0);
  });

  it('refuses an empty label rather than storing a row nothing can name', async () => {
    const { broadcast, pairing } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ ...A_PAIRING, label: '   ' });
    await settle();

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
    expect(pairing.registered).toEqual([]);
  });

  it('refuses an empty token: the credential is the point of the frame', async () => {
    const { broadcast, pairing } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ ...A_PAIRING, token: '' });
    await settle();

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
    expect(pairing.registered).toEqual([]);
  });

  it('stays open through a refusal: a typo is not a protocol error', async () => {
    // The reason the frame's own schema bounds these fields and rules on
    // nothing else. A strict parser would answer a mistyped address with a
    // `protocol-error` and a closed socket, which is a disconnection for a
    // typo.
    const { broadcast } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ ...A_PAIRING, address: 'not an address' });
    await settle();

    expect(client.socket.closure).toBeNull();
    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
  });

  it('says the hub broke when the hub broke, which is the answer worth retrying', async () => {
    const pairing = createFakePairing();
    pairing.failWith(new Error('database is locked'));
    const { broadcast } = harness(undefined, undefined, {}, pairing);
    const client = attach(broadcast);
    await client.hello();

    await client.say(A_PAIRING);
    await settle();

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'internal' });
  });

  it('needs a hello first, like everything else on this socket', async () => {
    const { broadcast, pairing } = harness();
    const client = attach(broadcast);

    await client.say(A_PAIRING);
    await settle();

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
    expect(pairing.registered).toEqual([]);
  });

  it('never says the token again, in any frame it sends afterwards', async () => {
    // The rule the whole pairing surface rests on: the token travels once,
    // inbound. Asserted over the characters on the socket rather than over a
    // field, because a field assertion only covers the shapes somebody thought
    // of -- this covers the reply, the refusal, every machine state after it,
    // and anything a later ticket adds.
    const { state, broadcast, timers } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say(A_PAIRING);
    await settle();
    state.applyConnection(connection('gpu-box-01', 'connected', ['store-work']));
    timers.fireAll();
    await settle();

    expect(client.received.some((frame) => frame.type === 'server-paired')).toBe(true);
    for (const text of client.socket.sent) {
      expect(text).not.toContain('printed-by-the-server');
    }
  });
});

describe('a client that unpairs a server', () => {
  const paired = {
    id: 'registration-1' as ServerRegistrationId,
    label: 'gpu-box-01',
    address: serverAddressSchema.parse('wss://gpu-box-01.example:8443'),
    serverId: null,
    createdAt: START,
    lastConnectedAt: null,
    token: 'printed-by-the-server',
    revokedAt: null,
  };

  it('is answered that the pairing is gone, with nothing else to carry', async () => {
    const pairing = createFakePairing({ servers: [paired] });
    const { broadcast } = harness(undefined, undefined, {}, pairing);
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'server-unpair', id: 2, registrationId: 'registration-1' });
    await settle();

    expect(client.received.at(-1)).toEqual({ type: 'server-unpaired', replyTo: 2 });
    expect(pairing.revoked).toEqual(['registration-1']);
  });

  it('tells the supervisor, so the hub stops dialling what it was just told to drop', async () => {
    const pairing = createFakePairing({ servers: [paired] });
    const { broadcast, syncs } = harness(undefined, undefined, {}, pairing);
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'server-unpair', id: 2, registrationId: 'registration-1' });
    await settle();

    expect(syncs()).toBe(1);
  });

  it('refuses a registration this hub does not have', async () => {
    const { broadcast, syncs } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'server-unpair', id: 2, registrationId: 'registration-9' });
    await settle();

    expect(client.received.at(-1)).toMatchObject({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
    });
    expect(syncs()).toBe(0);
  });

  it('refuses a second unpair the same way as an unknown one', async () => {
    // Already revoked and never existed are one outcome -- there is no live
    // pairing to end -- and `refused` rather than `bad-request` because the
    // frame was understood perfectly and the world is what said no.
    const pairing = createFakePairing({ servers: [paired] });
    const { broadcast } = harness(undefined, undefined, {}, pairing);
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'server-unpair', id: 2, registrationId: 'registration-1' });
    await settle();
    await client.say({ type: 'server-unpair', id: 3, registrationId: 'registration-1' });
    await settle();

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', replyTo: 3, code: 'refused' });
  });

  it('says the hub broke when the revocation itself failed', async () => {
    const pairing = createFakePairing({ servers: [paired] });
    pairing.failWith(new Error('database is locked'));
    const { broadcast } = harness(undefined, undefined, {}, pairing);
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'server-unpair', id: 2, registrationId: 'registration-1' });
    await settle();

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'internal' });
  });

  it('answers the client that asked and nobody else', async () => {
    const pairing = createFakePairing({ servers: [paired] });
    const { broadcast } = harness(undefined, undefined, {}, pairing);
    const asking = attach(broadcast);
    const watching = attach(broadcast);
    await asking.hello();
    await watching.hello();
    const seenByWatcher = watching.socket.sent.length;

    await asking.say({ type: 'server-unpair', id: 2, registrationId: 'registration-1' });
    await settle();

    expect(asking.received.at(-1)).toEqual({ type: 'server-unpaired', replyTo: 2 });
    expect(watching.socket.sent.length).toBe(seenByWatcher);
  });
});

describe('a client answering an approval', () => {
  const STORE = 'store-work';
  const SESSION = 'session-1';

  /** The frame a client sends, with the one id this file spends on it. */
  const decide = {
    type: 'approval-decide',
    id: 2,
    storeId: STORE,
    sessionId: SESSION,
    approvalId: 'approval-1',
    decision: 'grant',
  };

  it('says nothing until the machine holding the request says what happened', async () => {
    const { broadcast, approvals } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say(decide);

    // The frame has gone to the machine and nothing has come back. A receipt
    // written here would be this hub reporting a grant it cannot see the end
    // of: the hook it released may run for ten minutes.
    expect(approvals.decided).toEqual([
      { ref: { storeId: STORE, sessionId: SESSION }, approvalId: 'approval-1', decision: 'grant' },
    ]);
    expect(client.received.some((frame) => frame.type === 'approval-decided')).toBe(false);

    approvals.answer({ ok: true, outcome: 'granted', answeredBy: null });
    await Promise.resolve();

    expect(client.received.at(-1)).toEqual({
      type: 'approval-decided',
      replyTo: 2,
      outcome: 'granted',
      answeredBy: null,
    });
  });

  it('gives the client that lost the race the ending rather than a refusal', async () => {
    const { broadcast, approvals } = harness();
    const client = attach(broadcast);
    await client.hello();
    await client.say(decide);

    // Somebody else's tap was the one applied. What this client is owed is
    // what became of the request -- which is exactly what the receipt carries,
    // and why it has no "you won" on it.
    approvals.answer({
      ok: false,
      outcome: 'granted',
      answeredBy: null,
      code: 'refused',
      problem: 'that approval was already answered, and is granted',
    });
    await Promise.resolve();

    expect(client.received.at(-1)).toEqual({
      type: 'approval-decided',
      replyTo: 2,
      outcome: 'granted',
      answeredBy: null,
    });
  });

  it('refuses when there is no ending to report, because a receipt would invent one', async () => {
    const { broadcast, approvals } = harness();
    const client = attach(broadcast);
    await client.hello();
    await client.say(decide);

    approvals.answer({
      ok: false,
      outcome: null,
      answeredBy: null,
      code: 'refused',
      problem: 'this hub is holding no approval by that id for that session',
    });
    await Promise.resolve();

    expect(client.received.at(-1)).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
      message: 'this hub is holding no approval by that id for that session',
      holder: null,
    });
  });

  it('needs a hello first, like every other frame on the socket', async () => {
    const { broadcast, approvals } = harness();
    const client = attach(broadcast);

    await client.say(decide);

    expect(approvals.decided).toEqual([]);
    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
  });
});

/**
 * The two push frames, over the socket a person's browser is on.
 *
 * The subject is the connection: what the welcome says about this hub, which
 * frame comes back, and what the seam was handed in between. The table itself
 * is tested against a migrated schema, and the whole path -- a browser
 * subscribing to a hub that then holds the row -- is in `tests/hub-server`.
 */
describe('a client that wants to be told when nobody is looking', () => {
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHxN0-example';
  const KEYS = {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  };

  it('is told on the welcome which key to subscribe against', async () => {
    const { broadcast } = pushHarness(createFakePush());
    const client = attach(broadcast);

    await client.hello();

    expect(client.received[0]).toMatchObject({
      type: 'welcome',
      pushPublicKey: FAKE_PUSH_PUBLIC_KEY,
    });
  });

  it('is told null by a hub that has no push, rather than an empty key', async () => {
    // The state a hub served over plaintext is in anyway. A client reads this
    // and stays on the in-page floor instead of offering a control that
    // cannot work.
    const { broadcast } = pushHarness(null);
    const client = attach(broadcast);

    await client.hello();

    expect(client.received[0]).toMatchObject({ type: 'welcome', pushPublicKey: null });
  });

  it('has its subscription stored, and is told so', async () => {
    const push = createFakePush();
    const { broadcast } = pushHarness(push);
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'push-subscribe',
      id: 2,
      subscription: { endpoint: ENDPOINT, keys: KEYS },
    });
    await settle();

    expect(push.stored).toEqual([{ endpoint: ENDPOINT, keys: KEYS }]);
    expect(client.received.at(-1)).toEqual({ type: 'push-subscribed', replyTo: 2 });
  });

  it('has the endpoint forgotten, and is told so', async () => {
    const push = createFakePush();
    const { broadcast } = pushHarness(push);
    const client = attach(broadcast);
    await client.hello();
    await client.say({
      type: 'push-subscribe',
      id: 2,
      subscription: { endpoint: ENDPOINT, keys: KEYS },
    });
    await settle();

    await client.say({ type: 'push-unsubscribe', id: 3, endpoint: ENDPOINT });
    await settle();

    expect(push.stored).toEqual([]);
    expect(client.received.at(-1)).toEqual({ type: 'push-unsubscribed', replyTo: 3 });
  });

  it('is refused in words by a hub with no push, rather than quietly accepted', async () => {
    const { broadcast } = pushHarness(null);
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'push-subscribe',
      id: 2,
      subscription: { endpoint: ENDPOINT, keys: KEYS },
    });
    await settle();

    const answer = client.received.at(-1);
    expect(answer).toMatchObject({ type: 'refusal', replyTo: 2, code: 'refused' });
    if (answer?.type !== 'refusal') return;
    expect(answer.message).toContain('attention floor');
  });

  it('is refused an unsubscribe by a hub with no push: it never held the row', async () => {
    const { broadcast } = pushHarness(null);
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'push-unsubscribe', id: 2, endpoint: ENDPOINT });
    await settle();

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', replyTo: 2, code: 'refused' });
  });

  it('needs a hello first, like everything else on this socket', async () => {
    const push = createFakePush();
    const { broadcast } = pushHarness(push);
    const client = attach(broadcast);

    await client.say({
      type: 'push-subscribe',
      id: 1,
      subscription: { endpoint: ENDPOINT, keys: KEYS },
    });
    await settle();

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
    expect(push.stored).toEqual([]);
  });

  it('says the hub broke when the write itself failed, which retrying may fix', async () => {
    const push = createFakePush();
    push.failWith(new Error('database is locked'));
    const { broadcast } = pushHarness(push);
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'push-subscribe',
      id: 2,
      subscription: { endpoint: ENDPOINT, keys: KEYS },
    });
    await settle();

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'internal' });
  });

  it('answers the client that asked and nobody else', async () => {
    const { broadcast } = pushHarness(createFakePush());
    const asking = attach(broadcast);
    const watching = attach(broadcast);
    await asking.hello();
    await watching.hello();
    const seenByWatcher = watching.socket.sent.length;

    await asking.say({
      type: 'push-subscribe',
      id: 2,
      subscription: { endpoint: ENDPOINT, keys: KEYS },
    });
    await settle();

    expect(asking.received.at(-1)).toEqual({ type: 'push-subscribed', replyTo: 2 });
    expect(watching.socket.sent.length).toBe(seenByWatcher);
  });
});

/**
 * A client reading and editing a project's standing policy.
 *
 * Three frames and one answer, which is the shape being asserted here: every
 * one of them ends in the policy as it now stands, because a client that
 * applied its own add would be drawing a policy nobody vouched for.
 *
 * The refusals are the other half, and they are the half that matters. A rule
 * the parser will not have is a sentence for the person who typed it; a rule
 * that was not there is not a quiet success; and a policy the hub could not
 * read is never answered as an empty one, because an empty policy is a claim
 * that every request will reach somebody.
 */
describe('a client reading and editing a standing policy', () => {
  const PROJECT = nodeIdSchema.parse('node-project-work');
  const RULE = { tool: 'Bash', proposal: 'command: pnpm test' };

  it('answers a list with every rule the project holds', async () => {
    const { broadcast, approvalPolicy } = harness();
    await approvalPolicy.add({ project: PROJECT, rule: RULE });
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'approval-policy-list', id: 2, projectId: PROJECT });

    expect(client.received.at(-1)).toEqual({
      type: 'approval-policy',
      replyTo: 2,
      projectId: PROJECT,
      rules: [{ ruleId: 'rule-1', rule: RULE, createdAt: 1 }],
    });
  });

  it('answers an empty policy for a project that has decided nothing', async () => {
    const { broadcast } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'approval-policy-list', id: 2, projectId: PROJECT });

    expect(client.received.at(-1)).toMatchObject({ type: 'approval-policy', rules: [] });
  });

  it('answers an add with the policy the rule is now part of', async () => {
    const { broadcast, approvalPolicy } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'approval-policy-add', id: 2, projectId: PROJECT, rule: RULE });
    await Promise.resolve();

    expect(client.received.find((frame) => frame.type === 'approval-policy')).toMatchObject({
      type: 'approval-policy',
      replyTo: 2,
      rules: [{ rule: RULE }],
    });
    expect(approvalPolicy.held.get(PROJECT)).toHaveLength(1);
  });

  it('refuses a rule with the sentence the rule parser gave, not one of its own', async () => {
    const { broadcast, approvalPolicy } = harness();
    const client = attach(broadcast);
    await client.hello();

    // Shaped enough for the frame to parse, and not a rule. The bound is the
    // protocol's; the reason is `parseApprovalPolicyRule`'s, and it is what the
    // person who typed it has to read.
    await client.say({
      type: 'approval-policy-add',
      id: 2,
      projectId: PROJECT,
      rule: { tool: 'Bash', proposal: '   ' },
    });

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', replyTo: 2, code: 'refused' });
    expect(approvalPolicy.held.get(PROJECT) ?? []).toHaveLength(0);
  });

  it('refuses a rule made of a request too long to have been shown whole', async () => {
    const { broadcast, approvalPolicy } = harness();
    const client = attach(broadcast);
    await client.hello();

    // What a person gets by tapping "always allow" on a proposal the provider
    // had to cut. The frame parses -- the text is within the wire's bound --
    // and the rule is refused in words, because a rule made of cut text would
    // stand for every request that starts the same way.
    await client.say({
      type: 'approval-policy-add',
      id: 2,
      projectId: PROJECT,
      rule: { tool: 'Bash', proposal: 'x'.repeat(APPROVAL_PROPOSAL_MAX_CHARS) },
    });

    const refusal = client.received.at(-1);
    expect(refusal).toMatchObject({ type: 'refusal', replyTo: 2, code: 'refused' });
    expect(refusal?.type === 'refusal' ? refusal.message : '').toContain('too long');
    expect(approvalPolicy.held.get(PROJECT) ?? []).toHaveLength(0);
  });

  it('answers a removal with what is left', async () => {
    const { broadcast, approvalPolicy } = harness();
    const added = await approvalPolicy.add({ project: PROJECT, rule: RULE });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'approval-policy-remove',
      id: 2,
      projectId: PROJECT,
      ruleId: added.ruleId,
    });
    await Promise.resolve();

    expect(client.received.find((frame) => frame.type === 'approval-policy')).toEqual({
      type: 'approval-policy',
      replyTo: 2,
      projectId: PROJECT,
      rules: [],
    });
  });

  it('refuses a removal of a rule that project does not hold', async () => {
    // Not a silent success. "It is gone" and "the screen you are looking at is
    // not the policy this hub holds" are two different things to be told.
    const { broadcast } = harness();
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'approval-policy-remove',
      id: 2,
      projectId: PROJECT,
      ruleId: 'rule-nobody-wrote',
    });

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', replyTo: 2, code: 'refused' });
  });

  it('refuses rather than answering an empty policy when the read fails', async () => {
    // The one degradation this feature may not make. An empty list would be
    // drawn as "every request here reaches you", which is the opposite of what
    // an unreadable policy means.
    const { broadcast, approvalPolicy } = harness();
    approvalPolicy.fails('disk gone');
    const client = attach(broadcast);
    await client.hello();

    await client.say({ type: 'approval-policy-list', id: 2, projectId: PROJECT });

    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', replyTo: 2, code: 'internal' });
  });

  it('needs a hello first, like every other frame on the socket', async () => {
    const { broadcast, approvalPolicy } = harness();
    const client = attach(broadcast);

    await client.say({ type: 'approval-policy-list', id: 2, projectId: PROJECT });

    expect(approvalPolicy.held.size).toBe(0);
    expect(client.received.at(-1)).toMatchObject({ type: 'refusal', code: 'bad-request' });
  });
});

describe('reading one session’s transcript', () => {
  const STORE = 'store-work';
  const SESSION = 'session-1';

  it('answers the client that asked, with what the machine holding the file said', async () => {
    const sessions = createFakeSessions({
      transcript: {
        ok: true,
        activities: [
          { kind: 'command', text: 'pnpm install', exitStatus: 0 },
          { kind: 'command', text: 'pnpm test' },
        ],
        olderExist: true,
      },
    });
    const { broadcast } = harness(async () => [], sessions);
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'session-transcript',
      id: 2,
      storeId: STORE,
      sessionId: SESSION,
      count: 50,
    });

    expect(client.received.at(-1)).toEqual({
      type: 'session-transcript-read',
      replyTo: 2,
      activities: [
        { kind: 'command', text: 'pnpm install', exitStatus: 0 },
        { kind: 'command', text: 'pnpm test' },
      ],
      olderExist: true,
    });
    // The client named a session and a bound, and nothing else: no machine and
    // no provider, because both are the hub's rows to read.
    expect(sessions.transcripts).toEqual([{ storeId: STORE, sessionId: SESSION, count: 50 }]);
  });

  it('passes a refusal back as a sentence with no holder on it', async () => {
    const sessions = createFakeSessions({
      transcript: {
        ok: false,
        code: 'refused',
        problem: 'no server with that store mounted is connected right now',
      },
    });
    const { broadcast } = harness(async () => [], sessions);
    const client = attach(broadcast);
    await client.hello();

    await client.say({
      type: 'session-transcript',
      id: 2,
      storeId: STORE,
      sessionId: SESSION,
      count: 50,
    });

    expect(client.received.at(-1)).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
      message: 'no server with that store mounted is connected right now',
      // A transcript has no live process to name: it is a file, and no agent
      // running is why it could not be read.
      holder: null,
    });
    expect(client.socket.closure).toBeNull();
  });

  it('reads no transcript for a client that has not said hello', async () => {
    const sessions = createFakeSessions();
    const { broadcast } = harness(async () => [], sessions);
    const client = attach(broadcast);

    await client.say({
      type: 'session-transcript',
      id: 2,
      storeId: STORE,
      sessionId: SESSION,
      count: 50,
    });

    expect(sessions.transcripts).toEqual([]);
  });
});
