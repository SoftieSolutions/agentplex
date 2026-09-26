import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseClientFrame,
  parseHubFrame,
  parseHubToServerFrame,
  parseServerToHubFrame,
  parseTextFrame,
  CLIENT_PROTOCOL_VERSION,
  serverIdSchema,
  sessionIdSchema,
  startIdSchema,
  storeIdSchema,
  type ClientFrame,
  type HubFrame,
  type HubToServerFrame,
  type MachineState,
  type ProviderReadiness,
  type ServerRegistrationId,
  type ServerToHubFrame,
  nodeIdSchema,
  type Layout,
  type LayoutNode,
  type NodeId,
  type SessionRow,
  type StartId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  createSocketPair,
  createFakeTimers,
  PEER_GONE,
  type FakeMessageSocket,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import { createLogger, type DialResult, type SocketDialer } from '@agentplex/node-shared';
import { serveServerEnd } from './server-end.js';
import { forbiddenKeysIn, keysOf } from './frame-keys.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directories/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/directories/fake-directory-reader.js';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import {
  createFakeProviderAdapter,
  missingProvider,
  readyProvider,
  createFakeProviderFiles,
  createFakeStoreFiles,
} from '@agentplex/providers/testing';
import { createProviderRegistry, type ProviderFiles } from '@agentplex/providers';
import { createSessionController } from '../../../apps/server/src/sessions/session-control.js';
import { createFakeWorkingTree } from '../../../apps/server/src/working-tree/fake-working-tree.js';
import {
  createTerminalManager,
  type TerminalManager,
} from '../../../apps/server/src/terminal/terminal-manager.js';
import { createClients, type Clients } from '../../../apps/hub/src/clients/clients.js';
import { createFakeApprovals } from '../../../apps/hub/src/approvals/fake-approvals.js';
import { createFakeApprovalPolicy } from '../../../apps/hub/src/approval-policy/fake-approval-policy.js';
import { createFakeAttention } from '../../../apps/hub/src/attention/fake-attention.js';
import { toMachineState } from '../../../apps/hub/src/fleet-state/machine-state.js';
import { createExponentialBackoff } from '../../../apps/hub/src/servers/backoff.js';
import {
  createServers,
  type ServerConnectionReport,
  type Servers,
} from '../../../apps/hub/src/servers/servers.js';
import { registerServer } from '../../../apps/hub/src/pairing/server-registrations.js';
import {
  createPairing,
  newServerRegistrationSchema,
} from '../../../apps/hub/src/pairing/pairing.js';
import {
  openMigratedSchema,
  type MigratedSchema,
} from '../../../apps/hub/src/db/test-migrated-schema.js';
import {
  createFleetState,
  type FleetState,
} from '../../../apps/hub/src/fleet-state/fleet-state.js';
import { createCatalogue, type Catalogue } from '../../../apps/hub/src/catalogue/catalogue.js';
import { createFakeDocs } from '../../../apps/hub/src/docs/fake-docs.js';
import { createFakeGraphs } from '../../../apps/hub/src/graphs/fake-graphs.js';
import { createFakeGraphRuns } from '../../../apps/hub/src/graph-runs/fake-graph-runs.js';
import { createProjects, type Projects } from '../../../apps/hub/src/projects/projects.js';
import { createSessions, type Sessions } from '../../../apps/hub/src/sessions/sessions.js';
import { createTasks } from '../../../apps/hub/src/tasks/tasks.js';
import { createTerminal } from '../../../apps/hub/src/terminal/terminal.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/machine-load/fake-machine-probe.js';

/**
 * A start, from a client's frame to a process on another machine and back.
 *
 * Everything but the wire and the pty is the shipped code: two paired servers
 * with the same volume mounted, a real handshake in both directions, both
 * parsers, the real reducer, the real broadcast, and the real terminal manager
 * with its one-live-process-per-session rule. What is faked is what a test
 * cannot supply -- a socket, a forked process, a provider's files on disk --
 * and each of those is an implementation of a seam rather than a mock.
 *
 * The questions it exists to answer are the ones that only appear once there is
 * more than one machine: where does an unaddressed start land, does the user's
 * override survive the trip, is the second start on a live session refused with
 * the holder named, and does a stop find the owner without anybody naming a
 * process. The last assertion in the file is about the wire itself: no frame in
 * any direction carries an argv, an environment, an operation name or a process
 * handle, because the shape of the protocol has nowhere to put one.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = storeIdSchema.parse('store-work');

/**
 * What every machine in this fleet will let a client browse.
 *
 * Named here because the wire-shape assertion at the bottom of the file is
 * about it: the rule that lets a directory cross is that it is under a root the
 * server operator configured, so the test that says no instruction carries a
 * cwd now also says that every directory one does carry is under one of these.
 */
const BROWSE_ROOTS = ['/volumes/work'] as const;

/**
 * A checkout under the root, which is what a project is.
 *
 * Under `/volumes/work` and not equal to it, so that the two sessions already
 * in the store -- which ran at the volume's own path -- stay at the root when
 * this project is made. A project that swallowed them would make the placement
 * assertion below true for the wrong reason.
 */
const PROJECT_DIRECTORY = '/volumes/work/agentplex';

/**
 * A directory that exists on these machines and is under no browse root.
 *
 * It exists deliberately. A path that was simply missing would be refused by
 * the first check in the rule, and the refusal this file is about is the second
 * one: the operator did not list this, so nothing spawns in it.
 */
const UNLISTED_DIRECTORY = '/elsewhere/secret';

/** A store both machines have mounted: one volume, two servers attached. */
function storeOn(path: string): StoreDescriptor {
  return { storeId: WORK, path };
}

/**
 * The transcripts both machines can see when a hub first dials.
 *
 * `session-quiet` is waiting on a person, which is when stopping is safe.
 * `session-busy` is mid-turn. Both ran at the volume's own path, which is what
 * a session that belongs to no project looks like.
 *
 * Nothing here stands in for a session that has just been spawned. That one is
 * written by `providerWrites` at the moment a test spawns, because when it
 * appears is the whole of what the placement depends on: a transcript that was
 * already on disk when the hub first read the store is a session the tree
 * placed before anybody made a project, and it stays where it was put.
 */
function transcripts(): Record<string, string> {
  const at = (signal: string, updatedAt: number, cwd = '/volumes/work'): string =>
    JSON.stringify({ signal, updatedAt, cwd });

  return {
    '/volumes/work/claude/sessions/session-quiet.json': at('awaiting-input', START - 5_000),
    '/volumes/work/claude/sessions/session-busy.json': at('progressing', START - 5_000),
  };
}

/**
 * The provider writing its transcript as a spawned session comes up.
 *
 * Dated at the moment a terminal opened, which is what lets the scan afterwards
 * join the two: a session whose provider first wrote to it at or after a
 * terminal started, that no live terminal already holds, is that terminal's.
 *
 * It is the disk both machines read, because both have the volume mounted.
 */
function providerWrites(sessionId: string, cwd: string): void {
  for (const one of held().machines.values()) {
    one.transcripts[`/volumes/work/claude/sessions/${sessionId}.json`] = JSON.stringify({
      signal: 'awaiting-input',
      updatedAt: START,
      cwd,
    });
  }
}

interface Machine {
  readonly label: string;
  readonly terminals: TerminalManager;
  readonly ptys: FakePtyFactory;
  /**
   * The provider's files on this machine's volume, written to mid-run.
   *
   * On the machine and not on the connection, because that is what a disk is: a
   * hub that reconnects finds the transcripts it left, not a fresh volume.
   */
  readonly transcripts: Record<string, string>;
  /**
   * What this machine's startup preflight found, as its handshake reports it.
   *
   * Mutable, because the interesting case is a fleet where one box has the
   * provider and another does not, and the hub has to be shown telling them
   * apart on the same volume.
   */
  providers: readonly ProviderReadiness[];
  /**
   * This machine's own end of the connection it currently has, or `null`
   * before the first dial.
   *
   * The one thing a machine needs that is not durable, and it is here for the
   * case the durable half exists for: pulling the wire on a machine with an
   * agent alive on it, or losing it in the gap between a fork and the
   * transcript that names it. A test can close a socket and a test cannot
   * close a connection any other way -- the hub's own `stop()` is a shutdown
   * and never comes back.
   */
  socket: FakeMessageSocket | null;
  /** Every frame this machine sent to the hub, and every one it received. */
  readonly sentToHub: string[];
  readonly sentToServer: string[];
}

interface Harness {
  readonly state: FleetState;
  readonly sessions: Sessions;
  readonly clients: Clients;
  readonly connections: Servers;
  readonly catalogue: Catalogue;
  readonly projects: Projects;
  readonly machines: ReadonlyMap<string, Machine>;
  readonly timers: FakeTimers;
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

function registrationOf(label: string): ServerRegistrationId {
  return `registration-${label}` as ServerRegistrationId;
}

/**
 * One machine's durable half: its terminals and the processes under them.
 *
 * Built once and kept across every dial, because that is what a server is. A
 * hub that reconnects finds the agents it left running, not a fresh manager
 * that has forgotten them.
 */
function buildMachine(label: string, providers: readonly ProviderReadiness[]): Machine {
  const ptys = createFakePtyFactory();
  const supervisor = createPtySupervisor({
    pty: ptys,
    clock,
    ids: { newId: () => `${label}-run-${ptys.ptys.length}` },
    environment: { PATH: '/usr/bin' },
  });
  const terminals = createTerminalManager({ supervisor, clock, timers: createFakeTimers() });

  return {
    label,
    terminals,
    ptys,
    transcripts: transcripts(),
    providers,
    socket: null,
    sentToHub: [],
    sentToServer: [],
  };
}

/**
 * What these machines will let a hub look at, and spawn in.
 *
 * One browser per connection here rather than one per machine, because a
 * connection is what a test re-opens; the roots are the same list either way,
 * and the rule this file exercises is about the list rather than about who
 * holds it.
 */
function directoryBrowser(): ReturnType<typeof createDirectoryBrowser> {
  return createDirectoryBrowser({
    roots: [...BROWSE_ROOTS],
    reader: createFakeDirectoryReader({
      directories: {
        '/volumes/work': [{ name: 'agentplex', kind: 'directory' }],
        [PROJECT_DIRECTORY]: [],
        [UNLISTED_DIRECTORY]: [],
      },
    }),
  });
}

/** One connection to that machine: a fresh socket, and the store as it reads it. */
function serveMachine(machine: Machine): DialResult {
  // Re-read on every call rather than snapshotted, which is what makes this a
  // disk rather than a fixture: a scan after a spawn sees the transcript the
  // provider has since written.
  const files: ProviderFiles = {
    readFile: (path) => createFakeProviderFiles({ files: machine.transcripts }).readFile(path),
    listDirectory: (path) =>
      createFakeProviderFiles({ files: machine.transcripts }).listDirectory(path),
    readFileTail: (path, maxBytes) =>
      createFakeProviderFiles({ files: machine.transcripts }).readFileTail(path, maxBytes),
    stat: (path) => createFakeProviderFiles({ files: machine.transcripts }).stat(path),
  };
  const adapter = createFakeProviderAdapter({ provider: 'claude', files });
  const stores = [storeOn('/volumes/work')];
  const { hubEnd, serverEnd } = createSocketPair();

  serveServerEnd(serverEnd, {
    identity: {
      serverId: serverIdSchema.parse(`server-${machine.label}`),
      token: `tok-${machine.label}`,
    },
    // The roots this fleet browses under, so that a directory on any frame in
    // this file has something real to be checked against.
    browse: directoryBrowser(),
    stores,
    providers: machine.providers,
    // The same terminals the controller starts into: a subscription resolves
    // a session through the manager that holds the process.
    terminals: machine.terminals,
    machineLoad: createFakeMachineLoadReader(),
    sessions: createSessionController({
      stores,
      providers: createProviderRegistry([adapter]),
      terminals: machine.terminals,
      workingTree: createFakeWorkingTree(),
      // The same rule the browse above passes, so a spawn in a project is
      // bounded by the list this machine's operator wrote and by nothing else.
      browse: directoryBrowser(),
      // No hook socket in these suites: what a launch is handed before it
      // starts has its own tests on the server side.
      approvals: null,
      clock,
      logger,
    }),
    logger,
  });

  // What each end put on the wire, captured for the frame-shape assertions.
  const originalHubSend = hubEnd.send.bind(hubEnd);
  const capturing = {
    ...hubEnd,
    send(text: string): void {
      machine.sentToServer.push(text);
      originalHubSend(text);
    },
  };
  serverEnd.onMessage(() => {});
  hubEnd.onMessage((text) => machine.sentToHub.push(text));
  machine.socket = serverEnd;

  return { ok: true, socket: capturing };
}

/**
 * The whole fleet, its hub, and a client-facing broadcast over the lot.
 *
 * `preflightOf` is what each machine's startup preflight found. A parameter
 * rather than a constant because the interesting case is a fleet where a box
 * cannot run what it is being asked for, and that has to be true before the
 * handshake -- which is the only moment a server ever states it.
 */
async function start(
  preflightOf: (label: string) => readonly ProviderReadiness[] = () => [readyProvider('claude')],
): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`session-start-${suite}`);
  const database = migrated.database;

  const machines = new Map<string, Machine>();
  for (const label of ['attic', 'workshop']) {
    machines.set(label, buildMachine(label, preflightOf(label)));
    await registerServer(
      database,
      { newId: () => registrationOf(label) },
      clock,
      newServerRegistrationSchema.parse({
        label,
        address: `wss://${label}.example:8443`,
        token: `tok-${label}`,
      }),
    );
  }

  const dialer: SocketDialer = {
    dial: async (address: string): Promise<DialResult> => {
      const machine = machines.get(new URL(address).hostname.split('.')[0] ?? '');
      if (machine === undefined) return { ok: false, problem: 'connection refused' };
      return serveMachine(machine);
    },
  };

  const timers = createFakeTimers();
  const state = createFleetState({ logger });

  // Counted rather than constant: one source mints the hub's node ids, and a
  // fleet that reports three sessions and then has a project made in it mints
  // four keys. A source that answered twice with one string would have the
  // second insert collide and take a whole reading down with it.
  let minted = 0;
  const ids = { newId: () => `node-${String((minted += 1))}` };

  // Built before it dials, which is the same order `hub.ts` composes in: the
  // broadcast below has to be attached to the state before the first
  // connectivity change can reach it.
  const pairing = createPairing({
    database,
    files: createFakeStoreFiles(),
    ids: { newId: () => 'unused' },
    clock,
    logger,
  });

  const connections = createServers({
    pairing,
    dialer,
    hubId: 'hub-under-test' as never,
    timers,
    clock,
    logger,
    backoff: createExponentialBackoff({ baseMs: 500, maxMs: 8_000, random: () => 0 }),
    onChange: (report) => state.applyConnection(report),
    onReport: (report) => {
      const accepted = state.applySessions({
        registrationId: report.registrationId,
        storeId: report.storeId,
        sessions: report.sessions,
        holding: report.holding,
        reportedAt: clock.now(),
      });
      // The same wiring `hub.ts` does, because the tree following a report is
      // the half of the placement this file is about. Read through the closure
      // rather than captured: the catalogue is built below, and nothing
      // reports until `sync` at the end of this function.
      if (accepted) void catalogue.observe(report.storeId);
      terminal.noteStarts(report.registrationId, report.storeId, report.starts);
      // The other reader of the same tags, wired as `hub.ts` wires it: a
      // spawn's task has been waiting under its start handle since the start,
      // because until this report there was no session to file it under.
      void tasks.noteStarts(report.storeId, report.starts);
    },
    onStream: (registrationId, output) => terminal.deliver(registrationId, output),
  });

  // The relay, composed as `hub.ts` composes it. This suite asserts nothing
  // about terminals -- `terminal-relay.integration.test.ts` is where those
  // scenarios are -- but it runs the real thing rather than a fake, so that a
  // start's answer and the handle the relay files under it are produced by the
  // same code path a hub actually runs.
  const terminal = createTerminal({ state, servers: connections, logger });

  // The real feature over the real migrated schema, because the rows are the
  // subject here: a project is made by a client frame in one of the suites
  // below, and the directory a start carries is read back out of that row.
  const projects = createProjects({
    database,
    ids,
    clock,
    state,
    connections,
    logger,
    onTreeChanged: () => catalogue.changed(),
  });

  // The tree, so that "the session appeared under the project" is something
  // this file can read rather than something it has to take on trust.
  const catalogue = createCatalogue({
    database,
    ids,
    clock,
    logger,
    readStore: (storeId) => state.storeSessions(storeId),
    projects,
    // Nothing here removes a node, and a holder is only read to refuse one.
    readHolder: () => null,
    // Nothing here queries the catalogue either; the fleet is the reducer's
    // own published view, which is the one a query would read.
    readFleet: () => state.published(),
  });

  // The real table over the real migrated schema, because what a client is
  // shown on the row is what this suite now asserts: a task that came from a
  // fake would only ever agree with the fake.
  const tasks = createTasks({
    database,
    logger,
    onChanged: (ref, task) => state.applyTask(ref, task),
  });

  // The same id source the tree is built from, because `hub.ts` hands
  // `createSessions` that one: a start handle and a node id are both names this
  // hub mints, and two sources would be two answers to "who names a thing here".
  const sessions = createSessions({
    state,
    projects,
    connections,
    ids,
    logger,
    onStarted: (started) => tasks.noteStart(started),
  });

  const clients = createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers,
    logger,
    readLayout: () => catalogue.readLayout(),
    readPaneLayout: async () => null,
    writePaneLayout: async () => undefined,
    sessions,
    // The same two seams `hub.ts` hands the broadcast. Pairing is not this
    // file's subject -- it is the one the client-pairing suite is about -- but
    // a broadcast built without them would be a different broadcast.
    // Not this suite's subject; the fake keeps the rows in memory and answers
    // the two frames the way the real feature does.
    attention: createFakeAttention(),
    // Nothing in this file answers an approval; a broadcast built without the
    // seam would be a different broadcast from the one the hub runs.
    approvals: createFakeApprovals(),
    approvalPolicy: createFakeApprovalPolicy(),
    pairing,
    syncServers: () => connections.sync(),
    projects,
    catalogue,
    // Not the subject: a start is what this file is about, and the fake is what
    // a suite stands on when a seam is not its subject.
    docs: createFakeDocs(),
    graphs: createFakeGraphs(),
    graphRuns: createFakeGraphRuns(),
    terminal,
    // No push: none of these suites is about it, and a broadcast whose push
    // seam is absent is not the broadcast the hub builds.
    push: null,
  });

  await connections.sync();

  return { state, sessions, clients, connections, catalogue, projects, machines, timers };
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

/** A client on a socket, driven by hand and read back through the real parser. */
interface Client {
  say(frame: ClientFrame): Promise<void>;
  /** What the hub sent this client, parsed by the parser a client would use. */
  readonly received: readonly HubFrame[];
  /** What this client put on the wire, as raw text. */
  readonly said: readonly string[];
  readonly states: readonly MachineState[];
  reply(id: number): HubFrame;
  row(sessionId: string): SessionRow | undefined;
}

async function attach(): Promise<Client> {
  const socket = createFakeMessageSocket();
  const received: HubFrame[] = [];
  const said: string[] = [];
  socket.onMessage(() => {});
  held().clients.attach(socket);

  // Read back with the parser that owns this direction: a frame a client cannot
  // parse has not been sent in any sense that matters.
  const readAll = (): HubFrame[] =>
    socket.sent.map((text) => {
      const parsed = parseTextFrame(parseHubFrame, text);
      if (!parsed.ok) throw new Error(`the hub sent an unparseable frame: ${parsed.reason}`);
      return parsed.value;
    });

  const client: Client = {
    async say(frame: ClientFrame): Promise<void> {
      const text = JSON.stringify(frame);
      said.push(text);
      socket.receive(text);
      // Two turns of the loop: the fake socket delivers asynchronously, and an
      // answer that crosses to another machine and back takes more than one.
      for (let turn = 0; turn < 40; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      received.length = 0;
      received.push(...readAll());
    },
    get received(): readonly HubFrame[] {
      return received;
    },
    get said(): readonly string[] {
      return said;
    },
    get states(): readonly MachineState[] {
      return readAll()
        .filter((frame) => frame.type === 'machine-state')
        .map((frame) => frame.state);
    },
    reply(id: number): HubFrame {
      const answer = readAll().find((frame) => 'replyTo' in frame && frame.replyTo === id);
      if (answer === undefined) throw new Error(`nothing answered frame ${id}`);
      return answer;
    },
    row(sessionId: string): SessionRow | undefined {
      const state = toMachineState(held().state.snapshot());
      return state.stores
        .flatMap((store) => store.sessions)
        .find((row) => row.descriptor.sessionId === sessionId);
    },
  };

  await client.say({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION });
  return client;
}

/** Every terminal a machine actually opened, as the pty request recorded it. */
function launches(machine: Machine): readonly (readonly string[])[] {
  return machine.ptys.opened.map((request) => request.args);
}

/** The tree as a client would be answered it, right now. */
async function layoutNow(): Promise<Layout> {
  return held().catalogue.readLayout();
}

/** One session's node in that tree, or `undefined` when nothing points at it. */
async function nodeFor(sessionId: string): Promise<LayoutNode | undefined> {
  return (await layoutNow()).find((node) => node.anchor?.sessionId === sessionId);
}

/**
 * Waits for a session's node to be filed under one parent.
 *
 * Polled rather than awaited on a promise, because the tree write is
 * deliberately behind the reply: the hub answers a report with the fleet state
 * and the broadcast, and follows the tree after. A test that awaited the start
 * and then read once would be racing the design.
 */
async function untilFiledUnder(sessionId: string, parentId: NodeId): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if ((await nodeFor(sessionId))?.parentId === parentId) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${sessionId} to be filed under ${String(parentId)}`);
}

function machine(label: string): Machine {
  const found = held().machines.get(label);
  if (found === undefined) throw new Error(`no machine ${label}`);
  return found;
}

describe('a client-initiated session start', () => {
  beforeEach(async () => {
    harness = await start();
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'both servers to be connected',
    );
    await until(
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) === 2,
      'both servers to have reported the store',
    );
  });

  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('lands on a server the hub chose, and the session comes back held by it', async () => {
    const client = await attach();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: null,
      server: null,
      project: null,
    });

    const answer = client.reply(2);
    expect(answer.type).toBe('session-started');
    if (answer.type !== 'session-started') return;
    expect(answer.sessionId).toBe('session-quiet');

    // The machine the hub named is the machine that forked something.
    const chosen = answer.server === registrationOf('attic') ? 'attic' : 'workshop';
    const other = chosen === 'attic' ? 'workshop' : 'attic';
    expect(launches(machine(chosen))).toEqual([['--resume', 'session-quiet']]);
    expect(launches(machine(other))).toEqual([]);

    // And the state every client is sent says who is holding it.
    expect(client.row('session-quiet')?.holder).toEqual({
      server: answer.server,
      stoppable: true,
      pause: 'none',
    });
  });

  it('starts a new session where the hub sent it, and finds the id the provider wrote', async () => {
    const client = await attach();
    // The provider writes its transcript as it comes up, which is the only way
    // a spawn ever acquires a session id: naming one up front would mean
    // `--session-id`, the flag that splits a history in two.
    providerWrites('session-fresh', '/volumes/work');

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: 'look at the failing test',
      server: registrationOf('workshop'),
      project: null,
    });

    const answer = client.reply(2);
    expect(answer.type).toBe('session-started');

    // A spawn carries the prompt as one argv element and no session id: naming
    // one would mean `--session-id`, the flag that splits a history in two.
    expect(launches(machine('workshop'))).toEqual([['look at the failing test']]);

    // The scan after the start joined the terminal to the transcript the
    // provider wrote as it came up, so the hub knows which session is held.
    expect(client.row('session-fresh')?.holder).toEqual({
      server: registrationOf('workshop'),
      stoppable: true,
      pause: 'none',
    });
  });

  it('tells a client what a session was started to do, and nothing about one it found', async () => {
    const client = await attach();
    providerWrites('session-fresh', '/volumes/work');

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: 'fix the auth refresh loop and open a PR against main',
      server: registrationOf('workshop'),
      project: null,
    });
    expect(client.reply(2).type).toBe('session-started');

    // A state frame is coalesced behind a timer, so the broadcast the task is
    // on is one this test has to let out.
    await until(
      () => client.row('session-fresh')?.task !== undefined,
      'the hub to file the task under the session the provider named',
    );
    held().timers.fireAll();
    await new Promise((resolve) => setImmediate(resolve));

    // Read off the state this client was actually sent, not off the reducer:
    // what the panel draws is what crossed the wire and came back through the
    // client's own parser.
    const sent = client.states.at(-1);
    const rows = sent?.stores.flatMap((store) => store.sessions) ?? [];

    // The spawn had no session id when it was started, so this task waited
    // under its start handle until the report that named the session carried
    // the pair. That it is here is the whole of the rebinding working.
    expect(rows.find((row) => row.descriptor.sessionId === 'session-fresh')?.task).toBe(
      'fix the auth refresh loop and open a PR against main',
    );

    // And a session this hub merely found in the store says so. Its transcript
    // opens with something -- every transcript does -- and a row that showed it
    // here would be claiming a purpose nobody stated.
    expect(rows.find((row) => row.descriptor.sessionId === 'session-quiet')?.task).toBeNull();
  });

  it('honours the machine the user picked', async () => {
    const client = await attach();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: null,
      server: registrationOf('attic'),
      project: null,
    });

    expect(client.reply(2)).toMatchObject({
      type: 'session-started',
      server: registrationOf('attic'),
    });
    expect(launches(machine('attic'))).toEqual([['--resume', 'session-quiet']]);
    expect(launches(machine('workshop'))).toEqual([]);
  });

  it('refuses a second start on a live session, and names the machine holding it', async () => {
    const client = await attach();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: null,
      server: registrationOf('attic'),
      project: null,
    });
    expect(client.reply(2).type).toBe('session-started');

    // The second start picks the other machine deliberately: it has the same
    // volume mounted and is running nothing, so only the hub can know that
    // starting there would put two agents on one transcript.
    await client.say({
      type: 'session-start',
      id: 3,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: null,
      server: registrationOf('workshop'),
      project: null,
    });

    const refused = client.reply(3);
    expect(refused).toMatchObject({
      type: 'refusal',
      code: 'refused',
      holder: { server: registrationOf('attic'), stoppable: true, pause: 'none' },
    });
    expect(launches(machine('workshop'))).toEqual([]);
    // One process, still the first one.
    expect(machine('attic').ptys.ptys[0]?.kills).toBe(0);
  });

  it('stops a session the client addressed, resolving the owner hub-side', async () => {
    const client = await attach();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: null,
      server: registrationOf('attic'),
      project: null,
    });
    expect(client.reply(2).type).toBe('session-started');

    // The client names the session and nothing else: no machine, no terminal,
    // no pid. Everything needed to find the process is resolved on the way.
    await client.say({
      type: 'session-stop',
      id: 3,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
    });

    expect(client.reply(3)).toMatchObject({
      type: 'session-stopped',
      sessionId: 'session-quiet',
      server: registrationOf('attic'),
    });
    expect(machine('attic').ptys.ptys[0]?.kills).toBe(1);

    // A signalled child is not a dead one yet, so the session is still held at
    // the moment the stop is answered. It stops being held when the process
    // actually goes, which the next scan of that store is what notices.
    machine('attic').ptys.ptys[0]?.close({ exitCode: 0, signal: 15 });
    await client.say({
      type: 'session-stop',
      id: 4,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
    });

    expect(client.reply(4)).toMatchObject({ type: 'refusal', code: 'refused' });
    expect(client.row('session-quiet')?.holder).toBeNull();
  });

  it('gives a busy holder no stop, in the state and again when one is asked for', async () => {
    const client = await attach();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-busy'),
      provider: 'claude',
      prompt: null,
      server: registrationOf('workshop'),
      project: null,
    });
    expect(client.reply(2).type).toBe('session-started');

    // The fact a client renders the button from.
    expect(client.row('session-busy')?.holder).toEqual({
      server: registrationOf('workshop'),
      stoppable: false,
      pause: 'none',
    });

    // And the rule behind it, for every client that asks anyway.
    await client.say({
      type: 'session-stop',
      id: 3,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-busy'),
    });

    expect(client.reply(3)).toMatchObject({
      type: 'refusal',
      code: 'refused',
      holder: { server: registrationOf('workshop'), stoppable: false, pause: 'none' },
    });
    expect(machine('workshop').ptys.ptys[0]?.kills).toBe(0);
  });

  it('refuses a start for a store no paired server has mounted', async () => {
    const client = await attach();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: storeIdSchema.parse('store-nowhere'),
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: null,
      project: null,
    });

    expect(client.reply(2)).toMatchObject({ type: 'refusal', code: 'refused', holder: null });
    expect(launches(machine('attic'))).toEqual([]);
    expect(launches(machine('workshop'))).toEqual([]);
  });

  /**
   * The whole of AGX-133, in one conversation.
   *
   * A client makes a project, starts a session in it, and the session turns up
   * in the tree underneath it. Every hop is the shipped code: the hub writes
   * two rows and answers a node id, resolves that id to a directory, sends it
   * on the instruction; the real server refuses it unless a root its operator
   * configured is above it, and spawns there; the scan that follows reports the
   * `cwd` the session ran in, and the tree files it under the project keyed by
   * exactly that string.
   */
  it('starts a session in a project, and the tree files it under the project', async () => {
    const client = await attach();

    await client.say({
      type: 'project-create',
      id: 2,
      name: 'agentplex',
      directory: PROJECT_DIRECTORY,
    });
    const made = client.reply(2);
    expect(made.type).toBe('project-created');
    if (made.type !== 'project-created') return;

    providerWrites('session-fresh', PROJECT_DIRECTORY);
    await client.say({
      type: 'session-start',
      id: 3,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: registrationOf('workshop'),
      project: made.nodeId,
    });

    const answer = client.reply(3);
    expect(answer.type).toBe('session-started');

    // The instruction carried the directory, and only the directory: the client
    // named a node, and the hub is the only party that turned one into a path.
    const instruction = instructionsTo('workshop').find((frame) => frame.type === 'session-start');
    expect(instruction).toMatchObject({ directory: PROJECT_DIRECTORY });

    // And the spawn ran there. The pty request is the far end of the field:
    // `cwd`, and nothing else on the plan came off a frame.
    expect(machine('workshop').ptys.opened[0]).toMatchObject({ cwd: PROJECT_DIRECTORY, args: [] });
    expect(launches(machine('attic'))).toEqual([]);

    // The session the provider wrote as it came up reports that directory, and
    // the next reading of the store puts its node inside the project.
    await untilFiledUnder('session-fresh', made.nodeId);

    // The sessions that were already in the store ran at the volume's own path
    // and stay where they were put. Discovery writes placement once, at
    // creation, and these were created before anybody made a project.
    expect((await nodeFor('session-quiet'))?.parentId).toBeNull();
  });

  it('refuses a start in a project no machine will open, naming the directory', async () => {
    const client = await attach();

    await client.say({
      type: 'project-create',
      id: 2,
      name: 'somewhere else',
      directory: UNLISTED_DIRECTORY,
    });
    const made = client.reply(2);
    // The hub took it. It names no server, holds nobody's root list, and a copy
    // of one here would be a second answer to a question only a machine can
    // answer -- so the refusal belongs at start time and not at create time.
    expect(made.type).toBe('project-created');
    if (made.type !== 'project-created') return;

    await client.say({
      type: 'session-start',
      id: 3,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: registrationOf('workshop'),
      project: made.nodeId,
    });

    const refused = client.reply(3);
    expect(refused).toMatchObject({ type: 'refusal', code: 'refused' });
    if (refused.type !== 'refusal') return;
    // The machine's own sentence, naming the path the person picked. The hub
    // does not rewrite it: the words that know which box this was and which
    // setting an operator would change are the only ones worth sending.
    expect(refused.message).toContain(UNLISTED_DIRECTORY);
    expect(launches(machine('workshop'))).toEqual([]);
  });

  it('refuses a resume in a project rather than choosing one of two directories', async () => {
    const client = await attach();

    await client.say({
      type: 'project-create',
      id: 2,
      name: 'agentplex',
      directory: PROJECT_DIRECTORY,
    });
    const made = client.reply(2);
    if (made.type !== 'project-created') throw new Error('the project was not made');

    await client.say({
      type: 'session-start',
      id: 3,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: null,
      server: registrationOf('workshop'),
      project: made.nodeId,
    });

    expect(client.reply(3)).toMatchObject({ type: 'refusal', code: 'refused' });
    expect(launches(machine('workshop'))).toEqual([]);
    // Nothing was even asked: a resume's directory is its transcript's, so
    // there was no version of this the machine could have been sent.
    expect(instructionsTo('workshop').filter((frame) => frame.type === 'session-start')).toEqual(
      [],
    );
  });

  it('refuses a start naming a project this hub does not have', async () => {
    const client = await attach();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: null,
      project: nodeIdSchema.parse('node-nowhere'),
    });

    expect(client.reply(2)).toMatchObject({ type: 'refusal', code: 'refused', holder: null });
    expect(launches(machine('attic'))).toEqual([]);
    expect(launches(machine('workshop'))).toEqual([]);
  });

  it('puts no argv, environment, operation name or process handle on any wire', async () => {
    const client = await attach();

    await client.say({
      type: 'project-create',
      id: 2,
      name: 'agentplex',
      directory: PROJECT_DIRECTORY,
    });
    const made = client.reply(2);
    if (made.type !== 'project-created') throw new Error('the project was not made');

    // A start in a project, so that the directory assertion at the bottom
    // stands over an instruction that actually carries one rather than over an
    // absence.
    await client.say({
      type: 'session-start',
      id: 5,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: registrationOf('attic'),
      project: made.nodeId,
    });

    await client.say({
      type: 'session-start',
      id: 3,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: 'look at the failing test',
      server: registrationOf('workshop'),
      project: null,
    });
    await client.say({
      type: 'session-stop',
      id: 4,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
    });

    // Both hub-facing directions, both server-facing ones, parsed by the parser
    // that owns each rather than by `JSON.parse`: what is asserted on is what a
    // peer would actually read.
    const clientToHub = client.said.map((text) => parsed(parseClientFrame, text));
    const hubToClient = client.received;
    const hubToServer = [...held().machines.values()].flatMap((one) =>
      one.sentToServer.map((text) => parsed(parseHubToServerFrame, text)),
    );
    const serverToHub = [...held().machines.values()].flatMap((one) =>
      one.sentToHub.map((text) => parsed(parseServerToHubFrame, text)),
    );

    expect(hubToServer.some((frame) => frame.type === 'session-start')).toBe(true);
    expect(hubToServer.some((frame) => frame.type === 'session-stop')).toBe(true);

    // A process handle is meaningless off the machine that owns it, and an
    // argv, an environment or an operation name off a wire is the `{ command }`
    // frame the operation registry exists to prevent. The walk is shared with
    // every other suite that produces frames, so a frame a later ticket adds is
    // swept by the same rule rather than by a copy of it.
    for (const frame of [...clientToHub, ...hubToClient, ...hubToServer, ...serverToHub]) {
      expect(forbiddenKeysIn(frame), `${frame.type} carried a forbidden key`).toEqual([]);
    }

    // `cwd` is the one word with two meanings, so it is checked by direction
    // rather than by name. A session descriptor carries it as a label the user
    // reads; no instruction may carry it at all, because a `{ cwd }` field on an
    // instruction is a remote code execution primitive wearing a path.
    for (const frame of [...clientToHub, ...hubToServer]) {
      expect(keysOf(frame), `${frame.type} carried a cwd`).not.toContain('cwd');
    }

    // And the half of the amended rule that is not an absence. A directory may
    // cross, as a `directory` field and only as one, and every such field on an
    // instruction the hub puts to a server is either null or under a root that
    // server's operator configured. The project start above is what makes this
    // stand over a value rather than over an absence.
    expect(
      hubToServer.some(
        (frame) =>
          frame.type === 'session-start' && 'directory' in frame && frame.directory !== null,
      ),
    ).toBe(true);
    expectDirectoriesWithin(hubToServer, BROWSE_ROOTS);
  });
});

/**
 * The negative case, end to end.
 *
 * AGX-68 established that a pty cannot report this: the fork succeeds, the
 * program fails to resolve on the far side of it, and what the user gets is a
 * session that appears and vanishes with a nonzero code and no output. So the
 * claim being made here is not that the start fails -- it always did -- but
 * that it fails as a sentence, before anything is forked, and that the machine
 * is told nothing at all.
 */
describe('a session start against a machine with no such provider installed', () => {
  beforeEach(async () => {
    harness = await start(() => [missingProvider('claude')]);
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'both servers to be connected',
    );
  });

  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('refuses the start with a named reason and forks nothing anywhere', async () => {
    const client = await attach();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: 'look at the failing test',
      server: null,
      project: null,
    });

    const answer = client.reply(2);
    expect(answer).toMatchObject({ type: 'refusal', code: 'refused', holder: null });
    if (answer.type !== 'refusal') return;
    // A sentence naming the machine and the provider, not "the machine said no".
    expect(answer.message).toContain('claude');
    expect(answer.message).toMatch(/attic|workshop/);

    // Nothing was started, and nothing was even asked. A refusal that still
    // sent the instruction would be a pty forked into a program that is not
    // there, which is the failure this whole path exists to remove.
    expect(launches(machine('attic'))).toEqual([]);
    expect(launches(machine('workshop'))).toEqual([]);
    for (const label of ['attic', 'workshop']) {
      const instructions = machine(label)
        .sentToServer.map((text) => parsed<{ type: string }>(parseHubToServerFrame, text))
        .filter((frame) => frame.type === 'session-start');
      expect(instructions, `${label} was told to start something`).toEqual([]);
    }
  });

  it('still lists that machine, its stores and its sessions', async () => {
    // An unusable provider costs itself. A server whose claude is missing is
    // not a server that has disappeared: its transcripts are still readable,
    // its stores still mounted, and everything already on disk still shown.
    const client = await attach();
    const state = client.states.at(-1);

    expect(state?.stores[0]?.sessions.length).toBeGreaterThan(0);
    expect(state?.servers.map((server) => server.label).sort()).toEqual(['attic', 'workshop']);
  });

  it('publishes why, so the settings screen can say it before anybody taps start', async () => {
    const client = await attach();
    const state = client.states.at(-1);

    expect(state?.servers[0]?.providers).toEqual([
      {
        provider: 'claude',
        state: 'missing',
        version: null,
        directory: null,
        problem: expect.any(String),
      },
    ]);
  });
});

/**
 * A hub that comes back to a machine it left running.
 *
 * The harness has always built each machine's terminals once and kept them
 * across every dial, because that is what a server is: a connection is a
 * socket, and the processes underneath it outlive one. Nothing pulled the wire
 * with an agent alive on the far side, and that is the case the one-writer rule
 * is most exposed to. The hub keeps no durable memory of who is holding what --
 * deliberately, since a table of holds outlives the process that wrote it and
 * would present a dead machine's agents as running -- so after a drop the only
 * thing in the world that can restore the fact is the machine saying it again.
 */
describe('a hub that reconnects to a machine holding a live session', () => {
  beforeEach(async () => {
    harness = await start();
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'both servers to be connected',
    );
    await until(
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) === 2,
      'both servers to have reported the store',
    );
  });

  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  /** A session running on that machine, started the way a client starts one. */
  async function startOn(client: Client, label: string): Promise<void> {
    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: null,
      server: registrationOf(label),
      project: null,
    });
    expect(client.reply(2).type).toBe('session-started');
  }

  /**
   * The wire goes, and the hub dials again.
   *
   * The machine is untouched: nothing was told anything, nothing was signalled,
   * and the pty under the terminal manager never hears about it. That is the
   * whole class of event the dial loop exists for -- a hub restart, a network
   * that dropped, a lid that closed -- and the only part of it a test can cause
   * is the socket.
   */
  async function pullThePlug(label: string): Promise<void> {
    machine(label).socket?.close(PEER_GONE);
    await until(() => phaseOf(label) === 'stale', `${label} to be seen as dropped`);
    held().timers.fireAll();
    await until(() => phaseOf(label) === 'connected', `${label} to be dialled again`);
  }

  it('is told what the machine is still holding, in the first report after the handshake', async () => {
    const client = await attach();
    await startOn(client, 'attic');

    const attic = machine('attic');
    const reportsBeforeTheDrop = storeReports(attic).length;
    await pullThePlug('attic');
    await until(
      () => storeReports(attic).length > reportsBeforeTheDrop,
      'a store report on the new connection',
    );

    // Same terminal, same process: a reconnect starts nothing and kills
    // nothing, and the agent has been working through all of it.
    expect(attic.ptys.ptys).toHaveLength(1);
    expect(attic.ptys.ptys[0]?.kills).toBe(0);

    // The hold is on the report the fresh handshake produced, which is the only
    // place it could come from.
    expect(storeReports(attic).at(-1)?.holding).toEqual([
      { sessionId: 'session-quiet', stoppable: true, pause: 'none' },
    ]);

    await until(
      () => client.row('session-quiet')?.holder !== null,
      'the holder to be published again',
    );
    expect(client.row('session-quiet')).toMatchObject({
      reachable: true,
      holder: { server: registrationOf('attic'), stoppable: true, pause: 'none' },
    });
  });

  it('refuses a start on the session it came back to, and names the machine that has it', async () => {
    const client = await attach();
    await startOn(client, 'attic');
    await pullThePlug('attic');
    await until(
      () => client.row('session-quiet')?.holder !== null,
      'the holder to be published again',
    );

    // Aimed at the other machine, which has the same volume mounted and is
    // running nothing. Only the hub can know that starting there would put a
    // second agent on a transcript the first one is still writing -- and after
    // a drop it knows it only because the machine said so again.
    await client.say({
      type: 'session-start',
      id: 3,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: null,
      server: registrationOf('workshop'),
      project: null,
    });

    expect(client.reply(3)).toMatchObject({
      type: 'refusal',
      code: 'refused',
      holder: { server: registrationOf('attic'), stoppable: true, pause: 'none' },
    });
    expect(launches(machine('workshop'))).toEqual([]);
    expect(machine('attic').ptys.ptys).toHaveLength(1);
  });
});

/**
 * A fleet whose machines do not agree about what they can run.
 *
 * `start(preflightOf)` has taken a per-machine answer since readiness landed on
 * the handshake, and every call site passes a constant: both ready, or both
 * missing. The case the parameter exists for is this one -- one box on the
 * volume can run the agent and the other cannot -- and it is where the routing
 * rule's branches stop being independent: the filter that schedules around a
 * machine, the override that refuses the machine a person picked anyway, and
 * the line between a reading that means no and one that only means "could not
 * tell".
 *
 * The machine that cannot is `attic` in all but one of these, and that is the
 * half that makes the assertion worth anything. Ties break on label, so a
 * scheduler that had stopped filtering entirely would still land on `attic` and
 * still look right; it is only when the usable machine is the second one that
 * the filter is the thing being read.
 */
describe('a fleet where the machines differ in what they can start', () => {
  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  /** The fleet up, both machines connected and reporting, with a client on it. */
  async function fleetOf(
    preflightOf: (label: string) => readonly ProviderReadiness[],
  ): Promise<Client> {
    harness = await start(preflightOf);
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'both servers to be connected',
    );
    await until(
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) === 2,
      'both servers to have reported the store',
    );
    return attach();
  }

  /** An unaddressed start: the hub picks, which is the whole question here. */
  async function scheduleStart(client: Client, id: number, sessionId: string): Promise<void> {
    await client.say({
      type: 'session-start',
      id,
      storeId: WORK,
      sessionId: sessionIdSchema.parse(sessionId),
      provider: 'claude',
      prompt: null,
      server: null,
      project: null,
    });
  }

  /** A start on the machine a person picked, however that machine is reading. */
  async function startOn(
    client: Client,
    id: number,
    sessionId: string,
    label: string,
  ): Promise<void> {
    await client.say({
      type: 'session-start',
      id,
      storeId: WORK,
      sessionId: sessionIdSchema.parse(sessionId),
      provider: 'claude',
      prompt: null,
      server: registrationOf(label),
      project: null,
    });
  }

  it('schedules past the machine that is missing it, and refuses that machine by name', async () => {
    const client = await fleetOf((label) =>
      label === 'attic' ? [missingProvider('claude')] : [readyProvider('claude')],
    );

    await scheduleStart(client, 2, 'session-quiet');
    expect(client.reply(2)).toMatchObject({
      type: 'session-started',
      server: registrationOf('workshop'),
    });
    expect(launches(machine('workshop'))).toEqual([['--resume', 'session-quiet']]);
    expect(launches(machine('attic'))).toEqual([]);

    // And picked by hand it is still refused, in the machine's own words rather
    // than the hub's guess at what some other box meant.
    await startOn(client, 3, 'session-busy', 'attic');
    expect(client.reply(3)).toMatchObject({
      type: 'refusal',
      code: 'refused',
      holder: null,
      message: 'attic cannot run claude: no directory this server searches holds claude',
    });

    // Never asked, either time. A refusal that still sent the instruction would
    // be a pty forked into a program that is not there.
    expect(instructionsTo('attic')).toEqual([]);
  });

  it('refuses a machine whose agent says it is logged out', async () => {
    const client = await fleetOf((label) =>
      label === 'attic' ? [loggedOutProvider()] : [readyProvider('claude')],
    );

    await scheduleStart(client, 2, 'session-quiet');
    expect(client.reply(2)).toMatchObject({
      type: 'session-started',
      server: registrationOf('workshop'),
    });

    // The binary resolves, so nothing would die at the fork: what would happen
    // is a session sitting at a sign-in prompt instead of doing the work it was
    // asked for, which is a different thing to go and fix and is said as one.
    await startOn(client, 3, 'session-busy', 'attic');
    expect(client.reply(3)).toMatchObject({
      type: 'refusal',
      code: 'refused',
      message: 'attic cannot run claude: claude says it is not logged in',
    });
    expect(launches(machine('attic'))).toEqual([]);
  });

  it('starts on a machine whose reading could not be taken, because that is not a no', async () => {
    // The considered half of the readiness rule, and the only case here where
    // the machine the hub must choose is the first one: `attic` resolved the
    // program and could not read a version out of it, `workshop` does not have
    // it at all. A hub that turned "could not tell" into "no" would refuse the
    // whole store and take a working provider offline the first time its vendor
    // renamed a subcommand.
    const client = await fleetOf((label) =>
      label === 'attic' ? [unreadProvider()] : [missingProvider('claude')],
    );

    await scheduleStart(client, 2, 'session-quiet');
    expect(client.reply(2)).toMatchObject({
      type: 'session-started',
      server: registrationOf('attic'),
    });
    expect(launches(machine('attic'))).toEqual([['--resume', 'session-quiet']]);
    expect(launches(machine('workshop'))).toEqual([]);

    // And the problem is still published, because it is still a fact about the
    // machine that somebody may want to go and look at.
    expect(
      client.states.at(-1)?.servers.find((server) => server.label === 'attic')?.providers,
    ).toEqual([unreadProvider()]);
  });

  it('refuses a machine that never mentioned the provider at all', async () => {
    // A preflight with nothing in it is a build with no adapter for this
    // provider, which is a different thing to fix from a machine with no
    // binary, and the sentence says which it is.
    const client = await fleetOf((label) => (label === 'attic' ? [] : [readyProvider('claude')]));

    await scheduleStart(client, 2, 'session-quiet');
    expect(client.reply(2)).toMatchObject({
      type: 'session-started',
      server: registrationOf('workshop'),
    });

    await startOn(client, 3, 'session-busy', 'attic');
    expect(client.reply(3)).toMatchObject({
      type: 'refusal',
      code: 'refused',
      message: 'attic does not run claude',
    });
    expect(instructionsTo('attic')).toEqual([]);
  });
});

/**
 * The connection dies with an instruction on it.
 *
 * A start is the one thing the hub asks a server for and then waits on, and
 * everything above that wait is a client holding a frame id. The instruction
 * channel settles every outstanding one as an `internal` refusal when the
 * connection ends, and until now nothing drove that from a client frame to the
 * sentence the client reads.
 *
 * `internal` and not `refused`, and that is the decision this is about. A
 * refusal says the machine understood and declined; what actually happened is
 * that the hub does not know. The start may well have run -- the machine below
 * receives it and forks before the socket is gone -- so the answer a person
 * gets has to be one they can retry, and the truth about what is running comes
 * from the next handshake rather than from anything the hub remembers.
 */
describe('a machine that goes away with a start in flight', () => {
  beforeEach(async () => {
    harness = await start();
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'both servers to be connected',
    );
    await until(
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) === 2,
      'both servers to have reported the store',
    );
  });

  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('answers the client in words about the connection, and dials the machine again', async () => {
    const client = await attach();
    const attic = machine('attic');

    // The machine takes the instruction and the wire dies before it can answer.
    // Attached after the server's own listener, so the frame really does reach
    // the thing that acts on it: the server has already begun the start -- it
    // cannot finish one without awaiting -- and the close lands before anything
    // it would send.
    attic.socket?.onMessage((text) => {
      if (parsed<{ type: string }>(parseHubToServerFrame, text).type !== 'session-start') return;
      attic.socket?.close(PEER_GONE);
    });

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: null,
      server: registrationOf('attic'),
      project: null,
    });

    // Answered, and answered now: no timer has been fired in this test, so
    // nothing here waited out the instruction deadline. A client left holding a
    // frame id nothing will ever reply to is the failure this settles.
    expect(client.reply(2)).toMatchObject({
      type: 'refusal',
      code: 'internal',
      holder: null,
      message: 'the connection to the server ended before it answered',
    });

    // The machine is dialled again on the ordinary curve: a socket that ended
    // mid-instruction is a dropped connection like any other.
    await until(() => phaseOf('attic') === 'stale', 'attic to be seen as dropped');
    expect(connectionTo('attic')?.staleReason).toBe('dropped');
    held().timers.fireAll();
    await until(() => phaseOf('attic') === 'connected', 'attic to be dialled again');

    // And what the start actually did is the new handshake's answer rather than
    // anything the hub was holding: it ran, and the machine says so.
    await until(
      () => client.row('session-quiet')?.holder !== null,
      'the machine to report what it is holding',
    );
    expect(client.row('session-quiet')?.holder).toEqual({
      server: registrationOf('attic'),
      stoppable: true,
      pause: 'none',
    });
  });
});

describe('a spawn the hub lost the socket to', () => {
  /**
   * The gap this ticket is about, made into a scenario.
   *
   * The store holds no transcript for the session about to be spawned, so the
   * scan after the fork finds nothing to join it to and the terminal stays
   * unnamed -- which is the real state of a provider that has been forked and
   * has not written its session id yet. The socket then dies in that gap.
   *
   * Before a hub-minted start id, the only name that spawn had was the id of
   * the `session-start` frame on the connection that had just ended, so the
   * hub came back to an agent it had started and could no longer address --
   * forever, if the provider never named the session. The assertion below is
   * that the name survives the socket.
   *
   * Subscribing by that handle is asserted in
   * `terminal-relay.integration.test.ts`, which is where the relay's scenarios
   * are. What is asserted here is the report, which is what the relay reads.
   */
  beforeEach(async () => {
    harness = await start(() => [readyProvider('claude')]);
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'both servers to be connected',
    );
    await until(
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) === 2,
      'both servers to have reported the store',
    );
  });

  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('is still named to the hub on the connection after the one that started it', async () => {
    const client = await attach();
    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: 'look at the failing test',
      server: registrationOf('workshop'),
      project: null,
    });
    expect(client.reply(2).type).toBe('session-started');

    const workshop = machine('workshop');
    const startId = startIdOf(workshop);
    // Nothing named it, which is the state the reconnect has to survive.
    expect(startsIn(workshop).at(-1)).toEqual([{ startId, sessionId: null }]);

    const mark = workshop.sentToHub.length;
    await redial('workshop', mark);

    // The agent is the same one: a dropped socket closes no terminal.
    expect(workshop.ptys.ptys).toHaveLength(1);
    expect(workshop.ptys.ptys[0]?.kills).toBe(0);
    // And the new connection is told what the old one started, under the name
    // the hub itself minted before either socket existed.
    expect(startsIn(workshop, mark)[0]).toEqual([{ startId, sessionId: null }]);
  });

  it('is reported once more, with its session, when the provider finally names it', async () => {
    const client = await attach();
    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: registrationOf('workshop'),
      project: null,
    });
    expect(client.reply(2).type).toBe('session-started');

    const workshop = machine('workshop');
    const startId = startIdOf(workshop);
    // The provider writes its transcript while the hub is away, so the scan on
    // the next connection is the first one that can join the two.
    providerWrites('session-fresh', '/volumes/work');

    const mark = workshop.sentToHub.length;
    await redial('workshop', mark);

    // Told the pair once, on the connection that could learn it, and the hub
    // can join the pending pane to the session without guessing by time.
    const reported = startsIn(workshop, mark);
    expect(reported[0]).toEqual([{ startId, sessionId: sessionIdSchema.parse('session-fresh') }]);
    expect(reported.slice(1).flat()).toEqual([]);
  });

  it('says nothing about that start to a hub that did not make it', async () => {
    // The other machine is the same volume and the same hub here, so the
    // honest check of the scoping is the store the start was not made in:
    // attic forked nothing, and reports no start of anybody's.
    const client = await attach();
    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: registrationOf('workshop'),
      project: null,
    });
    expect(client.reply(2).type).toBe('session-started');

    expect(startsIn(machine('attic')).flat()).toEqual([]);
  });
});

/** What the supervisor says about one machine's connection, by label. */
function connectionTo(label: string): ServerConnectionReport | undefined {
  return held()
    .connections.snapshot()
    .find((report) => report.registrationId === registrationOf(label));
}

/** Where that connection is, as one word. */
function phaseOf(label: string): ServerConnectionReport['phase'] | undefined {
  return connectionTo(label)?.phase;
}

/** Every store report a machine has sent, in order, read back through the parser. */
function storeReports(
  one: Machine,
): readonly Extract<ServerToHubFrame, { type: 'store-report' }>[] {
  return one.sentToHub
    .map((text) => parsed<ServerToHubFrame>(parseServerToHubFrame, text))
    .filter((frame) => frame.type === 'store-report');
}

/** Every instruction a machine was actually sent, as it read it off the wire. */
function instructionsTo(label: string): readonly HubToServerFrame[] {
  return machine(label)
    .sentToServer.map((text) => parsed<HubToServerFrame>(parseHubToServerFrame, text))
    .filter((frame) => frame.type === 'session-start' || frame.type === 'session-stop');
}

/**
 * What a preflight reports for a provider that resolved and says it is logged
 * out: a version, a directory, and a person who has to go and run its login.
 *
 * Built from `readyProvider` rather than written out again, because the only
 * thing that differs is the one field the machine actually read differently.
 */
function loggedOutProvider(): ProviderReadiness {
  return {
    ...readyProvider('claude'),
    state: 'unauthenticated',
    problem: 'claude says it is not logged in',
  };
}

/**
 * What a preflight reports for a provider it could not read: the program is
 * there and something in front of it answered with what this build does not
 * understand.
 */
function unreadProvider(): ProviderReadiness {
  return {
    ...readyProvider('claude'),
    state: 'unknown',
    version: null,
    problem: 'claude printed no version',
  };
}

/**
 * Every `directory` field on an instruction is null or under one of these
 * roots.
 *
 * The rule as the wire can see it. The server enforces it for real, against
 * roots its own operator configured and with a `realpath` behind the check;
 * this is the shape assertion that stands whether or not any particular suite
 * remembered to browse -- so a frame that grows a directory field, anywhere,
 * has to be under a root before this file goes green.
 *
 * A path-prefix test and not a resolved one, deliberately: a test that resolved
 * paths would be a second implementation of the containment rule, and the one
 * this file exists to hold is "the field is bounded", not "the bound is
 * correct". `directory-browse.test.ts` holds the second.
 */
function expectDirectoriesWithin(
  frames: readonly { type: string }[],
  roots: readonly string[],
): void {
  for (const frame of frames) {
    for (const directory of directoriesIn(frame)) {
      if (directory === null) continue;
      const within = roots.some((root) => directory === root || directory.startsWith(`${root}/`));
      expect(
        within,
        `${frame.type} carried ${String(directory)}, which is under no browse root`,
      ).toBe(true);
    }
  }
}

/** Every value under a `directory` key anywhere in a frame, however nested. */
function directoriesIn(value: unknown): readonly (string | null)[] {
  if (Array.isArray(value)) return value.flatMap(directoriesIn);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    ...(key === 'directory' && (typeof nested === 'string' || nested === null) ? [nested] : []),
    ...directoriesIn(nested),
  ]);
}

/** Drops the socket a machine is holding and waits for the hub to come back. */
async function redial(label: string, from: number): Promise<void> {
  const report = () =>
    held()
      .connections.snapshot()
      .find((candidate) => candidate.registrationId === registrationOf(label));

  machine(label).socket?.close(PEER_GONE);
  await until(() => report()?.phase === 'stale', `${label} to go stale`);
  held().timers.fireAll();
  await until(() => report()?.phase === 'connected', `${label} to be dialled again`);
  // The report the server sends a hub that has only just connected is written
  // after the handshake, so the connection being up is not yet the frame.
  await until(
    () => startsIn(machine(label), from).length > 0,
    `${label} to report its store on the new connection`,
  );
}

/** The `starts` list off every store report a machine sent, in order. */
function startsIn(target: Machine, from = 0): readonly (readonly unknown[])[] {
  return target.sentToHub
    .slice(from)
    .map((text) => parsed<ServerToHubFrame>(parseServerToHubFrame, text))
    .filter((frame) => frame.type === 'store-report')
    .map((frame) => frame.starts);
}

/** The one start handle a machine was asked with, as the hub minted it. */
function startIdOf(target: Machine): StartId {
  const instruction = target.sentToServer
    .map((text) => parsed<{ type: string; startId?: string }>(parseHubToServerFrame, text))
    .find((frame) => frame.type === 'session-start');
  if (instruction?.startId === undefined) throw new Error('that machine was told to start nothing');
  return startIdSchema.parse(instruction.startId);
}

function parsed<T>(parser: (raw: unknown) => { ok: boolean }, text: string): T & { type: string } {
  const result = parseTextFrame(parser as never, text) as
    { ok: true; value: T & { type: string } } | { ok: false; reason: string };
  if (!result.ok) throw new Error(`an unparseable frame reached a peer: ${result.reason}`);
  return result.value;
}
