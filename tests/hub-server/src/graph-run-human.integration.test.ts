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
import { createApprovals } from '../../../apps/hub/src/features/approvals/approvals.js';
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
 * A run that reaches a HUMAN node, over the whole path: the hub's own
 * request in the machine state every client reads, a client's Allow or Deny
 * through the same frame a session's approval takes, and the run moving on
 * or ending because of it.
 *
 * The harness is `graph-run.integration.test.ts`'s with one difference: the
 * approvals feature is the real one, wired as `hub.ts` wires it, because the
 * question here is whether a request the hub raised itself is drawn, answered
 * and ended through the same feature a machine's request is. The AGENT node
 * after the gate is what proves Allow continued the run rather than ended it.
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
  migrated = await openMigratedSchema(`graph-run-human-${suite}`);
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
  // The real approvals feature, wired as `hub.ts` wires it: a session's list
  // to its row, the runs waiting on a person beside the stores, a decision
  // for a machine's request over the connection, and no standing policy.
  const approvals = createApprovals({
    clock,
    logger,
    onChanged: (ref, pending) => state.applyApprovals(ref, pending),
    onGraphRunChanged: (waiting) => state.applyGraphRunApprovals(waiting),
    dispatch: (instruction) =>
      new Promise((resolve) => {
        connections.decide(
          instruction.registrationId,
          {
            type: 'approval-decide',
            approvalId: instruction.approvalId,
            decision: instruction.decision,
          },
          (refusal) => resolve({ ok: false, code: refusal.code, problem: refusal.problem }),
        );
      }),
    policy: async () => null,
  });
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
const EDGES = [
  { from: 'start', to: 'gate' },
  { from: 'gate', to: 'review' },
];

/** TRIGGER, a HUMAN gate that waits as long as it takes, then an AGENT. */
const GATED: GraphDocument = graphDocumentSchema.parse({
  nodes: [
    TRIGGER,
    {
      ...BASE,
      id: 'gate',
      kind: 'human',
      label: 'Ship it',
      approvers: ['robert', 'ana'],
      timeoutMinutes: null,
    },
    REVIEW,
  ],
  edges: EDGES,
});

/** The same, with a gate that gives up after five minutes. */
const TIMED: GraphDocument = graphDocumentSchema.parse({
  nodes: [
    TRIGGER,
    {
      ...BASE,
      id: 'gate',
      kind: 'human',
      label: 'Ship it',
      approvers: ['robert'],
      timeoutMinutes: 5,
    },
    REVIEW,
  ],
  edges: EDGES,
});

async function publishedGraph(client: Client, document: GraphDocument): Promise<NodeId> {
  await client.say({ type: 'graph-create', id: 2, projectId: PROJECT, name: 'release' });
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

/** The runs waiting on a person, as the last machine state this client was sent lists them. */
function waitingOn(client: Client): MachineState['graphRunApprovals'] {
  const states = client.frames().filter((frame) => frame.type === 'machine-state');
  const last = states.at(-1);
  if (last === undefined || last.type !== 'machine-state') return [];
  return last.state.graphRunApprovals;
}

/** The same list as the hub itself publishes it, before any broadcast has flushed. */
function waitingAtTheHub(): MachineState['graphRunApprovals'] {
  return held().state.published().graphRunApprovals;
}

/**
 * Lets the coalesced broadcast go out. The broadcast flushes on the injected
 * timers, so a frame carrying a state change reaches no client until they
 * fire -- and firing them fires every pending timer, a HUMAN node's deadline
 * included. Called only where nothing but the flush is scheduled.
 */
async function flushed(): Promise<void> {
  held().timers.fireAll();
  for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Runs a published graph until it is waiting at the gate; answers the run id and the request. */
async function runToTheGate(
  client: Client,
  document: GraphDocument,
): Promise<{
  readonly runId: string;
  readonly waiting: MachineState['graphRunApprovals'][number];
}> {
  const nodeId = await publishedGraph(client, document);
  await client.say({ type: 'graph-run', id: 5, nodeId, input: { language: 'rust' } });
  const started = client.reply(5);
  if (started.type !== 'graph-run-started') throw new Error('the run was refused');

  await until(
    () => runStates(client).some((state) => state.status === 'waiting'),
    'the run to wait at the gate',
  );
  await until(() => waitingAtTheHub().length === 1, 'the request to reach the machine state');
  const [waiting] = waitingAtTheHub();
  if (waiting === undefined) throw new Error('nothing is waiting');
  expect(waiting).toMatchObject({
    graph: nodeId,
    number: 1,
    nodeLabel: 'Ship it',
    approval: {
      subject: { kind: 'graphRun', runId: started.runId, nodeId: 'gate' },
      tool: 'HUMAN',
      truncated: false,
      suggestions: [],
      answeredBy: null,
    },
  });
  return { runId: started.runId, waiting };
}

describe('a graph run that waits on a person, over the whole path', () => {
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

  it('shows the request in every client’s machine state, with the graph, the number and the words', async () => {
    const client = await attach();
    const watcher = await attach();
    const { waiting } = await runToTheGate(client, GATED);
    await flushed();

    // The words name the graph, the node and who was asked; the run state
    // says waiting and carries no request of its own.
    expect(waiting.approval.proposal).toContain('release');
    expect(waiting.approval.proposal).toContain('Ship it');
    expect(waiting.approval.proposal).toContain('robert, ana');
    expect(runStates(client).at(-1)).toMatchObject({
      status: 'waiting',
      step: 2,
      of: 3,
      steps: [
        { nodeId: 'start', outcome: 'succeeded' },
        { nodeId: 'gate', attempt: 0, outcome: 'waiting', output: null },
      ],
    });
    // Both clients read the same list off the same state frame.
    expect(waitingOn(client)).toEqual([waiting]);
    expect(waitingOn(watcher)).toEqual([waiting]);
    // And nothing was put on any session row, and no session was started.
    expect(
      held()
        .state.published()
        .stores.some((store) => store.sessions.some((row) => row.approvals.length > 0)),
    ).toBe(false);
    expect(held().machine.ptys.opened).toEqual([]);
  });

  it('Allow continues the run: the request leaves the state and the AGENT after the gate runs', async () => {
    const client = await attach();
    const { waiting } = await runToTheGate(client, GATED);
    providerWrites('session-fresh', PROJECT_DIRECTORY);

    await client.say({
      type: 'approval-decide',
      id: 6,
      subject: waiting.approval.subject,
      approvalId: waiting.approval.approvalId,
      decision: 'grant',
    });

    // The receipt arrives at once: the hub is the authority on its own run.
    expect(client.reply(6)).toEqual({
      type: 'approval-decided',
      replyTo: 6,
      outcome: 'granted',
      answeredBy: null,
    });
    await until(() => waitingAtTheHub().length === 0, 'the request to leave the state');
    await until(
      () => runStates(client).some((state) => state.status === 'succeeded'),
      'the run to succeed',
    );
    expect(runStates(client).at(-1)).toMatchObject({
      status: 'succeeded',
      steps: [
        { nodeId: 'start', outcome: 'succeeded' },
        { nodeId: 'gate', outcome: 'succeeded', output: null },
        { nodeId: 'review', outcome: 'succeeded' },
      ],
    });
    // Continued, not ended: the AGENT after the gate forked its prompt.
    expect(held().machine.ptys.opened.map((request) => request.args)).toEqual([[PROMPT]]);
    // Nothing went to the machine about the decision: it was the hub's to make.
    expect(held().machine.sentToServer.some((text) => text.includes('approval-decide'))).toBe(
      false,
    );
  });

  it('a client that comes back mid-wait reads the run as waiting, finds the request, and its Allow continues the run', async () => {
    const client = await attach();
    const { runId, waiting } = await runToTheGate(client, GATED);
    providerWrites('session-fresh', PROJECT_DIRECTORY);

    // A reconnection is a new socket that was sent no run state: it asks.
    const back = await attach();
    expect(runStates(back)).toEqual([]);
    await back.say({ type: 'graph-run-read', id: 2, nodeId: waiting.graph });
    expect(runStates(back).at(-1)).toMatchObject({
      nodeId: waiting.graph,
      runId,
      status: 'waiting',
      steps: [
        { nodeId: 'start', outcome: 'succeeded' },
        { nodeId: 'gate', attempt: 0, outcome: 'waiting', output: null },
      ],
    });
    // The request is not on the run state; it is in the machine state every
    // socket is sent whole, so the socket that came back holds it too.
    await flushed();
    expect(waitingOn(back)).toEqual([waiting]);

    await back.say({
      type: 'approval-decide',
      id: 3,
      subject: waiting.approval.subject,
      approvalId: waiting.approval.approvalId,
      decision: 'grant',
    });

    expect(back.reply(3)).toMatchObject({ type: 'approval-decided', outcome: 'granted' });
    // The read made it a watcher, so the run's end reaches it unasked.
    await until(
      () => runStates(back).some((state) => state.status === 'succeeded'),
      'the run to succeed on the socket that came back',
    );
    expect(waitingAtTheHub()).toEqual([]);
  });

  it('Deny fails the run naming the node, and starts nothing', async () => {
    const client = await attach();
    const { waiting } = await runToTheGate(client, GATED);

    await client.say({
      type: 'approval-decide',
      id: 6,
      subject: waiting.approval.subject,
      approvalId: waiting.approval.approvalId,
      decision: 'deny',
    });

    expect(client.reply(6)).toMatchObject({ type: 'approval-decided', outcome: 'denied' });
    await until(
      () => runStates(client).some((state) => state.status === 'failed'),
      'the run to fail',
    );
    expect(runStates(client).at(-1)).toMatchObject({
      status: 'failed',
      reason: 'the HUMAN node Ship it failed: a person denied Ship it',
      step: 2,
    });
    expect(waitingAtTheHub()).toEqual([]);
    expect(held().machine.ptys.opened).toEqual([]);
  });

  it('tells a second answer what the first one did', async () => {
    const client = await attach();
    const second = await attach();
    const { waiting } = await runToTheGate(client, GATED);

    await client.say({
      type: 'approval-decide',
      id: 6,
      subject: waiting.approval.subject,
      approvalId: waiting.approval.approvalId,
      decision: 'deny',
    });
    await second.say({
      type: 'approval-decide',
      id: 2,
      subject: waiting.approval.subject,
      approvalId: waiting.approval.approvalId,
      decision: 'grant',
    });

    expect(second.reply(2)).toMatchObject({ type: 'approval-decided', outcome: 'denied' });
  });

  it('a timeout fails the run naming the node and the minutes, and withdraws the request', async () => {
    const client = await attach();
    const { waiting } = await runToTheGate(client, TIMED);
    expect(held().timers.delays).toContain(5 * 60_000);

    held().timers.fireAll();

    await until(
      () => runStates(client).some((state) => state.status === 'failed'),
      'the run to fail at the deadline',
    );
    expect(runStates(client).at(-1)).toMatchObject({
      status: 'failed',
      reason:
        'the HUMAN node Ship it failed: Ship it waited 5 minutes for a person and nobody answered',
    });
    await until(() => waitingAtTheHub().length === 0, 'the request to leave the state');

    // A late tap is told the word rather than that nothing existed.
    await client.say({
      type: 'approval-decide',
      id: 6,
      subject: waiting.approval.subject,
      approvalId: waiting.approval.approvalId,
      decision: 'grant',
    });
    expect(client.reply(6)).toMatchObject({ type: 'approval-decided', outcome: 'withdrawn' });
  });

  it('a cancel withdraws the request and ends the run cancelled', async () => {
    const client = await attach();
    const { runId } = await runToTheGate(client, GATED);

    await client.say({ type: 'graph-run-cancel', id: 6, runId: runId as never });

    expect(client.reply(6)).toMatchObject({ type: 'graph-run-cancelled' });
    await until(
      () => runStates(client).some((state) => state.status === 'cancelled'),
      'the run to be cancelled',
    );
    expect(waitingAtTheHub()).toEqual([]);
  });

  it('carries no forbidden key on any frame in any direction', async () => {
    const client = await attach();
    const { waiting } = await runToTheGate(client, GATED);
    await client.say({
      type: 'approval-decide',
      id: 6,
      subject: waiting.approval.subject,
      approvalId: waiting.approval.approvalId,
      decision: 'deny',
    });
    await until(
      () => runStates(client).some((state) => state.status === 'failed'),
      'the run to fail',
    );

    for (const frame of client.frames()) expect(forbiddenKeysIn(frame)).toEqual([]);
    for (const text of client.said) expect(forbiddenKeysIn(JSON.parse(text))).toEqual([]);
    for (const text of [...held().machine.sentToServer, ...held().machine.sentToHub]) {
      expect(forbiddenKeysIn(JSON.parse(text))).toEqual([]);
    }
  });
});
