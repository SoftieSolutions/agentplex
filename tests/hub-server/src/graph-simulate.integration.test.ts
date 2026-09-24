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
import { createHumanExecutor } from '../../../apps/hub/src/features/graph-runs/human-executor.js';
import { createGraphRuns } from '../../../apps/hub/src/features/graph-runs/graph-runs.js';

/**
 * A simulation, from a client's frame to the path it answers, over the same
 * composed hub the run suite drives -- and nothing on the machine's end.
 *
 * Everything but the wire and the pty is the shipped code: a paired server
 * with a real handshake, the real reducer, the real graphs feature over a
 * real schema, and the real runtime with the AGENT executor whose placement
 * goes through the same start routing a client's start does. The questions
 * are the two a simulation exists to answer and the one it must never get
 * wrong: does the path say why at every step, does the AGENT name the
 * machine a run would use, and does the server end receive no instruction
 * and the database no run while it happens.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };
const WORK = storeIdSchema.parse('store-work');
const ATTIC = 'registration-attic' as ServerRegistrationId;
const PROJECT = 'project-agentplex' as NodeId;
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
  migrated = await openMigratedSchema(`graph-simulate-${suite}`);
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
     VALUES (?, NULL, 'project', 0, 'agentplex', 'user', ?)`,
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
/** TRIGGER -> ROUTER -> AGENT -> HUMAN, drafted and never published. */
const DRAFT: GraphDocument = graphDocumentSchema.parse({
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
    {
      ...BASE,
      id: 'gate',
      kind: 'human',
      label: 'Ana approves',
      approvers: ['ana'],
      timeoutMinutes: 30,
    },
  ],
  edges: [
    { from: 'start', to: 'classify' },
    { from: 'review', to: 'gate' },
  ],
});

/** A graph with this draft saved and nothing published, made through the frames a client sends. */
async function draftGraph(client: Client, document: GraphDocument = DRAFT): Promise<NodeId> {
  await client.say({ type: 'graph-create', id: 2, projectId: PROJECT, name: 'release-pipeline' });
  const created = client.reply(2);
  if (created.type !== 'graph-created') throw new Error('the graph was refused');
  await client.say({ type: 'graph-save', id: 3, nodeId: created.nodeId, document });
  if (client.reply(3).type !== 'graph-saved') throw new Error('the save was refused');
  return created.nodeId;
}

/** The type of every frame the hub sent the machine, in order. */
function instructionTypes(): string[] {
  return held().machine.sentToServer.map((text) => {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return 'unknown';
    return String(parsed.type);
  });
}

describe('a graph simulation over the whole path', () => {
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

  it('answers the path of a TRIGGER, ROUTER, AGENT, HUMAN draft, and the machine hears nothing', async () => {
    const client = await attach();
    const nodeId = await draftGraph(client);
    const sentBefore = instructionTypes().length;
    // The capture is live: the handshake the hub began went through it.
    expect(sentBefore).toBeGreaterThan(0);

    await client.say({ type: 'graph-simulate', id: 5, nodeId, input: { language: 'rust' } });

    expect(client.reply(5)).toEqual({
      type: 'graph-simulated',
      replyTo: 5,
      nodeId,
      path: [
        {
          nodeId: 'start',
          kind: 'trigger',
          depth: 0,
          outcome: 'would-run',
          why: 'would start the run with {"language":"rust"}',
        },
        {
          nodeId: 'classify',
          kind: 'router',
          depth: 0,
          outcome: 'would-run',
          why: 'route 1, language == rust, would send it to Rust reviewer: language is "rust"',
        },
        {
          nodeId: 'review',
          kind: 'agent',
          depth: 0,
          outcome: 'would-run',
          // The machine the hub's one start routing chose, by its label.
          why: 'would run claude on attic',
        },
        {
          nodeId: 'gate',
          kind: 'human',
          depth: 0,
          outcome: 'would-wait',
          why: 'would wait on a person up to 30 minutes for ana',
        },
      ],
      reason: null,
    });

    // No session-start, nor any other instruction, reached the server end.
    const sent = instructionTypes().slice(sentBefore);
    expect(sent).not.toContain('session-start');
    expect(sent).toEqual([]);
    expect(held().machine.ptys.ptys).toHaveLength(0);
    // No run was numbered: no row, and no state to any client.
    const rows = await migrated?.database.query('SELECT id FROM graph_runs');
    expect(rows?.rows).toEqual([]);
    expect(client.frames().some((frame) => frame.type === 'graph-run-state')).toBe(false);
  });

  it('says no machine could take an AGENT pinned to a machine this hub is not paired with', async () => {
    const client = await attach();
    const pinned = graphDocumentSchema.parse({
      ...DRAFT,
      nodes: DRAFT.nodes.map((node) =>
        node.kind === 'agent'
          ? { ...node, placement: { kind: 'pin', server: 'registration-gone' } }
          : node,
      ),
    });
    const nodeId = await draftGraph(client, pinned);

    await client.say({ type: 'graph-simulate', id: 5, nodeId, input: { language: 'rust' } });

    const answer = client.reply(5);
    if (answer.type !== 'graph-simulated') throw new Error(`simulate answered ${answer.type}`);
    expect(answer.path.map((step) => [step.nodeId, step.outcome])).toEqual([
      ['start', 'would-run'],
      ['classify', 'would-run'],
      ['review', 'would-stop'],
    ]);
    expect(answer.path.at(-1)?.why).toBe(
      'no machine could take this node: Rust reviewer is pinned to a server this hub is not paired with',
    );
    expect(answer.reason).toBe(
      'a run would stop at the AGENT node Rust reviewer: no machine could take this node: Rust reviewer is pinned to a server this hub is not paired with',
    );
  });

  it('refuses a node that is no graph, in words', async () => {
    const client = await attach();
    await client.say({ type: 'graph-simulate', id: 5, nodeId: PROJECT, input: {} });
    expect(client.reply(5)).toMatchObject({
      type: 'refusal',
      replyTo: 5,
      code: 'refused',
      message: 'this hub has no graph by that id',
    });
  });

  it('sends no frame carrying a key the wire forbids, either way', async () => {
    const client = await attach();
    const nodeId = await draftGraph(client);
    await client.say({ type: 'graph-simulate', id: 5, nodeId, input: { language: 'rust' } });

    for (const text of [...client.said, ...client.socket.sent]) {
      expect(forbiddenKeysIn(JSON.parse(text))).toEqual([]);
    }
  });
});
