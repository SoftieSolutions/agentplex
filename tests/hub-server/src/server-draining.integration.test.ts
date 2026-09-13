import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type MachineState,
  type ServerRegistrationId,
  type SessionRow,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  createSocketPair,
  createFakeTimers,
  type FakeMessageSocket,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import { createLogger, type DialResult, type SocketDialer } from '@agentplex/node-shared';
import { createPtySupervisor } from '@agentplex/pty';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createProviderRegistry } from '@agentplex/providers';
import {
  createFakeProviderAdapter,
  createFakeProviderFiles,
  createFakeStoreFiles,
  readyProvider,
} from '@agentplex/providers/testing';
import { serveServerEnd } from './server-end.js';
import { drainingSessions } from '../../../apps/server/src/drain.js';
import type { HubConnection } from '../../../apps/server/src/hub-connection.js';
import { createSessionController } from '../../../apps/server/src/session-control.js';
import { createFakeWorkingTree } from '../../../apps/server/src/fake-working-tree.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/fake-directory-reader.js';
import { createFakeProjects } from '../../../apps/hub/src/features/projects/fake-projects.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import {
  createTerminalManager,
  type TerminalManager,
} from '../../../apps/server/src/terminal-manager.js';
import { createExponentialBackoff } from '../../../apps/hub/src/features/servers/backoff.js';
import { createServers, type Servers } from '../../../apps/hub/src/features/servers/servers.js';
import { registerServer } from '../../../apps/hub/src/features/pairing/server-registrations.js';
import {
  createPairing,
  newServerRegistrationSchema,
} from '../../../apps/hub/src/features/pairing/pairing.js';
import {
  openMigratedSchema,
  type MigratedSchema,
} from '../../../apps/hub/src/db/test-migrated-schema.js';
import {
  createFleetState,
  type FleetState,
} from '../../../apps/hub/src/features/fleet-state/fleet-state.js';
import { toMachineState } from '../../../apps/hub/src/features/fleet-state/machine-state.js';
import { createSessions, type Sessions } from '../../../apps/hub/src/features/sessions/sessions.js';

/**
 * A server going down on purpose, and what the hub does about it.
 *
 * Everything but the wire, the clock and the forked process is the shipped
 * code: the server end seals its terminals and sends the real
 * `server-draining` frame with the real `drainingSessions` list on it, the
 * hub's own parser reads it, its dial loop decides what the close afterwards
 * means, and its router decides where a start may go. What the suite is for is
 * the difference a hub can only draw by being told: before this frame was
 * handled, a machine that announced a graceful shutdown and a machine whose
 * battery died produced exactly the same screen.
 *
 * Four claims, and they are the ticket:
 *
 *   * While a server drains it is still connected, because it is. The socket
 *     is up, the hub is still answered on it, and the shutdown is a fact
 *     beside the phase rather than one folded into it.
 *   * The sessions it named are still reachable and still held. They are
 *     closing, which is not the same as gone, and a row that said otherwise
 *     would be wrong for the seconds a person is most likely to be looking.
 *   * A start does not go to a machine that is leaving. The server would
 *     refuse it anyway -- its terminals are sealed -- so the refusal is the
 *     hub's, where it can still name the machine and say why.
 *   * The close that follows is expected, and dialled again when the machine
 *     said it would be back rather than half a second later.
 *
 * And the thing a drain must not be allowed to claim: once the machine is
 * back, a session that was killed at the end of the grace is a session that
 * ended. Nothing here goes on saying "finishing" about a process that is gone.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = storeIdSchema.parse('store-work');
const BUSY = sessionIdSchema.parse('session-busy');
const QUIET = sessionIdSchema.parse('session-quiet');

/** What the server says its drain will take, and what the backoff would allow. */
const GRACE_MS = 4_000;
const CEILING_MS = 8_000;

const PEER_GONE = { code: 1006, reason: 'the machine went away' };

/**
 * The machine: its terminals, its transcripts, and whichever connection it
 * currently has.
 *
 * The terminals and the transcripts outlive a connection, because that is what
 * a server is -- a hub that reconnects finds the disk it left behind. The
 * connection does not, and the drain is exactly the moment that difference
 * matters.
 */
interface Machine {
  readonly label: string;
  readonly terminals: TerminalManager;
  readonly ptys: FakePtyFactory;
  /** The provider's files, mutable so a test can take a session off the disk. */
  transcripts: Record<string, string>;
  /** The server's own end of the live connection, or `null` between dials. */
  connection: HubConnection | null;
  socket: FakeMessageSocket | null;
}

interface Harness {
  readonly state: FleetState;
  readonly sessions: Sessions;
  readonly connections: Servers;
  readonly machine: Machine;
  readonly timers: FakeTimers;
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

const ATTIC = 'registration-attic' as ServerRegistrationId;

function transcripts(): Record<string, string> {
  const at = (signal: string): string =>
    JSON.stringify({ signal, updatedAt: START - 5_000, cwd: '/volumes/work' });

  return {
    // Mid-turn, which is what a drain waits for and what it kills if the
    // waiting runs out.
    '/volumes/work/claude/sessions/session-busy.json': at('progressing'),
    '/volumes/work/claude/sessions/session-quiet.json': at('awaiting-input'),
  };
}

function buildMachine(label: string): Machine {
  const ptys = createFakePtyFactory();
  const supervisor = createPtySupervisor({
    pty: ptys,
    clock,
    ids: { newId: () => `${label}-run-${ptys.ptys.length}` },
    environment: { PATH: '/usr/bin' },
  });

  return {
    label,
    terminals: createTerminalManager({ supervisor, clock }),
    ptys,
    transcripts: transcripts(),
    connection: null,
    socket: null,
  };
}

/** One connection to that machine: a fresh socket, and the store as it reads it now. */
function serveMachine(machine: Machine): DialResult {
  const stores: readonly StoreDescriptor[] = [{ storeId: WORK, path: '/volumes/work' }];
  const files = createFakeProviderFiles({ files: machine.transcripts });
  const { hubEnd, serverEnd } = createSocketPair();

  machine.connection = serveServerEnd(serverEnd, {
    identity: {
      serverId: serverIdSchema.parse(`server-${machine.label}`),
      token: `tok-${machine.label}`,
    },
    stores,
    providers: [readyProvider('claude')],
    terminals: machine.terminals,
    machineLoad: createFakeMachineLoadReader(),
    sessions: createSessionController({
      stores,
      providers: createProviderRegistry([createFakeProviderAdapter({ provider: 'claude', files })]),
      terminals: machine.terminals,
      workingTree: createFakeWorkingTree(),
      // No roots, which is the default a server ships with: this suite is about
      // draining, and a start here names no project to be bounded against.
      browse: createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader() }),
      clock,
      logger,
    }),
    logger,
  });
  serverEnd.onMessage(() => {});
  machine.socket = serverEnd;

  return { ok: true, socket: hubEnd };
}

async function start(): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`server-draining-${suite}`);
  const database = migrated.database;
  const machine = buildMachine('attic');

  await registerServer(
    database,
    { newId: () => ATTIC },
    clock,
    newServerRegistrationSchema.parse({
      label: 'attic',
      address: 'wss://attic.example:8443',
      token: 'tok-attic',
    }),
  );

  const timers = createFakeTimers();
  const state = createFleetState({ logger });
  const connections = createServers({
    pairing: createPairing({
      database,
      files: createFakeStoreFiles(),
      ids: { newId: () => 'unused' },
      clock,
      logger,
    }),
    dialer: { dial: async (): Promise<DialResult> => serveMachine(machine) } satisfies SocketDialer,
    hubId: 'hub-under-test' as never,
    timers,
    clock,
    logger,
    // No jitter: this suite asserts on the schedule, and the arithmetic is
    // `backoff.test.ts`'s subject rather than this one's.
    backoff: createExponentialBackoff({ baseMs: 500, maxMs: CEILING_MS, random: () => 0 }),
    onChange: (report) => state.applyConnection(report),
    onReport: (report) =>
      void state.applySessions({
        registrationId: report.registrationId,
        storeId: report.storeId,
        sessions: report.sessions,
        holding: report.holding,
        reportedAt: clock.now(),
      }),
  });

  await connections.sync();
  return {
    state,
    // A fake project table: nothing here starts in a project, and the rows are
    // the project suites' subject.
    sessions: createSessions({ state, projects: createFakeProjects(), connections, logger }),
    connections,
    machine,
    timers,
  };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function held(): Harness {
  if (harness === null) throw new Error('no harness: beforeEach did not run');
  return harness;
}

/** The state as a client is sent it, which is where every claim here is read. */
function published(): MachineState {
  return toMachineState(held().state.snapshot());
}

function serverRow(): MachineState['servers'][number] {
  const row = published().servers[0];
  if (row === undefined) throw new Error('the hub published no server row');
  return row;
}

function sessionRow(sessionId: string): SessionRow | undefined {
  return published()
    .stores.flatMap((store) => store.sessions)
    .find((row) => row.descriptor.sessionId === sessionId);
}

/**
 * The server shuts down the way `server.ts` does: terminals sealed first, then
 * every established hub told, with the sessions the real function names.
 *
 * Sealed before the notice because that is the order the product runs in, and
 * it is what makes the hub's refusal below a courtesy rather than the only
 * thing standing between a start and a machine that is leaving.
 */
function announceDrain(graceMs = GRACE_MS): void {
  const machine = held().machine;
  machine.terminals.seal();
  machine.connection?.announceDraining(graceMs, drainingSessions(machine.terminals));
}

/** A session started on that machine, so a drain has something to be about. */
async function startSession(sessionId = BUSY): Promise<void> {
  const outcome = await held().sessions.start({
    storeId: WORK,
    sessionId,
    provider: 'claude',
    prompt: null,
    server: null,
    project: null,
  });
  if (!outcome.ok) throw new Error(`the start was refused: ${outcome.problem}`);
  await until(() => sessionRow(sessionId)?.holder !== null, `${sessionId} to be held`);
}

describe('a server that says it is shutting down', () => {
  beforeEach(async () => {
    harness = await start();
    await until(
      () => held().connections.snapshot()[0]?.phase === 'connected',
      'the machine to connect',
    );
    await until(() => sessionRow('session-busy') !== undefined, 'the store to be reported');
  });

  afterEach(async () => {
    await harness?.connections.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('keeps the row connected and names the drain and the sessions under it', async () => {
    await startSession();
    announceDrain();
    await until(() => serverRow().draining !== null, 'the hub to hear the drain');

    const row = serverRow();
    // Still connected, because it is: the socket is up and the hub is still
    // answered on it. The shutdown is the field beside the phase, and the pair
    // is the reading -- "unreachable" would be a lie about a machine that is
    // talking, and "connected" alone says nothing is happening.
    expect(row.phase).toBe('connected');
    expect(row.staleReason).toBeNull();
    expect(row.draining).toEqual({
      since: START,
      graceMs: GRACE_MS,
      sessions: [{ storeId: WORK, sessionId: BUSY }],
    });
  });

  it('leaves the sessions it is finishing reachable, and still held', async () => {
    await startSession();
    announceDrain();
    await until(() => serverRow().draining !== null, 'the hub to hear the drain');

    // The half a client draws: the row is not deleted, not greyed out and not
    // unheld. It is a live session on a machine that is going away, and which
    // of those it is belongs to the server row that named it.
    expect(sessionRow('session-busy')).toMatchObject({
      reachable: true,
      holder: { server: ATTIC, stoppable: false },
    });
  });

  it('refuses a start aimed at it, in words that name the drain', async () => {
    announceDrain();
    await until(() => serverRow().draining !== null, 'the hub to hear the drain');

    const scheduled = await held().sessions.start({
      storeId: WORK,
      sessionId: QUIET,
      provider: 'claude',
      prompt: null,
      server: null,
      project: null,
    });
    const overridden = await held().sessions.start({
      storeId: WORK,
      sessionId: QUIET,
      provider: 'claude',
      prompt: null,
      server: ATTIC,
      project: null,
    });

    for (const refused of [scheduled, overridden]) {
      expect(refused.ok).toBe(false);
      expect(refused.ok ? '' : refused.problem).toBe(
        'attic is shutting down and is not taking new sessions',
      );
    }
    // And never asked: the server sealed its terminals before it said
    // anything, so an instruction would have come back refused -- after a
    // round trip to a machine that is trying to exit.
    expect(held().machine.ptys.opened).toHaveLength(0);
  });

  it('waits the grace it was told before dialling again, not the first backoff step', async () => {
    await startSession();
    announceDrain();
    await until(() => serverRow().draining !== null, 'the hub to hear the drain');

    // Closed at once rather than at the end of the grace, which is the case
    // worth pinning: a server that finishes draining early is still
    // restarting, so the wait is the grace it named and not the time left of
    // it.
    held().machine.socket?.close(PEER_GONE);
    await until(
      () => held().connections.snapshot()[0]?.phase === 'stale' && held().timers.pending === 1,
      'the redial to be scheduled',
    );

    const row = serverRow();
    expect(row.staleReason).toBe('draining');
    expect(row.problem).toBe(
      'the server said it was shutting down with 1 session finishing, and then closed the connection',
    );
    // 500ms is what a dropped connection gets, and it is what this used to
    // get: eight dials into a machine that told the hub when to come back.
    expect(held().timers.delays).toEqual([GRACE_MS]);
  });

  it('will not wait longer than the backoff would, however long the grace', async () => {
    // A machine with a generous `TimeoutStopSec` must not be able to take the
    // hub off the air: honouring what it said is bounded by the same ceiling
    // every other wait here has.
    announceDrain(30 * 60_000);
    await until(() => serverRow().draining !== null, 'the hub to hear the drain');

    held().machine.socket?.close(PEER_GONE);
    await until(
      () => held().connections.snapshot()[0]?.phase === 'stale' && held().timers.pending === 1,
      'the redial to be scheduled',
    );

    expect(held().timers.delays).toEqual([CEILING_MS]);
  });

  it('finds the session again when the machine comes back, no longer held', async () => {
    await startSession();
    announceDrain();
    await until(() => serverRow().draining !== null, 'the hub to hear the drain');

    // The drain overran and the session was killed, which is what `closeAll`
    // is on a real shutdown. The transcript is still on the disk, so the
    // session is still a session -- what ended is the process.
    held().machine.terminals.closeAll();
    held().machine.socket?.close(PEER_GONE);
    await until(
      () => held().connections.snapshot()[0]?.phase === 'stale' && held().timers.pending === 1,
      'the redial to be scheduled',
    );

    held().timers.fireAll();
    await until(
      () => held().connections.snapshot()[0]?.phase === 'connected',
      'the machine to come back',
    );
    await until(() => sessionRow('session-busy')?.holder === null, 'the reconnected report');

    // Nothing here still says "finishing". The drain is over because the
    // machine that was doing it has answered a fresh handshake, and a session
    // nobody is holding is a session that ended.
    const row = serverRow();
    expect(row.draining).toBeNull();
    expect(row.staleReason).toBeNull();
    expect(sessionRow('session-busy')).toMatchObject({ reachable: true, holder: null });
  });

  it('shows a session the machine no longer sees as gone rather than as finishing', async () => {
    await startSession();
    announceDrain();
    await until(() => serverRow().draining !== null, 'the hub to hear the drain');

    // The session did not survive the restart in any form: whatever the drain
    // named, what the machine reports when it comes back is the answer.
    held().machine.terminals.closeAll();
    delete held().machine.transcripts['/volumes/work/claude/sessions/session-busy.json'];
    held().machine.socket?.close(PEER_GONE);
    await until(
      () => held().connections.snapshot()[0]?.phase === 'stale' && held().timers.pending === 1,
      'the redial to be scheduled',
    );

    held().timers.fireAll();
    await until(
      () => held().connections.snapshot()[0]?.phase === 'connected',
      'the machine to come back',
    );
    await until(() => sessionRow('session-busy') === undefined, 'the session to leave the list');

    expect(sessionRow('session-quiet')).toBeDefined();
    expect(serverRow().draining).toBeNull();
  });
});
