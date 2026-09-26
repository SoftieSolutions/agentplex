import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  parseHubFrame,
  parseTextFrame,
  CLIENT_PROTOCOL_VERSION,
  type ClientFrame,
  type GraphDocument,
  type HubFrame,
  type NodeId,
} from '@agentplex/protocol';
import { createFakeMessageSocket, createFakeTimers } from '@agentplex/node-shared/testing';
import { createLogger } from '@agentplex/node-shared';
import { createClients, type Clients } from '../../../apps/hub/src/clients/clients.js';
import { createFakeApprovals } from '../../../apps/hub/src/approvals/fake-approvals.js';
import { createFakeApprovalPolicy } from '../../../apps/hub/src/approval-policy/fake-approval-policy.js';
import { createFakeAttention } from '../../../apps/hub/src/attention/fake-attention.js';
import { createFakeCatalogue } from '../../../apps/hub/src/catalogue/fake-catalogue.js';
import { createFakeDocs } from '../../../apps/hub/src/docs/fake-docs.js';
import { createFakePairing } from '../../../apps/hub/src/pairing/fake-pairing.js';
import { createFakeProjects } from '../../../apps/hub/src/projects/fake-projects.js';
import { createFakeSessions } from '../../../apps/hub/src/sessions/fake-sessions.js';
import { createFakeTerminal } from '../../../apps/hub/src/terminal/fake-terminal.js';
import { createFleetState } from '../../../apps/hub/src/fleet-state/fleet-state.js';
import { createGraphs } from '../../../apps/hub/src/graphs/graphs.js';
import { createFakeGraphRuns } from '../../../apps/hub/src/graph-runs/fake-graph-runs.js';
import {
  openMigratedSchema,
  type MigratedSchema,
} from '../../../apps/hub/src/db/test-migrated-schema.js';
import { forbiddenKeysIn } from './frame-keys.js';

/**
 * A graph, from a client's frame to the hub's rows and back.
 *
 * Unlike a document, nothing here crosses to a server end: a graph is content
 * the hub holds, and the runtime that would put a step on a machine is
 * AGX-146's. So what this file drives is the half of the path that exists --
 * the real broadcast over a fake socket, the real graphs feature over a real
 * schema -- and what it has to establish is that the four frames round-trip
 * through the one parser each direction has, that a publish the feature
 * refuses reaches the client as a refusal in the feature's words, and that no
 * frame on the way carries a key the wire forbids.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };
const PROJECT = 'project-universe' as NodeId;

let migrated: MigratedSchema | null = null;
let clients: Clients | null = null;
let treeChanges = 0;
let suite = 0;

async function start(): Promise<Clients> {
  suite += 1;
  migrated = await openMigratedSchema(`graphs-relay-${suite}`);
  const { database } = migrated;
  await database.query(
    `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
     VALUES (?, NULL, 'project', 0, 'universe', 'user', ?)`,
    [PROJECT, START],
  );
  await database.query('INSERT INTO projects (node_id, directory, created_at) VALUES (?, ?, ?)', [
    PROJECT,
    '/srv/work/universe',
    START,
  ]);

  let minted = 0;
  const graphs = createGraphs({
    database,
    ids: { newId: () => `node-${String((minted += 1))}` },
    clock,
    logger,
    onTreeChanged: () => {
      treeChanges += 1;
    },
  });

  const state = createFleetState({ logger });
  return createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers: createFakeTimers(),
    logger,
    readLayout: async () => [],
    readPaneLayout: async () => null,
    writePaneLayout: async () => undefined,
    // Every seam but the subject is a fake: what this file is about is a graph
    // from frame to row and back, and nothing in it reaches a machine.
    sessions: createFakeSessions(),
    attention: createFakeAttention(),
    approvals: createFakeApprovals(),
    approvalPolicy: createFakeApprovalPolicy(),
    pairing: createFakePairing(),
    syncServers: async () => undefined,
    projects: createFakeProjects(),
    catalogue: createFakeCatalogue(),
    docs: createFakeDocs(),
    graphs,
    graphRuns: createFakeGraphRuns(),
    terminal: createFakeTerminal(),
    push: null,
  });
}

interface Client {
  say(frame: ClientFrame): Promise<void>;
  reply(id: number): HubFrame;
  readonly all: () => HubFrame[];
}

async function attach(): Promise<Client> {
  if (clients === null) throw new Error('no broadcast: beforeEach did not run');
  const socket = createFakeMessageSocket();
  socket.onMessage(() => {});
  clients.attach(socket);

  const all = (): HubFrame[] =>
    socket.sent.map((text) => {
      const parsed = parseTextFrame(parseHubFrame, text);
      if (!parsed.ok) throw new Error(`the hub sent an unparseable frame: ${parsed.reason}`);
      return parsed.value;
    });

  const client: Client = {
    async say(frame: ClientFrame): Promise<void> {
      socket.receive(JSON.stringify(frame));
      for (let turn = 0; turn < 20; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    reply(id: number): HubFrame {
      const answer = all().find((frame) => 'replyTo' in frame && frame.replyTo === id);
      if (answer === undefined) throw new Error(`nothing answered frame ${String(id)}`);
      return answer;
    },
    all,
  };
  await client.say({ type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION });
  return client;
}

const BASE = {
  position: { x: 0, y: 0 },
  placement: { kind: 'cheapest' },
  retry: { max: 0, backoff: 1 },
};
const TRIGGER = { ...BASE, id: 'start', kind: 'trigger', label: 'PR opened', source: 'manual' };

const RUNNABLE: GraphDocument = graphDocumentSchema.parse({
  nodes: [
    TRIGGER,
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
      prompt: 'Review the Rust in this change.',
      provider: 'claude',
      storeId: 'store-universe',
    },
  ],
  edges: [
    { from: 'start', to: 'classify' },
    { from: 'classify', to: 'review' },
  ],
});

const WITH_ACTION: GraphDocument = graphDocumentSchema.parse({
  nodes: [TRIGGER, { ...BASE, id: 'merge', kind: 'action', label: 'Merge + tag', name: 'merge' }],
  edges: [{ from: 'start', to: 'merge' }],
});

async function withGraph(): Promise<{ client: Client; nodeId: NodeId }> {
  const client = await attach();
  await client.say({ type: 'graph-create', id: 2, projectId: PROJECT, name: 'release-pipeline' });
  const created = client.reply(2);
  if (created.type !== 'graph-created') throw new Error('the graph was refused');
  return { client, nodeId: created.nodeId };
}

beforeEach(async () => {
  treeChanges = 0;
  clients = await start();
});

afterEach(async () => {
  clients?.stop();
  clients = null;
  await migrated?.close();
  migrated = null;
});

describe('a graph over a client socket', () => {
  it('creates a graph under the project and says the tree changed', async () => {
    const { client, nodeId } = await withGraph();

    expect(nodeId).toBe('node-1');
    expect(treeChanges).toBe(1);
    expect(client.reply(2)).toEqual({ type: 'graph-created', replyTo: 2, nodeId });
  });

  it('opens a fresh graph as draft v1 of nothing, with no published versions', async () => {
    const { client, nodeId } = await withGraph();

    await client.say({ type: 'graph-open', id: 3, nodeId });

    expect(client.reply(3)).toEqual({
      type: 'graph-document',
      replyTo: 3,
      nodeId,
      name: 'release-pipeline',
      draftVersion: 1,
      document: { nodes: [], edges: [] },
      published: [],
    });
  });

  it('saves the draft, publishes it as v1, and opens draft v2 as a copy', async () => {
    const { client, nodeId } = await withGraph();

    await client.say({ type: 'graph-save', id: 3, nodeId, document: RUNNABLE });
    await client.say({ type: 'graph-publish', id: 4, nodeId });
    await client.say({ type: 'graph-open', id: 5, nodeId });

    expect(client.reply(3)).toEqual({
      type: 'graph-saved',
      replyTo: 3,
      version: 1,
      updatedAt: START,
    });
    expect(client.reply(4)).toEqual({ type: 'graph-published', replyTo: 4, version: 1 });
    expect(client.reply(5)).toMatchObject({
      type: 'graph-document',
      replyTo: 5,
      draftVersion: 2,
      document: RUNNABLE,
      published: [{ version: 1, publishedAt: START }],
    });
    // A save and a publish change no row the tree carries.
    expect(treeChanges).toBe(1);
  });

  it('refuses to publish a draft with an ACTION node, in the feature’s words', async () => {
    const { client, nodeId } = await withGraph();
    await client.say({ type: 'graph-save', id: 3, nodeId, document: WITH_ACTION });

    await client.say({ type: 'graph-publish', id: 4, nodeId });

    const answer = client.reply(4);
    expect(answer).toMatchObject({ type: 'refusal', replyTo: 4, code: 'refused', holder: null });
    if (answer.type !== 'refusal') return;
    expect(answer.message).toContain('no action of that name exists on this build');
  });

  it('refuses a node that is not a graph on every frame that names one', async () => {
    const client = await attach();

    await client.say({ type: 'graph-open', id: 2, nodeId: PROJECT });
    await client.say({ type: 'graph-save', id: 3, nodeId: PROJECT, document: RUNNABLE });
    await client.say({ type: 'graph-publish', id: 4, nodeId: PROJECT });

    for (const id of [2, 3, 4]) {
      expect(client.reply(id)).toMatchObject({ type: 'refusal', replyTo: id, code: 'refused' });
    }
  });

  it('refuses a create in a project this hub does not have', async () => {
    const client = await attach();

    await client.say({
      type: 'graph-create',
      id: 2,
      projectId: 'node-nowhere' as NodeId,
      name: 'release',
    });

    expect(client.reply(2)).toMatchObject({ type: 'refusal', replyTo: 2, code: 'refused' });
    expect(treeChanges).toBe(0);
  });

  it('carries no forbidden key on any frame either way', async () => {
    const { client, nodeId } = await withGraph();
    await client.say({ type: 'graph-save', id: 3, nodeId, document: RUNNABLE });
    await client.say({ type: 'graph-publish', id: 4, nodeId });
    await client.say({ type: 'graph-open', id: 5, nodeId });

    for (const frame of client.all()) expect(forbiddenKeysIn(frame)).toEqual([]);
    for (const frame of [
      { type: 'graph-create', id: 2, projectId: PROJECT, name: 'x' },
      { type: 'graph-save', id: 3, nodeId, document: RUNNABLE },
      { type: 'graph-publish', id: 4, nodeId },
      { type: 'graph-open', id: 5, nodeId },
    ]) {
      expect(forbiddenKeysIn(frame)).toEqual([]);
    }
  });
});
