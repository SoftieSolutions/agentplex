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
  startIdSchema,
  storeIdSchema,
  type ClientFrame,
  type HubFrame,
  type MachineState,
  type ProviderReadiness,
  type ServerRegistrationId,
  type ServerToHubFrame,
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
import { createSessions, type Sessions } from '../../../apps/hub/src/features/sessions/sessions.js';
import { createTerminal } from '../../../apps/hub/src/features/terminal/terminal.js';
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
function transcripts(namesTheSpawn = true): Record<string, string> {
  const at = (signal: string, updatedAt: number): string =>
    JSON.stringify({ signal, updatedAt, cwd: '/volumes/work' });

  return {
    '/volumes/work/claude/sessions/session-quiet.json': at('awaiting-input', START - 5_000),
    '/volumes/work/claude/sessions/session-busy.json': at('progressing', START - 5_000),
    // Left out when a test wants the gap this ticket is about: a live terminal
    // with no session id, because the provider has not written one yet.
    ...(namesTheSpawn
      ? { '/volumes/work/claude/sessions/session-fresh.json': at('awaiting-input', START) }
      : {}),
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
   * The transcripts this machine's store holds, as the adapter reads them.
   *
   * Mutable, and read at each dial rather than captured once, because the
   * interesting moment is a provider writing its session id while the hub is
   * not connected -- which is exactly the gap a start handle has to survive.
   */
  readonly sessionFiles: Record<string, string>;
  /**
   * The server end of the connection it is holding now, for a test that needs
   * the socket to go away without the machine going with it.
   */
  live: FakeMessageSocket | undefined;
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
function buildMachine(
  label: string,
  providers: readonly ProviderReadiness[],
  sessionFiles: Record<string, string>,
): Machine {
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
    sessionFiles,
    live: undefined,
    sentToHub: [],
    sentToServer: [],
  };
}

/** One connection to that machine: a fresh socket, and the store as it reads it. */
function serveMachine(machine: Machine): DialResult {
  const files = createFakeProviderFiles({ files: machine.sessionFiles });
  const adapter = createFakeProviderAdapter({ provider: 'claude', files });
  const stores = [storeOn('/volumes/work')];
  const { hubEnd, serverEnd } = createSocketPair();
  machine.live = serverEnd;

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
  options: { readonly namesTheSpawn?: boolean } = {},
): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`session-start-${suite}`);
  const database = migrated.database;

  const machines = new Map<string, Machine>();
  for (const label of ['attic', 'workshop']) {
    machines.set(
      label,
      buildMachine(label, preflightOf(label), transcripts(options.namesTheSpawn)),
    );
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
      state.applySessions({
        registrationId: report.registrationId,
        storeId: report.storeId,
        sessions: report.sessions,
        holding: report.holding,
        reportedAt: clock.now(),
      });
      terminal.noteStarts(report.registrationId, report.storeId, report.starts);
    },
    onStream: (registrationId, output) => terminal.deliver(registrationId, output),
  });

  // The relay, composed as `hub.ts` composes it. This suite asserts nothing
  // about terminals -- `terminal-relay.integration.test.ts` is where those
  // scenarios are -- but it runs the real thing rather than a fake, so that a
  // start's answer and the handle the relay files under it are produced by the
  // same code path a hub actually runs.
  const terminal = createTerminal({ state, servers: connections, logger });

  // Counting rather than random, so a test can name the start the hub minted
  // without matching a pattern -- the reason `IdGenerator` is a seam at all.
  let minted = 0;
  const sessions = createSessions({
    state,
    connections,
    ids: { newId: () => `start-${(minted += 1)}` },
    logger,
  });

  const clients = createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers,
    logger,
    readLayout: async () => [],
    readPaneLayout: async () => null,
    writePaneLayout: async () => undefined,
    sessions,
    terminal,
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
    harness = await start(() => [readyProvider('claude')], { namesTheSpawn: false });
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
    });
    expect(client.reply(2).type).toBe('session-started');

    const workshop = machine('workshop');
    const startId = startIdOf(workshop);
    // The provider writes its transcript while the hub is away, so the scan on
    // the next connection is the first one that can join the two.
    workshop.sessionFiles['/volumes/work/claude/sessions/session-fresh.json'] = JSON.stringify({
      signal: 'awaiting-input',
      updatedAt: START,
      cwd: '/volumes/work',
    });

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
    });
    expect(client.reply(2).type).toBe('session-started');

    expect(startsIn(machine('attic')).flat()).toEqual([]);
  });
});

/** Drops the socket a machine is holding and waits for the hub to come back. */
async function redial(label: string, from: number): Promise<void> {
  const report = () =>
    held()
      .connections.snapshot()
      .find((candidate) => candidate.registrationId === registrationOf(label));

  machine(label).live?.close(PEER_GONE);
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

/** Every key anywhere in a frame, however deeply nested. */
function keysOf(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...keysOf(nested)]);
}
