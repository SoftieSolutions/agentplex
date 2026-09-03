import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  serverIdSchema,
  storeIdSchema,
  type HubId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import { serveHubConnection } from '../../server/hub-connection.js';
import { createSocketPair } from '../../shared/fake-message-socket.js';
import { createLogger } from '../../shared/logger.js';
import type { DialResult, SocketDialer } from '../../shared/message-socket.js';
import { createFakeTimers, type FakeTimers } from '../../shared/timers.js';
import type { Database } from '../db/database.js';
import {
  newServerRegistrationSchema,
  registerServer,
  revokeServer,
  type LiveServerRegistration,
} from '../pairing/server-registrations.js';
import { openMigratedSchema, type MigratedSchema } from '../pairing/test-migrated-schema.js';
import { attentionEligibleStores } from './attention.js';
import { createExponentialBackoff } from './backoff.js';
import { startConnectionSupervisor, type ConnectionSupervisor } from './connection-supervisor.js';

/**
 * The fleet: which servers are dialled, and what one being down costs the
 * others.
 *
 * The per-server rules are `server-connection.integration.test`'s. What this
 * asks is the question that only exists once there is more than one: does an
 * unreachable laptop take anything away from the box that is up. It must not,
 * and the reason it must not is the same reason the whole design has no
 * server-to-server coordination in it.
 */

const logger = createLogger('error', () => {});
const hubId = 'hub-under-test' as HubId;
const START = 1_756_000_000_000;
const clock = { now: () => START };

let migrated: MigratedSchema | null = null;
let timers: FakeTimers;
let supervisor: ConnectionSupervisor | null = null;

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
    return { ok: true, socket: hubEnd };
  },
};

async function register(label: string): Promise<LiveServerRegistration> {
  return registerServer(
    db(),
    { newId: () => `registration-${label}` },
    clock,
    newServerRegistrationSchema.parse({
      label,
      address: `wss://${label}.example:8443`,
      token: `tok-${label}.example`,
    }),
  );
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
  });
  return supervisor;
}

function phaseOf(running: ConnectionSupervisor, label: string): string | undefined {
  return running.snapshot().find((report) => report.label === label)?.phase;
}

describe('startConnectionSupervisor', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('connections-supervisor');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    timers = createFakeTimers();
    machines.clear();
    unreachable.clear();
    machines.set('laptop.example', {
      serverId: 'server-laptop',
      stores: [store('store-a', '/volumes/claude')],
    });
    machines.set('box.example', {
      serverId: 'server-box',
      stores: [store('store-b', '/mnt/claude')],
    });
    await db().query('DELETE FROM servers');
    await db().query('DELETE FROM stores');
  });

  afterEach(async () => {
    await supervisor?.stop();
    supervisor = null;
  });

  it('dials every paired server', async () => {
    await register('laptop');
    await register('box');

    const running = await startAll();
    await until(
      () => running.snapshot().every((report) => report.phase === 'connected'),
      'both servers',
    );

    expect(
      running
        .snapshot()
        .map((report) => report.serverId)
        .sort(),
    ).toEqual(['server-box', 'server-laptop']);
  });

  it('dials nothing when nothing is paired', async () => {
    const running = await startAll();

    expect(running.snapshot()).toEqual([]);
  });

  it('lets one unreachable server cost only itself', async () => {
    // The reason there is no fleet-wide state in here. A laptop that is shut
    // must not delay, block or degrade the box that is running.
    await register('laptop');
    await register('box');
    unreachable.add('laptop.example');

    const running = await startAll();
    await until(() => phaseOf(running, 'laptop') === 'stale', 'the laptop to go stale');
    await until(() => phaseOf(running, 'box') === 'connected', 'the box to connect');

    expect(running.snapshot().find((report) => report.label === 'box')).toMatchObject({
      phase: 'connected',
      stores: ['store-b'],
    });
  });

  it('leaves an unreachable server out of what attention may count', async () => {
    // The exclusion, end to end: the rows are all still there, and the store
    // on the machine nobody can reach is not among the ones a badge may be
    // built from.
    await register('laptop');
    await register('box');
    unreachable.add('laptop.example');

    const running = await startAll();
    await until(() => phaseOf(running, 'laptop') === 'stale', 'the laptop to go stale');
    await until(() => phaseOf(running, 'box') === 'connected', 'the box to connect');

    expect([...attentionEligibleStores(running.snapshot())]).toEqual(['store-b']);
  });

  it('picks up a pairing added after it started', async () => {
    const running = await startAll();
    await register('laptop');

    await running.sync();
    await until(() => phaseOf(running, 'laptop') === 'connected', 'the new server');

    expect(running.snapshot()).toHaveLength(1);
  });

  it('does not start a second connection for a pairing it already has', async () => {
    await register('laptop');
    const running = await startAll();
    await until(() => phaseOf(running, 'laptop') === 'connected', 'the server');

    await running.sync();
    await running.sync();

    expect(running.snapshot()).toHaveLength(1);
    expect(phaseOf(running, 'laptop')).toBe('connected');
  });

  it('stops dialling a pairing the operator revoked', async () => {
    const registration = await register('laptop');
    const running = await startAll();
    await until(() => phaseOf(running, 'laptop') === 'connected', 'the server');

    await revokeServer(db(), clock, registration.id);
    await running.sync();

    expect(running.snapshot()).toEqual([]);
    // And nothing is left scheduled to bring it back.
    expect(timers.pending).toBe(0);
  });

  it('stops every connection when the hub stops', async () => {
    await register('laptop');
    await register('box');
    const running = await startAll();
    await until(
      () => running.snapshot().every((report) => report.phase === 'connected'),
      'both servers',
    );

    await running.stop();

    expect(running.snapshot()).toEqual([]);
    expect(timers.pending).toBe(0);
  });

  it('is safe to stop twice, because a signal can arrive twice', async () => {
    await register('laptop');
    const running = await startAll();

    await running.stop();

    await expect(running.stop()).resolves.toBeUndefined();
  });

  it('does not start dialling again after it has stopped', async () => {
    await register('laptop');
    const running = await startAll();
    await running.stop();

    await running.sync();

    expect(running.snapshot()).toEqual([]);
  });
});
