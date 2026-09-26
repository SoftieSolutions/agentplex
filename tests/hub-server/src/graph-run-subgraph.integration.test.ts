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
import { createDirectoryBrowser } from '../../../apps/server/src/directories/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/directories/fake-directory-reader.js';
import { createSessionController } from '../../../apps/server/src/sessions/session-control.js';
import { createFakeWorkingTree } from '../../../apps/server/src/working-tree/fake-working-tree.js';
import {
  createTerminalManager,
  type TerminalManager,
} from '../../../apps/server/src/terminal/terminal-manager.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/machine-load/fake-machine-probe.js';
import { createClients, type Clients } from '../../../apps/hub/src/clients/clients.js';
import { createFakeApprovals } from '../../../apps/hub/src/approvals/fake-approvals.js';
import { createFakeApprovalPolicy } from '../../../apps/hub/src/approval-policy/fake-approval-policy.js';
import { createFakeAttention } from '../../../apps/hub/src/attention/fake-attention.js';
import { createFakeDocs } from '../../../apps/hub/src/docs/fake-docs.js';
import { toMachineState } from '../../../apps/hub/src/fleet-state/machine-state.js';
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
import { createCatalogue } from '../../../apps/hub/src/catalogue/catalogue.js';
import { createProjects } from '../../../apps/hub/src/projects/projects.js';
import { createSessions } from '../../../apps/hub/src/sessions/sessions.js';
import { createTasks } from '../../../apps/hub/src/tasks/tasks.js';
import { createTerminal } from '../../../apps/hub/src/terminal/terminal.js';
import { createGraphs } from '../../../apps/hub/src/graphs/graphs.js';
import { createAgentExecutor } from '../../../apps/hub/src/graph-runs/agent-executor.js';
import { createHumanExecutor } from '../../../apps/hub/src/graph-runs/human-executor.js';
import { createGraphRuns } from '../../../apps/hub/src/graph-runs/graph-runs.js';

/**
 * A SUB-GRAPH run over the whole path: a parent graph whose middle node runs
 * another graph at a pinned published version, driven by client frames and
 * with the child's AGENT step reaching a real server end.
 *
 * The harness is `graph-run.integration.test.ts`'s. The questions are the
 * ones only the joined path answers: does the child run the version the node
 * pins rather than the child graph's newest, is it a run of the child graph
 * with its own number -- in that graph's history, and named on the parent's
 * step so a person can follow it -- and does a graph that reaches itself fail
 * in words naming the node rather than looping or starting anything.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };
const WORK = storeIdSchema.parse('store-work');
const ATTIC = 'registration-attic' as ServerRegistrationId;
const PROJECT = 'project-work' as NodeId;
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
    terminals: createTerminalManager({ supervisor, clock, timers: createFakeTimers() }),
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
  migrated = await openMigratedSchema(`graph-run-subgraph-${suite}`);
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
     VALUES (?, NULL, 'project', 0, 'work', 'user', ?)`,
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
  // No graph here reaches a HUMAN node; the executor is built over the fake
  // approvals the connection is given so the table is whole.
  const approvals = createFakeApprovals();
  const human = createHumanExecutor({ approvals, ids, timers, logger });
  const graphRuns = createGraphRuns({
    database,
    ids,
    clock,
    timers,
    logger,
    graphs,
    agent,
    human,
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
    approvals,
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
const TRIGGER = { ...BASE, id: 'start', kind: 'trigger', label: 'PR opened', source: 'manual' };
const REVIEW = {
  ...BASE,
  id: 'review',
  kind: 'agent',
  label: 'Rust reviewer',
  prompt: PROMPT,
  provider: 'claude',
  storeId: WORK,
};
/** The child graph's v1: a TRIGGER and an AGENT that reaches the machine. */
const CHILD_V1: GraphDocument = graphDocumentSchema.parse({
  nodes: [TRIGGER, REVIEW],
  edges: [{ from: 'start', to: 'review' }],
});
/** The child graph's v2: the TRIGGER alone. A run of v2 starts no session. */
const CHILD_V2: GraphDocument = graphDocumentSchema.parse({ nodes: [TRIGGER], edges: [] });

function pinning(graph: NodeId, version: number): GraphDocument {
  return graphDocumentSchema.parse({
    nodes: [
      TRIGGER,
      { ...BASE, id: 'lint', kind: 'subgraph', label: 'Lint suite', graph, version },
    ],
    edges: [{ from: 'start', to: 'lint' }],
  });
}

let frameId = 10;
/** A frame id no earlier frame on this client has used. */
function nextId(): number {
  frameId += 1;
  return frameId;
}

/** Saves and publishes a document to a graph through the frames a client sends. */
async function publish(client: Client, nodeId: NodeId, document: GraphDocument): Promise<void> {
  await client.say({ type: 'graph-save', id: nextId(), nodeId, document });
  const publishId = nextId();
  await client.say({ type: 'graph-publish', id: publishId, nodeId });
  const answer = client.reply(publishId);
  if (answer.type !== 'graph-published') throw new Error(`the publish was refused: ${answer.type}`);
}

/** A graph made and published once or more, through client frames. */
async function graphWith(
  client: Client,
  name: string,
  ...versions: GraphDocument[]
): Promise<NodeId> {
  const createId = nextId();
  await client.say({ type: 'graph-create', id: createId, projectId: PROJECT, name });
  const created = client.reply(createId);
  if (created.type !== 'graph-created') {
    throw new Error(`the graph was refused: ${JSON.stringify(created)}`);
  }
  for (const document of versions) await publish(client, created.nodeId, document);
  return created.nodeId;
}

function runStates(client: Client): Extract<HubFrame, { type: 'graph-run-state' }>[] {
  return client.frames().filter((frame) => frame.type === 'graph-run-state');
}

async function historyOf(
  client: Client,
  nodeId: NodeId,
): Promise<Extract<HubFrame, { type: 'graph-run-history' }>['runs']> {
  const historyId = nextId();
  await client.say({ type: 'graph-run-history-request', id: historyId, nodeId });
  const answer = client.reply(historyId);
  if (answer.type !== 'graph-run-history') throw new Error(`no history: ${answer.type}`);
  expect(answer.nodeId).toBe(nodeId);
  return answer.runs;
}

describe('a SUB-GRAPH run over the whole path', () => {
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

  it('runs the child at the pinned version, numbered in its own graph and named on the parent step', async () => {
    const client = await attach();
    const child = await graphWith(client, 'lint-suite', CHILD_V1, CHILD_V2);
    // The child graph has run once on its own, so the child is its run #2.
    await client.say({ type: 'graph-run', id: 5, nodeId: child, input: {} });
    await until(
      () => runStates(client).some((state) => state.status === 'succeeded'),
      'the child graph’s own run to end',
    );
    expect(held().machine.ptys.ptys).toHaveLength(0);

    const parent = await graphWith(client, 'release-pipeline', pinning(child, 1));
    providerWrites('session-fresh', PROJECT_DIRECTORY);
    await client.say({ type: 'graph-run', id: 6, nodeId: parent, input: { language: 'rust' } });
    const started = client.reply(6);
    if (started.type !== 'graph-run-started') throw new Error('the run was refused');

    await until(
      () =>
        runStates(client).some(
          (state) => state.runId === started.runId && state.status === 'succeeded',
        ),
      'the parent run to succeed',
    );

    const parentEnd = runStates(client)
      .filter((state) => state.runId === started.runId)
      .at(-1);
    const lint = parentEnd?.steps.find((step) => step.nodeId === 'lint');
    expect(lint).toMatchObject({ outcome: 'succeeded', child: { number: 2 } });
    const named = lint?.child;
    if (named === null || named === undefined) throw new Error('the step named no child');

    // Pinned at v1: the child's AGENT started a session on the machine,
    // which v2 -- the child graph's newest -- has no node for.
    expect(held().machine.ptys.ptys).toHaveLength(1);
    const childEnd = runStates(client)
      .filter((state) => state.runId === named.runId)
      .at(-1);
    expect(childEnd).toMatchObject({
      nodeId: child,
      number: 2,
      status: 'succeeded',
      of: 2,
    });
    expect(childEnd?.steps.map((step) => step.nodeId)).toEqual(['start', 'review']);

    // The child is in its own graph's history, newest first, under its own
    // number; the parent's history is the parent's run alone.
    expect((await historyOf(client, child)).map((run) => [run.runId, run.number])).toEqual([
      [named.runId, 2],
      [expect.any(String), 1],
    ]);
    expect((await historyOf(client, parent)).map((run) => run.runId)).toEqual([started.runId]);

    // And the child opens whole from the parent's step, as a run of the child
    // graph, in an answer addressed to the open.
    const openId = nextId();
    await client.say({ type: 'graph-run-open', id: openId, nodeId: child, runId: named.runId });
    expect(client.reply(openId)).toMatchObject({
      type: 'graph-run-latest',
      nodeId: child,
      run: { nodeId: child, runId: named.runId, number: 2 },
    });
  });

  it('fails a graph that reaches itself, naming the node, and numbers no child', async () => {
    const client = await attach();
    const graph = await graphWith(client, 'release-pipeline', CHILD_V2);
    // v2 pins v1 of the same graph: publish allows it, the run refuses it.
    await publish(client, graph, pinning(graph, 1));

    await client.say({ type: 'graph-run', id: 5, nodeId: graph, input: {} });
    const started = client.reply(5);
    if (started.type !== 'graph-run-started') throw new Error('the run was refused');
    await until(
      () => runStates(client).some((state) => state.status === 'failed'),
      'the run to fail',
    );

    expect(runStates(client).at(-1)).toMatchObject({
      runId: started.runId,
      status: 'failed',
      reason:
        'the SUB-GRAPH node Lint suite failed: it would run release-pipeline, which is already running above it in this chain: release-pipeline → release-pipeline',
    });
    expect(await historyOf(client, graph)).toHaveLength(1);
    expect(held().machine.ptys.ptys).toHaveLength(0);
  });

  it('carries no forbidden key on any frame in any direction', async () => {
    const client = await attach();
    const child = await graphWith(client, 'lint-suite', CHILD_V2);
    const parent = await graphWith(client, 'release-pipeline', pinning(child, 1));
    await client.say({ type: 'graph-run', id: 5, nodeId: parent, input: {} });
    await until(
      () =>
        runStates(client).some((state) => state.nodeId === parent && state.status !== 'running'),
      'the run to end',
    );
    await historyOf(client, child);

    for (const frame of client.frames()) expect(forbiddenKeysIn(frame)).toEqual([]);
    for (const text of client.said) expect(forbiddenKeysIn(JSON.parse(text))).toEqual([]);
  });
});
