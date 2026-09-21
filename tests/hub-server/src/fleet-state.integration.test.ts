import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  machineStateSchema,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type HubId,
  type ServerRegistrationId,
  type SessionDescriptor,
  type StoreDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { serveServerEnd } from './server-end.js';
import { createFakeTerminals } from '../../../apps/server/src/fake-terminals.js';
import { createFakeStoreFiles, readyProvider } from '@agentplex/providers/testing';
import {
  createSocketPair,
  createFakeTimers,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import {
  createLogger,
  type DialResult,
  type MessageSocket,
  type SocketDialer,
} from '@agentplex/node-shared';
import { createExponentialBackoff } from '../../../apps/hub/src/features/servers/backoff.js';
import { createServers, type Servers } from '../../../apps/hub/src/features/servers/servers.js';
import type { Database } from '../../../apps/hub/src/db/database.js';
import {
  registerServer,
  revokeServer,
} from '../../../apps/hub/src/features/pairing/server-registrations.js';
import {
  createPairing,
  newServerRegistrationSchema,
  type Pairing,
} from '../../../apps/hub/src/features/pairing/pairing.js';
import {
  openMigratedSchema,
  type MigratedSchema,
} from '../../../apps/hub/src/db/test-migrated-schema.js';
import {
  createFleetState,
  type FleetState,
  type StoreView,
} from '../../../apps/hub/src/features/fleet-state/fleet-state.js';
import { createFakeSessionController } from '../../../apps/server/src/fake-session-controller.js';
import type { StoreReport } from '../../../apps/server/src/session-control.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { toMachineState } from '../../../apps/hub/src/features/fleet-state/machine-state.js';

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
let supervisor: Servers | null = null;
let reducer: FleetState;

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

/** The pairing feature over the same schema: the real reader of the table. */
function pairing(): Pairing {
  return createPairing({
    database: db(),
    files: createFakeStoreFiles(),
    ids: { newId: () => 'unused' },
    clock,
    logger,
  });
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
const machines = new Map<
  string,
  {
    serverId: string;
    stores: readonly StoreDescriptor[];
    /**
     * What that machine's own scan of a store finds, for the tests that are
     * about a descriptor rather than about a connection.
     *
     * Most tests here hand the reducer a report directly, because what they are
     * about is the merge. A test about what survives the trip cannot: the
     * question is whether a field is still there after the server's frame, the
     * wire and the hub's parser, and a report the test placed on the near side
     * of all three would answer it by assumption.
     */
    reports?: readonly StoreReport[];
  }
>();
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
    const controller = createFakeSessionController({ reports: machine.reports ?? [] });
    serveServerEnd(serverEnd, {
      // A real scan reads a disk and takes event-loop turns; a fake resolving in
      // the handshake's own microtask would race its report past the hub
      // attaching its listener, an ordering no real store scan can produce.
      sessions: {
        ...controller,
        report: async (storeId: StoreId) => {
          await new Promise((resolve) => setImmediate(resolve));
          return controller.report(storeId);
        },
      },
      terminals: createFakeTerminals().terminals,
      machineLoad: createFakeMachineLoadReader(),
      identity: { serverId: serverIdSchema.parse(machine.serverId), token: `tok-${host}` },
      stores: machine.stores,
      providers: [readyProvider()],
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

async function startAll(): Promise<Servers> {
  const running = createServers({
    pairing: pairing(),
    dialer,
    hubId,
    timers,
    clock,
    logger,
    backoff: createExponentialBackoff({ baseMs: 500, maxMs: 8000, random: () => 0 }),
    onChange: (report) => reducer.applyConnection(report),
    // The hub's other seam onto the supervisor, wired exactly as `hub.ts` wires
    // it. It is what carries a store report from the socket into the reducer,
    // and a suite that left it out could only ever drive descriptors it wrote
    // itself.
    onReport: (report) => {
      reducer.applySessions({
        registrationId: report.registrationId,
        storeId: report.storeId,
        sessions: report.sessions,
        holding: report.holding,
        reportedAt: START,
      });
    },
  });
  supervisor = running;
  await running.sync();
  return running;
}

function session(
  id: string,
  storeId: StoreId,
  status: SessionDescriptor['status'],
  /**
   * The model that machine's adapter read out of the session's own record, or
   * nothing for a record that named none.
   *
   * Omitted rather than nulled, because that is the frame an adapter that found
   * no model actually sends, and absence is the case with a way of going wrong:
   * an optional field is the one shape a wire parser can drop without anybody
   * noticing.
   */
  model?: string,
): SessionDescriptor {
  return {
    storeId,
    sessionId: sessionIdSchema.parse(id),
    provider: 'claude',
    status,
    updatedAt: START,
    cwd: '/volumes/claude/work',
    ...(model === undefined ? {} : { model }),
    branch: null,
    title: null,
    uncommitted: null,
  };
}

function view(storeId: string): StoreView {
  const found = reducer.snapshot().stores.find((candidate) => candidate.storeId === storeId);
  if (found === undefined) throw new Error(`no view for ${storeId}`);
  return found;
}

function phaseOf(running: Servers, label: string): string | undefined {
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
    reducer = createFleetState({ logger });
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
      holding: [],
      registrationId: laptop,
      storeId: shared,
      sessions: [session('session-1', shared, 'working'), session('session-2', shared, 'idle')],
      reportedAt: START,
    });
    reducer.applySessions({
      holding: [],
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
        holding: [],
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
      holding: [],
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
      holding: [],
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

  /**
   * The model, from the machine that read it to the frame a client is sent.
   *
   * Every other test in this suite hands the reducer a descriptor it wrote
   * itself, which cannot answer this ticket's question: an optional field is
   * exactly the shape that disappears quietly, stripped by a schema on either
   * end, and a report placed on the near side of the wire would never meet
   * them. Here the machine states it, its own report frame carries it, the
   * hub's parser reads it, the reducer holds it and the projection publishes
   * it -- and what is asserted is the output of the parser a client reads with.
   */
  it('carries the model a machine stated, and states none where that machine did not', async () => {
    const shared = storeIdSchema.parse('store-shared');
    machines.set('box.example', {
      serverId: 'server-box',
      stores: [store('store-shared', '/mnt/work')],
      reports: [
        {
          storeId: shared,
          sessions: [
            // The model named in `packages/providers/fixtures/claude-completed
            // -turn.jsonl`, which is the transcript the Claude adapter's own
            // test reads this field out of. A made-up name here would pass
            // against a relay that mangled a real one.
            session('session-1', shared, 'working', 'claude-opus-5'),
            session('session-2', shared, 'idle'),
          ],
          holding: [],
        },
      ],
    });
    await register('box');
    const running = await startAll();
    await until(() => phaseOf(running, 'box') === 'connected', 'the box to connect');
    await until(
      () => (reducer.snapshot().stores[0]?.sessions.length ?? 0) === 2,
      "the box's own report to reach the reducer",
    );

    const published = machineStateSchema.parse(toMachineState(reducer.snapshot()));
    const rows = published.stores.find((store) => store.storeId === shared)?.sessions ?? [];
    expect(rows.map((row) => row.descriptor.sessionId)).toEqual(['session-1', 'session-2']);
    expect(rows[0]?.descriptor.model).toBe('claude-opus-5');
    // Absence survives as absence. Not `null`, and above all not the other
    // session's model: a hub that filled this in from what it had seen would
    // print a guess beside a session nobody can check.
    expect(rows[1]?.descriptor).not.toHaveProperty('model');
  });
});
