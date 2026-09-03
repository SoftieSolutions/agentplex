import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type HubId,
  type ServerRegistrationId,
  type SessionDescriptor,
  type StoreDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { serveHubConnection } from '../../server/hub-connection.js';
import { createSocketPair } from '../../shared/fake-message-socket.js';
import { createLogger } from '../../shared/logger.js';
import type { DialResult, MessageSocket, SocketDialer } from '../../shared/message-socket.js';
import { createFakeTimers, type FakeTimers } from '../../shared/timers.js';
import { createExponentialBackoff } from '../connections/backoff.js';
import {
  startConnectionSupervisor,
  type ConnectionSupervisor,
} from '../connections/connection-supervisor.js';
import type { Database } from '../db/database.js';
import {
  newServerRegistrationSchema,
  registerServer,
  revokeServer,
} from '../pairing/server-registrations.js';
import { openMigratedSchema, type MigratedSchema } from '../pairing/test-migrated-schema.js';
import { createReducer, type Reducer, type StoreView } from './reducer.js';

/**
 * The reducer against the real supervisor, over real handshakes.
 *
 * The unit tests hand it connection reports; this drives the seam it will
 * actually be wired to -- `onChange` off a supervisor dialling servers that
 * answer for themselves -- so that the case the whole ticket is about is
 * demonstrated rather than asserted: two machines, one volume, one store.
 */

const logger = createLogger('error', () => {});
const hubId = 'hub-under-test' as HubId;
const START = 1_756_000_000_000;
const clock = { now: () => START };

let migrated: MigratedSchema | null = null;
let timers: FakeTimers;
let supervisor: ConnectionSupervisor | null = null;
let reducer: Reducer;

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

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

/** Which hostnames answer, and what each says when it does. */
const machines = new Map<string, { serverId: string; stores: readonly StoreDescriptor[] }>();
const unreachable = new Set<string>();
/** The server end of each open connection, so a test can pull the plug on one. */
const live = new Map<string, MessageSocket>();

const PEER_GONE = { code: 1006, reason: 'the machine went away' };

const dialer: SocketDialer = {
  dial: async (address: string): Promise<DialResult> => {
    const host = new URL(address).hostname;
    const machine = machines.get(host);
    if (machine === undefined || unreachable.has(host)) {
      return { ok: false, problem: 'connection refused' };
    }

    const { hubEnd, serverEnd } = createSocketPair();
    serveHubConnection(serverEnd, {
      identity: { serverId: serverIdSchema.parse(machine.serverId), token: `tok-${host}` },
      stores: machine.stores,
      logger,
    });
    live.set(host, serverEnd);
    return { ok: true, socket: hubEnd };
  },
};

/** The machine goes away without saying so, and stays away. */
function pullThePlug(host: string): void {
  unreachable.add(host);
  live.get(host)?.close(PEER_GONE);
}

async function register(label: string): Promise<ServerRegistrationId> {
  const registration = await registerServer(
    db(),
    { newId: () => `registration-${label}` },
    clock,
    newServerRegistrationSchema.parse({
      label,
      address: `wss://${label}.example:8443`,
      token: `tok-${label}.example`,
    }),
  );
  return registration.id;
}

async function startAll(): Promise<ConnectionSupervisor> {
  supervisor = await startConnectionSupervisor({
    database: db(),
    dialer,
    hubId,
    timers,
    clock,
    logger,
    backoff: createExponentialBackoff({ baseMs: 500, maxMs: 8000, random: () => 0 }),
    onChange: (report) => reducer.applyConnection(report),
  });
  return supervisor;
}

function session(
  id: string,
  storeId: StoreId,
  status: SessionDescriptor['status'],
): SessionDescriptor {
  return {
    storeId,
    sessionId: sessionIdSchema.parse(id),
    provider: 'claude',
    status,
    updatedAt: START,
    cwd: '/volumes/claude/work',
    title: null,
  };
}

function view(storeId: string): StoreView {
  const found = reducer.snapshot().stores.find((candidate) => candidate.storeId === storeId);
  if (found === undefined) throw new Error(`no view for ${storeId}`);
  return found;
}

function phaseOf(running: ConnectionSupervisor, label: string): string | undefined {
  return running.snapshot().find((report) => report.label === label)?.phase;
}

describe('the reducer over a live supervisor', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('hub-state-reducer');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    timers = createFakeTimers();
    reducer = createReducer({ logger });
    machines.clear();
    unreachable.clear();
    live.clear();
    // One volume, mounted on two machines at two paths. This is the case: the
    // store id is minted into the volume, so both servers report the same one.
    machines.set('laptop.example', {
      serverId: 'server-laptop',
      stores: [store('store-shared', '/Users/me/work')],
    });
    machines.set('box.example', {
      serverId: 'server-box',
      stores: [store('store-shared', '/mnt/work')],
    });
    await db().query('DELETE FROM servers');
    await db().query('DELETE FROM stores');
  });

  afterEach(async () => {
    await supervisor?.stop();
    supervisor = null;
  });

  it('reads two servers on one volume as one store with two attached', async () => {
    await register('laptop');
    await register('box');

    const running = await startAll();
    await until(
      () => running.snapshot().every((report) => report.phase === 'connected'),
      'both servers',
    );

    const stores = reducer.snapshot().stores;
    expect(stores.map((candidate) => candidate.storeId)).toEqual(['store-shared']);
    expect(view('store-shared').servers.map((server) => server.label)).toEqual(['box', 'laptop']);
    expect(view('store-shared').reachable).toBe(true);
  });

  it('unifies what both servers report into one session list', async () => {
    const laptop = await register('laptop');
    const box = await register('box');
    const running = await startAll();
    await until(
      () => running.snapshot().every((report) => report.phase === 'connected'),
      'both servers',
    );

    const shared = storeIdSchema.parse('store-shared');
    // Both machines read the same volume. The laptop is the one running the
    // session, so it is the only one that can see a process.
    reducer.applySessions({
      registrationId: laptop,
      storeId: shared,
      sessions: [session('session-1', shared, 'working'), session('session-2', shared, 'idle')],
      reportedAt: START,
    });
    reducer.applySessions({
      registrationId: box,
      storeId: shared,
      sessions: [session('session-1', shared, 'idle'), session('session-2', shared, 'idle')],
      reportedAt: START,
    });

    const sessions = view('store-shared').sessions;
    expect(sessions.map((row) => row.descriptor.sessionId)).toEqual(['session-1', 'session-2']);
    expect(sessions[0]?.descriptor.status).toBe('working');
    expect(sessions[0]?.source).toBe('registration-laptop');
    expect(sessions[0]?.reportedBy).toEqual(['registration-box', 'registration-laptop']);
  });

  it('keeps the store reachable through the server that is still up', async () => {
    const laptop = await register('laptop');
    await register('box');
    unreachable.add('laptop.example');

    const running = await startAll();
    await until(() => phaseOf(running, 'laptop') === 'stale', 'the laptop to go stale');
    await until(() => phaseOf(running, 'box') === 'connected', 'the box to connect');

    // The laptop never connected, so it has no stores of its own on record and
    // the store is the box's. What matters is that the volume is still there
    // and still answerable.
    expect(view('store-shared').reachable).toBe(true);
    expect(view('store-shared').unreachableSince).toBeNull();
    expect(
      reducer.applySessions({
        registrationId: laptop,
        storeId: storeIdSchema.parse('store-shared'),
        sessions: [],
        reportedAt: START,
      }),
    ).toBe(false);
  });

  it('keeps a store whose only server went away, labelled with its age', async () => {
    const box = await register('box');
    const running = await startAll();
    await until(() => phaseOf(running, 'box') === 'connected', 'the box to connect');

    const shared = storeIdSchema.parse('store-shared');
    reducer.applySessions({
      registrationId: box,
      storeId: shared,
      sessions: [session('session-1', shared, 'idle')],
      reportedAt: START,
    });

    // The machine goes away mid-connection. Its rows stay; they are all anyone
    // knows about that volume, and deleting them would read as an empty store.
    pullThePlug('box.example');
    await until(() => phaseOf(running, 'box') === 'stale', 'the box to go stale');

    const stale = view('store-shared');
    expect(stale.reachable).toBe(false);
    expect(stale.sessions.map((row) => row.descriptor.sessionId)).toEqual(['session-1']);
    expect(stale.sessions[0]?.reachable).toBe(false);
    expect(stale.lastReachableAt).toBe(START);
  });

  it('forgets a revoked pairing and everything it reported', async () => {
    const box = await register('box');
    const running = await startAll();
    await until(() => phaseOf(running, 'box') === 'connected', 'the box to connect');

    const shared = storeIdSchema.parse('store-shared');
    reducer.applySessions({
      registrationId: box,
      storeId: shared,
      sessions: [session('session-1', shared, 'idle')],
      reportedAt: START,
    });
    expect(view('store-shared').sessions).toHaveLength(1);

    await revokeServer(db(), clock, box);
    await running.sync();

    expect(reducer.snapshot().stores).toEqual([]);
    expect(reducer.snapshot().servers).toEqual([]);
  });
});
