import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { describe, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  PROTOCOL_VERSION,
  type SessionDescriptor,
  type SessionHold,
  type StoreDescriptor,
} from '@agentplex/protocol';
import { createFakeSessionController } from '../../server/fake-session-controller.js';
import { serveHubConnection } from '../../server/hub-connection.js';
import type { StoreReport } from '../../server/session-control.js';
import { createUnreachableDialer, createSocketPair } from '../../shared/fake-message-socket.js';
import { createLogger } from '../../shared/logger.js';
import type { DialResult, MessageSocket, SocketDialer } from '../../shared/message-socket.js';
import { createFakeTimers } from '../../shared/timers.js';
import { createFakeDatabase } from '../db/fake-database.js';
import { loadMigrations, type MigrationFileSystem } from '../db/migration-files.js';
import { migrate } from '../db/migrations.js';
import { nodeMigrationFileSystem } from '../db/node-migration-files.js';
import { createSqliteDatabase } from '../db/sqlite.js';
import { newServerRegistrationSchema, registerServer } from '../pairing/server-registrations.js';
import { startHub, type Hub } from '../hub.js';
import { CLIENT_SOCKET_PATH, CLIENT_TICKET_PATH } from './client-auth.js';

/**
 * Captures what a real hub says to a client, for the web store's tests.
 *
 * The web app's store tests feed hub frames into a fake socket, and those
 * frames must be captured real output rather than hand-written guesses -- a
 * hand-written fixture asserts that the store can read what its author
 * imagined the hub sends. This file starts the hub the way its own integration
 * test does, drives client conversations over a real websocket -- against an
 * empty hub, against one supervising a reporting fleet, and against that fleet
 * degraded -- and writes every frame the hub sent, verbatim, into a fixture
 * module in apps/web.
 *
 * A test file so it runs under vitest, which is the one runner here that
 * resolves `.js` specifiers to `.ts` sources; gated on an environment variable
 * so an ordinary test run never rewrites a fixture behind anyone's back. To
 * re-capture -- after any change to the hub-to-client frames, in the same
 * commit that bumps PROTOCOL_VERSION -- run, from apps/agentplexd:
 *
 *   CAPTURE_FIXTURES=1 pnpm vitest run src/hub/clients/capture-client-fixtures.test.ts
 */

const CLIENT_TOKEN = 'the-client-token-typed-on-the-device';
const HOST = '127.0.0.1';

const migrationFileSystem: MigrationFileSystem = {
  readDirectory: async () => ['0001_hub_identity.sql'],
  readFile: async () => 'CREATE TABLE hub_identity ()',
};

interface Client {
  send(frame: unknown): void;
  sendText(text: string): void;
  framesReceived(count: number): Promise<void>;
  closed(): Promise<void>;
  readonly received: readonly string[];
}

async function openClient(hub: Hub): Promise<Client> {
  const exchange = await fetch(`http://${HOST}:${hub.port}${CLIENT_TICKET_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
  });
  const issued = (await exchange.json()) as { ticket: string };

  const socket = new WebSocket(
    `ws://${HOST}:${hub.port}${CLIENT_SOCKET_PATH}?ticket=${encodeURIComponent(issued.ticket)}`,
  );

  const received: string[] = [];
  const waiting: (() => void)[] = [];
  let ended = false;

  socket.on('message', (data: Buffer) => {
    received.push(data.toString('utf8'));
    for (const wake of waiting.splice(0)) wake();
  });
  socket.on('close', () => {
    ended = true;
    for (const wake of waiting.splice(0)) wake();
  });
  await new Promise<void>((resolve) => socket.on('open', () => resolve()));

  return {
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    sendText: (text: string) => socket.send(text),
    async framesReceived(count: number): Promise<void> {
      while (received.length < count && !ended) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },
    async closed(): Promise<void> {
      while (!ended) await new Promise<void>((resolve) => waiting.push(resolve));
    },
    received,
  };
}

/** Labels a frame by what the parser read off it, never by what was expected. */
function labelFor(text: string): string {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
  const frame = parsed.value;
  if (frame.type === 'refusal') {
    return frame.code === 'protocol-version' ? 'refusalProtocolVersion' : 'refusal';
  }
  const labels = new Map<string, string>([
    ['welcome', 'welcome'],
    ['machine-state', 'machineState'],
    ['pong', 'pong'],
    ['layout', 'layout'],
    ['protocol-error', 'protocolError'],
  ]);
  const label = labels.get(frame.type);
  if (label === undefined) throw new Error(`no label for a ${frame.type} frame`);
  return label;
}

/**
 * A fleet for the populated captures: hostnames that answer a dial with a real
 * `serveHubConnection` backed by a fake session controller, so every session
 * the machine-state frame carries travelled the whole real path -- store
 * report, reducer, broadcast -- before it was captured.
 */
interface Machine {
  readonly serverId: string;
  readonly stores: readonly StoreDescriptor[];
  readonly reports: readonly StoreReport[];
}

const START = 1_756_000_000_000;
const MINUTE = 60_000;
const logger = createLogger('error', () => {});

function fleetDialer(
  machines: Map<string, Machine>,
  live: Map<string, MessageSocket>,
): SocketDialer {
  return {
    dial: async (address: string): Promise<DialResult> => {
      const host = new URL(address).hostname;
      const machine = machines.get(host);
      if (machine === undefined) return { ok: false, problem: 'connection refused' };
      const { hubEnd, serverEnd } = createSocketPair();
      const controller = createFakeSessionController({ reports: machine.reports });
      serveHubConnection(serverEnd, {
        // A real scan reads a disk and takes event-loop turns; a fake that
        // resolved in the same microtask as the handshake would race its
        // report past the hub attaching its listener, an ordering no real
        // store scan can produce.
        sessions: {
          ...controller,
          report: async (storeId) => {
            await new Promise((resolve) => setImmediate(resolve));
            return controller.report(storeId);
          },
        },
        identity: { serverId: serverIdSchema.parse(machine.serverId), token: `tok-${host}` },
        stores: machine.stores,
        logger,
      });
      live.set(host, serverEnd);
      return { ok: true, socket: hubEnd };
    },
  };
}

function descriptor(
  storeId: string,
  sessionId: string,
  provider: SessionDescriptor['provider'],
  status: SessionDescriptor['status'],
  updatedAt: number,
  cwd: string | null,
  title: string | null,
): SessionDescriptor {
  return {
    storeId: storeIdSchema.parse(storeId),
    sessionId: sessionIdSchema.parse(sessionId),
    provider,
    status,
    updatedAt,
    cwd,
    title,
  };
}

function hold(sessionId: string, stoppable: boolean): SessionHold {
  return { sessionId: sessionIdSchema.parse(sessionId), stoppable };
}

async function until(predicate: () => boolean, what: string | (() => string)): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
}

/** A hub over a real migrated SQLite file, dialling the given fleet. */
async function startFleetHub(
  machines: Map<string, Machine>,
  registrations: readonly { label: string; host: string }[],
  live: Map<string, MessageSocket>,
): Promise<{ hub: Hub; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'agentplex-capture-'));
  const database = createSqliteDatabase(join(directory, 'hub.db'));
  const migrationsDirectory = fileURLToPath(new URL('../../../migrations', import.meta.url));
  const migrations = await loadMigrations(migrationsDirectory, nodeMigrationFileSystem);
  const clock = { now: () => START };
  await migrate(database, migrations, logger, clock);
  for (const { label, host } of registrations) {
    await registerServer(
      database,
      { newId: () => `registration-${label}` },
      clock,
      newServerRegistrationSchema.parse({
        label,
        address: `wss://${host}:8443`,
        token: `tok-${host}`,
      }),
    );
  }
  let nextTicket = 0;
  const hub = await startHub({
    database,
    logger,
    ids: { newId: () => 'hub-1' },
    clock,
    clientToken: CLIENT_TOKEN,
    tokens: { newToken: () => `fleet-ticket-${(nextTicket += 1)}` },
    dialer: fleetDialer(machines, live),
    timers: createFakeTimers(),
    migrationsDirectory,
    migrationFileSystem: nodeMigrationFileSystem,
    host: HOST,
    port: 0,
  });
  return {
    hub,
    cleanup: async () => {
      await hub.stop();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function sessionCount(hub: Hub): number {
  return hub.state.snapshot().stores.reduce((sum, view) => sum + view.sessions.length, 0);
}

/** Opens a client, says hello, and returns the machine-state frame it was sent. */
async function captureState(hub: Hub): Promise<string> {
  const client = await openClient(hub);
  client.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
  await client.framesReceived(2);
  const text = client.received[1];
  if (text === undefined) throw new Error('the hub closed before sending a state');
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the second frame after a hello was not a machine-state');
  }
  return text;
}

describe.runIf(process.env.CAPTURE_FIXTURES === '1')('capturing client fixtures', () => {
  it('drives two conversations and writes what the hub said', async () => {
    let nextTicket = 0;
    const hub = await startHub({
      database: createFakeDatabase({
        respondWith: [{ match: /SELECT hub_id FROM hub_identity/, rows: [{ hub_id: 'hub-1' }] }],
      }),
      logger: createLogger('error', () => {}),
      ids: { newId: () => 'hub-1' },
      clock: { now: () => 1_756_000_000_000 },
      clientToken: CLIENT_TOKEN,
      tokens: { newToken: () => `ticket-${(nextTicket += 1)}` },
      dialer: createUnreachableDialer(),
      timers: createFakeTimers(),
      migrationsDirectory: '/migrations',
      migrationFileSystem,
      host: HOST,
      port: 0,
    });

    // The first conversation, in an order a real client could have: a hello
    // (answered by a welcome and, unasked, the whole machine state), a ping, a
    // layout request, a session start nothing can satisfy (answered by a
    // refusal), and finally something that is not JSON at all, which earns the
    // unsolicited protocol-error and a close.
    const first = await openClient(hub);
    first.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await first.framesReceived(2);
    first.send({ type: 'ping', id: 2 });
    await first.framesReceived(3);
    first.send({ type: 'layout-request', id: 3 });
    await first.framesReceived(4);
    first.send({
      type: 'session-start',
      id: 4,
      storeId: 'store-observatory',
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: null,
    });
    await first.framesReceived(5);
    first.sendText('definitely not a frame');
    await first.framesReceived(6);
    await first.closed();

    // The second conversation is one frame long: a hello claiming a protocol
    // this hub does not speak, refused with the code retrying cannot fix.
    const second = await openClient(hub);
    second.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION + 1 });
    await second.framesReceived(1);
    await second.closed();

    await hub.stop();

    // The third capture is a fleet: two paired servers, two stores, sessions
    // across every status the vocabulary has, holds on the ones with live
    // processes. What the session-list derives -- partitions, narrowings,
    // tones -- is tested against this frame, so it has to be one a real hub
    // assembled from real store reports rather than one written to match the
    // list's expectations.
    const fleet = new Map<string, Machine>([
      [
        'mbp-robert.example',
        {
          serverId: 'server-mbp',
          stores: [
            {
              storeId: storeIdSchema.parse('store-agentplex'),
              path: '/Users/robert/code/agentplex',
            },
          ],
          reports: [
            {
              storeId: storeIdSchema.parse('store-agentplex'),
              sessions: [
                descriptor(
                  'store-agentplex',
                  'session-fix-auth',
                  'claude',
                  'working',
                  START - 12 * MINUTE,
                  '/Users/robert/code/agentplex',
                  'fix-auth-refresh',
                ),
                descriptor(
                  'store-agentplex',
                  'session-migrate-db',
                  'codex',
                  'awaiting-permission',
                  START - 3 * MINUTE,
                  '/Users/robert/code/agentplex/db',
                  'migrate-db-v9',
                ),
                descriptor(
                  'store-agentplex',
                  'session-spike-wasm',
                  'claude',
                  'idle',
                  START - 120 * MINUTE,
                  null,
                  'spike-wasm',
                ),
              ],
              holding: [hold('session-fix-auth', false), hold('session-migrate-db', true)],
            },
          ],
        },
      ],
      [
        'gpu-box.example',
        {
          serverId: 'server-gpu',
          stores: [
            { storeId: storeIdSchema.parse('store-universe'), path: '/mnt/volumes/universe' },
          ],
          reports: [
            {
              storeId: storeIdSchema.parse('store-universe'),
              sessions: [
                descriptor(
                  'store-universe',
                  'session-bench-tokenizer',
                  'claude',
                  'working',
                  START - 41 * MINUTE,
                  '/mnt/volumes/universe/bench',
                  'bench-tokenizer',
                ),
                descriptor(
                  'store-universe',
                  'session-docs-sweep',
                  'codex',
                  'awaiting-input',
                  START - 4 * MINUTE,
                  '/mnt/volumes/universe/docs',
                  'docs-sweep',
                ),
                descriptor(
                  'store-universe',
                  'session-train-lora',
                  'claude',
                  'unknown',
                  START - 60 * MINUTE,
                  null,
                  null,
                ),
              ],
              holding: [hold('session-bench-tokenizer', false)],
            },
          ],
        },
      ],
    ]);
    const fleetLive = new Map<string, MessageSocket>();
    const populated = await startFleetHub(
      fleet,
      [
        { label: 'mbp-robert', host: 'mbp-robert.example' },
        { label: 'gpu-box-01', host: 'gpu-box.example' },
      ],
      fleetLive,
    );
    await until(
      () =>
        populated.hub.connections.snapshot().every((report) => report.phase === 'connected') &&
        sessionCount(populated.hub) === 6,
      () => `the fleet to connect and report: ${JSON.stringify(populated.hub.state.snapshot())}`,
    );
    const machineStatePopulated = await captureState(populated.hub);

    // The same fleet after one machine goes away without saying so: its rows
    // stay, labelled unreachable, and its needs-you session leaves the
    // attention count. The degradation states are tested against this frame.
    fleetLive.get('gpu-box.example')?.close({ code: 1006, reason: 'the machine went away' });
    await until(
      () =>
        populated.hub.connections
          .snapshot()
          .some((report) => report.label === 'gpu-box-01' && report.phase === 'stale'),
      'the gpu box to go stale',
    );
    const machineStateStale = await captureState(populated.hub);
    await populated.cleanup();

    // One machine, one store, one provider: the state in which no store or
    // provider narrowing may be drawn, captured rather than derived.
    const single = new Map<string, Machine>([
      [
        'mbp-robert.example',
        {
          serverId: 'server-mbp',
          stores: [
            {
              storeId: storeIdSchema.parse('store-agentplex'),
              path: '/Users/robert/code/agentplex',
            },
          ],
          reports: [
            {
              storeId: storeIdSchema.parse('store-agentplex'),
              sessions: [
                descriptor(
                  'store-agentplex',
                  'session-fix-auth',
                  'claude',
                  'working',
                  START - 12 * MINUTE,
                  '/Users/robert/code/agentplex',
                  'fix-auth-refresh',
                ),
                descriptor(
                  'store-agentplex',
                  'session-spike-wasm',
                  'claude',
                  'idle',
                  START - 120 * MINUTE,
                  null,
                  'spike-wasm',
                ),
              ],
              holding: [hold('session-fix-auth', false)],
            },
          ],
        },
      ],
    ]);
    const singleHub = await startFleetHub(
      single,
      [{ label: 'mbp-robert', host: 'mbp-robert.example' }],
      new Map(),
    );
    await until(
      () =>
        singleHub.hub.connections.snapshot().every((report) => report.phase === 'connected') &&
        sessionCount(singleHub.hub) === 2,
      'the single machine to connect and report',
    );
    const machineStateSingle = await captureState(singleHub.hub);
    await singleHub.cleanup();

    const captured = new Map<string, string>();
    for (const text of [...first.received, ...second.received]) {
      captured.set(labelFor(text), text);
    }
    captured.set('machineStatePopulated', machineStatePopulated);
    captured.set('machineStateStale', machineStateStale);
    captured.set('machineStateSingle', machineStateSingle);

    const entries = [...captured]
      .map(([label, text]) => `  ${label}: ${JSON.stringify(text)},`)
      .join('\n');
    const module = `/**
 * Hub frames, captured from a real hub over a real websocket.
 *
 * Generated by apps/agentplexd/src/hub/clients/capture-client-fixtures.test.ts
 * (see that file for how to re-run the capture). Never edited by hand: a
 * hand-written fixture tests that the store can read what its author imagined,
 * and these exist to test that it can read what the hub actually sends.
 * Re-capture after any change to the hub-to-client frames.
 *
 * Captured at protocol version ${PROTOCOL_VERSION}.
 */
export const hubFrames = {
${entries}
} as const;
`;

    const target = new URL('../../../../web/src/store/hub-frames.fixture.ts', import.meta.url);
    await mkdir(new URL('.', target), { recursive: true });
    await writeFile(target, module, 'utf8');
    process.stdout.write(`wrote ${captured.size} frames to ${fileURLToPath(target)}\n`);
  });
});
