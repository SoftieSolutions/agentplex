import { afterEach, describe, expect, it } from 'vitest';
import {
  parseServerToHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  sessionRefSchema,
  storeDescriptorSchema,
  type ServerToHubFrame,
} from '@agentplex/protocol';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { createFakeTimers } from '@agentplex/node-shared/testing';
import { createProviderRegistry } from '@agentplex/providers';
import {
  createFakeGrantFiles,
  createFakeProcessRunner,
  createFakeStoreFiles,
} from '@agentplex/providers/testing';
import type { Launch, LaunchPlan } from '@agentplex/providers';
import { startRuntime, type Runtime } from './boot.js';
import type { ServerConfig } from './config.js';
import { createOperationRegistry } from './operations/operation-registry.js';
import { createFakeDataRoot } from './fake-data-root.js';
import { createFakeTerminals, type FakeTerminals } from './fake-terminals.js';

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
}

let world: World | undefined;

afterEach(async () => {
  world?.runtime.stopWaiting();
  await world?.runtime.stop();
  world = undefined;
});

async function start(): Promise<World> {
  const terminals = createFakeTerminals();
  const records: LogRecord[] = [];
  const runtime = await startRuntime(config, {
    logger: createLogger('info', (record) => records.push(record)),
    ids: { newId: () => 'id-under-test' },
    timers: createFakeTimers(),
    storeFileSystem: createFakeStoreFiles(),
    dataRootFileSystem: createFakeDataRoot(),
    grantFileSystem: createFakeGrantFiles(),
    tokens: { newToken: () => TOKEN },
    // No adapters. A scan that found sessions would derive statuses of its own
    // and overwrite the one each test is making its point with.
    providers: createProviderRegistry([]),
    preflight: { run: async () => [] },
    terminals: terminals.terminals,
    operations: createOperationRegistry(createFakeProcessRunner()),
    beacon: {
      open: () => {
        throw new Error('the runtime opened a beacon socket with announcing off');
      },
      localAddresses: () => [],
    },
    clock: { now: () => 1_756_000_000_000 },
  });
  world = { runtime, terminals, records };
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
  close(): void;
}

async function dial({ runtime }: World): Promise<FakeHub> {
  const socket = new WebSocket(`ws://127.0.0.1:${runtime.server.port}`);
  const frames: ServerToHubFrame[] = [];
  const waiting: (() => void)[] = [];

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
