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
  type Layout,
  type MachineState,
  type SessionDescriptor,
  type SessionRow,
  type StoreId,
} from '@agentplex/protocol';
import {
  createLogger,
  type DialResult,
  type MessageSocket,
  type SocketDialer,
} from '@agentplex/node-shared';
import {
  createSocketPair,
  createFakeTimers,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import { createFakeStoreFiles, readyProvider } from '@agentplex/providers/testing';
import {
  createFakeSessionController,
  type FakeSessionController,
} from '../../../apps/server/src/sessions/fake-session-controller.js';
import { createFakeTerminals } from '../../../apps/server/src/terminal/fake-terminals.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/machine-load/fake-machine-probe.js';
import { createHubAudience, type HubAudience } from '../../../apps/server/src/hub/hub-audience.js';
import { serveServerEnd } from './server-end.js';
import { createFakeBeaconSource } from '../../../apps/hub/src/discovery/fake-discovery.js';
import { createFakeWebAssets } from '../../../apps/hub/src/web/fake-web.js';
import { createSqliteDatabase } from '../../../apps/hub/src/db/sqlite.js';
import { loadMigrations } from '../../../apps/hub/src/db/migration-files.js';
import { migrate } from '../../../apps/hub/src/db/migrations.js';
import { nodeMigrationFileSystem } from '../../../apps/hub/src/db/node-migration-files.js';
import { registerServer } from '../../../apps/hub/src/pairing/server-registrations.js';
import { newServerRegistrationSchema } from '../../../apps/hub/src/pairing/pairing.js';
import { startHub, type Hub } from '../../../apps/hub/src/hub.js';

/**
 * The tree a client is actually answered with, over a fleet that reports.
 *
 * Before AGX-90 nothing called discovery or the prune, so a live hub answered
 * every `layout-request` with an empty tree however many sessions were on the
 * machines -- and answered it confidently, which is the over-claim rather than
 * the gap. The suite drives the whole path the wiring joined: two servers scan,
 * their reports travel the real protocol, the reducer merges them, the
 * catalogue follows what it merged, and a client asks for the layout and is
 * told what is there.
 *
 * The prune's half is the same path run twice. A store that reports again
 * without a session it used to have is evidence that the session is gone, and
 * its node goes; a store nobody reached is not, and its nodes stay. The second
 * is the case worth having an integration test for, because the cost of
 * getting it wrong is a user's arrangement dismantling itself while a laptop
 * is shut.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };
const CLIENT_TOKEN = 'the-client-token-typed-on-the-device';
const HOST = '127.0.0.1';

const AGENTPLEX = storeIdSchema.parse('store-agentplex');
const UNIVERSE = storeIdSchema.parse('store-universe');

function descriptor(storeId: StoreId, sessionId: string, title: string | null): SessionDescriptor {
  return {
    storeId,
    sessionId: sessionIdSchema.parse(sessionId),
    provider: 'claude',
    status: 'idle',
    updatedAt: START,
    cwd: null,
    branch: null,
    title,
    uncommitted: null,
  };
}

/** One machine in the fleet, and the handle a test drives its next scan with. */
interface Machine {
  readonly label: string;
  readonly host: string;
  readonly serverId: string;
  readonly storeId: StoreId;
  readonly path: string;
  readonly controller: FakeSessionController;
  /** The connected hubs, once one has dialled. What `reportToAll` is called on. */
  audience: HubAudience | null;
  socket: MessageSocket | null;
}

function machine(
  label: string,
  serverId: string,
  storeId: StoreId,
  path: string,
  sessions: readonly SessionDescriptor[],
): Machine {
  return {
    label,
    host: `${label}.example`,
    serverId,
    storeId,
    path,
    controller: createFakeSessionController({ reports: [{ storeId, sessions, holding: [] }] }),
    audience: null,
    socket: null,
  };
}

function fleetDialer(machines: readonly Machine[]): SocketDialer {
  return {
    dial: async (address: string): Promise<DialResult> => {
      const host = new URL(address).hostname;
      const found = machines.find((candidate) => candidate.host === host);
      if (found === undefined) return { ok: false, problem: 'connection refused' };

      const { hubEnd, serverEnd } = createSocketPair();
      // A real scan reads a disk and takes event-loop turns; a fake that
      // resolved in the same microtask as the handshake would race its report
      // past the hub attaching its listener, an ordering no real store scan
      // can produce.
      const sessions = {
        ...found.controller,
        report: async (storeId: StoreId) => {
          await new Promise((resolve) => setImmediate(resolve));
          return found.controller.report(storeId);
        },
      };
      // The server's own audience, held by the test: `reportToAll` is how a
      // machine tells every connected hub that what is in a store changed, and
      // a second scan is exactly what this suite needs to drive.
      const audience = createHubAudience({ sessions, logger });
      found.audience = audience;
      serveServerEnd(serverEnd, {
        sessions,
        audience,
        terminals: createFakeTerminals().terminals,
        machineLoad: createFakeMachineLoadReader(),
        identity: { serverId: serverIdSchema.parse(found.serverId), token: `tok-${host}` },
        stores: [{ storeId: found.storeId, path: found.path }],
        providers: [readyProvider()],
        logger,
      });
      found.socket = serverEnd;
      return { ok: true, socket: hubEnd };
    },
  };
}

interface Fleet {
  readonly hub: Hub;
  /**
   * The deadline the broadcast coalesces on, held so a test can fire it.
   *
   * A state is not sent the instant one changes -- see `clients.ts` -- so a
   * suite that waited for a frame without firing this would be waiting for a
   * timer nobody wound. Firing it is what standing in for the passage of a few
   * milliseconds looks like here.
   */
  readonly timers: FakeTimers;
  readonly cleanup: () => Promise<void>;
}

async function startFleetHub(machines: readonly Machine[]): Promise<Fleet> {
  const directory = await mkdtemp(join(tmpdir(), 'agentplex-catalogue-'));
  const database = createSqliteDatabase(join(directory, 'hub.db'));
  const migrationsDirectory = fileURLToPath(
    new URL('../../../apps/hub/migrations', import.meta.url),
  );
  await migrate(
    database,
    await loadMigrations(migrationsDirectory, nodeMigrationFileSystem),
    logger,
    clock,
  );
  for (const found of machines) {
    await registerServer(
      database,
      { newId: () => `registration-${found.label}` },
      clock,
      newServerRegistrationSchema.parse({
        label: found.label,
        address: `wss://${found.host}:8443`,
        token: `tok-${found.host}`,
      }),
    );
  }

  // Counted, so a node id names the order it was minted in. The hub's own
  // identity takes the first; every one after it is a node.
  let minted = 0;
  const timers = createFakeTimers();
  const hub = await startHub({
    database,
    logger,
    ids: { newId: () => `id-${(minted += 1)}` },
    clock,
    clientToken: CLIENT_TOKEN,
    tokens: { newToken: () => 'unused' },
    dialer: fleetDialer(machines),
    discovery: createFakeBeaconSource(),
    timers,
    migrationsDirectory,
    migrationFileSystem: nodeMigrationFileSystem,
    webAssets: createFakeWebAssets(),
    host: HOST,
    port: 0,
    localServer: null,
    // No push: this suite is not about it, and the two seams it needs are a
    // cryptographic mint and a POST to somebody else's service.
    push: null,
    files: createFakeStoreFiles(),
  });

  return {
    hub,
    timers,
    cleanup: async () => {
      await hub.stop();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * A client on a linked socket pair rather than over the port.
 *
 * The ticket exchange and the websocket upgrade have their own suites, and
 * `clients.attach` takes a socket that has already passed both. What this
 * suite is about starts after that: a `layout-request` and what comes back.
 */
interface Client {
  layout(): Promise<Layout>;
  /** Sends one frame and waits for the hub's answer to it, whatever it is. */
  ask(frame: Record<string, unknown>): Promise<HubFrame>;
  /**
   * The first state this client was sent that holds this, or `null` so far.
   *
   * A predicate and not "the latest", because a state is broadcast whenever
   * anything in the fleet moves and what a test about the tree waits for is a
   * particular one of them. Nothing is asked for: this is the unsolicited half
   * of the protocol, which is how a client learns that a row changed.
   */
  stateWith(holds: (state: MachineState) => boolean): MachineState | null;
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

  let nextId = 0;
  const frameFor = async (replyTo: number): Promise<Layout> => {
    for (;;) {
      for (const text of received) {
        const parsed = parseTextFrame(parseHubFrame, text);
        if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
        if (parsed.value.type !== 'layout') continue;
        if (parsed.value.replyTo !== replyTo) continue;
        return parsed.value.nodes;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };

  serverEnd.send(
    JSON.stringify({ type: 'hello', id: (nextId += 1), protocolVersion: PROTOCOL_VERSION }),
  );

  /** The first frame that answers this id, whatever kind of answer it is. */
  const answerFor = async (replyTo: number): Promise<HubFrame> => {
    for (;;) {
      for (const text of received) {
        const parsed = parseTextFrame(parseHubFrame, text);
        if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
        const frame = parsed.value;
        if (!('replyTo' in frame) || frame.replyTo !== replyTo) continue;
        return frame;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };

  return {
    async layout(): Promise<Layout> {
      const id = (nextId += 1);
      serverEnd.send(JSON.stringify({ type: 'layout-request', id }));
      return frameFor(id);
    },

    stateWith(holds: (state: MachineState) => boolean): MachineState | null {
      for (const text of received) {
        const parsed = parseTextFrame(parseHubFrame, text);
        if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
        if (parsed.value.type !== 'machine-state') continue;
        if (holds(parsed.value.state)) return parsed.value.state;
      }
      return null;
    },

    async ask(frame: Record<string, unknown>): Promise<HubFrame> {
      const id = (nextId += 1);
      serverEnd.send(JSON.stringify({ ...frame, id }));
      return answerFor(id);
    },
  };
}

/** What one node points at, as one string, for a test that is about which sessions are in the tree. */
function anchor(node: Layout[number]): string {
  return `${String(node.anchor?.storeId)}/${String(node.anchor?.sessionId)}`;
}

/**
 * What the tree anchors, sorted.
 *
 * Sorted rather than in tree order, and that is a fact about the subject rather
 * than a convenience: two servers scan independently, so which store's report
 * reaches the hub first decides which sessions take the low root positions.
 * Asserting the order would be asserting a race.
 */
function anchored(layout: Layout): readonly string[] {
  return layout.map(anchor).sort();
}

async function until(predicate: () => Promise<boolean>, what: () => string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what()}`);
}

/** Waits for the tree to hold exactly this, so a pass that has not run yet is not read as a failure. */
async function settles(client: Client, expected: readonly string[]): Promise<Layout> {
  const wanted = [...expected].sort();
  let last: Layout = [];
  await until(
    async () => {
      last = await client.layout();
      return anchored(last).join() === wanted.join();
    },
    () => `the tree to hold ${wanted.join(', ')}; it holds ${anchored(last).join(', ')}`,
  );
  return last;
}

let fleet: Fleet | null = null;

afterEach(async () => {
  await fleet?.cleanup();
  fleet = null;
});

describe('the tree a reporting fleet fills in', () => {
  it('answers a layout request with one node per session the fleet reported', async () => {
    const laptop = machine('mbp-robert', 'server-mbp', AGENTPLEX, '/Users/robert/code/agentplex', [
      descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh'),
      descriptor(AGENTPLEX, 'session-spike-wasm', 'spike-wasm'),
    ]);
    const box = machine('gpu-box-01', 'server-gpu', UNIVERSE, '/mnt/volumes/universe', [
      descriptor(UNIVERSE, 'session-bench-tokenizer', null),
    ]);
    fleet = await startFleetHub([laptop, box]);
    const client = await openClient(fleet.hub);

    const layout = await settles(client, [
      'store-agentplex/session-fix-auth',
      'store-agentplex/session-spike-wasm',
      'store-universe/session-bench-tokenizer',
    ]);

    // Named by the transcript title, and nothing invented for the one whose
    // provider records none: null is what a client draws its own answer from.
    const byAnchor = new Map(layout.map((node) => [anchor(node), node]));
    expect(byAnchor.get('store-agentplex/session-fix-auth')?.name).toBe('fix-auth-refresh');
    expect(byAnchor.get('store-agentplex/session-spike-wasm')?.name).toBe('spike-wasm');
    expect(byAnchor.get('store-universe/session-bench-tokenizer')?.name).toBeNull();
    // Every one of them at the root, of the session kind, and none of them
    // named by a user: discovery places, and that is all it does.
    expect(layout.every((node) => node.kind === 'session')).toBe(true);
    expect(layout.every((node) => node.parentId === null)).toBe(true);
    expect(layout.every((node) => !node.named)).toBe(true);
  });

  it('prunes the node of a session a later report of that store no longer has', async () => {
    const laptop = machine('mbp-robert', 'server-mbp', AGENTPLEX, '/Users/robert/code/agentplex', [
      descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh'),
      descriptor(AGENTPLEX, 'session-spike-wasm', 'spike-wasm'),
    ]);
    const box = machine('gpu-box-01', 'server-gpu', UNIVERSE, '/mnt/volumes/universe', [
      descriptor(UNIVERSE, 'session-bench-tokenizer', null),
    ]);
    fleet = await startFleetHub([laptop, box]);
    const client = await openClient(fleet.hub);
    await settles(client, [
      'store-agentplex/session-fix-auth',
      'store-agentplex/session-spike-wasm',
      'store-universe/session-bench-tokenizer',
    ]);

    // The transcript was deleted. The machine scans again and says so, which is
    // evidence rather than absence: this store was reached and that session is
    // not in it.
    laptop.controller.setReport({
      storeId: AGENTPLEX,
      sessions: [descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh')],
      holding: [],
    });
    await laptop.audience?.reportToAll(AGENTPLEX);

    // The other store was not in that reading and keeps everything it had.
    await settles(client, [
      'store-agentplex/session-fix-auth',
      'store-universe/session-bench-tokenizer',
    ]);
  });

  it('keeps the nodes of a store nobody could reach', async () => {
    const laptop = machine('mbp-robert', 'server-mbp', AGENTPLEX, '/Users/robert/code/agentplex', [
      descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh'),
    ]);
    const box = machine('gpu-box-01', 'server-gpu', UNIVERSE, '/mnt/volumes/universe', [
      descriptor(UNIVERSE, 'session-bench-tokenizer', null),
    ]);
    fleet = await startFleetHub([laptop, box]);
    const client = await openClient(fleet.hub);
    await settles(client, [
      'store-agentplex/session-fix-auth',
      'store-universe/session-bench-tokenizer',
    ]);

    // The machine goes away without saying so. Nothing reached its store, so
    // nothing is evidence about what is in it, and the sweep is never run for
    // it. The laptop reporting again must not take the absent machine's node
    // with it.
    box.socket?.close({ code: 1006, reason: 'the machine went away' });
    await until(
      async () =>
        fleet?.hub.connections
          .snapshot()
          .some((report) => report.label === 'gpu-box-01' && report.phase === 'stale') === true,
      () => 'the gpu box to go stale',
    );
    await laptop.audience?.reportToAll(AGENTPLEX);

    await settles(client, [
      'store-agentplex/session-fix-auth',
      'store-universe/session-bench-tokenizer',
    ]);
  });
});

/**
 * Removing a node, over the fleet that reports the sessions it points at.
 *
 * The two things worth driving end to end are the two the tree cannot decide on
 * its own. A live holder is a fact about a process on another machine, and it
 * arrives here the only way it ever does -- in a store report, over the real
 * protocol, merged by the reducer -- so a suite that stubbed it would be
 * asserting that the hub reads its own fake. And a remembered removal is only
 * worth anything against a store that keeps on reporting the session: the test
 * that matters is the second report, and the one after the forgetting.
 */
describe('taking a session out of the tree', () => {
  it('refuses while a machine says it is running it, and names the machine', async () => {
    const laptop = machine('mbp-robert', 'server-mbp', AGENTPLEX, '/Users/robert/code/agentplex', [
      descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh'),
    ]);
    laptop.controller.setReport({
      storeId: AGENTPLEX,
      sessions: [descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh')],
      holding: [
        { sessionId: sessionIdSchema.parse('session-fix-auth'), stoppable: true, pause: 'none' },
      ],
    });
    fleet = await startFleetHub([laptop]);
    const client = await openClient(fleet.hub);
    const layout = await settles(client, ['store-agentplex/session-fix-auth']);
    const node = layout[0];
    if (node === undefined) throw new Error('the session was not placed');

    const answer = await client.ask({ type: 'node-remove', nodeId: node.id });

    expect(answer).toMatchObject({
      type: 'refusal',
      code: 'refused',
      // The hold came off this machine's own account of what it is running,
      // which is the only source that can answer it -- and the client is given
      // it so it can offer the stop rather than only the sentence.
      holder: { server: 'registration-mbp-robert', stoppable: true, pause: 'none' },
    });
    expect(await client.layout()).toHaveLength(1);

    // The agent finished. Nobody holds it now, and the same removal goes
    // through -- the refusal was about the world and not about the node.
    laptop.controller.setReport({
      storeId: AGENTPLEX,
      sessions: [descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh')],
      holding: [],
    });
    await laptop.audience?.reportToAll(AGENTPLEX);
    await until(
      async () =>
        fleet?.hub.state
          .snapshot()
          .stores.every((store) => store.sessions.every((row) => row.holder === null)) === true,
      () => 'the hold to be released',
    );

    expect(await client.ask({ type: 'node-remove', nodeId: node.id })).toMatchObject({
      type: 'node-removed',
    });
    await settles(client, []);
  });

  it('stays removed across the reports that follow, and comes back when forgotten', async () => {
    const laptop = machine('mbp-robert', 'server-mbp', AGENTPLEX, '/Users/robert/code/agentplex', [
      descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh'),
      descriptor(AGENTPLEX, 'session-spike-wasm', 'spike-wasm'),
    ]);
    fleet = await startFleetHub([laptop]);
    const client = await openClient(fleet.hub);
    const layout = await settles(client, [
      'store-agentplex/session-fix-auth',
      'store-agentplex/session-spike-wasm',
    ]);
    const node = layout.find((candidate) => candidate.anchor?.sessionId === 'session-fix-auth');
    if (node === undefined) throw new Error('the session was not placed');

    expect(await client.ask({ type: 'node-remove', nodeId: node.id })).toMatchObject({
      type: 'node-removed',
    });
    await settles(client, ['store-agentplex/session-spike-wasm']);

    // The whole point of remembering. The store still has the transcript --
    // nothing was deleted on any disk -- so every report from here on carries
    // the session, and every one of them would otherwise put the node back a
    // few seconds after the user removed it.
    await laptop.audience?.reportToAll(AGENTPLEX);
    await laptop.audience?.reportToAll(AGENTPLEX);
    expect(anchored(await client.layout())).toEqual(['store-agentplex/session-spike-wasm']);

    const forgotten = await client.ask({
      type: 'node-forget-removal',
      storeId: AGENTPLEX,
      sessionId: 'session-fix-auth',
    });

    expect(forgotten).toMatchObject({ type: 'node-removal-forgotten' });
    // Back already, rather than at whatever moment that machine next scans: the
    // hub runs a pass against what it currently believes is in the store on the
    // way to answering.
    expect(anchored(await client.layout())).toEqual([
      'store-agentplex/session-fix-auth',
      'store-agentplex/session-spike-wasm',
    ]);
  });
});

/**
 * The catalogue query over a fleet that reports, paged and grouped by server.
 *
 * The one thing this suite can say that `query.test` cannot: that the grouping
 * is over readings that arrived the only way a reading ever does -- a store
 * scan, over the real protocol, merged by the reducer -- and that the server
 * label on a heading is the label of the pairing this hub actually holds. A
 * unit test hands the query a machine state it wrote itself, which is exactly
 * the shape a hub might never produce.
 *
 * The paging half is here for the same reason the prune's is: what it costs to
 * get wrong is a client that pages forever or silently skips somebody's work,
 * and that only shows up against a hub whose version moves under the cursor.
 */
describe('paging the catalogue of a reporting fleet', () => {
  /** One page, or the refusal that came instead. */
  async function pageOf(client: Client, query: Record<string, unknown>): Promise<HubFrame> {
    return client.ask({
      type: 'catalogue-query',
      view: 'list',
      groupBy: 'server',
      sort: { key: 'name', direction: 'asc' },
      filter: {},
      cursor: null,
      limit: 10,
      ...query,
    });
  }

  it('answers one page per server heading, and walks the rest through the cursor', async () => {
    const laptop = machine('mbp-robert', 'server-mbp', AGENTPLEX, '/Users/robert/code/agentplex', [
      descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh'),
      descriptor(AGENTPLEX, 'session-spike-wasm', 'spike-wasm'),
    ]);
    const box = machine('gpu-box-01', 'server-gpu', UNIVERSE, '/mnt/volumes/universe', [
      descriptor(UNIVERSE, 'session-bench-tokenizer', 'bench-tokenizer'),
    ]);
    fleet = await startFleetHub([laptop, box]);
    const client = await openClient(fleet.hub);
    await settles(client, [
      'store-agentplex/session-fix-auth',
      'store-agentplex/session-spike-wasm',
      'store-universe/session-bench-tokenizer',
    ]);

    const first = await pageOf(client, { limit: 2 });
    if (first.type !== 'catalogue-page') throw new Error(`the query was answered ${first.type}`);

    // The count is over the whole answer and not over the page, which is what
    // lets a client say "2 of 3" rather than "2 so far".
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    // gpu-box-01 sorts before mbp-robert, and the heading on every item is the
    // label of the pairing this hub holds rather than anything a server said
    // about itself.
    expect(first.items.map((item) => item.group?.label)).toEqual(['gpu-box-01', 'mbp-robert']);
    expect(first.items.every((item) => item.group?.unfiled === false)).toBe(true);
    // The session row is on the item, whole, so the client joins nothing: the
    // heading and the row it heads agree because they are the same reading.
    for (const item of first.items) {
      expect(item.session?.source).toBe(item.group?.key);
    }

    const second = await pageOf(client, { limit: 2, cursor: first.nextCursor });
    if (second.type !== 'catalogue-page') throw new Error(`the query was answered ${second.type}`);

    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((item) => item.anchor?.sessionId).sort()).toEqual([
      'session-bench-tokenizer',
      'session-fix-auth',
      'session-spike-wasm',
    ]);
  });

  it('refuses a cursor from before the tree changed, and says it is stale', async () => {
    const laptop = machine('mbp-robert', 'server-mbp', AGENTPLEX, '/Users/robert/code/agentplex', [
      descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh'),
      descriptor(AGENTPLEX, 'session-spike-wasm', 'spike-wasm'),
    ]);
    fleet = await startFleetHub([laptop]);
    const client = await openClient(fleet.hub);
    await settles(client, [
      'store-agentplex/session-fix-auth',
      'store-agentplex/session-spike-wasm',
    ]);

    const first = await pageOf(client, { limit: 1 });
    if (first.type !== 'catalogue-page') throw new Error(`the query was answered ${first.type}`);
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('the first page ended the answer');

    // Anything that moves the tree will do; a folder is the cheapest. The
    // client has already been told the version moved -- `catalogue-changed`
    // reached this socket -- so what it does about the refusal is ask for the
    // first page again.
    expect(
      await client.ask({ type: 'node-create-folder', parentId: null, name: 'later' }),
    ).toMatchObject({ type: 'node-created' });

    const refused = await pageOf(client, { limit: 1, cursor });

    expect(refused).toMatchObject({ type: 'refusal', code: 'bad-request' });
    if (refused.type !== 'refusal') throw new Error('the stale cursor was not refused');
    expect(refused.message).toContain('stale');

    // And the first page still answers, at the version the tree is now at.
    const again = await pageOf(client, { limit: 1 });
    if (again.type !== 'catalogue-page') throw new Error(`the query was answered ${again.type}`);
    expect(again.version).toBeGreaterThan(first.version);
    expect(again.total).toBe(2);
  });
});

/**
 * The tree's answer to which project a session is in, on the row a client is
 * sent.
 *
 * Both halves of that sentence are why this is an integration test. The
 * association is the tree's and lives in this feature; the row is the fleet
 * state's and cannot import it. What joins them is a reading the hub takes
 * after every change and hands to the reducer, unawaited on both of its call
 * sites -- so the thing worth driving end to end is that a client is actually
 * told, over the real protocol, without anybody asking for it.
 */
describe('the project a session row carries', () => {
  it('names the project once the session is filed under one, and nothing for one that is not', async () => {
    const laptop = machine('mbp-robert', 'server-mbp', AGENTPLEX, '/Users/robert/code/agentplex', [
      descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh'),
      descriptor(AGENTPLEX, 'session-spike-wasm', 'spike-wasm'),
    ]);
    fleet = await startFleetHub([laptop]);
    const client = await openClient(fleet.hub);
    const layout = await settles(client, [
      'store-agentplex/session-fix-auth',
      'store-agentplex/session-spike-wasm',
    ]);
    const node = layout.find((candidate) => candidate.anchor?.sessionId === 'session-fix-auth');
    if (node === undefined) throw new Error('the session was not placed');

    // Nothing is filed yet: discovery placed both at the root, and a row in no
    // project says so rather than saying nothing.
    const before = await broadcast(
      client,
      (state) => rowIn(state, 'session-fix-auth') !== undefined,
      'a state holding the sessions that were reported',
    );
    expect(rowIn(before, 'session-fix-auth')?.project).toBeNull();

    const created = await client.ask({
      type: 'project-create',
      name: 'universe',
      directory: '/mnt/volumes/universe',
    });
    if (created.type !== 'project-created') {
      throw new Error(`the project create was answered ${created.type}`);
    }
    expect(
      await client.ask({
        type: 'node-move',
        nodeId: node.id,
        parentId: created.nodeId,
        position: 0,
      }),
    ).toMatchObject({ type: 'node-moved' });

    // Unasked for: the move changed the tree, the hub read where the tree now
    // puts each session, and the reducer published a state carrying it.
    const after = await broadcast(
      client,
      (state) => (rowIn(state, 'session-fix-auth')?.project ?? null) !== null,
      'a state carrying the project the session was moved into',
    );
    expect(rowIn(after, 'session-fix-auth')?.project).toEqual({
      nodeId: created.nodeId,
      name: 'universe',
    });
    // The other session was in that same reading and is in no project, which
    // is what the screens fall back to a store id for.
    expect(rowIn(after, 'session-spike-wasm')?.project).toBeNull();
  });
});

/**
 * The first state broadcast to this client that holds what the test is after.
 *
 * The deadline is fired on every attempt because the hub coalesces broadcasts
 * on it, and the reading this suite waits for is taken behind two promises
 * nobody awaits -- so what is being waited for is a frame rather than a call
 * returning, and it arrives a turn or two after the frame that provoked it.
 */
async function broadcast(
  client: Client,
  holds: (state: MachineState) => boolean,
  what: string,
): Promise<MachineState> {
  let found: MachineState | null = null;
  await until(
    async () => {
      fleet?.timers.fireAll();
      await new Promise((resolve) => setImmediate(resolve));
      found = client.stateWith(holds);
      return found !== null;
    },
    () => what,
  );
  if (found === null) throw new Error(`no state was sent holding ${what}`);
  return found;
}

/** One session's row in a state a client was sent, or `undefined`. */
function rowIn(state: MachineState, sessionId: string): SessionRow | undefined {
  return state.stores
    .flatMap((store) => store.sessions)
    .find((row) => row.descriptor.sessionId === sessionId);
}

/**
 * A flat search that can return a project, against a hub with a real schema.
 *
 * The one thing this suite can say that `query.test` cannot: which kinds are
 * containers is a fact the migrations wrote into `node_kinds`, not a set a test
 * scripted. A unit test hands the query its own four rows for that table and
 * would go on passing if a migration changed its mind about `project`; here the
 * project is one a client made through `project-create`, filed by the feature
 * that owns projects, and the reason it never came back from a flat search is
 * the seeded row that says it contains.
 */
describe('a flat catalogue search over the kinds a client names', () => {
  async function listing(client: Client, filter: Record<string, unknown>): Promise<HubFrame> {
    return client.ask({
      type: 'catalogue-query',
      view: 'list',
      groupBy: 'none',
      sort: { key: 'name', direction: 'asc' },
      filter,
      cursor: null,
      limit: 10,
    });
  }

  async function reportingHubWithAProject(): Promise<{ client: Client; projectId: string }> {
    const laptop = machine('mbp-robert', 'server-mbp', AGENTPLEX, '/Users/robert/code/agentplex', [
      descriptor(AGENTPLEX, 'session-fix-auth', 'fix-auth-refresh'),
    ]);
    fleet = await startFleetHub([laptop]);
    const client = await openClient(fleet.hub);
    await settles(client, ['store-agentplex/session-fix-auth']);

    const created = await client.ask({
      type: 'project-create',
      name: 'agentplex',
      directory: '/Users/robert/code/agentplex',
    });
    if (created.type !== 'project-created') {
      throw new Error(`the project was answered ${created.type}`);
    }
    return { client, projectId: created.nodeId };
  }

  it('answers a project to a search that names its kind, and none to one that does not', async () => {
    const { client, projectId } = await reportingHubWithAProject();

    const named = await listing(client, { search: 'agentplex', kinds: ['project'] });
    if (named.type !== 'catalogue-page') throw new Error(`the query was answered ${named.type}`);

    expect(named.items.map((item) => item.id)).toEqual([projectId]);
    expect(named.total).toBe(1);
    // A container has no reading behind it, so the name is the only field a
    // search can hit and the row says so rather than inventing a second one.
    expect(named.items[0]?.kind).toBe('project');
    expect(named.items[0]?.matched).toBe('name');
    expect(named.items[0]?.session).toBeNull();
    expect(named.items[0]?.anchor).toBeNull();

    // The same search with no kind named: the leaves-only rule stands, and the
    // project sitting right there is not among the answers. That is what the
    // sidebar catalogue panel goes on getting.
    const unnamed = await listing(client, { search: 'agentplex' });
    if (unnamed.type !== 'catalogue-page') {
      throw new Error(`the query was answered ${unnamed.type}`);
    }
    expect(unnamed.items).toEqual([]);
  });

  it('puts a project and a session in one flat order when both kinds are named', async () => {
    const { client, projectId } = await reportingHubWithAProject();

    const answered = await listing(client, { kinds: ['project', 'session'] });
    if (answered.type !== 'catalogue-page') {
      throw new Error(`the query was answered ${answered.type}`);
    }

    expect(answered.items.map((item) => [item.id, item.kind, item.displayName])).toEqual([
      [projectId, 'project', 'agentplex'],
      [answered.items[1]?.id, 'session', 'fix-auth-refresh'],
    ]);
    expect(answered.items[1]?.anchor?.sessionId).toBe('session-fix-auth');
  });

  it('answers nothing for a kind no migration has seeded, and refuses nothing', async () => {
    // What lets a palette ask for `graph` before the migration that seeds it:
    // an empty page rather than a refusal, so the kind can be asked for from
    // the day the client draws a heading for it.
    const { client } = await reportingHubWithAProject();

    const answered = await listing(client, { kinds: ['graph'] });
    if (answered.type !== 'catalogue-page') {
      throw new Error(`the query was answered ${answered.type}`);
    }

    expect(answered.items).toEqual([]);
    expect(answered.total).toBe(0);
  });
});
