import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseServerToHubFrame,
  parseTextFrame,
  SERVER_PROTOCOL_VERSION,
  type ProviderReadiness,
  sessionRefSchema,
  startIdSchema,
  storeDescriptorSchema,
  type ServerToHubFrame,
} from '@agentplex/protocol';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import { createProviderRegistry, type ProviderPreflight } from '@agentplex/providers';
import {
  createFakeGrantFiles,
  createFakeProcessRunner,
  createFakeStoreFiles,
  missingProvider,
  readyProvider,
  type FakeProcessRunner,
} from '@agentplex/providers/testing';
import type { Launch, LaunchPlan } from '@agentplex/providers';
import type { PtySignal } from '@agentplex/pty';
import { startRuntime, type Runtime } from './boot.js';
import type { ServerConfig } from './config.js';
import { createOperationRegistry } from './operations/operation-registry.js';
import { createFakeDataRoot } from './data-root/fake-data-root.js';
import { createFakeDirectoryReader } from './directories/fake-directory-reader.js';
import { createFakeWorkingTree } from './working-tree/fake-working-tree.js';
import { createFakeTerminals, type FakeTerminals } from './terminal/fake-terminals.js';
import { createFakeMachineLoadReader } from './machine-load/fake-machine-probe.js';
import { createFakeProjectFiles, type FakeProjectFiles } from './projects/fake-project-files.js';
import { createFakeStoreWatcher, type FakeStoreWatcher } from './store-watch/fake-store-watcher.js';
import { PROJECT_FILES_DIRECTORY } from './projects/project-files.js';

/**
 * The draining shutdown, against a real server on a real port with a real hub
 * socket on the other end of it.
 *
 * The parts that make this worth having over `drain.test.ts` are the ones a
 * unit test of the drain cannot reach: that `stop` seals the manager before it
 * waits, so a start arriving mid-drain is refused rather than forked into a
 * process nothing will stop; that the hubs dialled in are told what is
 * happening while it is still happening; and that a second signal reaches the
 * wait a first one started. Every one of those is wiring, and wiring is what
 * `server.ts` is.
 *
 * The timers are the fake ones, so the drain's wait is a thing this file ends
 * deliberately rather than a thing it sits through. The pty is fake because a
 * unit test cannot fork one; the manager over it is the shipped one, so
 * `stoppable` here is the predicate that ships.
 */

const STORE_PATH = '/volumes/claude';
const IDENTITY_PATH = '/etc/agentplex/server.json';

/** The server's own directory, which it creates before it serves anything. */
const DATA_PATH = '/var/lib/agentplex';

const PLAN: LaunchPlan = {
  command: 'claude',
  args: [],
  cwd: STORE_PATH,
  env: {},
  scrubEnvPrefixes: ['CLAUDE'],
};
const launch: Launch = { ok: true, plan: PLAN };

const config: ServerConfig = {
  logLevel: 'info',
  host: '127.0.0.1',
  port: 0,
  storePaths: [STORE_PATH],
  binPath: [],
  // Nothing to browse: this file is about what a shutdown does to the sessions
  // and the sockets, and an empty list is the default a server ships with.
  browseRoots: [],
  identityPath: IDENTITY_PATH,
  // Nothing supplied a pairing token, so this server mints its own; nothing
  // told it a zone either. Neither is what this file is about -- it is about
  // what a shutdown does to the sessions and the sockets -- and both have to
  // be said now that a config carries them.
  serverToken: undefined,
  dataPath: DATA_PATH,
  timezone: undefined,
  terminalCap: 8,
  drainMs: 15_000,
  announce: false,
};

const TOKEN = 'token-under-test';

interface World {
  readonly runtime: Runtime;
  readonly terminals: FakeTerminals;
  readonly records: readonly LogRecord[];
  readonly preflight: FakePreflight;
  /** The one runner every operation goes through, so a spawn is a request in here. */
  readonly runner: FakeProcessRunner;
  /** The disk under the project folders, so a write is a path in here. */
  readonly projectFiles: FakeProjectFiles;
  /** The store watch, so a change under a store is an event this file fires. */
  readonly watcher: FakeStoreWatcher;
  /** The clock the burst window is on, so the wait is ended rather than sat through. */
  readonly timers: FakeTimers;
}

/**
 * A preflight a test can change under a running server.
 *
 * Which is the whole subject of the re-probe: a machine somebody reconfigured
 * while the service was up. What the probe answers is a value each test
 * rewrites between calls, `runs` counts how many times this server actually
 * went and asked, and `hold` keeps an answer open so that two refreshes can be
 * in flight at once.
 */
interface FakePreflight extends ProviderPreflight {
  reading: readonly ProviderReadiness[];
  /** Set to make the next run reject, which its contract says it never does. */
  problem: string | null;
  /** How many times this server has asked, the boot probe included. */
  readonly runs: number;
  /** Holds every answer from here on until `release` is called. */
  hold(): void;
  release(): void;
}

function createFakePreflight(reading: readonly ProviderReadiness[]): FakePreflight {
  let runs = 0;
  let held: Promise<void> | null = null;
  let open: (() => void) | null = null;

  return {
    reading,
    problem: null,

    get runs() {
      return runs;
    },

    hold(): void {
      held = new Promise<void>((resolve) => {
        open = resolve;
      });
    },

    release(): void {
      held = null;
      open?.();
      open = null;
    },

    async run(): Promise<readonly ProviderReadiness[]> {
      runs += 1;
      if (held !== null) await held;
      if (this.problem !== null) throw new Error(this.problem);
      return this.reading;
    },
  };
}

let world: World | undefined;

afterEach(async () => {
  world?.runtime.stopWaiting();
  await world?.runtime.stop();
  world = undefined;
});

/**
 * `diesOn` is the agents this server holds: by default ones that go when they
 * are hung up on, because a shutdown now waits for its agents to exit and a
 * fake no signal ends would hold every test here open.
 */
async function start(
  reading: readonly ProviderReadiness[] = [],
  watcher: FakeStoreWatcher = createFakeStoreWatcher(),
  diesOn: readonly PtySignal[] = ['SIGHUP', 'SIGKILL'],
): Promise<World> {
  const terminals = createFakeTerminals({ diesOn });
  const records: LogRecord[] = [];
  const preflight = createFakePreflight(reading);
  const runner = createFakeProcessRunner();
  const projectFiles = createFakeProjectFiles();
  const timers = createFakeTimers();
  const runtime = await startRuntime(config, {
    logger: createLogger('info', (record) => records.push(record)),
    ids: { newId: () => 'id-under-test' },
    timers,
    storeFileSystem: createFakeStoreFiles(),
    storeWatcher: watcher,
    dataRootFileSystem: createFakeDataRoot(),
    directoryReader: createFakeDirectoryReader(),
    grantFileSystem: createFakeGrantFiles(),
    projectFiles,
    tokens: { newToken: () => TOKEN },
    // No adapters. A scan that found sessions would derive statuses of its own
    // and overwrite the one each test is making its point with.
    providers: createProviderRegistry([]),
    preflight,
    terminals: terminals.terminals,
    machineLoad: createFakeMachineLoadReader(),
    operations: createOperationRegistry(runner),
    workingTree: createFakeWorkingTree(),
    beacon: {
      open: () => {
        throw new Error('the runtime opened a beacon socket with announcing off');
      },
      localAddresses: () => [],
    },
    // No socket for permission hooks, which is what a server that could not
    // open one looks like: its launches carry no hook and its agents ask at
    // their own terminals.
    approvals: null,
    clock: { now: () => 1_756_000_000_000 },
  });
  world = { runtime, terminals, records, preflight, runner, projectFiles, watcher, timers };
  return world;
}

/** The one store this server mounted, as it named it back. */
const storeOf = ({ runtime }: World) =>
  storeDescriptorSchema.parse(runtime.server.stores[0] ?? { storeId: 'none', path: STORE_PATH });

/** A hub on the other end of a real socket, handshaken and reading frames. */
interface FakeHub {
  readonly frames: readonly ServerToHubFrame[];
  send(frame: unknown): void;
  /** Settles once a frame of this type has arrived, or fails the test. */
  next(type: ServerToHubFrame['type']): Promise<ServerToHubFrame>;
  /** Settles when the server ends this connection, with the code and reason. */
  ended(): Promise<{ readonly code: number; readonly reason: string }>;
  close(): void;
}

async function dial({ runtime }: World): Promise<FakeHub> {
  const socket = new WebSocket(`ws://127.0.0.1:${runtime.server.port}`);
  const frames: ServerToHubFrame[] = [];
  const waiting: (() => void)[] = [];
  const closed = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
    socket.addEventListener('close', (event: CloseEvent) =>
      resolve({ code: event.code, reason: event.reason }),
    );
  });

  socket.addEventListener('message', (event: MessageEvent) => {
    const parsed = parseTextFrame(parseServerToHubFrame, String(event.data));
    if (!parsed.ok) throw new Error(`the server sent something unreadable: ${parsed.reason}`);
    frames.push(parsed.value);
    for (const wake of waiting.splice(0)) wake();
  });

  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));

  const hub: FakeHub = {
    get frames() {
      return frames;
    },
    send(frame: unknown): void {
      socket.send(JSON.stringify(frame));
    },
    async next(type: ServerToHubFrame['type']): Promise<ServerToHubFrame> {
      for (;;) {
        const found = frames.find((frame) => frame.type === type);
        if (found !== undefined) return found;
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },
    ended(): Promise<{ readonly code: number; readonly reason: string }> {
      return closed;
    },
    close(): void {
      socket.close();
    },
  };

  hub.send({
    type: 'handshake',
    id: 1,
    protocolVersion: SERVER_PROTOCOL_VERSION,
    hubId: 'hub-1',
    token: TOKEN,
  });
  await hub.next('handshake-accepted');
  return hub;
}

/** What the shutdown said it did, off the line it logs on its way out. */
function shutdownRecord(records: readonly LogRecord[]): LogRecord | undefined {
  return records.find((record) => record.message === 'server stopped');
}

describe('a draining shutdown', () => {
  it('closes a session that is between turns and stops without waiting for anything', async () => {
    const started = await start();
    const session = sessionRefSchema.parse({
      storeId: storeOf(started).storeId,
      sessionId: 'session-a',
    });
    started.terminals.terminals.resume(session, launch);
    started.terminals.terminals.observe(session, 'awaiting-input');

    await started.runtime.stop();

    expect(shutdownRecord(started.records)?.fields).toMatchObject({
      end: 'drained',
      drained: 1,
      killed: 0,
    });
  });

  it('waits for a session that is mid-turn rather than killing it where it stands', async () => {
    const started = await start();
    const session = sessionRefSchema.parse({
      storeId: storeOf(started).storeId,
      sessionId: 'session-a',
    });
    started.terminals.terminals.resume(session, launch);
    started.terminals.terminals.observe(session, 'working');

    const stopping = started.runtime.stop();
    // The fake timers never fire on their own, so nothing below this line can
    // be the drain having quietly given up.
    await Promise.resolve();

    expect(started.terminals.factory.ptys[0]?.kills).toBe(0);
    expect(shutdownRecord(started.records)).toBeUndefined();

    started.runtime.stopWaiting();
    await stopping;

    expect(started.terminals.factory.ptys[0]?.kills).toBeGreaterThan(0);
    expect(shutdownRecord(started.records)?.fields).toMatchObject({
      end: 'abandoned',
      drained: 0,
      killed: 1,
    });
  });

  it('says it has stopped only once the agents it hung up on have gone', async () => {
    // An agent that catches the hangup and carries on. Until it has been
    // killed it is still running in the store, and a server that logged its
    // way out before then -- and exited, under systemd -- would be leaving it
    // to nobody.
    const started = await start([], createFakeStoreWatcher(), ['SIGKILL']);
    const session = sessionRefSchema.parse({
      storeId: storeOf(started).storeId,
      sessionId: 'session-a',
    });
    started.terminals.terminals.resume(session, launch);
    started.terminals.terminals.observe(session, 'awaiting-input');
    const pty = started.terminals.factory.ptys[0];

    const stopping = started.runtime.stop();
    await vi.waitFor(() => expect(pty?.signals).toEqual(['SIGHUP']));
    // The drain stops waiting on it, which leaves it to the shutdown's own
    // close -- the step this test is about.
    started.runtime.stopWaiting();
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(shutdownRecord(started.records)).toBeUndefined();

    started.terminals.timers.fireAll();
    await stopping;

    expect(pty?.signals).toEqual(['SIGHUP', 'SIGKILL']);
    expect(shutdownRecord(started.records)?.fields).toMatchObject({
      end: 'abandoned',
      drained: 0,
      killed: 1,
    });
  });

  it('tells every hub it is draining, and which sessions are closing', async () => {
    const started = await start();
    const session = sessionRefSchema.parse({
      storeId: storeOf(started).storeId,
      sessionId: 'session-a',
    });
    started.terminals.terminals.resume(session, launch);
    started.terminals.terminals.observe(session, 'working');
    const hub = await dial(started);

    const stopping = started.runtime.stop();
    const notice = await hub.next('server-draining');

    // Said while it is still true, which is the whole point: a hub that learned
    // this afterwards would have had a stretch of time in which a closing
    // session and a server that stopped answering looked the same.
    expect(notice).toEqual({
      type: 'server-draining',
      graceMs: 15_000,
      sessions: [{ storeId: session.storeId, sessionId: 'session-a' }],
    });

    started.runtime.stopWaiting();
    await stopping;
  });

  it('refuses a start that arrives mid-drain, and forks nothing for it', async () => {
    const started = await start();
    const session = sessionRefSchema.parse({
      storeId: storeOf(started).storeId,
      sessionId: 'session-a',
    });
    started.terminals.terminals.resume(session, launch);
    started.terminals.terminals.observe(session, 'working');
    const hub = await dial(started);

    const stopping = started.runtime.stop();
    await hub.next('server-draining');
    hub.send({
      type: 'session-start',
      id: 2,
      startId: startIdSchema.parse('start-mid-drain'),
      storeId: session.storeId,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      directory: null,
    });
    const refusal = await hub.next('session-refused');

    expect(refusal).toMatchObject({ replyTo: 2, code: 'refused' });
    // One pty, which is the one that was already running. A drain that kept
    // accepting starts would never end, and the session it forked would be one
    // nothing was left to stop.
    expect(started.terminals.factory.ptys).toHaveLength(1);

    started.runtime.stopWaiting();
    await stopping;
  });

  it('is safe to stop twice, and the second caller waits for the first shutdown', async () => {
    const started = await start();
    const session = sessionRefSchema.parse({
      storeId: storeOf(started).storeId,
      sessionId: 'session-a',
    });
    started.terminals.terminals.resume(session, launch);
    started.terminals.terminals.observe(session, 'working');

    const first = started.runtime.stop();
    const second = started.runtime.stop();
    started.runtime.stopWaiting();
    await Promise.all([first, second]);

    // One shutdown, not two. A second `stop` that returned at once would let a
    // caller carry on -- and exit the process -- in the middle of the drain the
    // first one is still in.
    expect(started.records.filter((record) => record.message === 'server stopped')).toHaveLength(1);
  });
});

/**
 * Re-reading what this machine's providers are, without bouncing the service.
 *
 * The staleness this amends is deliberate and stays: nothing below puts a probe
 * on the path of a session start or on a timer. What it adds is a way to ask
 * for a fresh reading at all, and the only path a fresh one has to a hub --
 * which is the handshake it already reads, taken again.
 */
describe('re-reading provider readiness', () => {
  it('reports the fresh reading to a hub that dials after it', async () => {
    const started = await start([missingProvider()]);
    started.preflight.reading = [readyProvider()];

    await started.runtime.refreshReadiness();
    const hub = await dial(started);

    // The operator installed it and this server was told to look again. A hub
    // connecting now is told what is true now, and not what was true at boot.
    expect(await hub.next('handshake-accepted')).toMatchObject({
      providers: [readyProvider()],
    });
  });

  it('ends the connections a hub already has, so it reads the fresh one too', async () => {
    const started = await start([missingProvider()]);
    const hub = await dial(started);
    started.preflight.reading = [readyProvider()];

    await started.runtime.refreshReadiness();

    // A normal close and a sentence. The hub redials by itself, and what it
    // reads on the way back in is the reading this server now holds. Nothing
    // here is a frame, because the fact lives on the handshake and there is no
    // frame on this direction that revises one.
    const ended = await hub.ended();
    expect(ended.reason).toContain('re-read');

    const second = await dial(started);
    expect(await second.next('handshake-accepted')).toMatchObject({
      providers: [readyProvider()],
    });
  });

  it('leaves a hub alone when the machine turned out not to have changed', async () => {
    const started = await start([readyProvider()]);
    const hub = await dial(started);

    await started.runtime.refreshReadiness();

    // The ordinary case, and the one that must cost nothing: an operator who
    // fixed the wrong machine, or a reload that landed twice. Dropping a
    // connection to redeliver a fact the hub already holds would spend every
    // watcher's subscription on nothing.
    hub.send({ type: 'ping', id: 99 });
    expect(await hub.next('pong')).toMatchObject({ replyTo: 99 });
  });

  it('keeps the reading it had when the probe itself failed', async () => {
    const started = await start([readyProvider()]);
    const hub = await dial(started);
    started.preflight.problem = 'the probe runner is broken';

    await started.runtime.refreshReadiness();

    // A failed refresh writes nothing. The alternative is worse than stale:
    // reporting that every provider went `unknown` because this server could
    // not run a probe would take a working machine offline over the probe.
    expect(started.runtime.server.providers).toEqual([readyProvider()]);
    hub.send({ type: 'ping', id: 99 });
    expect(await hub.next('pong')).toMatchObject({ replyTo: 99 });
  });

  it('answers two overlapping asks with one probe', async () => {
    const started = await start([readyProvider()]);
    const runsAfterBoot = started.preflight.runs;
    started.preflight.hold();

    const first = started.runtime.refreshReadiness();
    const second = started.runtime.refreshReadiness();
    started.preflight.release();
    await Promise.all([first, second]);

    // Two child processes per provider is the cost this whole design exists to
    // keep off a hot path, so a second ask arriving while the first is still
    // running joins it rather than doubling it. A signal anyone can send twice
    // is exactly where that matters.
    expect(started.preflight.runs).toBe(runsAfterBoot + 1);
  });

  it('discards a re-read that a shutdown overtook while it was probing', async () => {
    const started = await start([readyProvider()]);
    started.preflight.hold();
    const rereading = started.runtime.refreshReadiness();
    started.preflight.reading = [missingProvider()];

    const stopping = started.runtime.stop();
    started.preflight.release();

    // The hubs have already been told this server is draining, and their
    // sockets stay up through it so a client keeps seeing the last of its
    // agent's output. Ending them to deliver a fact about a machine that is
    // going away would take that away and buy nothing.
    expect(await rereading).toEqual([readyProvider()]);

    started.runtime.stopWaiting();
    await stopping;
  });

  it('probes nothing once the server has begun shutting down', async () => {
    const started = await start([readyProvider()]);
    const runsAfterBoot = started.preflight.runs;

    await started.runtime.stop();
    await started.runtime.refreshReadiness();

    // Nothing left to tell: the hubs have been told this server is draining and
    // the sockets are gone. A probe here would fork two children on a process
    // whose whole job now is to stop forking them.
    expect(started.preflight.runs).toBe(runsAfterBoot);
  });
});

/**
 * The document frames, end to end through the runtime `main` assembles, and
 * the one assertion about them that has to hold at this level rather than at
 * the handler's: nothing on them reaches a process.
 *
 * `directory` on a document frame is a key into the project file store and
 * the rule that no frame carries a cwd is about what reaches a child. The
 * handler's tests show the store is asked; this shows the runner and the pty
 * -- the only two ways this server starts anything -- were not. Both are the
 * real registry and the real manager over fakes that record every request,
 * so "no process" is an empty list rather than an absence of evidence.
 */
describe('the document frames', () => {
  const DIRECTORY = '/Users/dev/Code/agentplex';

  it('writes, reads back and lists a document, and starts no process doing it', async () => {
    const started = await start();
    const hub = await dial(started);

    hub.send({
      type: 'doc-write',
      id: 2,
      directory: DIRECTORY,
      name: 'plan.md',
      content: '# Plan\n',
    });
    const written = await hub.next('doc-written');
    hub.send({ type: 'doc-read', id: 3, directory: DIRECTORY, name: 'plan.md' });
    const content = await hub.next('doc-content');
    hub.send({ type: 'doc-list', id: 4, directory: DIRECTORY });
    const listing = await hub.next('doc-listing');

    expect(written).toMatchObject({ replyTo: 2 });
    expect(content).toMatchObject({ replyTo: 3, content: '# Plan\n' });
    expect(listing).toMatchObject({ replyTo: 4, entries: [{ name: 'plan.md', bytes: 7 }] });

    // No operation was run and no terminal was opened: the frames' fields
    // went to the file store and to nothing that forks.
    expect(started.runner.requests).toEqual([]);
    expect(started.terminals.factory.ptys).toEqual([]);

    // And what was written went under this server's own root, keyed by the
    // directory, and never into the directory itself.
    const root = `${DATA_PATH}/${PROJECT_FILES_DIRECTORY}/`;
    const touched = [...started.projectFiles.creates, ...started.projectFiles.writes];
    expect(touched.length).toBeGreaterThan(0);
    for (const path of touched) {
      expect(path.startsWith(root)).toBe(true);
      expect(path.startsWith(DIRECTORY)).toBe(false);
    }

    hub.close();
  });

  it('refuses a document it does not have on the frame the hub can already read', async () => {
    const started = await start();
    const hub = await dial(started);

    hub.send({ type: 'doc-read', id: 2, directory: DIRECTORY, name: 'missing.md' });
    const refusal = await hub.next('session-refused');

    expect(refusal).toMatchObject({ replyTo: 2, code: 'refused', hold: null });
    expect(started.runner.requests).toEqual([]);
    hub.close();
  });
});

/**
 * The store watcher, as `main` assembles it: a change on a real volume would
 * arrive at the seam, and what the server does with it is the wiring this file
 * exists to check. The unit half -- the window, the fan-out, the backoff --
 * is `store-watch.test.ts`, and the real `fs.watch` is
 * `node-store-watcher.integration.test.ts`.
 */
describe('a store that changes with nobody asking', () => {
  /** Every whole-store report this hub has been sent, handshake included. */
  const reports = (hub: FakeHub): readonly ServerToHubFrame[] =>
    hub.frames.filter((frame) => frame.type === 'store-report');

  it('reports it to a connected hub, on the path a start already uses', async () => {
    const started = await start();
    const hub = await dial(started);
    await hub.next('store-report');
    const atHandshake = reports(hub).length;

    // Somebody ran `claude` in a terminal on this machine. No frame arrived and
    // nothing here was asked anything; the only event is the filesystem.
    started.watcher.change(STORE_PATH);
    started.timers.fireAll();

    await vi.waitFor(() => expect(reports(hub).length).toBe(atHandshake + 1));
    expect(reports(hub)[atHandshake]).toMatchObject({
      type: 'store-report',
      storeId: storeOf(started).storeId,
    });
    hub.close();
  });

  it('starts anyway when a store cannot be watched, and says which one', async () => {
    const started = await start([], createFakeStoreWatcher({ refuse: [STORE_PATH] }));

    // The store costs itself and nothing else: the server is up, it serves, and
    // the reports a hub asks for are unaffected. What was lost is freshness
    // between them, which is exactly what the line says.
    const refusal = started.records.find((record) =>
      record.message.startsWith('not watching a store'),
    );
    expect(refusal?.level).toBe('warn');
    expect(refusal?.fields).toMatchObject({ path: STORE_PATH });

    const hub = await dial(started);
    expect(await hub.next('store-report')).toMatchObject({ storeId: storeOf(started).storeId });
    hub.close();
  });

  it('stops watching when the server stops', async () => {
    const started = await start();
    expect(started.watcher.watching).toEqual([STORE_PATH]);

    await started.runtime.stop();

    // Before the drain, not after it: a drain closes sessions, which writes
    // into the store, and a watch left open would spend a shutdown scanning
    // for hubs that have just been told this server is going away.
    expect(started.watcher.watching).toEqual([]);
    expect(started.watcher.closed).toEqual([STORE_PATH]);
  });
});
