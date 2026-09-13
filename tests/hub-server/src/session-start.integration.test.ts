import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseClientFrame,
  parseHubFrame,
  parseHubToServerFrame,
  parseServerToHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type ClientFrame,
  type HubFrame,
  type MachineState,
  type ProviderReadiness,
  type ServerRegistrationId,
  nodeIdSchema,
  type Layout,
  type LayoutNode,
  type NodeId,
  type SessionRow,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  createSocketPair,
  createFakeTimers,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import { createLogger, type DialResult, type SocketDialer } from '@agentplex/node-shared';
import { serveServerEnd } from './server-end.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/fake-directory-reader.js';
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
import { createSessionController } from '../../../apps/server/src/session-control.js';
import { createFakeWorkingTree } from '../../../apps/server/src/fake-working-tree.js';
import {
  createTerminalManager,
  type TerminalManager,
} from '../../../apps/server/src/terminal-manager.js';
import { createClients, type Clients } from '../../../apps/hub/src/features/clients/clients.js';
import { toMachineState } from '../../../apps/hub/src/features/fleet-state/machine-state.js';
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
import {
  createCatalogue,
  type Catalogue,
} from '../../../apps/hub/src/features/catalogue/catalogue.js';
import { createProjects, type Projects } from '../../../apps/hub/src/features/projects/projects.js';
import { createSessions, type Sessions } from '../../../apps/hub/src/features/sessions/sessions.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';

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
  const terminals = createTerminalManager({ supervisor, clock });

  return {
    label,
    terminals,
    ptys,
    transcripts: transcripts(),
    providers,
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
  const connections = createServers({
    pairing: createPairing({
      database,
      files: createFakeStoreFiles(),
      ids: { newId: () => 'unused' },
      clock,
      logger,
    }),
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
    },
  });

  // The real feature over the real migrated schema, because the rows are the
  // subject here: a project is made by a client frame in one of the suites
  // below, and the directory a start carries is read back out of that row.
  const projects = createProjects({ database, ids, clock, state, connections, logger });

  // The tree, so that "the session appeared under the project" is something
  // this file can read rather than something it has to take on trust.
  const catalogue = createCatalogue({
    database,
    ids,
    clock,
    logger,
    readStore: (storeId) => state.storeSessions(storeId),
    projects,
  });

  const sessions = createSessions({ state, projects, connections, logger });

  const clients = createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers,
    logger,
    readLayout: () => catalogue.readLayout(),
    readPaneLayout: async () => null,
    writePaneLayout: async () => undefined,
    sessions,
    projects,
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

  await client.say({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
  return client;
}

/** Every terminal a machine actually opened, as the pty request recorded it. */
function launches(machine: Machine): readonly (readonly string[])[] {
  return machine.ptys.opened.map((request) => request.args);
}

/** Every instruction the hub put to that machine, as the server would read it. */
function instructionsTo(label: string): readonly { type: string }[] {
  return machine(label).sentToServer.map((text) => parsed(parseHubToServerFrame, text));
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
    });
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
      holder: { server: registrationOf('attic'), stoppable: true },
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
      holder: { server: registrationOf('workshop'), stoppable: false },
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
    // frame the operation registry exists to prevent.
    for (const frame of [...clientToHub, ...hubToClient, ...hubToServer, ...serverToHub]) {
      for (const forbidden of [
        'args',
        'argv',
        'env',
        'command',
        'operation',
        'pid',
        'terminalId',
      ]) {
        expect(keysOf(frame), `${frame.type} carried ${forbidden}`).not.toContain(forbidden);
      }
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

function parsed<T>(parser: (raw: unknown) => { ok: boolean }, text: string): T & { type: string } {
  const result = parseTextFrame(parser as never, text) as
    { ok: true; value: T & { type: string } } | { ok: false; reason: string };
  if (!result.ok) throw new Error(`an unparseable frame reached a peer: ${result.reason}`);
  return result.value;
}

/** Every key anywhere in a frame, however deeply nested. */
function keysOf(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...keysOf(nested)]);
}
