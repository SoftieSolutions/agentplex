import { afterEach, describe, expect, it } from 'vitest';
import {
  parseServerToHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type ProviderReadiness,
  sessionRefSchema,
  storeDescriptorSchema,
  type ServerToHubFrame,
} from '@agentplex/protocol';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { createFakeTimers } from '@agentplex/node-shared/testing';
import { createProviderRegistry, type ProviderPreflight } from '@agentplex/providers';
import {
  createFakeProcessRunner,
  createFakeStoreFiles,
  missingProvider,
  readyProvider,
} from '@agentplex/providers/testing';
import type { Launch, LaunchPlan } from '@agentplex/providers';
import { startRuntime, type Runtime } from './boot.js';
import type { ServerConfig } from './config.js';
import { createOperationRegistry } from './operations/operation-registry.js';
import { createFakeWorkingTree } from './fake-working-tree.js';
import { createFakeTerminals, type FakeTerminals } from './fake-terminals.js';
import { createFakeMachineLoadReader } from './fake-machine-probe.js';

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
  identityPath: IDENTITY_PATH,
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

async function start(reading: readonly ProviderReadiness[] = []): Promise<World> {
  const terminals = createFakeTerminals();
  const records: LogRecord[] = [];
  const preflight = createFakePreflight(reading);
  const runtime = await startRuntime(config, {
    logger: createLogger('info', (record) => records.push(record)),
    ids: { newId: () => 'id-under-test' },
    timers: createFakeTimers(),
    storeFileSystem: createFakeStoreFiles(),
    tokens: { newToken: () => TOKEN },
    // No adapters. A scan that found sessions would derive statuses of its own
    // and overwrite the one each test is making its point with.
    providers: createProviderRegistry([]),
    preflight,
    terminals: terminals.terminals,
    machineLoad: createFakeMachineLoadReader(),
    operations: createOperationRegistry(createFakeProcessRunner()),
    workingTree: createFakeWorkingTree(),
    beacon: {
      open: () => {
        throw new Error('the runtime opened a beacon socket with announcing off');
      },
      localAddresses: () => [],
    },
    clock: { now: () => 1_756_000_000_000 },
  });
  world = { runtime, terminals, records, preflight };
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
    protocolVersion: PROTOCOL_VERSION,
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
      storeId: session.storeId,
      sessionId: null,
      provider: 'claude',
      prompt: null,
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
