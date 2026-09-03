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
  type ServerRegistrationId,
  type SessionRow,
  type StoreDescriptor,
} from '@agentplex/protocol';
import { createFakeMessageSocket, createSocketPair } from '../../shared/fake-message-socket.js';
import { createLogger } from '../../shared/logger.js';
import type { DialResult, SocketDialer } from '../../shared/message-socket.js';
import { createFakeTimers, type FakeTimers } from '../../shared/timers.js';
import { serveHubConnection } from '../../server/hub-connection.js';
import { createFakePtyFactory, type FakePtyFactory } from '../../server/fake-pty.js';
import { createFakeProviderAdapter } from '../../server/providers/fake-provider-adapter.js';
import { createFakeProviderFiles } from '../../server/providers/fake-provider-files.js';
import { createProviderRegistry } from '../../server/providers/provider-registry.js';
import { createPtySupervisor } from '../../server/pty-supervisor.js';
import { createSessionController } from '../../server/session-control.js';
import { createTerminalManager, type TerminalManager } from '../../server/terminal-manager.js';
import { startClientBroadcast, type ClientBroadcast } from '../clients/client-broadcast.js';
import { toMachineState } from '../clients/machine-state.js';
import { createExponentialBackoff } from '../connections/backoff.js';
import {
  startConnectionSupervisor,
  type ConnectionSupervisor,
} from '../connections/connection-supervisor.js';
import { newServerRegistrationSchema, registerServer } from '../pairing/server-registrations.js';
import { openMigratedSchema, type MigratedSchema } from '../pairing/test-migrated-schema.js';
import { createReducer, type Reducer } from '../state/reducer.js';
import { createSessionControl, type SessionControl } from './session-control.js';

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
  /** Every frame this machine sent to the hub, and every one it received. */
  readonly sentToHub: string[];
  readonly sentToServer: string[];
}

interface Harness {
  readonly state: Reducer;
  readonly sessions: SessionControl;
  readonly clients: ClientBroadcast;
  readonly connections: ConnectionSupervisor;
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
function buildMachine(label: string): Machine {
  const ptys = createFakePtyFactory();
  const supervisor = createPtySupervisor({
    pty: ptys,
    clock,
    ids: { newId: () => `${label}-run-${ptys.ptys.length}` },
    environment: { PATH: '/usr/bin' },
  });
  const terminals = createTerminalManager({ supervisor, clock });

  return { label, terminals, ptys, sentToHub: [], sentToServer: [] };
}

/** One connection to that machine: a fresh socket, and the store as it reads it. */
function serveMachine(machine: Machine): DialResult {
  const files = createFakeProviderFiles({ files: transcripts() });
  const adapter = createFakeProviderAdapter({ provider: 'claude', files });
  const stores = [storeOn('/volumes/work')];
  const { hubEnd, serverEnd } = createSocketPair();

  serveHubConnection(serverEnd, {
    identity: {
      serverId: serverIdSchema.parse(`server-${machine.label}`),
      token: `tok-${machine.label}`,
    },
    stores,
    sessions: createSessionController({
      stores,
      providers: createProviderRegistry([adapter]),
      terminals: machine.terminals,
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

async function start(): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`session-start-${suite}`);
  const database = migrated.database;

  const machines = new Map<string, Machine>();
  for (const label of ['attic', 'workshop']) {
    machines.set(label, buildMachine(label));
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
  const state = createReducer({ logger });

  let connections: ConnectionSupervisor | null = null;
  const sessions = createSessionControl({
    state,
    connections: {
      ask: (registrationId, instruction) =>
        connections === null
          ? Promise.resolve({
              ok: false as const,
              code: 'internal' as const,
              problem: 'not started',
              hold: null,
            })
          : connections.ask(registrationId, instruction),
    },
    logger,
  });

  const clients = startClientBroadcast({
    hubId: 'hub-under-test' as never,
    state,
    timers,
    logger,
    readLayout: async () => [],
    sessions,
  });

  connections = await startConnectionSupervisor({
    database,
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
