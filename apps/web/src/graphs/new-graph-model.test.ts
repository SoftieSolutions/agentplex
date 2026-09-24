import { beforeEach, describe, expect, it } from 'vitest';
import {
  nodeIdSchema,
  parseClientFrame,
  parseTextFrame,
  type ClientFrame,
  type NodeId,
} from '@agentplex/protocol';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import {
  buildGraphCreate,
  createGraphCreation,
  graphCreateBlockedReason,
  parseGraphName,
  type GraphCreation,
} from './new-graph-model.js';

/**
 * The New graph flow's rules, and the one piece of it that is not a pure
 * function: the store that sends the create and acts on the hub's answer.
 * Driven over the real hub store and a fake socket, so what opens the graph
 * is the frame a hub really sends and not a shape imagined here.
 */

const PROJECT = nodeIdSchema.parse('hub-5');
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function sent(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the form sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

describe('parseGraphName', () => {
  it('trims, and refuses a name of spaces in the schema’s words', () => {
    expect(parseGraphName('  release-pipeline ')).toEqual({ ok: true, name: 'release-pipeline' });
    expect(parseGraphName('   ')).toEqual({ ok: false, problem: 'give the graph a name' });
  });

  it('refuses a name longer than a node name may be', () => {
    const verdict = parseGraphName('x'.repeat(400));
    expect(verdict.ok).toBe(false);
  });
});

describe('buildGraphCreate', () => {
  it('is exactly the fields the frame defines', () => {
    expect(buildGraphCreate(PROJECT, 'release-pipeline')).toEqual({
      type: 'graph-create',
      projectId: 'hub-5',
      name: 'release-pipeline',
    });
  });
});

describe('graphCreateBlockedReason', () => {
  it('needs the connection, then a name, then a project', () => {
    expect(graphCreateBlockedReason('idle', 'x', PROJECT)).toBe('not connected to the hub');
    expect(graphCreateBlockedReason('reconnecting', 'x', PROJECT)).toMatch(/reconnecting/);
    expect(graphCreateBlockedReason('connected', ' ', PROJECT)).toBe('give the graph a name');
    expect(graphCreateBlockedReason('connected', 'x', null)).toBe(
      'pick the project this graph belongs to',
    );
    expect(graphCreateBlockedReason('connected', 'x', PROJECT)).toBeNull();
  });
});

describe('createGraphCreation', () => {
  let hub: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  let creation: GraphCreation;

  beforeEach(() => {
    sockets = createFakeSocketFactory();
    hub = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
    creation = createGraphCreation({ hub });
  });

  async function connected(): Promise<FakeSocket> {
    creation.subscribe(() => {});
    await settle();
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    socket.open();
    socket.deliver(hubFrames.welcome);
    return socket;
  }

  it('sends the create and waits on its frame', async () => {
    const socket = await connected();

    creation.submit(PROJECT, 'release-pipeline', () => {});

    expect(sent(socket).at(-1)).toEqual({
      type: 'graph-create',
      id: expect.any(Number),
      projectId: 'hub-5',
      name: 'release-pipeline',
    });
    expect(creation.getSnapshot()).toEqual({ waiting: true, refused: null });
  });

  it('calls back with the node the hub named, once, and stops waiting', async () => {
    const socket = await connected();
    const made: NodeId[] = [];
    creation.submit(PROJECT, 'release-pipeline', (nodeId) => made.push(nodeId));
    const create = sent(socket).at(-1);
    if (create === undefined || create.type !== 'graph-create') throw new Error('no create');

    socket.deliver(JSON.stringify({ type: 'graph-created', replyTo: create.id, nodeId: 'hub-10' }));
    socket.deliver(hubFrames.machineState);

    expect(made).toEqual(['hub-10']);
    expect(creation.getSnapshot()).toEqual({ waiting: false, refused: null });
  });

  it('ignores an answer to somebody else’s create', async () => {
    const socket = await connected();
    const made: NodeId[] = [];
    creation.submit(PROJECT, 'release-pipeline', (nodeId) => made.push(nodeId));

    socket.deliver(hubFrames.graphCreated);

    expect(made).toEqual([]);
    expect(creation.getSnapshot().waiting).toBe(true);
  });

  it('shows a refusal to its frame in the hub’s words', async () => {
    const socket = await connected();
    creation.submit(PROJECT, 'release-pipeline', () => {});
    const create = sent(socket).at(-1);
    if (create === undefined || create.type !== 'graph-create') throw new Error('no create');

    socket.deliver(
      JSON.stringify({
        type: 'refusal',
        replyTo: create.id,
        code: 'refused',
        message: 'a graph by that name is already in this project',
        holder: null,
      }),
    );

    expect(creation.getSnapshot()).toEqual({
      waiting: false,
      refused: 'a graph by that name is already in this project',
    });
  });

  it('says so when nothing could be sent', () => {
    // Never connected: the hub store queues, which is a wait the form should
    // not hide; the submit is refused with the store's own reason instead.
    creation.submit(PROJECT, 'release-pipeline', () => {});
    expect(creation.getSnapshot().waiting).toBe(false);
    expect(creation.getSnapshot().refused).toMatch(/not connected|queued|connection/);
  });

  it('stops waiting when the connection drops with the create out, and says so', async () => {
    const socket = await connected();
    const made: NodeId[] = [];
    creation.submit(PROJECT, 'release-pipeline', (nodeId) => made.push(nodeId));
    expect(creation.getSnapshot().waiting).toBe(true);

    socket.close();

    // The hub store forgets the frame without a refusal, so the form would
    // otherwise be disabled until the page reloads. Whether the create landed
    // is the tree's to show; the form only stops claiming it will hear back.
    expect(creation.getSnapshot().waiting).toBe(false);
    expect(creation.getSnapshot().refused).toMatch(/dropped/);
    expect(made).toEqual([]);
  });

  it('stops waiting when asked to start over', async () => {
    const socket = await connected();
    const made: NodeId[] = [];
    creation.submit(PROJECT, 'release-pipeline', (nodeId) => made.push(nodeId));
    const create = sent(socket).at(-1);
    if (create === undefined || create.type !== 'graph-create') throw new Error('no create');

    creation.reset();
    expect(creation.getSnapshot()).toEqual({ waiting: false, refused: null });

    // The answer to the abandoned create opens nothing: the form that asked
    // has moved on, and a navigation nobody is expecting is the surprise.
    socket.deliver(JSON.stringify({ type: 'graph-created', replyTo: create.id, nodeId: 'hub-10' }));
    expect(made).toEqual([]);
  });

  it('forgets a refusal when asked to start over', async () => {
    const socket = await connected();
    creation.submit(PROJECT, 'release-pipeline', () => {});
    const create = sent(socket).at(-1);
    if (create === undefined || create.type !== 'graph-create') throw new Error('no create');
    socket.deliver(
      JSON.stringify({
        type: 'refusal',
        replyTo: create.id,
        code: 'refused',
        message: 'no',
        holder: null,
      }),
    );

    creation.reset();

    expect(creation.getSnapshot()).toEqual({ waiting: false, refused: null });
  });
});
