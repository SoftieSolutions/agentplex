import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  parseHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  serverIdSchema,
  storeIdSchema,
  type ClientFrame,
  type GraphDocument,
  type HubFrame,
  type MachineState,
  type NodeId,
  type ServerRegistrationId,
  type SessionRow,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  createSocketPair,
  createFakeTimers,
  type FakeMessageSocket,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import { createLogger, type DialResult, type SocketDialer } from '@agentplex/node-shared';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import {
  createFakeProviderAdapter,
  createFakeProviderFiles,
  createFakeStoreFiles,
  readyProvider,
} from '@agentplex/providers/testing';
import { createProviderRegistry, type ProviderFiles } from '@agentplex/providers';
import { serveServerEnd } from './server-end.js';
import { forbiddenKeysIn } from './frame-keys.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/fake-directory-reader.js';
import { createSessionController } from '../../../apps/server/src/session-control.js';
import { createFakeWorkingTree } from '../../../apps/server/src/fake-working-tree.js';
import {
  createTerminalManager,
  type TerminalManager,
} from '../../../apps/server/src/terminal-manager.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { createClients, type Clients } from '../../../apps/hub/src/features/clients/clients.js';
import { createFakeApprovals } from '../../../apps/hub/src/features/approvals/fake-approvals.js';
import { createFakeApprovalPolicy } from '../../../apps/hub/src/features/approval-policy/fake-approval-policy.js';
import { createFakeAttention } from '../../../apps/hub/src/features/attention/fake-attention.js';
import { createFakeDocs } from '../../../apps/hub/src/features/docs/fake-docs.js';
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
import { createCatalogue } from '../../../apps/hub/src/features/catalogue/catalogue.js';
import { createProjects } from '../../../apps/hub/src/features/projects/projects.js';
import { createSessions } from '../../../apps/hub/src/features/sessions/sessions.js';
import { createTasks } from '../../../apps/hub/src/features/tasks/tasks.js';
import { createTerminal } from '../../../apps/hub/src/features/terminal/terminal.js';
import { createGraphs } from '../../../apps/hub/src/features/graphs/graphs.js';
import { createAgentExecutor } from '../../../apps/hub/src/features/graph-runs/agent-executor.js';
import { createGraphRuns } from '../../../apps/hub/src/features/graph-runs/graph-runs.js';

/**
 * A run, from a client's frame to a process on another machine and back to
 * every client as the run moves.
 *
 * Everything but the wire and the pty is the shipped code: a paired server
 * with a real handshake, both parsers, the real reducer, the real broadcast,
 * the real graphs feature over a real schema, and the real runtime whose
 * AGENT step goes through the same `Sessions.start` a client's start takes.
 * What is faked is what a test cannot supply -- a socket, a forked process,
 * a provider's files on disk.
 *
 * The questions here are the ones that only appear once the whole path is
 * joined: does the run's session appear as an ordinary row with its TASK set
 * to the node's prompt, does the AGENT step end when that row says the agent
 * is waiting, does every client hear the run move, and does no frame on the
 * way carry a key the wire forbids.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };
const WORK = storeIdSchema.parse('store-work');
const ATTIC = 'registration-attic' as ServerRegistrationId;
const PROJECT = 'project-universe' as NodeId;
const PROJECT_DIRECTORY = '/volumes/work/agentplex';
const PROMPT = 'Review the Rust in this change.';

interface Machine {
  readonly terminals: TerminalManager;
  readonly ptys: FakePtyFactory;
  readonly transcripts: Record<string, string>;
  readonly sentToHub: string[];
  readonly sentToServer: string[];
}

interface Harness {
  readonly state: FleetState;
  readonly clients: Clients;
  readonly connections: Servers;
  readonly machine: Machine;
  readonly timers: FakeTimers;
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

/** The provider writing its transcript as a spawned session comes up. */
function providerWrites(sessionId: string, cwd: string): void {
  held().machine.transcripts[`/volumes/work/claude/sessions/${sessionId}.json`] = JSON.stringify({
    signal: 'awaiting-input',
    updatedAt: START,
    cwd,
  });
}

function buildMachine(): Machine {
  const ptys = createFakePtyFactory();
  const supervisor = createPtySupervisor({
    pty: ptys,
    clock,
    ids: { newId: () => `attic-run-${String(ptys.ptys.length)}` },
    environment: { PATH: '/usr/bin' },
  });
  return {
    terminals: createTerminalManager({ supervisor, clock }),
    ptys,
    transcripts: {},
    sentToHub: [],
    sentToServer: [],
  };
}

function directoryBrowser(): ReturnType<typeof createDirectoryBrowser> {
  return createDirectoryBrowser({
    roots: ['/volumes/work'],
    reader: createFakeDirectoryReader({
      directories: {
        '/volumes/work': [{ name: 'agentplex', kind: 'directory' }],
        [PROJECT_DIRECTORY]: [],
      },
    }),
  });
}

function serveMachine(machine: Machine): DialResult {
  const files: ProviderFiles = {
    readFile: (path) => createFakeProviderFiles({ files: machine.transcripts }).readFile(path),
    listDirectory: (path) =>
      createFakeProviderFiles({ files: machine.transcripts }).listDirectory(path),
    readFileTail: (path, maxBytes) =>
      createFakeProviderFiles({ files: machine.transcripts }).readFileTail(path, maxBytes),
  };
  const adapter = createFakeProviderAdapter({ provider: 'claude', files });
  const stores: StoreDescriptor[] = [{ storeId: WORK, path: '/volumes/work' }];
  const { hubEnd, serverEnd } = createSocketPair();

  serveServerEnd(serverEnd, {
    identity: { serverId: serverIdSchema.parse('server-attic'), token: 'tok-attic' },
    browse: directoryBrowser(),
    stores,
    providers: [readyProvider('claude')],
    terminals: machine.terminals,
    machineLoad: createFakeMachineLoadReader(),
    sessions: createSessionController({
      stores,
      providers: createProviderRegistry([adapter]),
      terminals: machine.terminals,
      workingTree: createFakeWorkingTree(),
      browse: directoryBrowser(),
      approvals: null,
      clock,
      logger,
    }),
    logger,
  });

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
  migrated = await openMigratedSchema(`graph-run-${suite}`);
  const database = migrated.database;

  const machine = buildMachine();
  await registerServer(
    database,
    { newId: () => ATTIC },
    clock,
    newServerRegistrationSchema.parse({
      label: 'attic',
      address: 'wss://attic.example:8443',
      token: 'tok-attic',
    }),
  );
  // A project whose directory is under the machine's browse root, so the
  // run's session can be started in it -- the runtime passes the graph's
  // project, and the projects rows are where that becomes a directory.
  await database.query(
    `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
     VALUES (?, NULL, 'project', 0, 'universe', 'user', ?)`,
    [PROJECT, START],
  );
  await database.query('INSERT INTO projects (node_id, directory, created_at) VALUES (?, ?, ?)', [
    PROJECT,
    PROJECT_DIRECTORY,
    START,
  ]);

  const dialer: SocketDialer = {
    dial: async (address: string): Promise<DialResult> =>
      new URL(address).hostname === 'attic.example'
        ? serveMachine(machine)
        : { ok: false, problem: 'connection refused' },
  };

  const timers = createFakeTimers();
  const state = createFleetState({ logger });
  let minted = 0;
  const ids = { newId: () => `hub-${String((minted += 1))}` };

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
      if (accepted) void catalogue.observe(report.storeId);
      terminal.noteStarts(report.registrationId, report.storeId, report.starts);
      void tasks.noteStarts(report.storeId, report.starts);
      // The same wiring `hub.ts` has: the third reader of the start tags.
      graphRuns.noteStarts(report.storeId, report.starts);
    },
    onStream: (registrationId, output) => terminal.deliver(registrationId, output),
  });

  const terminal = createTerminal({ state, servers: connections, logger });
  const projects = createProjects({
    database,
    ids,
    clock,
    state,
    connections,
    logger,
    onTreeChanged: () => catalogue.changed(),
  });
  const catalogue = createCatalogue({
    database,
    ids,
    clock,
    logger,
    readStore: (storeId) => state.storeSessions(storeId),
    projects,
    readHolder: () => null,
    readFleet: () => state.published(),
  });
  const tasks = createTasks({
    database,
    logger,
    onChanged: (ref, task) => state.applyTask(ref, task),
  });
  const sessions = createSessions({
    state,
    projects,
    connections,
    ids,
    logger,
    onStarted: (started) => tasks.noteStart(started),
  });
  const graphs = createGraphs({
    database,
    ids,
    clock,
    logger,
    onTreeChanged: () => catalogue.changed(),
  });

  // The runtime, composed as `hub.ts` composes it: the one executor that
  // reaches a machine goes through the same `sessions` a client's start does,
  // and every state goes to every client through the broadcast built below.
  let clients: Clients | null = null;
  const agent = createAgentExecutor({ sessions, state, timers, logger });
  const graphRuns = createGraphRuns({
    database,
    ids,
    clock,
    timers,
    logger,
    graphs,
    agent,
    onState: (run) => clients?.runStateChanged(run),
  });
  await graphRuns.load();

  clients = createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers,
    logger,
    readLayout: () => catalogue.readLayout(),
    readPaneLayout: async () => null,
    writePaneLayout: async () => undefined,
    sessions,
    attention: createFakeAttention(),
    approvals: createFakeApprovals(),
    approvalPolicy: createFakeApprovalPolicy(),
    pairing,
    syncServers: () => connections.sync(),
    projects,
    catalogue,
    docs: createFakeDocs(),
    graphs,
    graphRuns,
    terminal,
    push: null,
  });

  await connections.sync();
  return { state, clients, connections, machine, timers };
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

interface Client {
  say(frame: ClientFrame): Promise<void>;
  /** Everything the hub has sent this client so far, through the client's own parser. */
  frames(): HubFrame[];
  reply(id: number): HubFrame;
  row(sessionId: string): SessionRow | undefined;
  readonly said: readonly string[];
  readonly socket: FakeMessageSocket;
}

async function attach(): Promise<Client> {
  const socket = createFakeMessageSocket();
  const said: string[] = [];
  socket.onMessage(() => {});
  held().clients.attach(socket);

  const frames = (): HubFrame[] =>
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
      for (let turn = 0; turn < 40; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    frames,
    reply(id: number): HubFrame {
      const answer = frames().find((frame) => 'replyTo' in frame && frame.replyTo === id);
      if (answer === undefined) throw new Error(`nothing answered frame ${String(id)}`);
      return answer;
    },
    row(sessionId: string): SessionRow | undefined {
      const state: MachineState = toMachineState(held().state.snapshot());
      return state.stores
        .flatMap((store) => store.sessions)
        .find((row) => row.descriptor.sessionId === sessionId);
    },
    said,
    socket,
  };
  await client.say({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
  return client;
}

const BASE = {
  position: { x: 0, y: 0 },
  placement: { kind: 'cheapest' },
  retry: { max: 0, backoff: 1 },
};
const RUNNABLE: GraphDocument = graphDocumentSchema.parse({
  nodes: [
    { ...BASE, id: 'start', kind: 'trigger', label: 'PR opened', source: 'manual' },
    {
      ...BASE,
      id: 'classify',
      kind: 'router',
      label: 'Classify diff',
      model: 'haiku',
      routes: [{ condition: 'language == rust', to: 'review' }],
      otherwise: null,
    },
    {
      ...BASE,
      id: 'review',
      kind: 'agent',
      label: 'Rust reviewer',
      prompt: PROMPT,
      provider: 'claude',
      storeId: WORK,
    },
  ],
  edges: [{ from: 'start', to: 'classify' }],
});

/** A published graph of the document above, made through the frames a client sends. */
async function publishedGraph(client: Client, document: GraphDocument = RUNNABLE): Promise<NodeId> {
  await client.say({ type: 'graph-create', id: 2, projectId: PROJECT, name: 'release-pipeline' });
  const created = client.reply(2);
  if (created.type !== 'graph-created') throw new Error('the graph was refused');
  await client.say({ type: 'graph-save', id: 3, nodeId: created.nodeId, document });
  await client.say({ type: 'graph-publish', id: 4, nodeId: created.nodeId });
  if (client.reply(4).type !== 'graph-published') throw new Error('the publish was refused');
  return created.nodeId;
}

function runStates(client: Client): Extract<HubFrame, { type: 'graph-run-state' }>[] {
  return client.frames().filter((frame) => frame.type === 'graph-run-state');
}

describe('a graph run over the whole path', () => {
  beforeEach(async () => {
    harness = await start();
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'the server to be connected',
    );
    await until(
      () => held().state.snapshot().stores.length === 1,
      'the server to have reported the store',
    );
  });

  afterEach(async () => {
    await harness?.connections.stop();
    harness?.clients.stop();
    await migrated?.close();
    harness = null;
    migrated = null;
  });

  it('runs a published graph: started, then every state until succeeded, with the session an ordinary row', async () => {
    const client = await attach();
    const watcher = await attach();
    const nodeId = await publishedGraph(client);
    providerWrites('session-fresh', PROJECT_DIRECTORY);

    await client.say({ type: 'graph-run', id: 5, nodeId, input: { language: 'rust' } });

    const started = client.reply(5);
    expect(started).toMatchObject({ type: 'graph-run-started', replyTo: 5, number: 1 });
    if (started.type !== 'graph-run-started') return;

    await until(
      () => runStates(client).some((state) => state.status === 'succeeded'),
      'the run to succeed',
    );
    const states = runStates(client);
    expect(states[0]).toMatchObject({
      runId: started.runId,
      number: 1,
      status: 'running',
      step: 0,
      of: 3,
    });
    expect(states.at(-1)).toMatchObject({
      runId: started.runId,
      number: 1,
      status: 'succeeded',
      reason: null,
      step: 3,
      of: 3,
      steps: [
        { nodeId: 'start', attempt: 0, outcome: 'succeeded', output: { language: 'rust' } },
        { nodeId: 'classify', attempt: 0, outcome: 'succeeded', output: { language: 'rust' } },
        {
          nodeId: 'review',
          attempt: 0,
          outcome: 'succeeded',
          output: { storeId: WORK, sessionId: 'session-fresh', status: 'awaiting-input' },
        },
      ],
    });
    // The strip's live reading existed on the way: the agent was running at step 3.
    expect(
      states.some(
        (state) =>
          state.status === 'running' &&
          state.step === 3 &&
          state.steps.at(-1)?.nodeId === 'review' &&
          state.steps.at(-1)?.outcome === 'running',
      ),
    ).toBe(true);

    // The other client heard the same run move, unsolicited.
    expect(runStates(watcher).at(-1)).toEqual(states.at(-1));

    // The machine forked the prompt as one argv element, in the project's directory.
    expect(held().machine.ptys.opened.map((request) => request.args)).toEqual([[PROMPT]]);
    expect(held().machine.ptys.opened[0]?.cwd).toBe(PROJECT_DIRECTORY);

    // And the session is an ordinary row: held by the machine, with its TASK
    // set to the node's prompt, which is what `tasks.ts` does for any start.
    await until(() => client.row('session-fresh')?.task === PROMPT, 'the task to be filed');
    expect(client.row('session-fresh')).toMatchObject({
      holder: { server: ATTIC, stoppable: true },
      task: PROMPT,
    });
  });

  it('fails a run whose router matches nothing, naming the node, and starts no session', async () => {
    const client = await attach();
    const nodeId = await publishedGraph(client);

    await client.say({ type: 'graph-run', id: 5, nodeId, input: { language: 'go' } });

    expect(client.reply(5).type).toBe('graph-run-started');
    await until(
      () => runStates(client).some((state) => state.status === 'failed'),
      'the run to fail',
    );
    expect(runStates(client).at(-1)).toMatchObject({
      status: 'failed',
      reason:
        'the ROUTER node Classify diff failed: no route on Classify diff matched and it has no otherwise',
      step: 2,
    });
    expect(held().machine.ptys.opened).toEqual([]);
  });

  it('refuses a run of a graph nothing has been published of, and a cancel of no run', async () => {
    const client = await attach();
    await client.say({ type: 'graph-create', id: 2, projectId: PROJECT, name: 'draft-only' });
    const created = client.reply(2);
    if (created.type !== 'graph-created') throw new Error('the graph was refused');

    await client.say({ type: 'graph-run', id: 3, nodeId: created.nodeId, input: {} });
    await client.say({ type: 'graph-run-cancel', id: 4, runId: 'run-nowhere' as never });

    expect(client.reply(3)).toMatchObject({
      type: 'refusal',
      replyTo: 3,
      code: 'refused',
      message: 'this graph has no published version to run; publish it first',
    });
    expect(client.reply(4)).toMatchObject({
      type: 'refusal',
      replyTo: 4,
      code: 'refused',
      message: 'no run by that id is in flight',
    });
  });

  it('carries no forbidden key on any frame in any direction', async () => {
    const client = await attach();
    const nodeId = await publishedGraph(client);
    providerWrites('session-fresh', PROJECT_DIRECTORY);
    await client.say({ type: 'graph-run', id: 5, nodeId, input: { language: 'rust' } });
    await until(
      () => runStates(client).some((state) => state.status === 'succeeded'),
      'the run to succeed',
    );

    for (const frame of client.frames()) expect(forbiddenKeysIn(frame)).toEqual([]);
    for (const text of client.said) expect(forbiddenKeysIn(JSON.parse(text))).toEqual([]);
    for (const text of [...held().machine.sentToServer, ...held().machine.sentToHub]) {
      expect(forbiddenKeysIn(JSON.parse(text))).toEqual([]);
    }
  });
});
