import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  PROTOCOL_VERSION,
  type HubFrame,
  type MachineState,
  type SessionDescriptor,
  type SessionRow,
  type SessionStatus,
  type StoreId,
} from '@agentplex/protocol';
import {
  createLogger,
  systemTimers,
  type DialResult,
  type SocketDialer,
} from '@agentplex/node-shared';
import { createSocketPair } from '@agentplex/node-shared/testing';
import { createFakeStoreFiles, readyProvider } from '@agentplex/providers/testing';
import {
  createFakeSessionController,
  type FakeSessionController,
} from '../../../apps/server/src/fake-session-controller.js';
import { createFakeTerminals } from '../../../apps/server/src/fake-terminals.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { createHubAudience, type HubAudience } from '../../../apps/server/src/hub-audience.js';
import { serveServerEnd } from './server-end.js';
import { createFakeBeaconSource } from '../../../apps/hub/src/features/discovery/fake-discovery.js';
import { createFakeWebAssets } from '../../../apps/hub/src/features/web/fake-web.js';
import { createSqliteDatabase, type SqliteDatabase } from '../../../apps/hub/src/db/sqlite.js';
import { loadMigrations } from '../../../apps/hub/src/db/migration-files.js';
import { migrate } from '../../../apps/hub/src/db/migrations.js';
import { nodeMigrationFileSystem } from '../../../apps/hub/src/db/node-migration-files.js';
import { registerServer } from '../../../apps/hub/src/features/pairing/server-registrations.js';
import { newServerRegistrationSchema } from '../../../apps/hub/src/features/pairing/pairing.js';
import { startHub, type Hub } from '../../../apps/hub/src/hub.js';

/**
 * The attention semantic, end to end: a prompt, an acknowledgement, and a
 * second prompt that outlives it.
 *
 * The whole ticket is one comparison between two moments that come from two
 * different places -- the hub stamps one when a client says it has seen the
 * session, and a provider writes the other into a transcript on a machine
 * somewhere else. A unit test can only assert that the reducer holds both. This
 * runs the real path: a server scans a store and reports it over the real
 * protocol, a client acknowledges over the real client protocol, the server
 * scans again, and the state the hub then publishes is read back through the
 * protocol's own parser.
 *
 * It is the second scan that earns the integration test. A boolean would have
 * survived it -- acknowledged once, acknowledged forever -- and the bug it
 * produces is silent: an agent stops at a permission prompt and nothing tells
 * anybody, because somebody dismissed the last one.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const MINUTE = 60_000;
const CLIENT_TOKEN = 'the-client-token-typed-on-the-device';
const HOST = '127.0.0.1';

const WORK = storeIdSchema.parse('store-work');
const PROMPTED = 'session-migrate-db';

/** The hub's clock, moved by the tests: an acknowledgement is stamped off it. */
let now = START;
const clock = { now: () => now };

function descriptor(
  sessionId: string,
  status: SessionStatus,
  updatedAt: number,
): SessionDescriptor {
  return {
    storeId: WORK,
    sessionId: sessionIdSchema.parse(sessionId),
    provider: 'claude',
    status,
    updatedAt,
    cwd: '/Users/robert/code/agentplex',
    branch: null,
    title: null,
    uncommitted: null,
  };
}

/** One machine, and the handle a test drives its next scan with. */
interface Machine {
  readonly controller: FakeSessionController;
  audience: HubAudience | null;
}

const machine: Machine = { controller: createFakeSessionController(), audience: null };

function dialer(): SocketDialer {
  return {
    dial: async (address: string): Promise<DialResult> => {
      if (new URL(address).hostname !== 'laptop.example') {
        return { ok: false, problem: 'connection refused' };
      }
      const { hubEnd, serverEnd } = createSocketPair();
      // A real scan reads a disk and takes event-loop turns; a fake resolving
      // in the handshake's own microtask would race its report past the hub
      // attaching its listener, an ordering no real store scan can produce.
      const sessions = {
        ...machine.controller,
        report: async (storeId: StoreId) => {
          await new Promise((resolve) => setImmediate(resolve));
          return machine.controller.report(storeId);
        },
      };
      const audience = createHubAudience({ sessions, logger });
      machine.audience = audience;
      serveServerEnd(serverEnd, {
        sessions,
        audience,
        terminals: createFakeTerminals().terminals,
        machineLoad: createFakeMachineLoadReader(),
        identity: { serverId: serverIdSchema.parse('server-laptop'), token: 'tok-laptop.example' },
        stores: [{ storeId: WORK, path: '/Users/robert/code' }],
        providers: [readyProvider()],
        logger,
      });
      return { ok: true, socket: hubEnd };
    },
  };
}

interface Fleet {
  readonly hub: Hub;
  /** Re-opens a hub over the same database file: the restart, without the wipe. */
  restart: () => Promise<Hub>;
  readonly cleanup: () => Promise<void>;
}

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../../apps/hub/migrations', import.meta.url),
);

/**
 * One hub over an already-migrated database.
 *
 * Separated from the setup below so the restart test can run it twice over one
 * file. What the restart has to exercise is the real hub's own read-back at
 * boot, which is why this is `startHub` and not a re-wiring of its parts.
 */
async function openHub(database: SqliteDatabase): Promise<Hub> {
  let minted = 0;
  return startHub({
    database,
    logger,
    ids: { newId: () => `id-${(minted += 1)}` },
    clock,
    clientToken: CLIENT_TOKEN,
    tokens: { newToken: () => 'unused' },
    dialer: dialer(),
    discovery: createFakeBeaconSource(),
    // Real timers, unlike every other suite here: this one is about what a
    // client is *sent*, and the broadcast's flush is scheduled rather than
    // immediate. A fake schedule nobody advances would leave every state after
    // the first hello unsent, which would make this suite pass on a hub that
    // never published anything.
    timers: systemTimers,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    migrationFileSystem: nodeMigrationFileSystem,
    webAssets: createFakeWebAssets(),
    host: HOST,
    port: 0,
    localServer: null,
    files: createFakeStoreFiles(),
  });
}

async function startFleetHub(): Promise<Fleet> {
  const directory = await mkdtemp(join(tmpdir(), 'agentplex-attention-'));
  const database = createSqliteDatabase(join(directory, 'hub.db'));
  await migrate(
    database,
    await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem),
    logger,
    clock,
  );
  await registerServer(
    database,
    { newId: () => 'registration-laptop' },
    clock,
    newServerRegistrationSchema.parse({
      label: 'laptop',
      address: 'wss://laptop.example:8443',
      token: 'tok-laptop.example',
    }),
  );

  let hub = await openHub(database);
  return {
    get hub(): Hub {
      return hub;
    },
    async restart(): Promise<Hub> {
      await hub.stop();
      hub = await openHub(database);
      return hub;
    },
    cleanup: async () => {
      await hub.stop();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A client on a linked socket pair: the ticket exchange has its own suite. */
interface Client {
  /** Sends one frame and waits for the hub's answer to it, whatever it is. */
  ask(frame: Record<string, unknown>): Promise<HubFrame>;
  /** The newest machine state this client has been sent. */
  state(): MachineState | null;
}

async function openClient(hub: Hub): Promise<Client> {
  const { hubEnd, serverEnd } = createSocketPair();
  const received: string[] = [];
  const waiting: (() => void)[] = [];
  serverEnd.onMessage((text) => {
    received.push(text);
    for (const wake of waiting.splice(0)) wake();
  });
  hub.clients.attach(hubEnd);

  const read = (text: string): HubFrame => {
    const parsed = parseTextFrame(parseHubFrame, text);
    if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  };

  let nextId = 0;
  serverEnd.send(
    JSON.stringify({ type: 'hello', id: (nextId += 1), protocolVersion: PROTOCOL_VERSION }),
  );

  return {
    async ask(frame: Record<string, unknown>): Promise<HubFrame> {
      const id = (nextId += 1);
      serverEnd.send(JSON.stringify({ ...frame, id }));
      for (;;) {
        for (const text of received) {
          const answer = read(text);
          if ('replyTo' in answer && answer.replyTo === id) return answer;
        }
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },

    state(): MachineState | null {
      const states = received
        .map(read)
        .filter(
          (frame): frame is Extract<HubFrame, { type: 'machine-state' }> =>
            frame.type === 'machine-state',
        );
      return states.at(-1)?.state ?? null;
    },
  };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The prompted session's row, as the newest state this client holds describes it. */
function rowOf(client: Client, sessionId: string = PROMPTED): SessionRow {
  const state = client.state();
  const row = state?.stores
    .find((store) => store.storeId === WORK)
    ?.sessions.find((session) => session.descriptor.sessionId === sessionId);
  if (row === undefined) throw new Error(`no published row for ${sessionId}`);
  return row;
}

/** Whether the row's acknowledgement still holds: the whole rule, in one line. */
function acknowledged(row: SessionRow): boolean {
  return row.acknowledgedAt !== null && row.acknowledgedAt >= row.descriptor.updatedAt;
}

let fleet: Fleet | null = null;

async function start(): Promise<{ hub: Hub; client: Client }> {
  const started = await startFleetHub();
  fleet = started;
  const client = await openClient(started.hub);
  await until(() => {
    try {
      return rowOf(client).descriptor.status === 'awaiting-permission';
    } catch {
      return false;
    }
  }, 'the prompted session to reach the client');
  return { hub: started.hub, client };
}

describe('an acknowledgement, over a hub and a server', () => {
  afterEach(async () => {
    await fleet?.cleanup();
    fleet = null;
    machine.audience = null;
    now = START;
    machine.controller.setReport({
      storeId: WORK,
      sessions: [descriptor(PROMPTED, 'awaiting-permission', START - 5 * MINUTE)],
      holding: [],
    });
  });

  // Set before the first dial as well as after each test: the report is what
  // the server scans, and the hub dials as soon as it starts.
  machine.controller.setReport({
    storeId: WORK,
    sessions: [descriptor(PROMPTED, 'awaiting-permission', START - 5 * MINUTE)],
    holding: [],
  });

  it('holds while the session has said nothing since, and is spent when it speaks again', async () => {
    const { client } = await start();
    expect(acknowledged(rowOf(client))).toBe(false);

    const answer = await client.ask({
      type: 'session-acknowledge',
      storeId: WORK,
      sessionId: PROMPTED,
    });
    expect(answer).toMatchObject({ type: 'session-attention', acknowledgedAt: START });

    await until(() => rowOf(client).acknowledgedAt !== null, 'the acknowledgement to be published');
    const seen = rowOf(client);
    expect(acknowledged(seen)).toBe(true);
    // The fact itself is untouched: the session still says it wants a human,
    // and the row is still there. An acknowledgement quiets the alert.
    expect(seen.descriptor.status).toBe('awaiting-permission');

    // The second prompt. The agent ran on and stopped again, which the
    // provider records as a later write, and the scan that follows reports it.
    machine.controller.setReport({
      storeId: WORK,
      sessions: [descriptor(PROMPTED, 'awaiting-permission', START + MINUTE)],
      holding: [],
    });
    await machine.audience?.reportToAll(WORK);
    await until(
      () => rowOf(client).descriptor.updatedAt === START + MINUTE,
      'the second prompt to reach the client',
    );

    const again = rowOf(client);
    // Still stamped, and no longer an acknowledgement of anything: this is the
    // line a boolean could not have drawn.
    expect(again.acknowledgedAt).toBe(START);
    expect(acknowledged(again)).toBe(false);
  });

  it('is not spent by a scan that says what the last one said', async () => {
    const { client } = await start();
    await client.ask({ type: 'session-acknowledge', storeId: WORK, sessionId: PROMPTED });
    await until(() => rowOf(client).acknowledgedAt !== null, 'the acknowledgement to be published');

    // Servers scan on a schedule. A store nobody touched between two scans
    // reports the same descriptor, and an acknowledgement that expired on the
    // timetable rather than on the session speaking would be no better than a
    // badge that comes back by itself.
    await machine.audience?.reportToAll(WORK);
    await machine.audience?.reportToAll(WORK);
    expect(acknowledged(rowOf(client))).toBe(true);
  });

  it('keeps a muted session on the row, saying exactly what it said before', async () => {
    const { client } = await start();
    const answer = await client.ask({
      type: 'session-mute',
      storeId: WORK,
      sessionId: PROMPTED,
      muted: true,
    });
    expect(answer).toMatchObject({ type: 'session-attention', mutedAt: START });

    await until(() => rowOf(client).mutedAt !== null, 'the mute to be published');
    const muted = rowOf(client);
    // Mute silences the alert, never the fact. Everything a person could act
    // on is still on the row; what a client does with `mutedAt` is dim it.
    expect(muted.descriptor.status).toBe('awaiting-permission');
    expect(muted.reachable).toBe(true);
    expect(muted.mutedAt).toBe(START);
    expect(muted.acknowledgedAt).toBeNull();
  });

  it('survives a restart, because a hub that forgot a mute would start nagging again', async () => {
    const { client } = await start();
    await client.ask({ type: 'session-mute', storeId: WORK, sessionId: PROMPTED, muted: true });
    await until(() => rowOf(client).mutedAt !== null, 'the mute to be published');
    expect(acknowledged(rowOf(client))).toBe(false);

    // The same database file, a new hub over it, a new dial, a new scan. The
    // mute is the one thing on the row that nothing on any machine could put
    // back.
    const started = fleet;
    if (started === null) throw new Error('no fleet');
    const after = await openClient(await started.restart());
    await until(() => {
      try {
        return rowOf(after).mutedAt !== null;
      } catch {
        return false;
      }
    }, 'the mute to come back with the row');
    expect(rowOf(after).descriptor.status).toBe('awaiting-permission');
  });

  it('refuses a session this hub has never heard of, as a reply and not a closed socket', async () => {
    const { client } = await start();
    const answer = await client.ask({
      type: 'session-acknowledge',
      storeId: WORK,
      sessionId: 'session-nobody-has',
    });
    expect(answer).toMatchObject({ type: 'refusal', code: 'refused' });

    // Still talking, and still able to acknowledge the session it can see.
    const second = await client.ask({
      type: 'session-acknowledge',
      storeId: WORK,
      sessionId: PROMPTED,
    });
    expect(second.type).toBe('session-attention');
  });
});
