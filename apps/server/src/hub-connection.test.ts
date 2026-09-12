import { describe, expect, it } from 'vitest';
import {
  parseServerToHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type ProviderReadiness,
  type ServerToHubFrame,
  sessionRefSchema,
  type StoreDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { createFakeMessageSocket, PEER_GONE } from '@agentplex/node-shared/testing';
import { createLogger, CLOSE_POLICY, type LogRecord } from '@agentplex/node-shared';
import { serveHubConnection } from './hub-connection.js';
import type { ServerIdentity } from '@agentplex/providers';
import { createFakeSessionController } from './fake-session-controller.js';
import { createFakeTerminals } from './fake-terminals.js';
import {
  createFakeGrantAuthority,
  missingProvider,
  readyProvider,
} from '@agentplex/providers/testing';
import { createHubAudience } from './hub-audience.js';
import { createFakeMachineLoadReader, createFakeMachineProbe } from './fake-machine-probe.js';
import { createMachineLoadReader, type MachineLoadReader } from './machine-load.js';
import * as linux from './machine-load-linux.fixture.js';

const logger = createLogger('error', () => {});

const identity: ServerIdentity = {
  serverId: 'server-under-test' as ServerIdentity['serverId'],
  token: 'the-right-token',
};

/** The one grant this file's server has, and the token minted for it. */
const TOKEN = 'the-right-token';
const GRANT = 'grant-under-test';

const stores: readonly StoreDescriptor[] = [
  { storeId: 'store-a' as StoreId, path: '/volumes/claude' },
];

const SESSION = sessionRefSchema.parse({ storeId: 'store-a', sessionId: 'session-a' });

/** What the startup preflight found, as every handshake reports it. */
const providers: readonly ProviderReadiness[] = [readyProvider()];

/** The frame a well-behaved hub opens with. */
function handshake(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'handshake',
    id: 1,
    protocolVersion: PROTOCOL_VERSION,
    hubId: 'hub-under-test',
    token: TOKEN,
    ...overrides,
  });
}

/**
 * The dependencies every connection in this file shares, so that a test naming
 * one of them is naming the thing it is about.
 */
function deps(
  overrides: Partial<Parameters<typeof serveHubConnection>[1]> = {},
): Parameters<typeof serveHubConnection>[1] {
  const sessions = overrides.sessions ?? createFakeSessionController();
  return {
    connectionId: 'connection-under-test',
    identity,
    grants: createFakeGrantAuthority({ grants: { [TOKEN]: GRANT } }),
    audience: createHubAudience({ sessions, logger }),
    stores,
    providers,
    sessions,
    terminals: createFakeTerminals().terminals,
    machineLoad: createFakeMachineLoadReader(),
    logger,
    ...overrides,
  };
}

function connect(overrides: Partial<Parameters<typeof serveHubConnection>[1]> = {}) {
  const socket = createFakeMessageSocket();
  const { terminals, factory } = createFakeTerminals();
  const sessions = overrides.sessions ?? createFakeSessionController();
  const connection = serveHubConnection(socket, deps({ terminals, sessions, ...overrides }));
  return { socket, connection, terminals, factory, sessions };
}

/**
 * A machine whose counters move between questions, and a clock that moves with
 * them, so that a pong has a share to carry.
 *
 * Built from the captured Linux counters rather than from numbers written here:
 * what a pong carries is whatever the reader made of a real machine's
 * accounting, and a hand-made pair would test the assembly and not the reading.
 */
function busyMachine(): { reader: MachineLoadReader; advance: () => void } {
  const probe = createFakeMachineProbe(linux.before, linux.loadAverage);
  let now = 0;
  const reader = createMachineLoadReader({ probe, clock: { now: () => now } });
  return {
    reader,
    advance: () => {
      probe.set(linux.after);
      now += linux.windowMs;
    },
  };
}

/** Everything the server said, parsed by the parser that owns this direction. */
function replies(sent: readonly string[]): ServerToHubFrame[] {
  return sent.map((text) => {
    const parsed = parseTextFrame(parseServerToHubFrame, text);
    if (!parsed.ok) throw new Error(`the server sent an unparseable frame: ${parsed.reason}`);
    return parsed.value;
  });
}

/** Delivery is asynchronous, as it is on a real socket. */
const settle = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 0));

describe('serveHubConnection', () => {
  it('answers a good handshake with its identity, version and mounted stores', async () => {
    const { socket, connection } = connect();

    socket.receive(handshake());
    await settle();

    expect(replies(socket.sent)).toEqual([
      {
        type: 'handshake-accepted',
        replyTo: 1,
        protocolVersion: PROTOCOL_VERSION,
        serverId: 'server-under-test',
        stores: [{ storeId: 'store-a', path: '/volumes/claude' }],
        providers: [readyProvider()],
      },
    ]);
    expect(connection.state).toBe('established');
    expect(connection.grantId).toBe(GRANT);
    expect(socket.closure).toBeNull();
  });

  it('reports the stores it actually has, and an empty list when it has none', async () => {
    const socket = createFakeMessageSocket();
    serveHubConnection(socket, deps({ stores: [], providers: [readyProvider()] }));

    socket.receive(handshake());
    await settle();

    expect(replies(socket.sent)[0]).toMatchObject({ stores: [] });
  });

  it('says which providers it cannot run, rather than leaving that to a spawn', async () => {
    // The whole point of the field. On a pty this server would accept the
    // start, fork successfully, and report a session that appeared and
    // vanished; the hub has to be able to say no before that, and it can only
    // do that with what it is told here.
    const socket = createFakeMessageSocket();
    serveHubConnection(
      socket,
      deps({ providers: [missingProvider('claude'), readyProvider('codex')] }),
    );

    socket.receive(handshake());
    await settle();

    expect(replies(socket.sent)[0]).toMatchObject({
      providers: [
        { provider: 'claude', state: 'missing' },
        { provider: 'codex', state: 'ready' },
      ],
    });
  });

  it('refuses a wrong token and closes', async () => {
    const { socket, connection } = connect();

    socket.receive(handshake({ token: 'a-guess' }));
    await settle();

    expect(replies(socket.sent)).toEqual([
      { type: 'handshake-rejected', replyTo: 1, reason: 'unauthorized' },
    ]);
    expect(connection.state).toBe('closed');
    expect(socket.closure).toMatchObject({ code: CLOSE_POLICY });
  });

  it('says nothing about itself to a peer that did not authenticate', async () => {
    // The rejection carries a code and no detail on purpose: a server that
    // explained which half of the credential was wrong would be an oracle for
    // guessing the other half, and one that leaked its serverId or its stores
    // would answer a question the peer had not earned.
    const { socket } = connect();

    socket.receive(handshake({ token: 'a-guess' }));
    await settle();

    expect(socket.sent.join()).not.toContain('server-under-test');
    expect(socket.sent.join()).not.toContain('/volumes/claude');
  });

  it('checks the token before the protocol version', async () => {
    // Order matters: a peer with no valid token learns only that it was wrong.
    const { socket } = connect();

    socket.receive(handshake({ token: 'a-guess', protocolVersion: PROTOCOL_VERSION + 1 }));
    await settle();

    expect(replies(socket.sent)[0]).toMatchObject({ reason: 'unauthorized' });
  });

  it('refuses a protocol version that is not exactly its own', async () => {
    const { socket, connection } = connect();

    socket.receive(handshake({ protocolVersion: PROTOCOL_VERSION + 1 }));
    await settle();

    expect(replies(socket.sent)).toEqual([
      { type: 'handshake-rejected', replyTo: 1, reason: 'protocol-version' },
    ]);
    expect(connection.state).toBe('closed');
  });

  it('refuses an older protocol version too, because the match is exact and not a floor', async () => {
    const { socket } = connect();

    socket.receive(handshake({ protocolVersion: PROTOCOL_VERSION - 1 }));
    await settle();

    expect(replies(socket.sent)[0]).toMatchObject({ reason: 'protocol-version' });
  });

  it('answers nothing before a handshake, whatever is asked', async () => {
    const { socket, connection } = connect();

    socket.receive(JSON.stringify({ type: 'ping', id: 7 }));
    await settle();

    expect(replies(socket.sent)).toEqual([
      { type: 'protocol-error', code: 'bad-request', message: expect.any(String) },
    ]);
    expect(connection.state).toBe('closed');
  });

  it('answers a ping once the connection is established', async () => {
    const { socket } = connect();
    socket.receive(handshake());
    await settle();

    socket.receive(JSON.stringify({ type: 'ping', id: 2 }));
    await settle();

    expect(replies(socket.sent)[1]).toMatchObject({ type: 'pong', replyTo: 2 });
  });

  it('carries what this machine was doing, on the answer to the ping', async () => {
    // The cadence argument, made into a test. The load rides the heartbeat, so
    // a machine reports its cpus exactly as often as a hub asks after it and
    // never on a schedule of its own.
    const { reader, advance } = busyMachine();
    const { socket } = connect({ machineLoad: reader });
    socket.receive(handshake());
    await settle();

    advance();
    socket.receive(JSON.stringify({ type: 'ping', id: 2 }));
    await settle();

    const pong = replies(socket.sent)[1];
    expect(pong).toMatchObject({ type: 'pong', replyTo: 2 });
    // A share, and the window it is a share of. Not the window this test chose
    // for the fixture capture -- the one that elapsed between the reading taken
    // at the handshake and the reading taken now.
    expect(pong).toMatchObject({ load: { cpu: { windowMs: linux.windowMs } } });
  });

  it('takes its first reading at the handshake, so the first pong has a window', async () => {
    // Without the baseline the first answer after a connection opens would
    // carry no share at all, and a freshly connected machine would show no cpu
    // figure for a whole heartbeat. This is not a timer: it happens once,
    // because a hub dialled in.
    const { reader, advance } = busyMachine();
    const { socket } = connect({ machineLoad: reader });

    socket.receive(handshake());
    await settle();
    advance();
    socket.receive(JSON.stringify({ type: 'ping', id: 2 }));
    await settle();

    expect(replies(socket.sent)[1]).toMatchObject({
      load: { cpu: { percent: expect.any(Number) } },
    });
  });

  it('says nothing about its load rather than inventing one it cannot read', async () => {
    // A machine that exposes no cpu accounting. `null` on the frame, not a
    // reading of zeros: the pong still answers the ping, and the hub learns
    // that this machine cannot say.
    const silent = createMachineLoadReader({
      probe: createFakeMachineProbe([]),
      clock: { now: () => 0 },
    });
    const { socket } = connect({ machineLoad: silent });
    socket.receive(handshake());
    await settle();

    socket.receive(JSON.stringify({ type: 'ping', id: 2 }));
    await settle();

    expect(replies(socket.sent)[1]).toEqual({ type: 'pong', replyTo: 2, load: null });
  });

  it('refuses a second handshake on a connection that already has one', async () => {
    const { socket, connection } = connect();
    socket.receive(handshake());
    await settle();

    socket.receive(handshake({ id: 2 }));
    await settle();

    expect(replies(socket.sent)[1]).toMatchObject({ type: 'protocol-error' });
    expect(connection.state).toBe('closed');
  });

  it('closes on a frame it cannot read, having said what it objected to', async () => {
    const { socket, connection } = connect();

    socket.receive('{ not json');
    await settle();

    expect(replies(socket.sent)).toEqual([
      { type: 'protocol-error', code: 'bad-request', message: expect.any(String) },
    ]);
    expect(connection.state).toBe('closed');
  });

  it('closes on a frame that is JSON but not a frame', async () => {
    const { socket, connection } = connect();

    socket.receive(JSON.stringify({ type: 'handshake', id: 1, token: 'x' }));
    await settle();

    expect(replies(socket.sent)[0]).toMatchObject({ type: 'protocol-error' });
    expect(connection.state).toBe('closed');
  });

  it('never echoes the offending frame back', async () => {
    const { socket } = connect();

    socket.receive(JSON.stringify({ type: 'handshake', id: 1, token: 'a-secret-guess' }));
    await settle();

    expect(socket.sent.join()).not.toContain('a-secret-guess');
  });

  it('stops reading once it has closed', async () => {
    const { socket } = connect();
    socket.receive('{ not json');
    await settle();
    const afterClose = socket.sent.length;

    socket.receive(handshake());
    await settle();

    expect(socket.sent).toHaveLength(afterClose);
  });

  /**
   * The refusal that must look the same whatever went wrong. A rejection saying
   * "your access was revoked" confirms the token was real, which is the one bit
   * an attacker wants and the reason this frame carries no detail.
   */
  it.each([['revoked'], ['expired'], ['no-grant']] as const)(
    'refuses a %s grant exactly as it refuses a wrong token',
    async (refusal) => {
      const grants = createFakeGrantAuthority({
        grants: { [TOKEN]: GRANT },
        withdrawn: { [GRANT]: refusal },
      });
      const { socket, connection } = connect({ grants });

      socket.receive(handshake());
      await settle();

      expect(replies(socket.sent)).toEqual([
        { type: 'handshake-rejected', replyTo: 1, reason: 'unauthorized' },
      ]);
      expect(connection.state).toBe('closed');
      expect(connection.grantId).toBeNull();
      expect(socket.sent.join()).not.toContain(refusal);
    },
  );

  it('resolves the token to a grant rather than comparing it with one string', async () => {
    const grants = createFakeGrantAuthority({
      grants: { 'the-hub-in-the-basement': 'grant-basement', 'the-ci-hub': 'grant-ci' },
    });

    const basement = connect({ grants });
    basement.socket.receive(handshake({ token: 'the-hub-in-the-basement' }));
    const ci = connect({ grants });
    ci.socket.receive(handshake({ token: 'the-ci-hub' }));
    await settle();

    expect(basement.connection.grantId).toBe('grant-basement');
    expect(ci.connection.grantId).toBe('grant-ci');
  });

  /**
   * `hubId` survives as a label. A hub that renamed itself -- a rebuilt
   * database mints a new id -- is the same operator with the same token, and
   * the server records the disagreement rather than refusing it.
   */
  it('accepts a hub id it has never seen on a grant it has', async () => {
    const grants = createFakeGrantAuthority({ grants: { [TOKEN]: GRANT } });
    const { socket, connection } = connect({ grants });

    socket.receive(handshake({ hubId: 'a-hub-id-nothing-has-ever-seen' }));
    await settle();

    expect(connection.state).toBe('established');
    expect(grants.seen[0]?.hubId).toBe('a-hub-id-nothing-has-ever-seen');
  });

  /**
   * `redactSecrets` is wired into every log call, but a field it does not match
   * is a field it does not redact. Nothing here should be handing it one.
   */
  it('puts no token in a log line, on any path', async () => {
    const written: LogRecord[] = [];
    const noisy = createLogger('debug', (record) => void written.push(record));

    const good = connect({ logger: noisy });
    good.socket.receive(handshake());
    const bad = connect({ logger: noisy });
    bad.socket.receive(handshake({ id: 2, token: 'a-guess-that-must-not-be-logged' }));
    await settle();
    bad.socket.closeFromPeer(PEER_GONE);
    good.socket.closeFromPeer(PEER_GONE);
    await settle();

    const everything = JSON.stringify(written);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('a-guess-that-must-not-be-logged');
    // And the line did happen, so this is not passing on an empty log.
    expect(written.map((record) => record.message)).toContain('hub connection established');
  });

  it('answers nothing while it is still resolving a grant', async () => {
    // A file read is not instant, and a state machine with nothing between "no
    // handshake yet" and "established" would have a window in which a second
    // frame is answered by a connection that has neither refused nor accepted.
    const { socket, connection } = connect();

    // Both frames are on the wire before the grant has been resolved, which is
    // the race a real hub reconnecting into a busy server produces.
    socket.receive(handshake());
    socket.receive(JSON.stringify({ type: 'ping', id: 9 }));
    await settle();

    expect(replies(socket.sent)[0]).toMatchObject({ type: 'protocol-error' });
    expect(connection.state).toBe('closed');
    // And it never went on to accept: a connection refused mid-authorization
    // must not be established by the answer that was already in flight.
    expect(connection.grantId).toBeNull();
    expect(replies(socket.sent).some((frame) => frame.type === 'handshake-accepted')).toBe(false);
  });

  it('notices the hub going away', async () => {
    const { socket, connection } = connect();
    socket.receive(handshake());
    await settle();

    socket.closeFromPeer(PEER_GONE);
    await settle();

    expect(connection.state).toBe('closed');
  });

  it('says it is draining, unasked, with the sessions that are closing', async () => {
    const { socket, connection } = connect();
    socket.receive(handshake());
    await settle();
    const before = socket.sent.length;

    connection.announceDraining(15_000, [SESSION]);

    expect(replies(socket.sent.slice(before))).toEqual([
      {
        type: 'server-draining',
        graceMs: 15_000,
        sessions: [SESSION],
      },
    ]);
  });

  it('tells a peer that has not handshaken nothing about what is running here', () => {
    // The same rule every other frame follows. A socket that never proved it
    // may ask is owed no facts about this machine, and a shutdown is a fact.
    const { socket, connection } = connect();

    connection.announceDraining(15_000, []);

    expect(socket.sent).toHaveLength(0);
  });

  it('says nothing to a hub that has already gone', async () => {
    const { socket, connection } = connect();
    socket.receive(handshake());
    await settle();
    socket.closeFromPeer(PEER_GONE);
    await settle();
    const before = socket.sent.length;

    connection.announceDraining(15_000, []);

    expect(socket.sent).toHaveLength(before);
  });
});

/**
 * Two hubs paired with one server, which is the case the connection had no
 * answer for before grants: each connection was independent, each authenticated
 * with the same string, and nothing arbitrated between them.
 *
 * The decision these assert is that any paired hub may do anything to any
 * session -- they are one trust domain, each holding a credential this server
 * minted for it, and grants carry no scopes yet -- and that the cost of saying
 * yes is telling everybody what happened.
 */
describe('two hubs on one server', () => {
  const SESSION = { storeId: 'store-a', sessionId: 'session-a' };

  function report(sessionIds: readonly string[]) {
    return {
      storeId: 'store-a' as StoreId,
      sessions: [],
      holding: sessionIds.map((sessionId) => ({ sessionId: sessionId as never, stoppable: true })),
    };
  }

  /** One server, one session controller, one audience, and two dialled hubs. */
  async function twoHubs() {
    const sessions = createFakeSessionController({ reports: [report(['session-a'])] });
    const audience = createHubAudience({ sessions, logger });
    const grants = createFakeGrantAuthority({
      grants: { 'token-basement': 'grant-basement', 'token-laptop': 'grant-laptop' },
    });

    const dial = (connectionId: string, token: string) => {
      const socket = createFakeMessageSocket();
      const connection = serveHubConnection(socket, {
        ...deps({ sessions, audience, grants }),
        connectionId,
      });
      socket.receive(handshake({ token, hubId: connectionId }));
      return { socket, connection };
    };

    const basement = dial('connection-basement', 'token-basement');
    const laptop = dial('connection-laptop', 'token-laptop');
    await settle();
    return { basement, laptop, sessions, audience, dial };
  }

  /** What one socket has been sent, minus the handshake and the first reports. */
  function since(socket: { readonly sent: readonly string[] }, mark: number): ServerToHubFrame[] {
    return replies(socket.sent.slice(mark));
  }

  it('lets each hub authenticate to its own grant', async () => {
    const { basement, laptop, audience } = await twoHubs();

    expect(basement.connection.grantId).toBe('grant-basement');
    expect(laptop.connection.grantId).toBe('grant-laptop');
    expect(audience.grants).toEqual(['grant-basement', 'grant-laptop']);
  });

  /**
   * The fourth open question, answered. `session-stopped` carries `replyTo` and
   * the second hub asked nothing, so there is no frame to reply to. What it
   * gets instead is the fact: a whole store report, unsolicited, which is
   * already the shape that says what this server is running.
   */
  it('tells the hub that did not send the stop that the session stopped', async () => {
    const { basement, laptop, sessions } = await twoHubs();
    const mark = laptop.socket.sent.length;
    sessions.answerWith({
      ok: true,
      storeId: 'store-a' as StoreId,
      sessionId: 'session-a' as never,
      terminalId: 'terminal-a',
    });
    sessions.setReport(report([]));

    basement.socket.receive(JSON.stringify({ type: 'session-stop', id: 2, ...SESSION }));
    await settle();

    expect(since(laptop.socket, mark)).toEqual([
      { type: 'store-report', storeId: 'store-a', sessions: [], holding: [], starts: [] },
    ]);
  });

  it('answers the hub that did send it, after the report and on its own socket', async () => {
    const { basement, sessions } = await twoHubs();
    const mark = basement.socket.sent.length;
    sessions.answerWith({
      ok: true,
      storeId: 'store-a' as StoreId,
      sessionId: 'session-a' as never,
      terminalId: 'terminal-a',
    });
    sessions.setReport(report([]));

    basement.socket.receive(JSON.stringify({ type: 'session-stop', id: 2, ...SESSION }));
    await settle();

    expect(since(basement.socket, mark).map((frame) => frame.type)).toEqual([
      'store-report',
      'session-stopped',
    ]);
  });

  /**
   * The first open question, answered. The stop that arrives first wins,
   * because it is the one that finds a live terminal. The loser is told two
   * things in the order that makes them one sentence: this server's whole view
   * of the store, and then that it is not running that session.
   */
  it('gives the loser of a race the store and then the refusal', async () => {
    const { basement, laptop, sessions } = await twoHubs();
    sessions.answerWith({
      ok: true,
      storeId: 'store-a' as StoreId,
      sessionId: 'session-a' as never,
      terminalId: 'terminal-a',
    });
    sessions.setReport(report([]));
    basement.socket.receive(JSON.stringify({ type: 'session-stop', id: 2, ...SESSION }));
    await settle();

    const mark = laptop.socket.sent.length;
    sessions.answerWith({
      ok: false,
      code: 'refused',
      problem: 'this server is not running that session',
      hold: null,
    });
    laptop.socket.receive(JSON.stringify({ type: 'session-stop', id: 3, ...SESSION }));
    await settle();

    expect(since(laptop.socket, mark)).toEqual([
      { type: 'store-report', storeId: 'store-a', sessions: [], holding: [], starts: [] },
      {
        type: 'session-refused',
        replyTo: 3,
        code: 'refused',
        message: 'this server is not running that session',
        hold: null,
      },
    ]);
    // And it stays connected: it asked for something this machine would not do,
    // not something it may not ask.
    expect(laptop.connection.state).toBe('established');
  });

  it('tells every hub about a session one of them started', async () => {
    const { basement, laptop, sessions } = await twoHubs();
    const mark = laptop.socket.sent.length;
    sessions.answerWith({
      ok: true,
      storeId: 'store-a' as StoreId,
      sessionId: null,
      terminalId: 'terminal-a',
    });

    basement.socket.receive(
      JSON.stringify({
        type: 'session-start',
        id: 2,
        storeId: 'store-a',
        sessionId: null,
        provider: 'claude',
        prompt: null,
      }),
    );
    await settle();

    expect(since(laptop.socket, mark).map((frame) => frame.type)).toEqual(['store-report']);
  });

  /**
   * The second open question, answered in the direction that costs nothing. A
   * hub that has just connected knows what this machine has mounted and nothing
   * about what is in it, so it is owed a report; the hubs that were already
   * here know both, and re-sending it to them would make one flapping
   * connection everybody else's traffic.
   */
  it('reports to a hub that has just connected and not to the ones already there', async () => {
    const { basement, laptop, dial } = await twoHubs();
    const marks = [basement.socket.sent.length, laptop.socket.sent.length] as const;

    const third = dial('connection-ci', 'token-basement');
    await settle();

    expect(since(third.socket, 0).map((frame) => frame.type)).toEqual([
      'handshake-accepted',
      'store-report',
    ]);
    expect(basement.socket.sent.slice(marks[0])).toEqual([]);
    expect(laptop.socket.sent.slice(marks[1])).toEqual([]);
  });

  it('scans a store once for a stop, whatever the audience', async () => {
    const { basement, sessions } = await twoHubs();
    const before = sessions.scans.length;
    sessions.answerWith({
      ok: true,
      storeId: 'store-a' as StoreId,
      sessionId: 'session-a' as never,
      terminalId: 'terminal-a',
    });

    basement.socket.receive(JSON.stringify({ type: 'session-stop', id: 2, ...SESSION }));
    await settle();

    expect(sessions.scans.length - before).toBe(1);
  });
});
