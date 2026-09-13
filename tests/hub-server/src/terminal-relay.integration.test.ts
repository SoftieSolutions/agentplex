import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeTerminalChunk,
  parseHubFrame,
  parseHubToServerFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type ClientFrame,
  type HubFrame,
  type HubToServerFrame,
  type ServerRegistrationId,
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
import { createTerminal, type Terminal } from '../../../apps/hub/src/features/terminal/terminal.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';

/**
 * A terminal, from a pty on one machine to the clients watching it, and back.
 *
 * Everything but the wire and the fork is the shipped code: a real handshake, a
 * real terminal manager with its real scrollback, both parsers on both legs,
 * the real relay in the middle and the real client connection at the end. What
 * is faked is what a test cannot supply -- a socket, a forked process, a
 * provider's files on disk -- and each is an implementation of a seam.
 *
 * The questions it exists to answer are the ones that only appear once there is
 * a middle: does a pane get the history before the live stream and in that
 * order, do two browsers on one session both see it off one subscription, does
 * a pane opened on a spawn keep working when the provider finally names the
 * session, does the server stop being watched when the last viewer leaves, and
 * does a machine that is not there produce a sentence rather than a blank
 * rectangle. One assertion is about the bytes themselves: the string a client
 * receives is the string the pty produced, character for character, because
 * anything in between that decoded it would be the thing that breaks the
 * sessions drawing boxes.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = storeIdSchema.parse('store-work');
const QUIET = sessionIdSchema.parse('session-quiet');
const FRESH = sessionIdSchema.parse('session-fresh');

/**
 * Output a decoder would ruin.
 *
 * Box drawing, an emoji past the basic plane, and a byte that is not valid
 * UTF-8 on its own -- which is exactly what a chunk boundary in the middle of a
 * code point looks like to whatever reads it next.
 */
const DRAWN = new Uint8Array([...new TextEncoder().encode('[1m┌──┐ 🙂[0m\r\n'), 0xf0, 0x9f]);

function storeOn(path: string): StoreDescriptor {
  return { storeId: WORK, path };
}

/** The transcripts the machine can see. `session-fresh` is written on demand. */
function transcripts(namesTheSpawn: boolean): Record<string, string> {
  const at = (signal: string, updatedAt: number): string =>
    JSON.stringify({ signal, updatedAt, cwd: '/volumes/work' });

  return {
    '/volumes/work/claude/sessions/session-quiet.json': at('awaiting-input', START - 5_000),
    ...(namesTheSpawn
      ? { '/volumes/work/claude/sessions/session-fresh.json': at('awaiting-input', START) }
      : {}),
  };
}

interface Machine {
  readonly label: string;
  readonly terminals: TerminalManager;
  readonly ptys: FakePtyFactory;
  readonly sessionFiles: Record<string, string>;
  /** The server end of the connection it holds now, for dropping a socket. */
  live: FakeMessageSocket | undefined;
  /** Every frame the hub put on the wire to this machine, as raw text. */
  readonly sentToServer: string[];
}

interface Harness {
  readonly state: FleetState;
  readonly sessions: Sessions;
  readonly terminal: Terminal;
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

function buildMachine(label: string, sessionFiles: Record<string, string>): Machine {
  const ptys = createFakePtyFactory();
  const supervisor = createPtySupervisor({
    pty: ptys,
    clock,
    ids: { newId: () => `${label}-run-${ptys.ptys.length}` },
    environment: { PATH: '/usr/bin' },
  });

  return {
    label,
    terminals: createTerminalManager({ supervisor, clock }),
    ptys,
    sessionFiles,
    live: undefined,
    sentToServer: [],
  };
}

/** One connection to that machine: a fresh socket, and the store as it reads it. */
function serveMachine(machine: Machine): DialResult {
  // A live view of the machine's disk rather than a snapshot of it. The fake
  // files copy what they are given, and the moment this suite is about is a
  // provider writing its session id while the connection that started it is
  // still up -- so each read is answered from the record as it stands, which is
  // what a disk does.
  const files: ProviderFiles = {
    readFile: (path) => createFakeProviderFiles({ files: machine.sessionFiles }).readFile(path),
    listDirectory: (path) =>
      createFakeProviderFiles({ files: machine.sessionFiles }).listDirectory(path),
  };
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
    providers: [readyProvider('claude')],
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

  const originalSend = hubEnd.send.bind(hubEnd);
  return {
    ok: true,
    socket: {
      ...hubEnd,
      send(text: string): void {
        machine.sentToServer.push(text);
        originalSend(text);
      },
    },
  };
}

async function start(
  options: {
    readonly namesTheSpawn?: boolean;
    /**
     * Which machines are paired.
     *
     * Two by default, because a fleet is what makes the relay interesting. One
     * is how a suite gets a session that *only* an unreachable machine reports:
     * two servers sharing a volume both read the same transcript, so with a
     * second machine up there is always somewhere else to ask.
     */
    readonly machines?: readonly string[];
  } = {},
): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`terminal-relay-${suite}`);
  const database = migrated.database;

  const machines = new Map<string, Machine>();
  for (const label of options.machines ?? ['attic', 'workshop']) {
    machines.set(label, buildMachine(label, transcripts(options.namesTheSpawn ?? true)));
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

  // The same composition `hub.ts` uses, knot and all: the relay puts frames to
  // the servers and the servers hand it what arrives, so one of the two is
  // named in a closure before it is built.
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

  const terminal = createTerminal({ state, servers: connections, logger });

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

  return { state, sessions, terminal, clients, connections, machines, timers };
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

function machine(label: string): Machine {
  const found = held().machines.get(label);
  if (found === undefined) throw new Error(`no machine ${label}`);
  return found;
}

/** A client on a socket, read back through the parser a browser would use. */
interface Client {
  say(frame: ClientFrame): Promise<void>;
  readonly socket: FakeMessageSocket;
  readonly received: readonly HubFrame[];
  /** Every chunk this client was sent, decoded only to be asserted on. */
  readonly printed: readonly string[];
  reply(id: number): HubFrame;
}

async function attach(): Promise<Client> {
  const socket = createFakeMessageSocket();
  socket.onMessage(() => {});
  held().clients.attach(socket);

  const readAll = (): HubFrame[] =>
    socket.sent.map((text) => {
      const parsed = parseTextFrame(parseHubFrame, text);
      if (!parsed.ok) throw new Error(`the hub sent an unparseable frame: ${parsed.reason}`);
      return parsed.value;
    });

  const client: Client = {
    socket,
    async say(frame: ClientFrame): Promise<void> {
      socket.receive(JSON.stringify(frame));
      await settle();
    },
    get received(): readonly HubFrame[] {
      return readAll();
    },
    get printed(): readonly string[] {
      return readAll()
        .filter((frame) => frame.type === 'terminal-output')
        .map((frame) => new TextDecoder().decode(decodeTerminalChunk(frame.chunk)));
    },
    reply(id: number): HubFrame {
      const answer = readAll().find((frame) => 'replyTo' in frame && frame.replyTo === id);
      if (answer === undefined) throw new Error(`nothing answered frame ${id}`);
      return answer;
    },
  };

  await client.say({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
  return client;
}

/** Turns of the loop: an answer that crosses to another machine and back. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The frames the hub put to one machine, as that machine's parser reads them. */
function instructions(target: Machine): readonly HubToServerFrame[] {
  return target.sentToServer.map((text) => {
    const parsed = parseTextFrame(parseHubToServerFrame, text);
    if (!parsed.ok) throw new Error(`the hub sent a server something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

/** Starts `session-quiet` on one machine and answers with the pty it forked. */
async function runQuietOn(client: Client, label: string, id: number): Promise<void> {
  await client.say({
    type: 'session-start',
    id,
    storeId: WORK,
    sessionId: QUIET,
    provider: 'claude',
    prompt: null,
    server: registrationOf(label),
  });
  expect(client.reply(id).type).toBe('session-started');
}

describe('a client watching a session', () => {
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
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) > 0,
      'the store to be reported',
    );
  });

  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('is given the history it is told to expect, and then the live stream', async () => {
    const client = await attach();
    await runQuietOn(client, 'attic', 2);

    // Printed before anybody attached: this is the scrollback, and it is what
    // the subscription has to replay.
    machine('attic').ptys.last?.emit('building\r\n');
    machine('attic').ptys.last?.emit('still building\r\n');
    await settle();

    await client.say({
      type: 'session-subscribe',
      id: 3,
      target: { by: 'session', storeId: WORK, sessionId: QUIET },
    });

    const answer = client.reply(3);
    expect(answer).toMatchObject({
      type: 'session-subscribed',
      storeId: WORK,
      sessionId: QUIET,
      replayChunks: 2,
      // Nothing was evicted, so this pane is being shown the session from its
      // first byte -- which is the fact `droppedBytes` exists to state.
      droppedBytes: 0,
    });

    machine('attic').ptys.last?.emit('done\r\n');
    await settle();

    expect(client.printed).toEqual(['building\r\n', 'still building\r\n', 'done\r\n']);
    // The reply comes before the history it counts. A relay that let a
    // microtask in between would have those the other way round, and the count
    // would be about frames the client already had.
    const order = client.received.map((frame) => frame.type);
    expect(order.indexOf('session-subscribed')).toBeLessThan(order.indexOf('terminal-output'));
  });

  it('relays the bytes without reading them', async () => {
    const client = await attach();
    await runQuietOn(client, 'attic', 2);
    await client.say({
      type: 'session-subscribe',
      id: 3,
      target: { by: 'session', storeId: WORK, sessionId: QUIET },
    });

    machine('attic').ptys.last?.emit(DRAWN);
    await settle();

    const relayed = client.received.find((frame) => frame.type === 'terminal-output');
    const arrived = relayed?.type === 'terminal-output' ? decodeTerminalChunk(relayed.chunk) : null;
    // Byte for byte, including the two that are half of a code point. A chunk
    // boundary lands wherever the pty put it, and anything that decoded this on
    // the way would have turned that half into a replacement character.
    expect(arrived).toEqual(DRAWN);
  });
});

describe('a session whose only machine has gone away', () => {
  beforeEach(async () => {
    // One machine, deliberately. With two on the same volume there is always
    // another server holding the transcript, and the hub asks it -- which is
    // the right behaviour and the wrong scenario for this assertion.
    harness = await start({ machines: ['workshop'] });
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'the server to be connected',
    );
    await until(
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) > 0,
      'the store to be reported',
    );
  });

  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('is refused with the machine named, because a blank pane names nothing', async () => {
    const client = await attach();
    await runQuietOn(client, 'workshop', 2);

    machine('workshop').live?.close(PEER_GONE);
    await until(
      () =>
        held()
          .connections.snapshot()
          .find((report) => report.registrationId === registrationOf('workshop'))?.phase ===
        'stale',
      'workshop to go stale',
    );

    await client.say({
      type: 'session-subscribe',
      id: 3,
      target: { by: 'session', storeId: WORK, sessionId: QUIET },
    });

    const refused = client.reply(3);
    expect(refused).toMatchObject({ type: 'refusal', code: 'refused' });
    // A silent empty pane and a machine that is asleep draw the same rectangle.
    // The name is the whole of the difference, and what a person does next.
    expect(refused.type === 'refusal' ? refused.message : '').toContain('workshop');
    // The rows are still there: an unreachable machine keeps what it reported,
    // labelled, which is what makes this a refusal rather than a missing row.
    expect(held().state.snapshot().stores[0]?.sessions.length).toBeGreaterThan(0);
  });
});

describe('two browsers on one session', () => {
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
      () => (held().state.snapshot().stores[0]?.sessions.length ?? 0) > 0,
      'the store to be reported',
    );
  });

  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('both see the stream, and either can type into it', async () => {
    const first = await attach();
    const second = await attach();
    await runQuietOn(first, 'attic', 2);

    for (const client of [first, second]) {
      await client.say({
        type: 'session-subscribe',
        id: 3,
        target: { by: 'session', storeId: WORK, sessionId: QUIET },
      });
      expect(client.reply(3).type).toBe('session-subscribed');
    }

    machine('attic').ptys.last?.emit('shared\r\n');
    await settle();

    expect(first.printed.at(-1)).toBe('shared\r\n');
    expect(second.printed.at(-1)).toBe('shared\r\n');

    await first.say({
      type: 'terminal-input',
      id: 4,
      target: { by: 'session', storeId: WORK, sessionId: QUIET },
      data: 'l',
    });
    await second.say({
      type: 'terminal-input',
      id: 5,
      target: { by: 'session', storeId: WORK, sessionId: QUIET },
      data: 's\r',
    });

    // Both keystrokes reach the one pty. What it does with them interleaved is
    // the pty's business: a terminal is a shared device, and a hub that took
    // turns would be inventing a rule the program on the far end has not got.
    expect(machine('attic').ptys.last?.written).toEqual(['l', 's\r']);
    // Silence on success, like the server leg. Neither keystroke was answered.
    expect(first.received.some((frame) => 'replyTo' in frame && frame.replyTo === 4)).toBe(false);
  });

  it('stops watching at the server only when the last of them leaves', async () => {
    const first = await attach();
    const second = await attach();
    await runQuietOn(first, 'attic', 2);

    for (const client of [first, second]) {
      await client.say({
        type: 'session-subscribe',
        id: 3,
        target: { by: 'session', storeId: WORK, sessionId: QUIET },
      });
    }

    const detaches = (): number =>
      instructions(machine('attic')).filter((frame) => frame.type === 'session-unsubscribe').length;

    await first.say({
      type: 'session-unsubscribe',
      id: 4,
      target: { by: 'session', storeId: WORK, sessionId: QUIET },
    });
    expect(first.reply(4)).toMatchObject({ type: 'session-unsubscribed' });
    expect(detaches()).toBe(0);

    // And the socket that never says anything takes the same path off the
    // terminal as the frame does, which is the only path a crashed tab has.
    second.socket.closeFromPeer(PEER_GONE);
    await settle();

    expect(detaches()).toBe(1);
    // Detaching closes nothing: the agent goes on working with nobody watching.
    expect(machine('attic').ptys.last?.kills).toBe(0);
    expect(machine('attic').terminals.terminals).toHaveLength(1);
  });
});

describe('a pane opened on a spawn the provider has not named', () => {
  beforeEach(async () => {
    harness = await start({ namesTheSpawn: false });
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

  it('watches by its own start handle, and keeps watching when the id lands', async () => {
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
    const started = client.reply(2);
    expect(started).toMatchObject({ type: 'session-started', sessionId: null });

    // The client's handle is the id of its own start frame, which is the only
    // name a spawn has until the provider writes one.
    await client.say({ type: 'session-subscribe', id: 3, target: { by: 'start', startId: 2 } });
    expect(client.reply(3)).toMatchObject({
      type: 'session-subscribed',
      sessionId: null,
      startId: 2,
    });

    const spawned = machine('workshop').ptys.ptys[0];
    spawned?.emit('starting up\r\n');
    await settle();
    expect(client.printed).toEqual(['starting up\r\n']);

    // The provider writes its transcript, and a scan of that store is what
    // joins the terminal to it. Anything that changes what is running in a
    // store reports it, so a second start on the same machine is the scan --
    // which is also the ordinary way this happens in life, since a person who
    // just started one agent is about to start another.
    machine('workshop').sessionFiles['/volumes/work/claude/sessions/session-fresh.json'] =
      JSON.stringify({ signal: 'awaiting-input', updatedAt: START, cwd: '/volumes/work' });
    await runQuietOn(client, 'workshop', 4);
    await until(
      () =>
        held()
          .state.snapshot()
          .stores[0]?.sessions.some((row) => row.ref.sessionId === FRESH) === true,
      'the provider to name the session',
    );

    spawned?.emit('named now\r\n');
    await settle();

    // The same pane, still fed, and the frames now carry the session the start
    // turned out to be.
    expect(client.printed).toEqual(['starting up\r\n', 'named now\r\n']);
    const last = client.received.filter((frame) => frame.type === 'terminal-output').at(-1);
    expect(last?.type === 'terminal-output' ? last.sessionId : undefined).toBe(FRESH);
    expect(last?.type === 'terminal-output' ? last.startId : undefined).toBe(2);
  });

  it('refuses a start handle that belongs to another connection', async () => {
    const owner = await attach();
    const stranger = await attach();

    await owner.say({
      type: 'session-start',
      id: 2,
      storeId: WORK,
      sessionId: null,
      provider: 'claude',
      prompt: null,
      server: registrationOf('workshop'),
    });
    expect(owner.reply(2).type).toBe('session-started');

    await stranger.say({ type: 'session-subscribe', id: 2, target: { by: 'start', startId: 2 } });

    // A start handle is the name one socket has for what it asked, and it is
    // meaningless on any other. Nothing was even put to the machine.
    expect(stranger.reply(2)).toMatchObject({
      type: 'refusal',
      code: 'refused',
      message: 'this connection did not start that session',
    });
    expect(
      instructions(machine('workshop')).filter((frame) => frame.type === 'session-subscribe'),
    ).toEqual([]);
  });
});
