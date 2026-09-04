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
import type { SessionOutcome, StoreReport } from '../../server/session-control.js';
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
  if (frame.type === 'machine-state') {
    // Labelled by what the state holds, so the web tests get a captured state
    // with a paired server in it as well as the empty one.
    return frame.state.servers.length > 0 ? 'machineStateWithServer' : 'machineState';
  }
  if (frame.type === 'pane-layout') {
    return frame.layout === null ? 'paneLayoutEmpty' : 'paneLayout';
  }
  const labels = new Map<string, string>([
    ['welcome', 'welcome'],
    ['pong', 'pong'],
    ['layout', 'layout'],
    ['pane-layout-saved', 'paneLayoutSaved'],
    ['session-started', 'sessionStarted'],
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
  /** What this machine's controller answers a start with. Default: a refusal. */
  readonly startOutcome?: SessionOutcome;
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
      const controller = createFakeSessionController(
        machine.startOutcome === undefined
          ? { reports: machine.reports }
          : { reports: machine.reports, outcome: machine.startOutcome },
      );
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
  it('drives three conversations and writes what the hub said', async () => {
    let nextTicket = 0;
    const dependencies = {
      logger: createLogger('error', () => {}),
      ids: { newId: () => 'hub-1' },
      clock: { now: () => 1_756_000_000_000 },
      clientToken: CLIENT_TOKEN,
      tokens: { newToken: () => `ticket-${(nextTicket += 1)}` },
      dialer: createUnreachableDialer(),
      migrationsDirectory: '/migrations',
      migrationFileSystem,
      host: HOST,
      port: 0,
    };
    const hub = await startHub({
      ...dependencies,
      database: createFakeDatabase({
        respondWith: [{ match: /SELECT hub_id FROM hub_identity/, rows: [{ hub_id: 'hub-1' }] }],
      }),
      timers: createFakeTimers(),
    });

    // The first conversation, in an order a real client could have: a hello
    // (answered by a welcome and, unasked, the whole machine state), a ping, a
    // layout request, a pane layout request against a hub that has never
    // stored one, a pane layout save, a session start nothing can satisfy
    // (answered by a refusal), and finally something that is not JSON at all,
    // which earns the unsolicited protocol-error and a close.
    const first = await openClient(hub);
    first.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await first.framesReceived(2);
    first.send({ type: 'ping', id: 2 });
    await first.framesReceived(3);
    first.send({ type: 'layout-request', id: 3 });
    await first.framesReceived(4);
    first.send({ type: 'pane-layout-request', id: 4 });
    await first.framesReceived(5);
    first.send({
      type: 'pane-layout-save',
      id: 5,
      layout: '{"v":1,"root":{"kind":"pane","content":{"type":"empty"}}}',
    });
    await first.framesReceived(6);
    first.send({
      type: 'session-start',
      id: 6,
      storeId: 'store-observatory',
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: null,
    });
    await first.framesReceived(7);
    first.sendText('definitely not a frame');
    await first.framesReceived(8);
    await first.closed();

    // The second conversation is one frame long: a hello claiming a protocol
    // this hub does not speak, refused with the code retrying cannot fix.
    const second = await openClient(hub);
    second.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION + 1 });
    await second.framesReceived(1);
    await second.closed();

    await hub.stop();

    // A third conversation against a hub whose pairing table holds one server.
    // The dialer is unreachable, so the machine state carries that pairing as
    // a stale row — which is exactly the shape the settings screen's tests
    // need: a real server row, captured, with its problem in the hub's words.
    const pairedHub = await startHub({
      database: createFakeDatabase({
        respondWith: [
          { match: /SELECT hub_id FROM hub_identity/, rows: [{ hub_id: 'hub-1' }] },
          {
            match: /FROM servers/,
            rows: [
              {
                id: 'pairing-1',
                label: 'gpu-box-01',
                address: 'wss://gpu-box-01.example:8443',
                token: 'the-token-the-server-printed',
                server_id: null,
                created_at: 1_755_000_000_000,
                revoked_at: null,
                last_connected_at: null,
              },
            ],
          },
        ],
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
    const third = await openClient(pairedHub);
    third.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    // Wait until a broadcast shows the pairing as stale, however the dial
    // failure raced the hello: the last machine-state captured is that one.
    for (let count = 2; ; count += 1) {
      await third.framesReceived(count);
      const staleSeen = third.received.some((text) => {
        const parsed = parseTextFrame(parseHubFrame, text);
        return (
          parsed.ok &&
          parsed.value.type === 'machine-state' &&
          parsed.value.state.servers.some((server) => server.phase === 'stale')
        );
      });
      if (staleSeen) break;
    }
    await pairedHub.stop();
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
          // Answers a start the way a real spawn does: ok, with no session id,
          // because the provider has not written one yet. The web form's
          // follow-up rules are tested against exactly this reply.
          startOutcome: {
            ok: true,
            storeId: storeIdSchema.parse('store-agentplex'),
            sessionId: null,
          },
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

    // A start that succeeds, captured for the new-session flow: the reply names
    // the machine the hub picked, and its sessionId is null because a fresh
    // spawn has no id until the provider writes one -- the reply the web form's
    // follow-up logic has to read honestly rather than invent an address from.
    const starter = await openClient(singleHub.hub);
    starter.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await starter.framesReceived(2);
    starter.send({
      type: 'session-start',
      id: 2,
      storeId: 'store-agentplex',
      sessionId: null,
      provider: 'claude',
      prompt: 'fix the auth refresh loop',
      server: null,
    });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'sessionStarted'),
      'the start to be answered',
    );
    const sessionStarted = starter.received.find((text) => labelFor(text) === 'sessionStarted');
    if (sessionStarted === undefined) throw new Error('the start was not answered');
    await singleHub.cleanup();

    // A shared volume: two machines with the same store mounted. This is the
    // state in which the new-session server override is drawn -- more than one
    // connected machine could run the store -- and, degraded, the state in
    // which it is not: two attached, one reachable, no decision left to make.
    const sharedStore: StoreDescriptor = {
      storeId: storeIdSchema.parse('store-shared'),
      path: '/mnt/volumes/shared',
    };
    const sharedFleet = new Map<string, Machine>([
      [
        'mbp-robert.example',
        {
          serverId: 'server-mbp',
          stores: [sharedStore],
          reports: [
            {
              storeId: sharedStore.storeId,
              sessions: [
                descriptor(
                  'store-shared',
                  'session-shared-notes',
                  'claude',
                  'idle',
                  START - 30 * MINUTE,
                  '/mnt/volumes/shared/notes',
                  'shared-notes',
                ),
              ],
              holding: [],
            },
          ],
        },
      ],
      [
        'gpu-box.example',
        {
          serverId: 'server-gpu',
          stores: [sharedStore],
          reports: [
            {
              storeId: sharedStore.storeId,
              sessions: [
                descriptor(
                  'store-shared',
                  'session-shared-notes',
                  'claude',
                  'idle',
                  START - 30 * MINUTE,
                  '/mnt/volumes/shared/notes',
                  'shared-notes',
                ),
              ],
              holding: [],
            },
          ],
        },
      ],
    ]);
    const sharedLive = new Map<string, MessageSocket>();
    const sharedHub = await startFleetHub(
      sharedFleet,
      [
        { label: 'mbp-robert', host: 'mbp-robert.example' },
        { label: 'gpu-box-01', host: 'gpu-box.example' },
      ],
      sharedLive,
    );
    await until(
      () =>
        sharedHub.hub.connections.snapshot().every((report) => report.phase === 'connected') &&
        sharedHub.hub.state
          .snapshot()
          .stores.some((view) => view.storeId === 'store-shared' && view.servers.length === 2),
      'the shared fleet to connect and report',
    );
    const machineStateShared = await captureState(sharedHub.hub);
    sharedLive.get('gpu-box.example')?.close({ code: 1006, reason: 'the machine went away' });
    await until(
      () =>
        sharedHub.hub.connections
          .snapshot()
          .some((report) => report.label === 'gpu-box-01' && report.phase === 'stale'),
      'the shared gpu box to go stale',
    );
    const machineStateSharedDegraded = await captureState(sharedHub.hub);
    await sharedHub.cleanup();

    // A hub whose database already holds a pane layout, for the answer a
    // stored arrangement earns. A second hub rather than a re-ask of the
    // first, because the fake database records writes without keeping them;
    // the scripted row stands in for a hub that persisted an earlier save.
    const stored = await startHub({
      ...dependencies,
      database: createFakeDatabase({
        respondWith: [
          { match: /SELECT hub_id FROM hub_identity/, rows: [{ hub_id: 'hub-1' }] },
          {
            match: /SELECT layout FROM pane_layout/,
            rows: [{ layout: '{"v":1,"root":{"kind":"pane","content":{"type":"empty"}}}' }],
          },
        ],
      }),
      timers: createFakeTimers(),
    });
    const fourth = await openClient(stored);
    fourth.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await fourth.framesReceived(2);
    fourth.send({ type: 'pane-layout-request', id: 2 });
    await fourth.framesReceived(3);
    await stored.stop();

    const captured = new Map<string, string>();
    for (const text of [
      ...first.received,
      ...second.received,
      ...third.received,
      ...fourth.received,
    ]) {
      captured.set(labelFor(text), text);
    }
    captured.set('machineStatePopulated', machineStatePopulated);
    captured.set('machineStateStale', machineStateStale);
    captured.set('machineStateSingle', machineStateSingle);
    captured.set('sessionStarted', sessionStarted);
    captured.set('machineStateShared', machineStateShared);
    captured.set('machineStateSharedDegraded', machineStateSharedDegraded);

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
