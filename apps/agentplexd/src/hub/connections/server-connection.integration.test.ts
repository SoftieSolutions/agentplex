import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  serverIdSchema,
  storeIdSchema,
  type HubId,
  type ServerId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import { serveHubConnection } from '../../server/hub-connection.js';
import {
  createFakeMessageSocket,
  createSocketPair,
  PEER_GONE,
  type FakeMessageSocket,
} from '../../shared/fake-message-socket.js';
import { createLogger } from '../../shared/logger.js';
import { closure, CLOSE_NORMAL, type SocketDialer } from '../../shared/message-socket.js';
import { createFakeTimers, type FakeTimers } from '../../shared/timers.js';
import type { Database } from '../db/database.js';
import {
  findServer,
  newServerRegistrationSchema,
  registerServer,
  revokeServer,
  type LiveServerRegistration,
} from '../pairing/server-registrations.js';
import { listStores } from '../pairing/store-records.js';
import { openMigratedSchema, type MigratedSchema } from '../pairing/test-migrated-schema.js';
import { createExponentialBackoff } from './backoff.js';
import { startServerConnection, type ServerConnection } from './server-connection.js';
import { createFakeSessionController } from '../../server/fake-session-controller.js';

/**
 * The connection supervisor for one server, driven end to end.
 *
 * Both halves of the handshake are the real code: the dialer hands back a
 * linked socket pair with the server role's own `serveHubConnection` on the
 * far end, so a token is really compared, a protocol version is really
 * checked, and the frames are really JSON. Only three things are replaced, and
 * each is something a test cannot supply -- the wire, the passage of time, and
 * the machine at the other end being switched off.
 *
 * The database is real and on disk, because the claim under test is that an
 * unreachable server keeps its rows. A fake agreeing with that would only be
 * agreeing with this file.
 */

const logger = createLogger('error', () => {});
const hubId = 'hub-under-test' as HubId;

/** Fixed unless a test moves it: a stale label has to be checkable to the ms. */
const START = 1_756_000_000_000;

let migrated: MigratedSchema | null = null;

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

/** Waits for something the loop does asynchronously, without waiting on a clock. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function store(id: string, path: string): StoreDescriptor {
  return { storeId: storeIdSchema.parse(id), path };
}

/**
 * The machine at the other end of the wire, with the switches a test needs:
 * whether it is reachable, who it says it is, and what token it accepts.
 */
interface FakeMachine {
  readonly dialer: SocketDialer;
  /** How many times the hub has dialled. */
  readonly dials: number;
  /** The server end of the live connection, for hanging up from over there. */
  readonly live: FakeMessageSocket | null;
  /**
   * Stops the far end hearing anything, without closing.
   *
   * A suspended laptop, a NAT that forgot the flow: the socket stays open, the
   * hub's frames go nowhere, and no close ever arrives. Only an unanswered
   * ping can notice, which is the point of having one.
   */
  goSilent(): void;
  reachable: boolean;
  serverId: ServerId;
  token: string;
  stores: readonly StoreDescriptor[];
}

function fakeMachine(options: {
  serverId?: string;
  token?: string;
  stores?: readonly StoreDescriptor[];
}): FakeMachine {
  let dials = 0;
  let live: FakeMessageSocket | null = null;
  let hubSide: FakeMessageSocket | null = null;

  const machine: FakeMachine = {
    reachable: true,
    serverId: serverIdSchema.parse(options.serverId ?? 'server-laptop'),
    token: options.token ?? 'tok-laptop',
    stores: options.stores ?? [store('store-a', '/volumes/claude')],

    dialer: {
      dial: async () => {
        dials += 1;
        if (!machine.reachable) return { ok: false, problem: 'connection refused' };

        const { hubEnd, serverEnd } = createSocketPair();
        // The real server half, so the handshake this test drives is the one
        // the product runs.
        serveHubConnection(serverEnd, {
          sessions: createFakeSessionController(),
          identity: { serverId: machine.serverId, token: machine.token },
          stores: machine.stores,
          logger,
        });
        live = serverEnd;
        hubSide = hubEnd;
        return { ok: true, socket: hubEnd };
      },
    },

    goSilent(): void {
      // Repointed at a socket nobody serves, so sends succeed into nothing.
      hubSide?.connectTo(createFakeMessageSocket());
    },

    get dials() {
      return dials;
    },
    get live() {
      return live;
    },
  };

  return machine;
}

let running: ServerConnection | null = null;
let timers: FakeTimers;

async function register(label: string, token = `tok-${label}`): Promise<LiveServerRegistration> {
  return registerServer(
    db(),
    { newId: () => `registration-${label}` },
    { now: () => START },
    newServerRegistrationSchema.parse({
      label,
      address: `wss://${label}.example:8443`,
      token,
    }),
  );
}

interface StartOptions {
  readonly now?: () => number;
  readonly refusedRetryMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
}

function start(
  registration: LiveServerRegistration,
  machine: FakeMachine,
  options: StartOptions = {},
): ServerConnection {
  const connection = startServerConnection(registration, {
    database: db(),
    dialer: machine.dialer,
    hubId,
    timers,
    clock: { now: options.now ?? (() => START) },
    logger,
    // No jitter: this suite asserts on the schedule, and jitter is arithmetic
    // that `backoff.test.ts` already owns.
    backoff: createExponentialBackoff({ baseMs: 500, maxMs: 8000, random: () => 0 }),
    ...(options.refusedRetryMs === undefined ? {} : { refusedRetryMs: options.refusedRetryMs }),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.heartbeatTimeoutMs === undefined
      ? {}
      : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
  });
  running = connection;
  return connection;
}

/** Waits for the retry timer that a failure schedules, and answers its delay. */
async function retryDelayAfter(
  connection: ServerConnection,
  failures: number,
): Promise<number | undefined> {
  await until(
    () => connection.report.failedAttempts === failures && timers.pending === 1,
    `retry number ${failures} to be scheduled`,
  );
  return timers.delays[0];
}

describe('startServerConnection', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('connections-server-connection');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    timers = createFakeTimers();
    await db().query('DELETE FROM servers');
    await db().query('DELETE FROM stores');
  });

  afterEach(async () => {
    await running?.stop();
    running = null;
  });

  it('connects, and reports who answered and what it had mounted', async () => {
    const registration = await register('laptop');
    const connection = start(registration, fakeMachine({ token: 'tok-laptop' }));

    await until(() => connection.report.phase === 'connected', 'a connection');

    expect(connection.report).toMatchObject({
      phase: 'connected',
      serverId: 'server-laptop',
      stores: ['store-a'],
      connectedSince: START,
      staleSince: null,
      problem: null,
      failedAttempts: 0,
    });
  });

  it('writes the connection down, so a restart can still say when it was up', async () => {
    // The one connectivity fact that may live in a column: it is about the
    // past, so no restart can make it untrue.
    const registration = await register('laptop');
    const connection = start(registration, fakeMachine({}));

    await until(() => connection.report.phase === 'connected', 'a connection');

    expect((await findServer(db(), registration.id))?.lastConnectedAt).toBe(START);
  });

  it('marks an unreachable server stale, with a beginning and a reason', async () => {
    const registration = await register('laptop');
    const machine = fakeMachine({});
    machine.reachable = false;

    const connection = start(registration, machine);
    await until(() => connection.report.phase === 'stale', 'a stale server');

    expect(connection.report).toMatchObject({
      phase: 'stale',
      staleReason: 'unreachable',
      staleSince: START,
      // Never connected is a different fact from connected long ago: this
      // pairing has never worked, and a screen should be able to say so.
      lastConnectedAt: null,
      connectedSince: null,
    });
    expect(connection.report.problem).toContain('connection refused');
  });

  it('keeps every row an unreachable server had', async () => {
    // The whole rule, as a database assertion: unreachable is a label, never a
    // deletion. A hub that dropped rows when a laptop shut would lose the
    // pairing the operator typed and the stores it knows about.
    const registration = await register('laptop');
    const machine = fakeMachine({});
    const connection = start(registration, machine);
    await until(() => connection.report.phase === 'connected', 'a connection');

    machine.reachable = false;
    machine.live?.close(PEER_GONE);
    await until(() => connection.report.phase === 'stale', 'a stale server');

    expect(await findServer(db(), registration.id)).not.toBeNull();
    expect((await listStores(db())).map((row) => row.storeId)).toEqual(['store-a']);
  });

  it('lengthens the wait between retries', async () => {
    const registration = await register('laptop');
    const machine = fakeMachine({});
    machine.reachable = false;
    const connection = start(registration, machine);

    const delays: (number | undefined)[] = [];
    for (let failure = 1; failure <= 4; failure += 1) {
      delays.push(await retryDelayAfter(connection, failure));
      timers.fireAll();
    }

    // Doubling from the base, and stopping at the cap: a machine that has been
    // off all weekend is still dialled every few seconds, so switching it on
    // is enough to bring it back.
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    expect(machine.dials).toBeGreaterThanOrEqual(4);
  });

  it('keeps the stale label pointing at when the trouble started', async () => {
    // A retry is the same outage continuing. If each failure moved this, a
    // server that has been down since Friday would report that it went down a
    // second ago, and the age on the badge would be a lie that refreshes.
    const registration = await register('laptop');
    const machine = fakeMachine({});
    machine.reachable = false;
    let now = START;
    const connection = start(registration, machine, { now: () => now });
    await retryDelayAfter(connection, 1);

    now = START + 900_000;
    timers.fireAll();
    await retryDelayAfter(connection, 2);

    expect(connection.report.staleSince).toBe(START);
  });

  it('clears the staleness when the server comes back', async () => {
    const registration = await register('laptop');
    const machine = fakeMachine({});
    machine.reachable = false;
    const connection = start(registration, machine);
    await retryDelayAfter(connection, 1);

    machine.reachable = true;
    timers.fireAll();
    await until(() => connection.report.phase === 'connected', 'a recovered connection');

    expect(connection.report).toMatchObject({
      phase: 'connected',
      staleSince: null,
      staleReason: null,
      problem: null,
      failedAttempts: 0,
    });
  });

  it('goes stale when an established connection drops, and dials again', async () => {
    const registration = await register('laptop');
    const machine = fakeMachine({});
    const connection = start(registration, machine);
    await until(() => connection.report.phase === 'connected', 'a connection');
    const dialsWhenUp = machine.dials;

    machine.live?.close(PEER_GONE);
    await until(() => connection.report.phase === 'stale', 'a stale server');

    expect(connection.report.staleReason).toBe('dropped');
    // The first retry after a drop is the short one: a dropped connection is
    // usually a blip, and the attempt count starts again at one.
    expect(await retryDelayAfter(connection, 1)).toBe(500);
    timers.fireAll();
    await until(() => machine.dials > dialsWhenUp, 'a redial');
  });

  it('still says when a dropped server was last up', async () => {
    const registration = await register('laptop');
    const machine = fakeMachine({});
    let now = START;
    const connection = start(registration, machine, { now: () => now });
    await until(() => connection.report.phase === 'connected', 'a connection');

    now = START + 60_000;
    machine.live?.close(PEER_GONE);
    await until(() => connection.report.phase === 'stale', 'a stale server');

    // Stale since a minute in, last up at the start: an age, not an absence.
    expect(connection.report).toMatchObject({
      staleSince: START + 60_000,
      lastConnectedAt: START,
      // And what it had mounted is still there to show, labelled rather than
      // emptied -- an empty store list would read as a machine with nothing on
      // it, which is a different and wrong claim.
      stores: ['store-a'],
      serverId: 'server-laptop',
    });
  });

  it('ends a connection whose pings stop being answered', async () => {
    // The failure TCP never reports: a laptop that suspended, a NAT that
    // forgot the flow. Without this the hub would show it connected forever.
    const registration = await register('laptop');
    const machine = fakeMachine({});
    const connection = start(registration, machine, {
      heartbeatIntervalMs: 20_000,
      heartbeatTimeoutMs: 10_000,
    });
    await until(() => connection.report.phase === 'connected', 'a connection');

    // The far end stops hearing anything, without closing. Nothing replies,
    // and only the deadline can notice.
    machine.goSilent();
    machine.reachable = false;

    // The interval, then the deadline the ping set. Flushed in between, so
    // that a pong genuinely had the chance to arrive and did not.
    timers.fireAll();
    await new Promise((resolve) => setImmediate(resolve));
    timers.fireAll();

    await until(() => connection.report.phase === 'stale', 'a stale server');
    expect(connection.report.staleReason).toBe('dropped');
  });

  it('refuses a server that answers with a different identity, and says to re-pair', async () => {
    const registration = await register('laptop');
    const machine = fakeMachine({ serverId: 'server-original' });
    const connection = start(registration, machine, { refusedRetryMs: 60_000 });
    await until(() => connection.report.phase === 'connected', 'a connection');

    // The machine was re-provisioned and minted a new identity with the same
    // token pasted back in.
    machine.serverId = serverIdSchema.parse('server-replacement');
    machine.live?.close(PEER_GONE);
    await retryDelayAfter(connection, 1);
    timers.fireAll();
    await until(() => connection.report.staleReason === 'identity-changed', 'a refusal');

    expect(connection.report.problem).toContain('pair the machine again');
    // Not retried on the fast curve: nothing changes until a person acts, and
    // half-second dials would fill the log with one repeated fact.
    expect(await retryDelayAfter(connection, 2)).toBe(60_000);
    // And the pairing still names the server it was completed with.
    expect((await findServer(db(), registration.id))?.serverId).toBe('server-original');
  });

  it('waits before dialling again when the token is refused', async () => {
    const registration = await register('laptop', 'tok-the-user-typed');
    const machine = fakeMachine({ token: 'tok-the-server-printed' });

    const connection = start(registration, machine, { refusedRetryMs: 60_000 });
    await until(() => connection.report.phase === 'stale', 'a refusal');

    expect(connection.report.staleReason).toBe('unauthorized');
    expect(await retryDelayAfter(connection, 1)).toBe(60_000);
  });

  it('stops for good when the pairing was revoked while it was dialling', async () => {
    const registration = await register('laptop');
    await revokeServer(db(), { now: () => START }, registration.id);
    const machine = fakeMachine({});

    const connection = start(registration, machine);
    await until(() => connection.report.phase === 'stopped', 'a stopped connection');

    const dialsWhenRevoked = machine.dials;
    timers.fireAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect(machine.dials).toBe(dialsWhenRevoked);
    expect(timers.pending).toBe(0);
  });

  it('closes what it holds and stops dialling when the hub stops', async () => {
    const registration = await register('laptop');
    const machine = fakeMachine({});
    const connection = start(registration, machine);
    await until(() => connection.report.phase === 'connected', 'a connection');

    await connection.stop();

    expect(connection.report.phase).toBe('stopped');
    expect(machine.live?.closure).not.toBeNull();
    // Nothing scheduled behind it: a timer that outlives a shutdown is what
    // keeps a process from exiting.
    expect(timers.pending).toBe(0);
  });

  it('does not wait out a backoff to shut down', async () => {
    const registration = await register('laptop');
    const machine = fakeMachine({});
    machine.reachable = false;
    const connection = start(registration, machine);
    await retryDelayAfter(connection, 1);

    // No timer is fired here. If stopping had to wait for the retry that is
    // pending, this would hang rather than fail.
    await connection.stop();

    expect(connection.report.phase).toBe('stopped');
  });

  it('starts the stale clock from what the row remembered, across a restart', async () => {
    // A hub that came back up must not report a server that has been down for
    // a week as having last been seen at boot.
    const registration = await register('laptop');
    const machine = fakeMachine({});
    const first = start(registration, machine);
    await until(() => first.report.phase === 'connected', 'a connection');
    await first.stop();

    const remembered = await findServer(db(), registration.id);
    machine.reachable = false;
    const second = start(remembered as LiveServerRegistration, machine, {
      now: () => START + 604_800_000,
    });
    await until(() => second.report.phase === 'stale', 'a stale server');

    expect(second.report.lastConnectedAt).toBe(START);
    expect(second.report.staleSince).toBe(START + 604_800_000);
  });

  it('reports every change to whoever is listening, in the order they happened', async () => {
    // The seam the reducer attaches to. Order is the point: a consumer that
    // saw `connected` after `stale` would draw the wrong thing.
    const registration = await register('laptop');
    const machine = fakeMachine({});
    const phases: string[] = [];
    const connection = startServerConnection(registration, {
      database: db(),
      dialer: machine.dialer,
      hubId,
      timers,
      clock: { now: () => START },
      logger,
      backoff: createExponentialBackoff({ baseMs: 500, maxMs: 8000, random: () => 0 }),
      onChange: (report) => phases.push(report.phase),
    });
    running = connection;

    await until(() => connection.report.phase === 'connected', 'a connection');
    machine.live?.close(PEER_GONE);
    await until(() => connection.report.phase === 'stale', 'a stale server');
    await connection.stop();

    expect(phases).toEqual(['connected', 'stale', 'stopped']);
  });

  it('does not leave a socket open when the hub stops mid-dial', async () => {
    // A dial cannot be taken back: the hub stops, and a moment later the
    // machine picks up and completes a perfectly good handshake. Nobody wants
    // that connection, and a socket held by nobody is one that stays open
    // until a process exits.
    const registration = await register('laptop');
    const { hubEnd, serverEnd } = createSocketPair();
    serveHubConnection(serverEnd, {
      sessions: createFakeSessionController(),
      identity: { serverId: serverIdSchema.parse('server-laptop'), token: 'tok-laptop' },
      stores: [store('store-a', '/volumes/claude')],
      logger,
    });

    // The dial parked, to be answered by hand after the shutdown.
    const parked: (() => void)[] = [];
    const connection = start(registration, {
      ...fakeMachine({}),
      dialer: {
        dial: () =>
          new Promise((resolve) => {
            parked.push(() => resolve({ ok: true, socket: hubEnd }));
          }),
      },
    });

    await until(() => parked.length > 0, 'a dial in flight');
    await connection.stop();
    parked[0]?.();
    await until(() => hubEnd.closure !== null, 'the late socket to be closed');

    expect(hubEnd.closure).toEqual(closure(CLOSE_NORMAL, 'the hub is stopping'));
  });
});
