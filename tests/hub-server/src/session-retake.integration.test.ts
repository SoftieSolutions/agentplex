import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeTerminalChunk,
  parseClientFrame,
  parseHubFrame,
  parseHubToServerFrame,
  parseServerToHubFrame,
  parseTextFrame,
  CLIENT_PROTOCOL_VERSION,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type ClientFrame,
  type HubFrame,
  type HubToServerFrame,
  type ServerRegistrationId,
  type ServerToHubFrame,
  type SessionHolder,
  type SessionId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  createFakeTimers,
  createSocketPair,
  type FakeMessageSocket,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import { createLogger, type DialResult, type SocketDialer } from '@agentplex/node-shared';
import {
  createFakeProcessProbe,
  createFakeProviderAdapter,
  createFakeProviderFiles,
  createFakeStoreFiles,
  readProviderFixture,
  readyProvider,
} from '@agentplex/providers/testing';
import {
  createClaudeAdapter,
  createProviderRegistry,
  type ProviderFiles,
} from '@agentplex/providers';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import { serveServerEnd } from './server-end.js';
import { forbiddenKeysIn } from './frame-keys.js';
import { createFakeWorkingTree } from '../../../apps/server/src/working-tree/fake-working-tree.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directories/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/directories/fake-directory-reader.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/machine-load/fake-machine-probe.js';
import { createFakeProcessSignaller } from '../../../apps/server/src/sessions/fake-process-signaller.js';
import { createSessionController } from '../../../apps/server/src/sessions/session-control.js';
import {
  createTerminalManager,
  type TerminalManager,
} from '../../../apps/server/src/terminal/terminal-manager.js';
import { createClients, type Clients } from '../../../apps/hub/src/clients/clients.js';
import { createFakeApprovals } from '../../../apps/hub/src/approvals/fake-approvals.js';
import { createFakeApprovalPolicy } from '../../../apps/hub/src/approval-policy/fake-approval-policy.js';
import { createFakeAttention } from '../../../apps/hub/src/attention/fake-attention.js';
import { createFakeCatalogue } from '../../../apps/hub/src/catalogue/fake-catalogue.js';
import { createFakeDocs } from '../../../apps/hub/src/docs/fake-docs.js';
import { createFakeGraphs } from '../../../apps/hub/src/graphs/fake-graphs.js';
import { createFakeGraphRuns } from '../../../apps/hub/src/graph-runs/fake-graph-runs.js';
import { createFakeProjects } from '../../../apps/hub/src/projects/fake-projects.js';
import { createExponentialBackoff } from '../../../apps/hub/src/servers/backoff.js';
import { createServers, type Servers } from '../../../apps/hub/src/servers/servers.js';
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
import { createSessions } from '../../../apps/hub/src/sessions/sessions.js';
import { createTerminal } from '../../../apps/hub/src/terminal/terminal.js';

/**
 * A retake, from a client's frame to a claude somebody's own terminal was
 * running on another machine, and back to a session agentplex holds.
 *
 * The server end is the shipped one over the real Claude adapter, reading the
 * captured registry entry and the captured transcript with only the pid, the
 * id and the dates bent, as the server's own retake suite does. What is faked
 * is what a test cannot supply: the socket, the disk, the fork, the process
 * table and the kernel's signal -- and the fake signaller ends the pid in the
 * fake process table on SIGHUP, so the controller finds the process gone the
 * way it would for real, by asking again.
 *
 * What this suite exists to say: that the hub routes a client's retake to the
 * machine that sees the process, with the provider off its own row; that the
 * client is answered as a start is, and then sees the session held and can
 * watch its terminal by session; and that a refusal reaches the client in the
 * words of whichever side said no.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = storeIdSchema.parse('store-work');
const MACHINE: ServerRegistrationId = 'registration-attic' as ServerRegistrationId;
const STORE: StoreDescriptor = { storeId: WORK, path: '/volumes/work' };

/** The captured transcript's own session, run by a claude outside agentplex. */
const SESSION = sessionIdSchema.parse('10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde');
const OUTSIDE_PID = 5_150;
/** The pid the fake pty hands the resume this server forks. */
const NEW_PID = 6_160;
const REGISTERED_AT = START - 600_000;
/** As far before its entry as the captured process started before its own. */
const OUTSIDE_STARTED_AT = REGISTERED_AT - 1_669;
const TRANSCRIPT = `${STORE.path}/projects/-Users-dev-Code-agentplex/${SESSION}.jsonl`;
const ENTRY = `${STORE.path}/sessions/${String(OUTSIDE_PID)}.json`;

/**
 * A codex session the fake codex adapter says a process runs, which no
 * registry this server reads can name at the moment it would signal.
 */
const CODEX_SESSION = sessionIdSchema.parse('session-codex-outside');
const CODEX_RECORD = `${STORE.path}/codex/sessions/${CODEX_SESSION}.json`;

interface Harness {
  readonly state: FleetState;
  readonly clients: Clients;
  readonly connections: Servers;
  readonly terminals: TerminalManager;
  readonly ptys: FakePtyFactory;
  /** The hub's timers, which the client broadcast coalesces on. */
  readonly hubTimers: FakeTimers;
  /** The server controller's timers: a retake's polls for the process to go. */
  readonly serverTimers: FakeTimers;
  /** Every signal the server sent, and to which pid. */
  readonly signalled: () => readonly { readonly pid: number; readonly signal: string }[];
  readonly dialled: { readonly hubEnd: FakeMessageSocket; readonly serverEnd: FakeMessageSocket }[];
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

function held(): Harness {
  if (harness === null) throw new Error('no harness: the test did not start one');
  return harness;
}

/** One hub, one paired machine with a claude outside agentplex at `status` in its registry. */
async function start(status: string): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`session-retake-${String(suite)}`);
  const database = migrated.database;
  const dialled: { hubEnd: FakeMessageSocket; serverEnd: FakeMessageSocket }[] = [];

  const disk: Record<string, string> = {
    [ENTRY]: JSON.stringify({
      ...JSON.parse(await readProviderFixture('claude-session-registry.json')),
      pid: OUTSIDE_PID,
      sessionId: SESSION,
      startedAt: REGISTERED_AT,
      statusUpdatedAt: REGISTERED_AT,
      status,
    }),
    [TRANSCRIPT]: await readProviderFixture('claude-completed-turn.jsonl'),
    [CODEX_RECORD]: JSON.stringify({
      signal: 'awaiting-input',
      updatedAt: START - 1_000,
      cwd: STORE.path,
      process: 'verified',
      running: true,
      pid: 7_170,
    }),
  };
  const files: ProviderFiles = {
    readFile: (path) => createFakeProviderFiles({ files: disk }).readFile(path),
    listDirectory: (path) => createFakeProviderFiles({ files: disk }).listDirectory(path),
    readFileTail: (path, maxBytes) =>
      createFakeProviderFiles({ files: disk }).readFileTail(path, maxBytes),
    stat: (path) => createFakeProviderFiles({ files: disk }).stat(path),
  };

  const ptys = createFakePtyFactory({ pids: [NEW_PID] });
  const terminals = createTerminalManager({
    supervisor: createPtySupervisor({
      pty: ptys,
      clock,
      ids: { newId: () => `run-${String(ptys.ptys.length)}` },
      environment: {},
    }),
    clock,
    timers: createFakeTimers(),
  });

  const probe = createFakeProcessProbe({ processes: { [OUTSIDE_PID]: OUTSIDE_STARTED_AT } });
  // A claude at its prompt ends on SIGHUP, which is what the controller asks
  // the process table again to find out.
  const signaller = createFakeProcessSignaller({ onSignal: (pid) => probe.exit(pid) });
  const serverTimers = createFakeTimers();
  const sessions = createSessionController({
    signaller,
    processes: probe,
    timers: serverTimers,
    stores: [STORE],
    providers: createProviderRegistry([
      createClaudeAdapter({ files, probe, homeDirectory: '/home/agentplex' }),
      createFakeProviderAdapter({ provider: 'codex', files }),
    ]),
    terminals,
    workingTree: createFakeWorkingTree(),
    homeDirectory: '/home/agentplex',
    browse: createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader() }),
    approvals: null,
    clock,
    logger,
  });

  await registerServer(
    database,
    { newId: () => MACHINE },
    clock,
    newServerRegistrationSchema.parse({
      label: 'attic',
      address: 'wss://attic.example:8443',
      token: 'tok-attic',
    }),
  );

  const dialer: SocketDialer = {
    dial: async (): Promise<DialResult> => {
      const { hubEnd, serverEnd } = createSocketPair();
      serveServerEnd(serverEnd, {
        identity: { serverId: serverIdSchema.parse('server-attic'), token: 'tok-attic' },
        stores: [STORE],
        providers: [readyProvider('claude'), readyProvider('codex')],
        terminals,
        machineLoad: createFakeMachineLoadReader(),
        sessions,
        logger,
      });
      dialled.push({ hubEnd, serverEnd });
      return { ok: true, socket: hubEnd };
    },
  };

  const hubTimers = createFakeTimers();
  const state = createFleetState({ logger });
  const pairing = createPairing({
    database,
    files: createFakeStoreFiles(),
    ids: { newId: () => 'unused' },
    clock,
    logger,
  });

  // The composition `hub.ts` has: the relay puts frames to the servers and the
  // servers hand it what arrives, so one is named in a closure before it is built.
  const connections = createServers({
    pairing,
    dialer,
    hubId: 'hub-under-test' as never,
    timers: hubTimers,
    clock,
    logger,
    backoff: createExponentialBackoff({ baseMs: 500, maxMs: 8_000, random: () => 0 }),
    onChange: (report) => {
      state.applyConnection(report);
      terminal.noteConnection(report);
    },
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

  const clients = createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers: hubTimers,
    logger,
    readLayout: async () => [],
    readPaneLayout: async () => null,
    writePaneLayout: async () => undefined,
    sessions: createSessions({
      state,
      projects: createFakeProjects(),
      connections,
      ids: { newId: () => 'start-1' },
      logger,
      onStarted: async () => undefined,
    }),
    attention: createFakeAttention(),
    approvals: createFakeApprovals(),
    approvalPolicy: createFakeApprovalPolicy(),
    push: null,
    pairing,
    syncServers: () => connections.sync(),
    projects: createFakeProjects(),
    catalogue: createFakeCatalogue(),
    docs: createFakeDocs(),
    graphs: createFakeGraphs(),
    graphRuns: createFakeGraphRuns(),
    terminal,
  });

  await connections.sync();

  return {
    state,
    clients,
    connections,
    terminals,
    ptys,
    hubTimers,
    serverTimers,
    signalled: () => signaller.sent,
    dialled,
  };
}

/** Lets every promise that can move, move. */
async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Lets everything move, firing the hub's timers between: the broadcast
 * coalesces on one, which is what a real hub does a few milliseconds later.
 * Never while an instruction is out, since the same timers hold its deadline.
 */
async function settle(): Promise<void> {
  await turns(40);
  held().hubTimers.fireAll();
  await turns(10);
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

function parsedFrame<T>(parser: (raw: unknown) => { ok: boolean }, text: string): T {
  const result = parseTextFrame(parser as never, text) as
    { ok: true; value: T } | { ok: false; reason: string };
  if (!result.ok) throw new Error(`an unparseable frame reached a peer: ${result.reason}`);
  return result.value;
}

interface Client {
  /** Puts a frame on the socket and returns at once, firing nothing. */
  send(frame: ClientFrame): void;
  say(frame: ClientFrame): Promise<void>;
  /** The answer to frame `id`, or `undefined` while it has none. */
  answer(id: number): HubFrame | undefined;
  said(): ClientFrame[];
  heard(): HubFrame[];
  /** The holder on a session's row, as of the last machine state this client was sent. */
  holder(sessionId: string): SessionHolder | null;
  /** What the client was shown of the session's terminal, decoded. */
  printed(): string;
}

async function attach(): Promise<Client> {
  const socket = createFakeMessageSocket();
  socket.onMessage(() => {});
  held().clients.attach(socket);
  const outbound: string[] = [];

  const client: Client = {
    send(frame: ClientFrame): void {
      const text = JSON.stringify(frame);
      outbound.push(text);
      socket.receive(text);
    },
    async say(frame: ClientFrame): Promise<void> {
      client.send(frame);
      await settle();
    },
    answer(id: number): HubFrame | undefined {
      return client.heard().find((frame) => 'replyTo' in frame && frame.replyTo === id);
    },
    said(): ClientFrame[] {
      return outbound.map((text) => parsedFrame(parseClientFrame, text));
    },
    heard(): HubFrame[] {
      return socket.sent.map((text) => parsedFrame(parseHubFrame, text));
    },
    holder(sessionId: string): SessionHolder | null {
      const latest = client
        .heard()
        .filter((frame) => frame.type === 'machine-state')
        .at(-1);
      if (latest?.type !== 'machine-state') return null;
      for (const store of latest.state.stores) {
        for (const row of store.sessions) {
          if (row.descriptor.sessionId === sessionId) return row.holder;
        }
      }
      return null;
    },
    printed(): string {
      return client
        .heard()
        .filter((frame) => frame.type === 'terminal-output')
        .map((frame) =>
          frame.type === 'terminal-output'
            ? new TextDecoder().decode(decodeTerminalChunk(frame.chunk))
            : '',
        )
        .join('');
    },
  };

  await client.say({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION });
  return client;
}

/** What the hub put to the machine, parsed as the server parses it. */
function instructions(): HubToServerFrame[] {
  return held().dialled.flatMap(({ hubEnd }) =>
    hubEnd.sent.map((text) => parsedFrame<HubToServerFrame>(parseHubToServerFrame, text)),
  );
}

/** What the machine answered the hub, parsed as the hub parses it. */
function answers(): ServerToHubFrame[] {
  return held().dialled.flatMap(({ serverEnd }) =>
    serverEnd.sent.map((text) => parsedFrame<ServerToHubFrame>(parseServerToHubFrame, text)),
  );
}

/**
 * Sends a retake and waits for its answer, firing the machine's poll each
 * turn: the retake answers only once the process it signalled is seen gone.
 * The hub's timers stay still until it has answered, since they hold the
 * deadline the hub put on the instruction.
 */
async function retake(client: Client, id: number, sessionId: SessionId): Promise<HubFrame> {
  client.send({ type: 'session-retake', id, storeId: WORK, sessionId });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await turns(40);
    const answered = client.answer(id);
    if (answered !== undefined) {
      await settle();
      return answered;
    }
    held().serverTimers.fireAll();
  }
  throw new Error(`nothing answered retake ${String(id)}`);
}

/** Starts the hub against a claude at `status`, and waits for the machine's first report. */
async function begin(status: string): Promise<void> {
  harness = await start(status);
  await until(
    () =>
      held()
        .state.snapshot()
        .stores.some((store) => store.sessions.length > 0),
    'the machine to report the sessions in its store',
  );
}

afterEach(async () => {
  if (harness !== null) {
    await harness.connections.stop();
    harness.clients.stop();
    harness.terminals.closeAll();
  }
  await migrated?.close();
  harness = null;
  migrated = null;
});

describe('retaking a session a claude outside agentplex is running', () => {
  it('ends the outside claude, resumes the session there, and leaves it held and watchable', async () => {
    await begin('idle');
    const client = await attach();

    // Before: a process runs the session and agentplex holds none of it.
    const before = held()
      .state.snapshot()
      .stores[0]?.sessions.find((row) => row.ref.sessionId === SESSION);
    expect(before?.descriptor.process).toBe('running');
    expect(before?.holder).toBeNull();

    const answered = await retake(client, 2, SESSION);

    expect(answered).toEqual({
      type: 'session-started',
      replyTo: 2,
      storeId: WORK,
      sessionId: SESSION,
      server: MACHINE,
    });
    // The hub put it to the machine by session, with the provider off its own
    // row; the machine ended the outside pid with SIGHUP and forked a resume.
    expect(instructions().filter((frame) => frame.type === 'session-retake')).toEqual([
      expect.objectContaining({ storeId: WORK, sessionId: SESSION, provider: 'claude' }),
    ]);
    expect(held().signalled()).toEqual([{ pid: OUTSIDE_PID, signal: 'SIGHUP' }]);
    expect(held().ptys.opened).toHaveLength(1);
    expect(held().ptys.opened[0]?.args).toEqual(expect.arrayContaining(['--resume', SESSION]));

    await until(() => client.holder(SESSION) !== null, 'the client to see the session held');
    expect(client.holder(SESSION)).toMatchObject({ server: MACHINE });

    await client.say({
      type: 'session-subscribe',
      id: 3,
      target: { by: 'session', storeId: WORK, sessionId: SESSION },
    });
    expect(client.answer(3)).toMatchObject({
      type: 'session-subscribed',
      storeId: WORK,
      sessionId: SESSION,
    });

    held().ptys.last?.emit('resumed here\r\n');
    await until(() => client.printed().includes('resumed here'), 'the terminal to reach the pane');
  });

  it("relays the machine's refusal of a claude mid-turn in the machine's words", async () => {
    await begin('busy');
    const client = await attach();

    const answered = await retake(client, 2, SESSION);

    const refused = answers().find((frame) => frame.type === 'session-refused');
    expect(refused?.type).toBe('session-refused');
    if (refused?.type !== 'session-refused') return;
    expect(refused.message).toContain('working elsewhere');
    expect(answered).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
      message: refused.message,
      holder: null,
    });
    expect(held().signalled()).toEqual([]);
    expect(held().ptys.opened).toEqual([]);
  });

  it("relays the machine's refusal of a codex row whose process it cannot name", async () => {
    await begin('idle');
    const client = await attach();

    const answered = await retake(client, 2, CODEX_SESSION);

    expect(instructions().filter((frame) => frame.type === 'session-retake')).toEqual([
      expect.objectContaining({ sessionId: CODEX_SESSION, provider: 'codex' }),
    ]);
    const refused = answers().find((frame) => frame.type === 'session-refused');
    if (refused?.type !== 'session-refused') throw new Error('the machine did not refuse');
    expect(answered).toMatchObject({ type: 'refusal', replyTo: 2, message: refused.message });
    expect(held().signalled()).toEqual([]);
  });

  it('carries no pid and no argv in either direction', async () => {
    await begin('idle');
    const client = await attach();
    await retake(client, 2, SESSION);

    for (const frame of client.said()) expect(forbiddenKeysIn(frame)).toEqual([]);
    for (const frame of instructions()) expect(forbiddenKeysIn(frame)).toEqual([]);
  });
});
