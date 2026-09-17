import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { describe, it } from 'vitest';
import {
  formatServerBeacon,
  parseHubFrame,
  parseTextFrame,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  PROTOCOL_VERSION,
  type ProviderReadiness,
  type SessionDescriptor,
  type SessionHold,
  type StoreDescriptor,
} from '@agentplex/protocol';
import { createFakeSessionController } from '../../../apps/server/src/fake-session-controller.js';
import {
  createFakeStoreFiles,
  createFakeProviderAdapter,
  createFakeProviderFiles,
  missingProvider,
  readyProvider,
  unauthenticatedProvider,
  unknownProvider,
} from '@agentplex/providers/testing';
import { createProviderRegistry, type ProviderFiles } from '@agentplex/providers';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import {
  createTerminalManager,
  type TerminalManager,
} from '../../../apps/server/src/terminal-manager.js';
import { createSessionController } from '../../../apps/server/src/session-control.js';
import { createFakeWorkingTree } from '../../../apps/server/src/fake-working-tree.js';
import {
  createFakeBeaconSource,
  type FakeBeaconSource,
} from '../../../apps/hub/src/features/discovery/fake-discovery.js';
import { createFakeWebAssets } from '../../../apps/hub/src/features/web/fake-web.js';
import { serveServerEnd } from './server-end.js';
import type { HubConnection } from '../../../apps/server/src/hub-connection.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/fake-directory-reader.js';
import { createFakeTerminals } from '../../../apps/server/src/fake-terminals.js';
import type {
  SessionController,
  SessionOutcome,
  StoreReport,
} from '../../../apps/server/src/session-control.js';
import {
  createUnreachableDialer,
  createSocketPair,
  createFakeTimers,
} from '@agentplex/node-shared/testing';
import {
  createLogger,
  type DialResult,
  type MessageSocket,
  type SocketDialer,
} from '@agentplex/node-shared';
import { createFakeDatabase } from '../../../apps/hub/src/db/fake-database.js';
import {
  loadMigrations,
  type MigrationFileSystem,
} from '../../../apps/hub/src/db/migration-files.js';
import { migrate } from '../../../apps/hub/src/db/migrations.js';
import { nodeMigrationFileSystem } from '../../../apps/hub/src/db/node-migration-files.js';
import { createSqliteDatabase } from '../../../apps/hub/src/db/sqlite.js';
import { registerServer } from '../../../apps/hub/src/features/pairing/server-registrations.js';
import { newServerRegistrationSchema } from '../../../apps/hub/src/features/pairing/pairing.js';
import { startHub, type Hub } from '../../../apps/hub/src/hub.js';
import {
  CLIENT_SOCKET_PATH,
  CLIENT_TICKET_PATH,
} from '../../../apps/hub/src/features/client-auth/client-auth.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';

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
 * commit that bumps PROTOCOL_VERSION -- run, from tests/hub-server:
 *
 *   CAPTURE_FIXTURES=1 pnpm vitest run src/capture-client-fixtures.test.ts
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
    if (frame.code === 'protocol-version') return 'refusalProtocolVersion';
    // A refusal that names a holder is a different answer from "no", and the
    // two kinds of holder are different again: one leads somewhere -- stop the
    // machine it names -- and one is the reason there is nowhere to lead. A
    // client draws all three, so all three are captured apart.
    if (frame.holder !== null) {
      return frame.holder.stoppable ? 'refusalHeldStoppable' : 'refusalHeldBusy';
    }
    return 'refusal';
  }
  if (frame.type === 'machine-state') {
    // Labelled by what the state holds, so the web tests get a captured state
    // with a paired server in it as well as the empty one.
    if (frame.state.candidates.length > 0) return 'machineStateDiscovered';
    return frame.state.servers.length > 0 ? 'machineStateWithServer' : 'machineState';
  }
  if (frame.type === 'session-attention') {
    // Labelled by what the row now says rather than by which frame asked, for
    // the reason everything here is: the reply is one shape for two questions,
    // and what a client has to be able to read is the answer.
    if (frame.mutedAt !== null) return 'sessionMuted';
    if (frame.acknowledgedThrough !== null) return 'sessionAcknowledged';
    return 'sessionUnmuted';
  }
  if (frame.type === 'pane-layout') {
    return frame.layout === null ? 'paneLayoutEmpty' : 'paneLayout';
  }
  if (frame.type === 'catalogue-page') {
    // Labelled by whether the answer ended, because those are the two shapes a
    // paging client has to handle: a page that is the whole answer, and one
    // with a cursor on it that the store has to ask again with.
    //
    // And by which view answered, read off the frame rather than off what was
    // asked for: the tree view is the only one that carries containers, since
    // the list view drops them, which is what flat means. The web draws two
    // screens out of this one frame and has to be tested against both.
    const containers = frame.items.some(
      (entry) => entry.kind === 'folder' || entry.kind === 'project',
    );
    if (containers) {
      return frame.nextCursor === null ? 'catalogueTreePage' : 'catalogueTreePagePartial';
    }
    return frame.nextCursor === null ? 'cataloguePage' : 'cataloguePagePartial';
  }
  if (frame.type === 'directory-listing') {
    // Labelled by which of the two shapes it is. The roots listing carries the
    // absolute paths of the roots as entry names and the other carries single
    // segments, and the web's joining rule has to be tested against both.
    return frame.directory === null ? 'directoryRoots' : 'directoryListing';
  }
  if (frame.type === 'session-subscribed') {
    // A subscription made by start handle is answered under that handle, and
    // with no session until the provider has written one. That is a third case
    // and not a variant of the two below: a pane on it is showing a live
    // terminal that no address anywhere can name yet.
    if (frame.startId !== null) return 'sessionSubscribedPending';
    // Labelled by what it says about the history, because those are the two
    // cases a pane has to draw differently: a subscriber being shown the
    // session from its first byte, and one joining mid-stream.
    return frame.droppedBytes > 0 ? 'sessionSubscribedTruncated' : 'sessionSubscribed';
  }
  if (frame.type === 'terminal-output') {
    // Output on a start handle, before and after the provider named the
    // session. The pair is the whole of the rebind: a client watching by
    // handle learns which session it is watching from the first chunk that
    // carries both names, and nothing else on the client leg ever tells it.
    if (frame.startId !== null) {
      return frame.sessionId === null ? 'terminalOutputPending' : 'terminalOutputNamed';
    }
    // The same distinction one layer down: bytes that arrived with a gap in
    // front of them, and bytes that did not.
    return frame.droppedChunks > 0 ? 'terminalOutputDropped' : 'terminalOutput';
  }
  const labels = new Map<string, string>([
    ['welcome', 'welcome'],
    ['pong', 'pong'],
    ['layout', 'layout'],
    ['pane-layout-saved', 'paneLayoutSaved'],
    ['session-started', 'sessionStarted'],
    ['session-stopped', 'sessionStopped'],
    ['server-paired', 'serverPaired'],
    ['server-unpaired', 'serverUnpaired'],
    ['project-created', 'projectCreated'],
    ['node-created', 'nodeCreated'],
    ['node-renamed', 'nodeRenamed'],
    ['node-moved', 'nodeMoved'],
    ['node-removed', 'nodeRemoved'],
    ['node-removal-forgotten', 'nodeRemovalForgotten'],
    ['catalogue-changed', 'catalogueChanged'],
    ['doc-created', 'docCreated'],
    ['doc-saved', 'docSaved'],
    ['doc-content', 'docContent'],
    ['session-unsubscribed', 'sessionUnsubscribed'],
    ['session-subscription-ended', 'sessionSubscriptionEnded'],
    ['protocol-error', 'protocolError'],
  ]);
  const label = labels.get(frame.type);
  if (label === undefined) throw new Error(`no label for a ${frame.type} frame`);
  return label;
}

/**
 * A fleet for the populated captures: hostnames that answer a dial with a real
 * `serveServerEnd` backed by a fake session controller, so every session
 * the machine-state frame carries travelled the whole real path -- store
 * report, reducer, broadcast -- before it was captured.
 */
interface Machine {
  readonly serverId: string;
  readonly stores: readonly StoreDescriptor[];
  readonly reports: readonly StoreReport[];
  /** What that machine's startup preflight found, as it reports it. */
  readonly providers: readonly ProviderReadiness[];
  /** What this machine's controller answers a start with. Default: a refusal. */
  readonly startOutcome?: SessionOutcome;
  /**
   * What a client may browse on this machine, and what is under it.
   *
   * Absent is a machine with no browse roots, which is the default a server
   * ships with; the one machine that has them is the one the directory-listing
   * fixture is captured from.
   */
  readonly browse?: {
    readonly roots: readonly string[];
    readonly directories: Readonly<
      Record<string, readonly { name: string; kind: 'directory' | 'file' | 'other' }[]>
    >;
  };
  /**
   * A real session controller over a fake pty, for the terminal captures.
   *
   * The other machines here answer a start without running anything, which is
   * all a machine-state capture needs. A terminal frame is different: there is
   * nothing to subscribe to unless a process exists, a scrollback exists, and
   * the real terminal manager is the thing counting watchers -- so the
   * terminal captures stand on the shipped server code with only the fork
   * faked, exactly as `terminal-relay.integration.test.ts` does.
   */
  readonly live?: LiveMachine;
}

/** The shipped server-side terminal path, with a fake pty under it. */
interface LiveMachine {
  readonly sessions: SessionController;
  readonly terminals: TerminalManager;
  readonly ptys: FakePtyFactory;
  /**
   * The transcripts this machine's disk holds, live rather than a snapshot.
   *
   * Written to during the capture, because the moment the pending-pane frames
   * exist for is a provider writing its session id while the connection that
   * started it is still up. The reads below are answered from the record as it
   * stands, which is what a disk does.
   */
  readonly sessionFiles: Record<string, string>;
}

const START = 1_756_000_000_000;
const MINUTE = 60_000;
const logger = createLogger('error', () => {});

function fleetDialer(
  machines: Map<string, Machine>,
  live: Map<string, MessageSocket>,
  /**
   * Each machine's end of the connection, for the one capture where the server
   * speaks first: a drain is the only thing a server says that nobody asked
   * for and that is not a report, and the only way to capture the state it
   * produces is to have the real server end send the real frame.
   */
  served: Map<string, HubConnection>,
): SocketDialer {
  return {
    dial: async (address: string): Promise<DialResult> => {
      const host = new URL(address).hostname;
      const machine = machines.get(host);
      if (machine === undefined) return { ok: false, problem: 'connection refused' };
      const { hubEnd, serverEnd } = createSocketPair();
      const controller =
        machine.live?.sessions ??
        createFakeSessionController(
          machine.startOutcome === undefined
            ? { reports: machine.reports }
            : { reports: machine.reports, outcome: machine.startOutcome },
        );
      const connection = serveServerEnd(serverEnd, {
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
        terminals: machine.live?.terminals ?? createFakeTerminals().terminals,
        machineLoad: createFakeMachineLoadReader(),
        identity: { serverId: serverIdSchema.parse(machine.serverId), token: `tok-${host}` },
        stores: machine.stores,
        providers: machine.providers,
        browse: createDirectoryBrowser({
          roots: [...(machine.browse?.roots ?? [])],
          reader: createFakeDirectoryReader({ directories: machine.browse?.directories ?? {} }),
        }),
        logger,
      });
      live.set(host, serverEnd);
      served.set(host, connection);
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
  /**
   * What git found in that session's checkout, or `null` for a session whose
   * directory this server did not read -- which is most of them, and is the
   * shape a client has to draw for a store that is not a repository or a
   * machine with no git.
   */
  uncommitted: SessionDescriptor['uncommitted'] = null,
  /**
   * The branch that checkout was on, or `null` for a session whose directory
   * this server did not read, or one on a detached head. Last and defaulted for
   * the same reason the diffstat is: the common descriptor is the one where
   * nobody looked.
   */
  branch: string | null = null,
  usage?: SessionDescriptor['usage'],
): SessionDescriptor {
  return {
    storeId: storeIdSchema.parse(storeId),
    sessionId: sessionIdSchema.parse(sessionId),
    provider,
    status,
    updatedAt,
    cwd,
    branch,
    title,
    uncommitted,
    // Omitted rather than nulled when a session has no counts, so the captured
    // frames carry both shapes the client has to render: a session with a
    // number on it and a session with none.
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Token counts for a captured session, taken from real provider output.
 *
 * These are the two API responses in `packages/providers/fixtures/claude-
 * completed-turn.jsonl` added up once each. Invented round numbers would hide
 * the thing the client most has to get right: a real session is almost
 * entirely cache reads, and a surface that folded these four into one input
 * figure would show a cost several times over.
 */
const CAPTURED_USAGE = {
  inputTokens: 4,
  cacheReadTokens: 77_192,
  cacheWriteTokens: 18_872,
  outputTokens: 1347,
};

function hold(sessionId: string, stoppable: boolean): SessionHold {
  return { sessionId: sessionIdSchema.parse(sessionId), stoppable };
}

/** The store the terminal captures run in, and the session they watch. */
const LIVE_STORE: StoreDescriptor = {
  storeId: storeIdSchema.parse('store-work'),
  path: '/volumes/work',
};
const LIVE_SESSION = sessionIdSchema.parse('session-build');
/** The session a spawn turns out to be, written mid-capture rather than up front. */
const SPAWNED_SESSION = sessionIdSchema.parse('session-spawned');

/**
 * Small enough that a burst of output makes the server's own scrollback drop
 * something.
 *
 * `droppedBytes` on a subscribe reply is the number a pane uses to say it is
 * joining mid-stream, and it is nonzero only when a real terminal really
 * evicted real history. Shrinking the buffer is how that is provoked in a
 * second rather than in a megabyte; the rule doing the evicting is the shipped
 * one either way.
 */
const CAPTURE_SCROLLBACK_BYTES = 512;

/** The shipped server terminal path, with only the fork faked. */
function buildLiveMachine(): LiveMachine {
  const ptys = createFakePtyFactory();
  const clock = { now: () => START };
  const supervisor = createPtySupervisor({
    pty: ptys,
    clock,
    ids: { newId: () => `capture-run-${String(ptys.ptys.length)}` },
    environment: { PATH: '/usr/bin' },
    scrollbackBytes: CAPTURE_SCROLLBACK_BYTES,
  });
  const terminals = createTerminalManager({ supervisor, clock });
  // The transcript the provider has already written, so the session exists to
  // be resumed and the store report names it.
  const sessionFiles = {
    [`${LIVE_STORE.path}/claude/sessions/${LIVE_SESSION}.json`]: JSON.stringify({
      signal: 'awaiting-input',
      updatedAt: START,
      cwd: LIVE_STORE.path,
    }),
  };
  const files: ProviderFiles = {
    readFile: (path) => createFakeProviderFiles({ files: sessionFiles }).readFile(path),
    listDirectory: (path) => createFakeProviderFiles({ files: sessionFiles }).listDirectory(path),
  };
  const stores = [LIVE_STORE];
  return {
    ptys,
    terminals,
    sessionFiles,
    sessions: createSessionController({
      stores,
      providers: createProviderRegistry([createFakeProviderAdapter({ provider: 'claude', files })]),
      terminals,
      workingTree: createFakeWorkingTree(),
      // No roots, which is the default a server ships with: this machine
      // resumes a session that names its own directory, and nothing captured
      // here starts in a project.
      browse: createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader() }),
      clock,
      logger,
    }),
  };
}

/**
 * Waits for a client to stop being sent things.
 *
 * Turns of the loop are not enough here, and that is the point of the whole
 * burst below: a megabyte on a real socket leaves the process when the kernel
 * says so, and the relay's decision to drop is made against how far behind
 * that socket is. So this waits on real time and on the frames actually
 * arriving, which is the only clock that fact is true on.
 */
async function quiet(client: Client): Promise<void> {
  let seen = -1;
  while (seen !== client.received.length) {
    seen = client.received.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The first frame a client was sent under a label, or a failure naming it. */
function firstFrame(client: Client, label: string): string {
  const found = client.received.find((text) => labelFor(text) === label);
  if (found === undefined) throw new Error(`nothing the client received was a ${label}`);
  return found;
}

/** The same, from the end. */
function lastFrame(client: Client, label: string): string {
  const found = [...client.received].reverse().find((text) => labelFor(text) === label);
  if (found === undefined) throw new Error(`nothing the client received was a ${label}`);
  return found;
}

async function until(predicate: () => boolean, what: string | (() => string)): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
}

/**
 * A hub id source that counts, which is what every capture but one wants.
 *
 * Counted rather than constant, because the hub's id source is also where a
 * node in the tree gets its primary key: with discovery wired to the report
 * seam (AGX-90), a fleet that reports two sessions mints two node ids, and a
 * source that answered both with one string would have the second insert
 * collide and take the whole reading down with it. The hub's own identity takes
 * the first; every one after it is a node.
 */
function countingHubIds(): () => string {
  let minted = 0;
  return () => `hub-${(minted += 1)}`;
}

/** A hub over a real migrated SQLite file, dialling the given fleet. */
async function startFleetHub(
  machines: Map<string, Machine>,
  registrations: readonly { label: string; host: string }[],
  live: Map<string, MessageSocket>,
  discovery: FakeBeaconSource = createFakeBeaconSource(),
  /**
   * The hub's id source. Only the pairing capture supplies one: every other hub
   * here wants the counter below, which is what the hub is given when it starts
   * for real.
   */
  newRegistrationId: () => string = countingHubIds(),
  /** Each machine's own end, for the capture that needs a server to announce a drain. */
  served: Map<string, HubConnection> = new Map(),
): Promise<{ hub: Hub; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'agentplex-capture-'));
  const database = createSqliteDatabase(join(directory, 'hub.db'));
  const migrationsDirectory = fileURLToPath(
    new URL('../../../apps/hub/migrations', import.meta.url),
  );
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
    ids: { newId: newRegistrationId },
    clock,
    clientToken: CLIENT_TOKEN,
    tokens: { newToken: () => `fleet-ticket-${(nextTicket += 1)}` },
    dialer: fleetDialer(machines, live, served),
    discovery,
    timers: createFakeTimers(),
    migrationsDirectory,
    migrationFileSystem: nodeMigrationFileSystem,
    // Nothing to serve: these fixtures are the frames the hub sends over a
    // socket, and no static file has ever been one of them.
    webAssets: createFakeWebAssets(),
    host: HOST,
    port: 0,
    localServer: null,
    files: createFakeStoreFiles(),
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
      // A silent network, so the states captured from this hub carry the
      // empty candidate list a hub that has heard nothing publishes.
      discovery: createFakeBeaconSource(),
      migrationsDirectory: '/migrations',
      migrationFileSystem,
      // Nothing to serve: these fixtures are the frames the hub sends over a
      // socket, and no static file has ever been one of them.
      webAssets: createFakeWebAssets(),
      host: HOST,
      port: 0,
      localServer: null,
      files: createFakeStoreFiles(),
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
      project: null,
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
      discovery: createFakeBeaconSource(),
      timers: createFakeTimers(),
      migrationsDirectory: '/migrations',
      migrationFileSystem,
      // Nothing to serve: these fixtures are the frames the hub sends over a
      // socket, and no static file has ever been one of them.
      webAssets: createFakeWebAssets(),
      host: HOST,
      port: 0,
      localServer: null,
      files: createFakeStoreFiles(),
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
          providers: [readyProvider('claude'), readyProvider('codex')],
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
                  // One session with a working tree somebody read, so the
                  // client's store has a fixture for the diff panel as well as
                  // for the far commoner case beneath it.
                  {
                    files: 3,
                    added: 42,
                    removed: 5,
                    entries: [
                      { path: 'src/auth/refresh.ts', added: 18, removed: 4 },
                      { path: 'src/auth/refresh.test.ts', added: 22, removed: 0 },
                      { path: 'src/auth/index.ts', added: 2, removed: 1 },
                    ],
                  },
                  'fix/auth-refresh',
                  CAPTURED_USAGE,
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
          providers: [readyProvider('claude'), missingProvider('codex')],
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

    // Attention: the two facts on a session row that no machine reported and
    // no scan can rebuild.
    //
    // Its own hub over the same fleet, rather than more conversation on the
    // one above. The two states captured from that hub are about a machine
    // going away and must stay about only that -- and an acknowledgement
    // cannot be taken back, so a hub that had been spoken to could not be
    // handed back clean. A second hub costs one more dial and keeps each
    // fixture a claim about one thing.
    //
    // Both land on a session that is asking for a human, because that is the
    // case the whole epic turns on and the two answers to it are different
    // ones: an acknowledgement says it has been seen, and a mute says keep
    // showing it and stop making noise about it. `machineStateAttended` is
    // therefore a state with one acknowledged prompt and one muted one still
    // saying it wants somebody -- which is the pair a client has to draw
    // differently. The unmute afterwards is the third answer this one reply
    // shape can carry, both moments null, and a client that could not read it
    // would be a client that cannot undo a mute.
    const attentiveLive = new Map<string, MessageSocket>();
    const attentive = await startFleetHub(
      fleet,
      [
        { label: 'mbp-robert', host: 'mbp-robert.example' },
        { label: 'gpu-box-01', host: 'gpu-box.example' },
      ],
      attentiveLive,
    );
    await until(
      () =>
        attentive.hub.connections.snapshot().every((report) => report.phase === 'connected') &&
        sessionCount(attentive.hub) === 6,
      () => `the fleet to connect and report: ${JSON.stringify(attentive.hub.state.snapshot())}`,
    );

    const attender = await openClient(attentive.hub);
    attender.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await attender.framesReceived(2);
    attender.send({
      type: 'session-acknowledge',
      id: 2,
      storeId: 'store-agentplex',
      sessionId: 'session-migrate-db',
    });
    await until(
      () => attender.received.some((text) => labelFor(text) === 'sessionAcknowledged'),
      'the acknowledgement to be answered',
    );
    attender.send({
      type: 'session-mute',
      id: 3,
      storeId: 'store-universe',
      sessionId: 'session-docs-sweep',
      muted: true,
    });
    await until(
      () => attender.received.some((text) => labelFor(text) === 'sessionMuted'),
      'the mute to be answered',
    );
    const machineStateAttended = await captureState(attentive.hub);

    // An acknowledgement of a session this hub has never heard of, refused.
    // The bound on the attention table, in the words a person reads: an
    // acknowledgement of something nobody can see has nothing to be spent
    // against, and a table that took any pair of strings could be grown
    // without limit by anything holding a socket.
    attender.send({
      type: 'session-acknowledge',
      id: 4,
      storeId: 'store-agentplex',
      sessionId: 'session-nobody-has',
    });
    await until(
      () => attender.received.some((text) => labelFor(text) === 'refusal'),
      'the acknowledgement of an unknown session to be refused',
    );
    attender.send({
      type: 'session-mute',
      id: 5,
      storeId: 'store-universe',
      sessionId: 'session-docs-sweep',
      muted: false,
    });
    await until(
      () => attender.received.some((text) => labelFor(text) === 'sessionUnmuted'),
      'the unmute to be answered',
    );
    const sessionAcknowledged = firstFrame(attender, 'sessionAcknowledged');
    const sessionMuted = firstFrame(attender, 'sessionMuted');
    const sessionUnmuted = firstFrame(attender, 'sessionUnmuted');
    const refusalAttention = firstFrame(attender, 'refusal');
    await attentive.cleanup();

    // One machine, one store, one provider: the state in which no store or
    // provider narrowing may be drawn, captured rather than derived.
    const single = new Map<string, Machine>([
      [
        'mbp-robert.example',
        {
          serverId: 'server-mbp',
          providers: [readyProvider('claude'), readyProvider('codex')],
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
                  // One session with a working tree somebody read, so the
                  // client's store has a fixture for the diff panel as well as
                  // for the far commoner case beneath it.
                  {
                    files: 3,
                    added: 42,
                    removed: 5,
                    entries: [
                      { path: 'src/auth/refresh.ts', added: 18, removed: 4 },
                      { path: 'src/auth/refresh.test.ts', added: 22, removed: 0 },
                      { path: 'src/auth/index.ts', added: 2, removed: 1 },
                    ],
                  },
                  'fix/auth-refresh',
                  CAPTURED_USAGE,
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
          // The one machine in these captures with somewhere to browse, so the
          // directory frames are captured from a real server answering out of
          // real configuration rather than written by hand.
          browse: {
            roots: ['/Users/robert/code'],
            directories: {
              '/Users/robert/code': [
                { name: '.config', kind: 'directory' },
                { name: 'agentplex', kind: 'directory' },
                { name: 'notes.md', kind: 'file' },
                { name: 'scratch', kind: 'other' },
              ],
            },
          },
          // Answers a start the way a real spawn does: ok, with no session id,
          // because the provider has not written one yet. The web form's
          // follow-up rules are tested against exactly this reply.
          startOutcome: {
            ok: true,
            storeId: storeIdSchema.parse('store-agentplex'),
            sessionId: null,
            // The server's own name for the process it opened. It never
            // crosses a wire; it is here because the outcome is the server's
            // and not the hub's.
            terminalId: 'terminal-mbp-1',
          },
        },
      ],
    ]);
    const singleLive = new Map<string, MessageSocket>();
    const singleHub = await startFleetHub(
      single,
      [{ label: 'mbp-robert', host: 'mbp-robert.example' }],
      singleLive,
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
      project: null,
    });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'sessionStarted'),
      'the start to be answered',
    );
    const sessionStarted = starter.received.find((text) => labelFor(text) === 'sessionStarted');
    if (sessionStarted === undefined) throw new Error('the start was not answered');

    // A browse of the same machine, both shapes. The roots listing is how a
    // picker starts -- the client does not know what a machine will allow --
    // and the directory listing under it is what every step after that looks
    // like. Both travel the whole real path: the hub relays, the server answers
    // out of the roots it was configured with, and the frames captured here are
    // what a client actually reads.
    starter.send({
      type: 'directory-list',
      id: 3,
      server: 'registration-mbp-robert',
      directory: null,
    });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'directoryRoots'),
      'the roots browse to be answered',
    );
    starter.send({
      type: 'directory-list',
      id: 4,
      server: 'registration-mbp-robert',
      directory: '/Users/robert/code',
    });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'directoryListing'),
      'the directory browse to be answered',
    );
    const directoryRoots = starter.received.find((text) => labelFor(text) === 'directoryRoots');
    const directoryListing = starter.received.find((text) => labelFor(text) === 'directoryListing');
    if (directoryRoots === undefined || directoryListing === undefined) {
      throw new Error('a browse was not answered');
    }

    // A project made out of the directory that was just browsed to, and then
    // renamed. Both replies travel the whole real path -- the hub writes two
    // rows in one transaction and answers -- so what the web's forms are tested
    // against is what a hub actually says rather than what their author
    // imagined. The node id in the reply is the one thing a client cannot work
    // out for itself, which is why the frame carries it.
    starter.send({
      type: 'project-create',
      id: 5,
      name: 'agentplex',
      directory: '/Users/robert/code/agentplex',
    });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'projectCreated'),
      'the project create to be answered',
    );
    const projectCreated = starter.received.find((text) => labelFor(text) === 'projectCreated');
    if (projectCreated === undefined) throw new Error('the project create was not answered');
    const created = parseTextFrame(parseHubFrame, projectCreated);
    if (!created.ok || created.value.type !== 'project-created') {
      throw new Error('the project create was answered with something else');
    }

    starter.send({
      type: 'node-rename',
      id: 6,
      nodeId: created.value.nodeId,
      name: 'agentplex (main checkout)',
    });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'nodeRenamed'),
      'the project rename to be answered',
    );
    const nodeRenamed = starter.received.find((text) => labelFor(text) === 'nodeRenamed');
    if (nodeRenamed === undefined) throw new Error('the project rename was not answered');

    // A document in that project, written, saved and read back. The whole real
    // path again: the hub turns the node id into the project's directory out of
    // its own rows, the server writes the file under its own data root, and the
    // three replies captured here are what a client actually reads. The write
    // times are the machine's -- the fake project disk counts its writes, so
    // this fixture says "the second write on that machine" rather than a
    // millisecond somebody typed.
    starter.send({
      type: 'doc-create',
      id: 8,
      projectId: created.value.nodeId,
      server: 'registration-mbp-robert',
      name: 'plan.md',
      content: '# Plan\n\n- read the failing test\n- fix the refresh loop\n',
    });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'docCreated'),
      'the document create to be answered',
    );
    const docCreated = starter.received.find((text) => labelFor(text) === 'docCreated');
    if (docCreated === undefined) throw new Error('the document create was not answered');
    const madeDoc = parseTextFrame(parseHubFrame, docCreated);
    if (!madeDoc.ok || madeDoc.value.type !== 'doc-created') {
      throw new Error('the document create was answered with something else');
    }

    starter.send({
      type: 'doc-save',
      id: 9,
      nodeId: madeDoc.value.nodeId,
      content: '# Plan\n\n- read the failing test\n- fix the refresh loop\n- write it up\n',
    });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'docSaved'),
      'the document save to be answered',
    );
    const docSaved = starter.received.find((text) => labelFor(text) === 'docSaved');
    if (docSaved === undefined) throw new Error('the document save was not answered');

    starter.send({ type: 'doc-open', id: 10, nodeId: madeDoc.value.nodeId });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'docContent'),
      'the document open to be answered',
    );
    const docContent = starter.received.find((text) => labelFor(text) === 'docContent');
    if (docContent === undefined) throw new Error('the document open was not answered');

    // The editor's own flow, which is the order a person meets these frames
    // in: the document is read, edited, and written back whole. Captured as a
    // second save because the web's editor store is tested against a real
    // answer to a save that followed a real open -- the two replies have to be
    // consecutive there, and they are consecutive here for the same reason.
    starter.send({
      type: 'doc-save',
      id: 11,
      nodeId: madeDoc.value.nodeId,
      content:
        '# Plan\n\n- read the failing test\n- fix the refresh loop\n- write it up\n- ship it\n',
    });
    await until(
      () => starter.received.filter((text) => labelFor(text) === 'docSaved').length === 2,
      'the second document save to be answered',
    );
    const docSavedAfterOpen = starter.received.filter((text) => labelFor(text) === 'docSaved')[1];
    if (docSavedAfterOpen === undefined) throw new Error('the second save was not answered');

    // The tree with that project in it, so the web's project picker has a
    // captured layout to read rather than one somebody typed. Last, because
    // the tree is the hub's own rows and says the same thing whether or not
    // the machine holding the file is awake.
    starter.send({ type: 'layout-request', id: 13 });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'layout'),
      'the layout to be answered',
    );
    const layoutWithProject = starter.received.find((text) => labelFor(text) === 'layout');
    if (layoutWithProject === undefined) throw new Error('the layout was not answered');
    const tree = parseTextFrame(parseHubFrame, layoutWithProject);
    if (!tree.ok || tree.value.type !== 'layout') {
      throw new Error('the layout was answered with something else');
    }
    const nodeFor = (sessionId: string): string => {
      if (tree.value.type !== 'layout')
        throw new Error('the layout was answered with something else');
      const node = tree.value.nodes.find((candidate) => candidate.anchor?.sessionId === sessionId);
      if (node === undefined) throw new Error(`no node was placed for ${sessionId}`);
      return node.id;
    };

    // The five tree edits, in an order a person could have performed: make a
    // folder, put the project in it, try to remove a session somebody is
    // running, remove one nobody is, and then change your mind about it. Every
    // reply here is a frame the web store has to read, and the refusal in the
    // middle is the one with a machine named on it.
    starter.send({ type: 'node-create-folder', id: 8, parentId: null, name: 'this week' });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'nodeCreated'),
      'the folder to be made',
    );
    const nodeCreated = starter.received.find((text) => labelFor(text) === 'nodeCreated');
    if (nodeCreated === undefined) throw new Error('the folder create was not answered');
    const folder = parseTextFrame(parseHubFrame, nodeCreated);
    if (!folder.ok || folder.value.type !== 'node-created') {
      throw new Error('the folder create was answered with something else');
    }

    starter.send({
      type: 'node-move',
      id: 9,
      nodeId: created.value.nodeId,
      parentId: folder.value.nodeId,
      position: 0,
    });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'nodeMoved'),
      'the move to be answered',
    );
    const nodeMoved = starter.received.find((text) => labelFor(text) === 'nodeMoved');
    if (nodeMoved === undefined) throw new Error('the move was not answered');

    // This machine reports itself as holding `session-fix-auth`, so the tree
    // will not let go of it: the refusal names the machine, and that is what
    // the client offers a stop against.
    starter.send({ type: 'node-remove', id: 10, nodeId: nodeFor('session-fix-auth') });
    // Found by "a refusal that names a holder" rather than by one label, because
    // `labelFor` splits those in two -- a holder that can be stopped and one
    // that cannot -- and which of the two this is is the machine's to say.
    const namesAHolder = (text: string): boolean => {
      const label = labelFor(text);
      return label === 'refusalHeldStoppable' || label === 'refusalHeldBusy';
    };
    await until(() => starter.received.some(namesAHolder), 'the removal to be refused');
    const refusalHolder = starter.received.find(namesAHolder);
    if (refusalHolder === undefined) throw new Error('the removal was not refused');

    starter.send({ type: 'node-remove', id: 11, nodeId: nodeFor('session-spike-wasm') });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'nodeRemoved'),
      'the removal to be answered',
    );
    const nodeRemoved = starter.received.find((text) => labelFor(text) === 'nodeRemoved');
    if (nodeRemoved === undefined) throw new Error('the removal was not answered');

    starter.send({
      type: 'node-forget-removal',
      id: 12,
      storeId: 'store-agentplex',
      sessionId: 'session-spike-wasm',
    });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'nodeRemovalForgotten'),
      'the forgetting to be answered',
    );
    const nodeRemovalForgotten = starter.received.find(
      (text) => labelFor(text) === 'nodeRemovalForgotten',
    );
    if (nodeRemovalForgotten === undefined) throw new Error('the forgetting was not answered');

    // Unsolicited, and it arrived on this socket because the tree changed --
    // not because this client asked. It is the frame the store re-requests a
    // layout on.
    const catalogueChanged = starter.received.find((text) => labelFor(text) === 'catalogueChanged');
    if (catalogueChanged === undefined) throw new Error('no catalogue-changed was broadcast');

    // The tree after all of that: a folder, a project inside it, and the
    // sessions. It is the one captured layout with a container in it, which is
    // what the web's "move to a folder" menu is built out of.
    starter.send({ type: 'layout-request', id: 13 });
    await until(
      () => starter.received.filter((text) => labelFor(text) === 'layout').length > 1,
      'the arranged tree to be answered',
    );
    const layoutArranged = starter.received.findLast((text) => labelFor(text) === 'layout');
    if (layoutArranged === undefined) throw new Error('the second layout was not answered');

    // The catalogue, over that same arranged tree: grouped by server, sorted by
    // name, and cut at one so the store's tests get both shapes -- a page with
    // a cursor on it and the page that ends the answer. The session rows on the
    // items are the reducer's own, which is what makes "the client joins
    // nothing" something the web tests can stand on rather than take on trust.
    const catalogueQuery = {
      type: 'catalogue-query',
      view: 'list',
      groupBy: 'server',
      sort: { key: 'name', direction: 'asc' },
      filter: {},
      limit: 1,
    };
    starter.send({ ...catalogueQuery, id: 14, cursor: null });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'cataloguePagePartial'),
      'the first catalogue page to be answered',
    );
    const cataloguePagePartial = starter.received.find(
      (text) => labelFor(text) === 'cataloguePagePartial',
    );
    if (cataloguePagePartial === undefined) throw new Error('no catalogue page was answered');
    const partial = parseTextFrame(parseHubFrame, cataloguePagePartial);
    if (!partial.ok || partial.value.type !== 'catalogue-page') {
      throw new Error('the catalogue page did not parse back');
    }
    starter.send({ ...catalogueQuery, id: 15, cursor: partial.value.nextCursor, limit: 10 });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'cataloguePage'),
      'the last catalogue page to be answered',
    );
    const cataloguePage = starter.received.find((text) => labelFor(text) === 'cataloguePage');
    if (cataloguePage === undefined) throw new Error('no final catalogue page was answered');

    // A cursor the tree has moved past. Captured rather than written by hand,
    // because what the store has to be able to read is the sentence this hub
    // actually sends when it refuses one.
    starter.send({ type: 'node-create-folder', id: 16, parentId: null, name: 'later' });
    await until(
      () => starter.received.filter((text) => labelFor(text) === 'nodeCreated').length > 1,
      'the folder that moves the version to be made',
    );
    starter.send({ ...catalogueQuery, id: 17, cursor: partial.value.nextCursor });
    await until(
      () =>
        starter.received.some((text) => {
          const seen = parseTextFrame(parseHubFrame, text);
          return seen.ok && seen.value.type === 'refusal' && seen.value.replyTo === 17;
        }),
      'the stale cursor to be refused',
    );
    const refusalStaleCursor = starter.received.find((text) => {
      const seen = parseTextFrame(parseHubFrame, text);
      return seen.ok && seen.value.type === 'refusal' && seen.value.replyTo === 17;
    });
    if (refusalStaleCursor === undefined) throw new Error('the stale cursor was not refused');

    // The same catalogue as the tree it is: containers, their children, parents
    // before children, and the depth on every row. Ungrouped, because in a tree
    // the containment is the grouping -- the hub labels the items and reorders
    // nothing -- and cut at two, so the sidebar's tests get a tree page with a
    // cursor on it as well as the one that ends the answer.
    const treeQuery = {
      type: 'catalogue-query',
      view: 'tree',
      groupBy: 'none',
      sort: { key: 'name', direction: 'asc' },
      filter: {},
    };
    starter.send({ ...treeQuery, id: 18, cursor: null, limit: 2 });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'catalogueTreePagePartial'),
      'the first tree page to be answered',
    );
    const catalogueTreePagePartial = starter.received.find(
      (text) => labelFor(text) === 'catalogueTreePagePartial',
    );
    if (catalogueTreePagePartial === undefined) throw new Error('no tree page was answered');
    const treePartial = parseTextFrame(parseHubFrame, catalogueTreePagePartial);
    if (!treePartial.ok || treePartial.value.type !== 'catalogue-page') {
      throw new Error('the tree page did not parse back');
    }
    starter.send({ ...treeQuery, id: 19, cursor: treePartial.value.nextCursor, limit: 50 });
    await until(
      () => starter.received.some((text) => labelFor(text) === 'catalogueTreePage'),
      'the last tree page to be answered',
    );
    const catalogueTreePage = starter.received.find(
      (text) => labelFor(text) === 'catalogueTreePage',
    );
    if (catalogueTreePage === undefined) throw new Error('no final tree page was answered');

    // The same save once the machine has gone away, which is the refusal the
    // editor is written around: the hub holds no copy of a document, so a
    // write it cannot deliver is a no with the machine named in it, and what
    // the editor must not do with that no is drop the characters. Captured
    // rather than written here because the sentence is the hub's.
    //
    // Last in this conversation, and that is not incidental: everything above
    // -- the tree, the catalogue, both pages of both views -- is captured with
    // this machine connected, so taking it away is the end of the scenario
    // rather than a state the later captures would have inherited.
    singleLive.get('mbp-robert.example')?.close({ code: 1006, reason: 'the machine went away' });
    await until(
      () => singleHub.hub.connections.snapshot().some((report) => report.phase === 'stale'),
      'the single machine to go stale',
    );
    starter.send({
      type: 'doc-save',
      // The id this frame carries is load-bearing beyond this file: the web's
      // editor suite runs its own counter up to the same numbers so that a
      // captured answer lands on the captured request, which is the property
      // that suite is about. It is 12 because a save follows a read and a
      // first save, and moving it would be moving the reply it is matched to.
      id: 12,
      nodeId: madeDoc.value.nodeId,
      content: '# Plan\n\n- everything above, and this line nobody received\n',
    });
    // By the frame it answers and not by its label: this conversation has
    // already been refused a stale cursor, and both are refusals with no
    // holder on them.
    const answersTheAwaySave = (text: string): boolean => {
      const seen = parseTextFrame(parseHubFrame, text);
      return seen.ok && seen.value.type === 'refusal' && seen.value.replyTo === 12;
    };
    await until(
      () => starter.received.some(answersTheAwaySave),
      'the save to the machine that went away to be refused',
    );
    const refusalDocAway = starter.received.find(answersTheAwaySave);
    if (refusalDocAway === undefined) throw new Error('the save was not refused');

    await singleHub.cleanup();

    // A machine holding one session it will stop and one it will not, for the
    // three answers a holder produces and that a client has to draw: a stop
    // that lands, a stop refused because the holder is mid-turn, and a start
    // refused because the session is already running somewhere that can be
    // stopped. The last is the one the `holder` field exists for -- "it is
    // running over here" is a different answer from "no", and the way out is
    // named rather than left for the user to find.
    const held = new Map<string, Machine>([
      [
        'mbp-robert.example',
        {
          serverId: 'server-mbp',
          providers: [readyProvider('claude'), readyProvider('codex')],
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
              ],
              holding: [hold('session-fix-auth', false), hold('session-migrate-db', true)],
            },
          ],
          // The controller answers both a start and a stop with this, and only
          // the stop gets that far: the two refusals below are the hub's, taken
          // before any machine is instructed.
          startOutcome: {
            ok: true,
            storeId: storeIdSchema.parse('store-agentplex'),
            sessionId: null,
            terminalId: 'terminal-mbp-2',
          },
        },
      ],
    ]);
    const heldHub = await startFleetHub(
      held,
      [{ label: 'mbp-robert', host: 'mbp-robert.example' }],
      new Map(),
    );
    await until(
      () =>
        heldHub.hub.connections.snapshot().every((report) => report.phase === 'connected') &&
        sessionCount(heldHub.hub) === 2,
      'the holding machine to connect and report',
    );
    const stopper = await openClient(heldHub.hub);
    stopper.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await stopper.framesReceived(2);
    // The two frames a real client sends next, and the reason they are here:
    // the session list asks for the tree and for a page of the catalogue as
    // soon as it is connected, so every command it then sends is numbered two
    // higher than it would be in a capture that skipped them. The refusals
    // below are matched to a pending command by `replyTo`, so a capture whose
    // numbering was not the client's would answer a frame no screen ever sent.
    stopper.send({ type: 'layout-request', id: 2 });
    await until(
      () => stopper.received.some((text) => labelFor(text) === 'layout'),
      'the tree a client asks for on connecting',
    );
    stopper.send({
      type: 'catalogue-query',
      id: 3,
      view: 'list',
      groupBy: 'none',
      sort: { key: 'updatedAt', direction: 'desc' },
      filter: {},
      cursor: null,
      limit: 50,
    });
    await until(
      () => stopper.received.some((text) => labelFor(text) === 'cataloguePage'),
      'the catalogue page a list asks for on connecting',
    );
    stopper.send({
      type: 'session-stop',
      id: 4,
      storeId: 'store-agentplex',
      sessionId: 'session-fix-auth',
    });
    await until(
      () => stopper.received.some((text) => labelFor(text) === 'refusalHeldBusy'),
      'the mid-turn stop to be refused',
    );
    stopper.send({
      type: 'session-start',
      id: 5,
      storeId: 'store-agentplex',
      sessionId: 'session-migrate-db',
      provider: 'codex',
      prompt: null,
      server: null,
      project: null,
    });
    await until(
      () => stopper.received.some((text) => labelFor(text) === 'refusalHeldStoppable'),
      'the start on a held session to be refused',
    );
    stopper.send({
      type: 'session-stop',
      id: 6,
      storeId: 'store-agentplex',
      sessionId: 'session-migrate-db',
    });
    await until(
      () => stopper.received.some((text) => labelFor(text) === 'sessionStopped'),
      'the stop to land',
    );
    const fromStopper = (label: string): string => {
      const text = stopper.received.find((candidate) => labelFor(candidate) === label);
      if (text === undefined) throw new Error(`the hub never sent a ${label}`);
      return text;
    };
    const refusalHeldBusy = fromStopper('refusalHeldBusy');
    const refusalHeldStoppable = fromStopper('refusalHeldStoppable');
    const sessionStopped = fromStopper('sessionStopped');
    await heldHub.cleanup();
    // A machine that says it is going down, captured while it still is. The
    // real server end sends the real `server-draining` frame, so this is the
    // state a client is sent during a drain rather than anybody's idea of it:
    // the row is still `connected`, because the socket is up and the hub is
    // still being answered, and the shutdown sits beside the phase with the
    // sessions that are finishing named on it. Both halves are the reading --
    // the phase alone says nothing is happening, and a phase that said
    // otherwise would take a live connection off the screen. The settings
    // screen's draining row is drawn from this frame.
    const drainingServed = new Map<string, HubConnection>();
    const drainingHub = await startFleetHub(
      single,
      [{ label: 'mbp-robert', host: 'mbp-robert.example' }],
      new Map(),
      createFakeBeaconSource(),
      countingHubIds(),
      drainingServed,
    );
    await until(
      () =>
        drainingHub.hub.connections.snapshot().every((report) => report.phase === 'connected') &&
        sessionCount(drainingHub.hub) === 2,
      'the machine that is about to drain to connect and report',
    );
    drainingServed.get('mbp-robert.example')?.announceDraining(15_000, [
      {
        storeId: storeIdSchema.parse('store-agentplex'),
        sessionId: sessionIdSchema.parse('session-fix-auth'),
      },
    ]);
    await until(
      () => drainingHub.hub.connections.snapshot().some((report) => report.draining !== null),
      'the hub to hear the drain',
    );
    const machineStateDraining = await captureState(drainingHub.hub);
    await drainingHub.cleanup();

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
          providers: [readyProvider('claude'), readyProvider('codex')],
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
          providers: [readyProvider('claude'), missingProvider('codex')],
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

    // A client pairing a machine over the socket, on a hub that starts with an
    // empty pairing table: the refusal a mistyped address earns, the answer to
    // a pairing the hub accepts, and the answer to unpairing it again. These
    // are the frames the settings screen's own tests stand on, and they have to
    // be the hub's rather than anybody's idea of them -- the refusal's words in
    // particular are the address parser's, and the screen shows them verbatim.
    const pairable = new Map<string, Machine>([
      [
        'mbp-robert.example',
        {
          serverId: 'server-mbp',
          providers: [readyProvider('claude')],
          stores: [
            {
              storeId: storeIdSchema.parse('store-agentplex'),
              path: '/Users/robert/code/agentplex',
            },
          ],
          reports: [{ storeId: storeIdSchema.parse('store-agentplex'), sessions: [], holding: [] }],
        },
      ],
    ]);
    // The hub's own identity is the first id it asks for, at boot; everything
    // after it is a pairing somebody made.
    let minted = 0;
    const pairingHub = await startFleetHub(
      pairable,
      [],
      new Map(),
      createFakeBeaconSource(),
      () => {
        minted += 1;
        return minted === 1 ? 'hub-1' : `registration-${String(minted - 1)}`;
      },
    );
    const pairer = await openClient(pairingHub.hub);
    pairer.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await pairer.framesReceived(2);
    pairer.send({
      type: 'server-pair',
      id: 2,
      label: 'gpu-box-01',
      // Plaintext to a machine that is not this one: refused in the parser's
      // own words, and the socket stays open.
      address: 'ws://gpu-box-01.example:8443',
      token: 'the-token-the-server-printed',
    });
    await until(
      () => pairer.received.some((text) => labelFor(text) === 'refusal'),
      'the mistyped address to be refused',
    );
    const refusalPairing = pairer.received.find((text) => labelFor(text) === 'refusal');
    pairer.send({
      type: 'server-pair',
      id: 3,
      label: 'mbp-robert',
      address: 'wss://mbp-robert.example:8443',
      token: 'tok-mbp-robert.example',
    });
    await until(
      () => pairer.received.some((text) => labelFor(text) === 'serverPaired'),
      () => `the pairing to be answered: ${pairer.received.join(' | ')}`,
    );
    const serverPaired = pairer.received.find((text) => labelFor(text) === 'serverPaired');
    // Paired and then dialled, with no restart in between: the state below is
    // the one the settings list draws after somebody types a token.
    await until(
      () => pairingHub.hub.connections.snapshot().some((report) => report.phase === 'connected'),
      () => `the new pairing to connect: ${JSON.stringify(pairingHub.hub.connections.snapshot())}`,
    );
    const machineStateJustPaired = await captureState(pairingHub.hub);
    pairer.send({ type: 'server-unpair', id: 4, registrationId: 'registration-1' });
    await until(
      () => pairer.received.some((text) => labelFor(text) === 'serverUnpaired'),
      'the unpairing to be answered',
    );
    const serverUnpaired = pairer.received.find((text) => labelFor(text) === 'serverUnpaired');
    await pairingHub.cleanup();
    if (
      refusalPairing === undefined ||
      serverPaired === undefined ||
      serverUnpaired === undefined
    ) {
      throw new Error('the pairing conversation was not answered');
    }

    // A fleet that disagrees about what it can start, which is the state the
    // new-session form's provider chooser is a function of. Four machines on
    // one volume, one per reading the preflight can produce: one that runs
    // claude and is logged out of codex, one whose claude answered no version
    // probe and whose codex is ready, one whose build carries no adapters at
    // all, and one that has neither -- so a single captured frame holds
    // `ready`, `unauthenticated`, `unknown`, `missing` and the empty list, and
    // the client's rules are read against what a hub actually assembled out of
    // four handshakes rather than against a literal somebody typed.
    const mixedStore: StoreDescriptor = {
      storeId: storeIdSchema.parse('store-mixed'),
      path: '/mnt/volumes/mixed',
    };
    const mixedReport: StoreReport = {
      storeId: mixedStore.storeId,
      sessions: [
        descriptor(
          'store-mixed',
          'session-mixed-notes',
          'claude',
          'idle',
          START - 30 * MINUTE,
          '/mnt/volumes/mixed/notes',
          'mixed-notes',
        ),
      ],
      holding: [],
    };
    const mixedFleet = new Map<string, Machine>([
      [
        'mbp-robert.example',
        {
          serverId: 'server-mbp',
          providers: [readyProvider('claude'), unauthenticatedProvider('codex')],
          stores: [mixedStore],
          reports: [mixedReport],
        },
      ],
      [
        'gpu-box.example',
        {
          serverId: 'server-gpu',
          providers: [unknownProvider('claude'), readyProvider('codex')],
          stores: [mixedStore],
          reports: [mixedReport],
        },
      ],
      [
        'mini.example',
        {
          serverId: 'server-mini',
          providers: [],
          stores: [mixedStore],
          reports: [mixedReport],
        },
      ],
      [
        'old-box.example',
        {
          serverId: 'server-old',
          providers: [missingProvider('claude'), unauthenticatedProvider('codex')],
          stores: [mixedStore],
          reports: [mixedReport],
        },
      ],
    ]);
    const mixedHub = await startFleetHub(
      mixedFleet,
      [
        { label: 'mbp-robert', host: 'mbp-robert.example' },
        { label: 'gpu-box-01', host: 'gpu-box.example' },
        { label: 'mini-01', host: 'mini.example' },
        { label: 'old-box-01', host: 'old-box.example' },
      ],
      new Map(),
    );
    await until(
      () =>
        mixedHub.hub.connections.snapshot().every((report) => report.phase === 'connected') &&
        mixedHub.hub.state
          .snapshot()
          .stores.some((view) => view.storeId === 'store-mixed' && view.servers.length === 4),
      'the mixed fleet to connect and report',
    );
    const machineStateProviders = await captureState(mixedHub.hub);
    await mixedHub.cleanup();

    // A hub that has heard two machines announce themselves and is paired with
    // neither. The beacons are formatted by the protocol's own formatter --
    // the function an announcing server calls -- and travel the whole real
    // path: the listener parses them, the reducer holds them in a collection
    // of their own, and the broadcast publishes the frame captured here. One
    // speaks this build's protocol and one does not, which is the pair of rows
    // the settings screen has to draw differently.
    const network = createFakeBeaconSource();
    const listeningHub = await startFleetHub(new Map(), [], new Map(), network);
    network.send(
      formatServerBeacon({
        type: 'agentplex-server-beacon',
        protocolVersion: PROTOCOL_VERSION,
        serverId: serverIdSchema.parse('server-mbp'),
        address: '192.168.1.24',
        port: 8443,
      }),
    );
    network.send(
      formatServerBeacon({
        type: 'agentplex-server-beacon',
        protocolVersion: PROTOCOL_VERSION - 1,
        serverId: serverIdSchema.parse('server-old-build'),
        address: '192.168.1.31',
        port: 8443,
      }),
      '192.168.1.31',
    );
    await until(
      () => listeningHub.hub.state.snapshot().candidates.length === 2,
      'the beacons to be heard',
    );
    const machineStateDiscovered = await captureState(listeningHub.hub);
    await listeningHub.cleanup();

    // A terminal, end to end. The server end is the shipped one with only the
    // fork faked: the real session controller, the real terminal manager, the
    // real scrollback and its real eviction rule, behind the real relay. Every
    // frame below is a frame a hub sent a browser about a process that was
    // actually running.
    //
    // Three of them exist only to admit to a gap, and those are the ones a
    // hand-written fixture would always get flatteringly wrong: a reply that
    // says how much history is missing, output that says how much of itself
    // never arrived, and a refusal for a session whose machine is asleep. So
    // each is provoked here rather than described -- a scrollback small enough
    // to overflow, more output in one turn than a socket can write, and a
    // machine that goes away.
    const live = buildLiveMachine();
    const terminalFleet = new Map<string, Machine>([
      [
        'mbp-robert.example',
        {
          serverId: 'server-mbp',
          providers: [readyProvider('claude')],
          stores: [LIVE_STORE],
          // Unused: this machine scans its own store through the real
          // controller, which is the whole reason it is here.
          reports: [],
          live,
        },
      ],
    ]);
    const terminalLive = new Map<string, MessageSocket>();
    const terminalHub = await startFleetHub(
      terminalFleet,
      [{ label: 'mbp-robert', host: 'mbp-robert.example' }],
      terminalLive,
    );
    await until(
      () =>
        terminalHub.hub.connections.snapshot().every((report) => report.phase === 'connected') &&
        sessionCount(terminalHub.hub) === 1,
      'the machine holding the terminal to connect and report',
    );

    // One client resumes the session and another watches it, so that the
    // subscribe is the second frame on the watching socket -- which is what a
    // pane's first subscribe is, and therefore the id these fixtures carry.
    const runner = await openClient(terminalHub.hub);
    runner.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await runner.framesReceived(2);
    runner.send({
      type: 'session-start',
      id: 2,
      storeId: LIVE_STORE.storeId,
      sessionId: LIVE_SESSION,
      provider: 'claude',
      prompt: null,
      server: null,
      project: null,
    });
    await until(
      () => runner.received.some((text) => labelFor(text) === 'sessionStarted'),
      'the session to be running',
    );

    const watched = {
      by: 'session' as const,
      storeId: LIVE_STORE.storeId,
      sessionId: LIVE_SESSION,
    };

    // Printed before anybody attached: this is the scrollback, and it is what
    // the subscription has to replay.
    live.ptys.last?.emit('building\r\n');
    live.ptys.last?.emit('still building\r\n');

    const watcher = await openClient(terminalHub.hub);
    watcher.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await watcher.framesReceived(2);
    watcher.send({ type: 'session-subscribe', id: 2, target: watched });
    await until(
      () => watcher.received.filter((text) => labelFor(text) === 'terminalOutput').length >= 2,
      'the reply and the history it promised',
    );

    // The gap on this link. More output in one turn than the socket to this
    // client can write, so the relay throws whole chunks away and charges them
    // to this watch; the next frame that does get through carries the count.
    const noise = new Uint8Array(64 * 1024).fill(0x2e);
    for (let round = 0; round < 4; round += 1) {
      for (let at = 0; at < 48; at += 1) live.ptys.last?.emit(noise);
      await quiet(watcher);
      live.ptys.last?.emit(`marker ${String(round)}\r\n`);
      await quiet(watcher);
      if (watcher.received.some((text) => labelFor(text) === 'terminalOutputDropped')) break;
    }
    if (!watcher.received.some((text) => labelFor(text) === 'terminalOutputDropped')) {
      throw new Error('the relay never fell behind, so there is no dropped-chunk frame to capture');
    }
    // One more, so the captured frame is the small one that follows the burst
    // rather than a megabyte of noise: the count is cumulative, so every frame
    // after a drop carries it.
    live.ptys.last?.emit('done\r\n');
    await quiet(watcher);

    watcher.send({ type: 'session-unsubscribe', id: 3, target: watched });
    await until(
      () => watcher.received.some((text) => labelFor(text) === 'sessionUnsubscribed'),
      'the detach to be answered',
    );

    // A pane opened on a session that has been running a while. The burst
    // above overflowed the terminal's scrollback, so this is the reply that
    // says outright how much of the beginning is gone.
    const latecomer = await openClient(terminalHub.hub);
    latecomer.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await latecomer.framesReceived(2);
    latecomer.send({ type: 'session-subscribe', id: 2, target: watched });
    await until(
      () => latecomer.received.some((text) => labelFor(text) === 'sessionSubscribedTruncated'),
      'the late subscription to be answered with the size of the gap',
    );

    // A pane opened on a spawn, which is the one case a session id cannot
    // address: the provider mints its own and writes it moments after the
    // fork, so between the two there is a live terminal and no name for it.
    //
    // The frame ids are the ones the web store itself will mint -- hello,
    // then the start, then the pane's subscribe, then the subscribe it sends
    // again -- because a client's start handle *is* the id of its own
    // `session-start` frame, and these fixtures have to drive that store.
    const spawning = await openClient(terminalHub.hub);
    spawning.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await spawning.framesReceived(2);
    spawning.send({
      type: 'session-start',
      id: 2,
      storeId: LIVE_STORE.storeId,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: null,
      project: null,
    });
    await until(
      () => spawning.received.some((text) => labelFor(text) === 'sessionStarted'),
      'the spawn to be running',
    );

    // The refusal a pane meets when it opens in the same click that sends the
    // start: the hub writes the handle only once the machine has answered the
    // fork, and a handle it has not written is one it can only refuse. It is
    // provoked here with a handle that was never a start rather than by racing
    // the fork, because the hub's answer is the same either way -- one lookup
    // in this connection's own map, one sentence -- and a race would capture
    // a frame that exists only when the timing goes one particular way.
    spawning.send({ type: 'session-subscribe', id: 3, target: { by: 'start', startId: 99 } });
    await until(
      () => spawning.received.some((text) => labelFor(text) === 'refusal'),
      'the subscription by an unwritten handle to be refused',
    );

    // And the subscribe the client sends again on reading `session-started`,
    // which is the frame that says the handle now exists.
    spawning.send({ type: 'session-subscribe', id: 4, target: { by: 'start', startId: 2 } });
    await until(
      () => spawning.received.some((text) => labelFor(text) === 'sessionSubscribedPending'),
      'the subscription by start handle to be answered',
    );

    const spawned = live.ptys.ptys[1];
    spawned?.emit('starting up\r\n');
    await quiet(spawning);

    // The provider writes its transcript, and a scan of the store is what joins
    // the terminal to it. Anything that changes what is running in a store
    // reports it, so a second start is the scan -- which is also the ordinary
    // way this happens in life, since a person who has just started one agent
    // is about to start another.
    live.sessionFiles[`${LIVE_STORE.path}/claude/sessions/${SPAWNED_SESSION}.json`] =
      JSON.stringify({ signal: 'awaiting-input', updatedAt: START, cwd: LIVE_STORE.path });
    spawning.send({
      type: 'session-start',
      id: 5,
      storeId: LIVE_STORE.storeId,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: null,
      project: null,
    });
    await until(
      () =>
        terminalHub.hub.state
          .snapshot()
          .stores[0]?.sessions.some((row) => row.ref.sessionId === SPAWNED_SESSION) === true,
      'the provider to name the session the spawn became',
    );

    spawned?.emit('named now\r\n');
    await quiet(spawning);

    // And the machine goes away without saying so. The rows it reported stay,
    // labelled, so this is a refusal naming a machine rather than a session
    // that cannot be found -- which is the difference between a pane that says
    // what to do about it and a blank rectangle.
    terminalLive.get('mbp-robert.example')?.close({ code: 1006, reason: 'the machine went away' });
    await until(
      () => terminalHub.hub.connections.snapshot().some((report) => report.phase === 'stale'),
      'the machine holding the terminal to go stale',
    );
    // The pane that was watching when it went. The server said nothing on its
    // way out -- it stopped saying anything -- so this frame is the hub's own,
    // and it is the only thing that tells a still rectangle from a quiet agent.
    await until(
      () => latecomer.received.some((text) => labelFor(text) === 'sessionSubscriptionEnded'),
      'the watching pane to be told that its feed ended',
    );
    const orphan = await openClient(terminalHub.hub);
    orphan.send({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
    await orphan.framesReceived(2);
    orphan.send({ type: 'session-subscribe', id: 2, target: watched });
    await until(
      () => orphan.received.some((text) => labelFor(text) === 'refusal'),
      'the subscription to a sleeping machine to be refused',
    );

    const sessionSubscribed = firstFrame(watcher, 'sessionSubscribed');
    const terminalOutput = firstFrame(watcher, 'terminalOutput');
    const terminalOutputDropped = lastFrame(watcher, 'terminalOutputDropped');
    const sessionUnsubscribed = firstFrame(watcher, 'sessionUnsubscribed');
    const sessionSubscribedTruncated = firstFrame(latecomer, 'sessionSubscribedTruncated');
    const sessionSubscriptionEnded = firstFrame(latecomer, 'sessionSubscriptionEnded');
    const refusalTerminal = firstFrame(orphan, 'refusal');
    const refusalStartUnknown = firstFrame(spawning, 'refusal');
    const sessionSubscribedPending = firstFrame(spawning, 'sessionSubscribedPending');
    const terminalOutputPending = firstFrame(spawning, 'terminalOutputPending');
    const terminalOutputNamed = firstFrame(spawning, 'terminalOutputNamed');
    await terminalHub.cleanup();

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
    captured.set('machineStateAttended', machineStateAttended);
    captured.set('sessionAcknowledged', sessionAcknowledged);
    captured.set('sessionMuted', sessionMuted);
    captured.set('sessionUnmuted', sessionUnmuted);
    captured.set('refusalAttention', refusalAttention);
    captured.set('machineStateSingle', machineStateSingle);
    captured.set('machineStateDraining', machineStateDraining);
    captured.set('sessionStarted', sessionStarted);
    captured.set('sessionStopped', sessionStopped);
    captured.set('refusalHeldBusy', refusalHeldBusy);
    captured.set('refusalHeldStoppable', refusalHeldStoppable);
    captured.set('directoryRoots', directoryRoots);
    captured.set('directoryListing', directoryListing);
    captured.set('projectCreated', projectCreated);
    captured.set('nodeRenamed', nodeRenamed);
    captured.set('docCreated', docCreated);
    captured.set('docSaved', docSaved);
    captured.set('docSavedAfterOpen', docSavedAfterOpen);
    captured.set('refusalDocAway', refusalDocAway);
    captured.set('docContent', docContent);
    captured.set('layoutWithProject', layoutWithProject);
    captured.set('nodeCreated', nodeCreated);
    captured.set('nodeMoved', nodeMoved);
    captured.set('refusalHolder', refusalHolder);
    captured.set('nodeRemoved', nodeRemoved);
    captured.set('nodeRemovalForgotten', nodeRemovalForgotten);
    captured.set('catalogueChanged', catalogueChanged);
    captured.set('layoutArranged', layoutArranged);
    captured.set('cataloguePagePartial', cataloguePagePartial);
    captured.set('cataloguePage', cataloguePage);
    captured.set('refusalStaleCursor', refusalStaleCursor);
    captured.set('catalogueTreePagePartial', catalogueTreePagePartial);
    captured.set('catalogueTreePage', catalogueTreePage);
    captured.set('machineStateShared', machineStateShared);
    captured.set('machineStateSharedDegraded', machineStateSharedDegraded);
    captured.set('machineStateProviders', machineStateProviders);
    captured.set('machineStateDiscovered', machineStateDiscovered);
    captured.set('refusalPairing', refusalPairing);
    captured.set('serverPaired', serverPaired);
    captured.set('serverUnpaired', serverUnpaired);
    captured.set('machineStateJustPaired', machineStateJustPaired);
    captured.set('sessionSubscribed', sessionSubscribed);
    captured.set('sessionSubscribedTruncated', sessionSubscribedTruncated);
    captured.set('terminalOutput', terminalOutput);
    captured.set('terminalOutputDropped', terminalOutputDropped);
    captured.set('sessionUnsubscribed', sessionUnsubscribed);
    captured.set('sessionSubscriptionEnded', sessionSubscriptionEnded);
    captured.set('refusalTerminal', refusalTerminal);
    captured.set('refusalStartUnknown', refusalStartUnknown);
    captured.set('sessionSubscribedPending', sessionSubscribedPending);
    captured.set('terminalOutputPending', terminalOutputPending);
    captured.set('terminalOutputNamed', terminalOutputNamed);

    const entries = [...captured]
      .map(([label, text]) => `  ${label}: ${JSON.stringify(text)},`)
      .join('\n');
    const module = `/**
 * Hub frames, captured from a real hub over a real websocket.
 *
 * Generated by tests/hub-server/src/capture-client-fixtures.test.ts
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

    const target = new URL('../../../apps/web/src/store/hub-frames.fixture.ts', import.meta.url);
    await mkdir(new URL('.', target), { recursive: true });
    await writeFile(target, module, 'utf8');
    process.stdout.write(`wrote ${captured.size} frames to ${fileURLToPath(target)}\n`);
  });
});
