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
  type HubToServerFrame,
  type MachineState,
  type ProviderReadiness,
  type ServerRegistrationId,
  type ServerToHubFrame,
  type SessionRow,
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
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import {
  createFakeProviderAdapter,
  missingProvider,
  readyProvider,
  createFakeProviderFiles,
  createFakeStoreFiles,
} from '@agentplex/providers/testing';
import { createProviderRegistry } from '@agentplex/providers';
import { createSessionController } from '../../../apps/server/src/session-control.js';
import { createFakeWorkingTree } from '../../../apps/server/src/fake-working-tree.js';
import {
  createTerminalManager,
  type TerminalManager,
} from '../../../apps/server/src/terminal-manager.js';
import { createClients, type Clients } from '../../../apps/hub/src/features/clients/clients.js';
import { toMachineState } from '../../../apps/hub/src/features/fleet-state/machine-state.js';
import { createExponentialBackoff } from '../../../apps/hub/src/features/servers/backoff.js';
import {
  createServers,
  type ServerConnectionReport,
  type Servers,
} from '../../../apps/hub/src/features/servers/servers.js';
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

/** A store both machines have mounted: one volume, two servers attached. */
function storeOn(path: string): StoreDescriptor {
  return { storeId: WORK, path };
}

/**
 * The transcripts both machines can see.
 *
 * `session-quiet` is waiting on a person, which is when stopping is safe.
 * `session-busy` is mid-turn. `session-fresh` stands in for the transcript a
 * provider writes as it starts: it is dated at the moment a spawn opens its
 * terminal, which is what lets the scan afterwards join the two.
 */
function transcripts(): Readonly<Record<string, string>> {
  const at = (signal: string, updatedAt: number): string =>
    JSON.stringify({ signal, updatedAt, cwd: '/volumes/work' });

  return {
    '/volumes/work/claude/sessions/session-quiet.json': at('awaiting-input', START - 5_000),
    '/volumes/work/claude/sessions/session-busy.json': at('progressing', START - 5_000),
    '/volumes/work/claude/sessions/session-fresh.json': at('awaiting-input', START),
  };
}

interface Machine {
  readonly label: string;
  readonly terminals: TerminalManager;
  readonly ptys: FakePtyFactory;
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
   * agent alive on it. A test can close a socket and a test cannot close a
   * connection any other way -- the hub's own `stop()` is a shutdown and never
   * comes back.
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
    providers,
    socket: null,
    sentToHub: [],
    sentToServer: [],
  };
}

/** One connection to that machine: a fresh socket, and the store as it reads it. */
function serveMachine(machine: Machine): DialResult {
  const files = createFakeProviderFiles({ files: transcripts() });
  const adapter = createFakeProviderAdapter({ provider: 'claude', files });
  const stores = [storeOn('/volumes/work')];
  const { hubEnd, serverEnd } = createSocketPair();

  serveServerEnd(serverEnd, {
    identity: {
      serverId: serverIdSchema.parse(`server-${machine.label}`),
      token: `tok-${machine.label}`,
    },
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
    onReport: (report) =>
      void state.applySessions({
        registrationId: report.registrationId,
        storeId: report.storeId,
        sessions: report.sessions,
        holding: report.holding,
        reportedAt: clock.now(),
      }),
  });

  const sessions = createSessions({ state, connections, logger });

  const clients = createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers,
    logger,
    readLayout: async () => [],
    readPaneLayout: async () => null,
    writePaneLayout: async () => undefined,
    sessions,
    // The same two seams `hub.ts` hands the broadcast. Pairing is not this
    // file's subject -- it is the one the client-pairing suite is about -- but
    // a broadcast built without them would be a different broadcast.
    pairing,
    syncServers: () => connections.sync(),
  });

  await connections.sync();

  return { state, sessions, clients, connections, machines, timers };
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
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) === 3,
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

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: 'look at the failing test',
      server: registrationOf('workshop'),
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
    });

    expect(client.reply(2)).toMatchObject({ type: 'refusal', code: 'refused', holder: null });
    expect(launches(machine('attic'))).toEqual([]);
    expect(launches(machine('workshop'))).toEqual([]);
  });

  it('puts no argv, environment, operation name or process handle on any wire', async () => {
    const client = await attach();

    await client.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('session-quiet'),
      provider: 'claude',
      prompt: 'look at the failing test',
      server: registrationOf('workshop'),
    });
    await client.say({
      type: 'session-stop',
      id: 3,
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
    // reads; no instruction may carry it at all, because a directory off the
    // wire is a remote code execution primitive wearing a path.
    for (const frame of [...clientToHub, ...hubToServer]) {
      expect(keysOf(frame), `${frame.type} carried a cwd`).not.toContain('cwd');
    }
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
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) === 3,
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
      { sessionId: 'session-quiet', stoppable: true },
    ]);

    await until(
      () => client.row('session-quiet')?.holder !== null,
      'the holder to be published again',
    );
    expect(client.row('session-quiet')).toMatchObject({
      reachable: true,
      holder: { server: registrationOf('attic'), stoppable: true },
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
    });

    expect(client.reply(3)).toMatchObject({
      type: 'refusal',
      code: 'refused',
      holder: { server: registrationOf('attic'), stoppable: true },
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
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) === 3,
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
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) === 3,
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
    });
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
