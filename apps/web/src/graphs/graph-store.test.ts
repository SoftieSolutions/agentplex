import { beforeEach, describe, expect, it } from 'vitest';
import {
  graphNodeIdSchema,
  nodeIdSchema,
  parseClientFrame,
  parseTextFrame,
  type ClientFrame,
} from '@agentplex/protocol';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { moveNode, setNodeField } from './graph-model.js';
import { createGraphStore, type GraphStore } from './graph-store.js';

/**
 * One open graph as the screen holds it: asked for on the first subscriber,
 * edited through the model, saved and published through the hub store's
 * commands, and dirty exactly while the document differs from what the hub
 * last confirmed.
 *
 * Driven over the real hub store and a fake socket, with the hub's answers
 * the captured fixture carries, so what clears dirty is a frame a hub really
 * sends and not a shape somebody imagined.
 */

const GRAPH = nodeIdSchema.parse('hub-10');
const START = graphNodeIdSchema.parse('start');
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function sent(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the store sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

function refusalTo(replyTo: number, message: string): string {
  return JSON.stringify({ type: 'refusal', replyTo, code: 'refused', message, holder: null });
}

describe('createGraphStore', () => {
  let hub: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  let timers: ReturnType<typeof createFakeTimers>;
  let store: GraphStore;
  let changes: number;

  beforeEach(() => {
    sockets = createFakeSocketFactory();
    timers = createFakeTimers();
    hub = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers,
      frameIds: createFrameIdCounter(),
    });
    store = createGraphStore({ hub, nodeId: GRAPH });
    changes = 0;
  });

  /** Subscribes, connects, and delivers the welcome; the open goes out on the way. */
  async function open(): Promise<{ socket: FakeSocket; stop: () => void }> {
    const stop = store.subscribe(() => {
      changes += 1;
    });
    await settle();
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    socket.open();
    socket.deliver(hubFrames.welcome);
    return { socket, stop };
  }

  /** Opened, with the hub's word that the graph has never run, so Run is free. */
  async function opened(): Promise<{ socket: FakeSocket; stop: () => void }> {
    const handle = await open();
    handle.socket.deliver(hubFrames.graphDocument);
    handle.socket.deliver(noneFor(frameOf(handle.socket, 'graph-run-read').id));
    return handle;
  }

  /** The hub's word that the graph has never run, addressed to the read this store sent. */
  function noneFor(frameId: number): string {
    const captured = JSON.parse(hubFrames.graphRunLatestNone) as object;
    return JSON.stringify({ ...captured, replyTo: frameId, nodeId: 'hub-10' });
  }

  /**
   * The hub's answer to a read that found a run, addressed to the read this
   * store sent, carrying one of the captured states of this graph's runs.
   */
  function latestFor(frameId: number, stateFrame: string): string {
    const captured = JSON.parse(hubFrames.graphRunLatestFound) as object;
    const { type: _type, ...run } = JSON.parse(stateFrame) as { type: string; nodeId: string };
    return JSON.stringify({ ...captured, replyTo: frameId, nodeId: run.nodeId, run });
  }

  /** The captured run parked at a HUMAN node, filed under this store's graph. */
  function waitingHere(): string {
    const captured = JSON.parse(hubFrames.graphRunStateWaiting) as { nodeId: string };
    return JSON.stringify({ ...captured, nodeId: 'hub-10' });
  }

  type Addressed = Extract<ClientFrame, { id: number }>;

  function frameOf(socket: FakeSocket, type: Addressed['type']): Addressed {
    const frame = sent(socket)
      .filter((each): each is Addressed => each.type === type && 'id' in each)
      .at(-1);
    if (frame === undefined) throw new Error(`no ${type} was sent`);
    return frame;
  }

  it('asks for the graph once something subscribes, and holds nothing until it is answered', async () => {
    expect(store.getSnapshot().document).toBeNull();
    const { socket } = await open();

    expect(sent(socket).filter((frame) => frame.type === 'graph-open')).toEqual([
      { type: 'graph-open', id: expect.any(Number), nodeId: 'hub-10' },
    ]);
    expect(store.getSnapshot().document).toBeNull();
    expect(store.getSnapshot().dirty).toBe(false);
  });

  it('takes the hub’s answer whole: name, draft, published versions and the document', async () => {
    await opened();

    const state = store.getSnapshot();
    expect(state.name).toBe('release-pipeline');
    expect(state.draftVersion).toBe(2);
    expect(state.published).toEqual([{ version: 1, publishedAt: 1756000000000 }]);
    expect(state.document?.nodes.map((node) => node.id)).toEqual(['start', 'classify', 'review']);
    expect(state.dirty).toBe(false);
    expect(state.problem).toBeNull();
  });

  it('ignores a graph-document about another node', async () => {
    const other = createGraphStore({ hub, nodeId: nodeIdSchema.parse('hub-99') });
    other.subscribe(() => {});
    await opened();

    expect(other.getSnapshot().document).toBeNull();
    expect(store.getSnapshot().document).not.toBeNull();
  });

  it('applies an accepted edit and is dirty until the hub confirms it', async () => {
    await opened();
    const before = changes;

    store.edit((document) => moveNode(document, START, { x: 40, y: 92 }));

    const state = store.getSnapshot();
    expect(state.document?.nodes[0]?.position).toEqual({ x: 40, y: 92 });
    expect(state.dirty).toBe(true);
    expect(changes).toBe(before + 1);
  });

  it('keeps the document and says why when an edit is refused', async () => {
    await opened();

    store.edit((document) => setNodeField(document, START, 'retry', { max: 99, backoff: 1 }));

    const state = store.getSnapshot();
    expect(state.document?.nodes[0]?.retry).toEqual({ max: 0, backoff: 1 });
    expect(state.dirty).toBe(false);
    expect(state.problem).toMatch(/10/);
  });

  it('does nothing with an edit before the document has arrived', async () => {
    await open();

    store.edit((document) => moveNode(document, START, { x: 1, y: 1 }));

    expect(store.getSnapshot().document).toBeNull();
    expect(store.getSnapshot().dirty).toBe(false);
  });

  it('saves the document as edited, positions included, and is clean once the save lands', async () => {
    const { socket } = await opened();
    store.edit((document) => moveNode(document, START, { x: 40, y: 92 }));

    store.save();

    const save = frameOf(socket, 'graph-save');
    if (save.type !== 'graph-save') throw new Error('not a save');
    expect(save.nodeId).toBe('hub-10');
    expect(save.document.nodes[0]?.position).toEqual({ x: 40, y: 92 });
    expect(store.getSnapshot().saving).toBe(true);

    socket.deliver(
      JSON.stringify({
        type: 'graph-saved',
        replyTo: save.id,
        version: 2,
        updatedAt: 1756000500000,
      }),
    );

    const state = store.getSnapshot();
    expect(state.dirty).toBe(false);
    expect(state.saving).toBe(false);
    expect(state.savedVersion).toBe(2);
    expect(state.savedAt).toBe(1756000500000);
  });

  it('sends no save while nothing is dirty', async () => {
    const { socket } = await opened();

    store.save();

    expect(sent(socket).filter((frame) => frame.type === 'graph-save')).toEqual([]);
  });

  it('stays dirty when an edit was made after the save went out', async () => {
    const { socket } = await opened();
    store.edit((document) => moveNode(document, START, { x: 40, y: 92 }));
    store.save();
    const save = frameOf(socket, 'graph-save');
    store.edit((document) => moveNode(document, START, { x: 41, y: 92 }));

    socket.deliver(
      JSON.stringify({
        type: 'graph-saved',
        replyTo: save.id,
        version: 2,
        updatedAt: 1756000500000,
      }),
    );

    expect(store.getSnapshot().dirty).toBe(true);
    expect(store.getSnapshot().saving).toBe(false);
  });

  it('ignores a graph-saved that answers some other frame', async () => {
    const { socket } = await opened();
    store.edit((document) => moveNode(document, START, { x: 40, y: 92 }));
    store.save();

    socket.deliver(hubFrames.graphSaved);

    expect(store.getSnapshot().dirty).toBe(true);
  });

  it('publishes what it saved: a dirty draft is saved first, and the publish waits for the save to land', async () => {
    const { socket } = await opened();
    store.edit((document) => moveNode(document, START, { x: 40, y: 92 }));

    store.publish();

    // Nothing but the save has gone: a publish sent in the same breath would
    // stamp whatever draft the hub holds if the save were refused.
    expect(sent(socket).filter((frame) => frame.type === 'graph-publish')).toEqual([]);
    expect(store.getSnapshot().saving).toBe(true);
    expect(store.getSnapshot().publishing).toBe(true);

    const save = frameOf(socket, 'graph-save');
    socket.deliver(
      JSON.stringify({ type: 'graph-saved', replyTo: save.id, version: 2, updatedAt: 1 }),
    );

    expect(
      sent(socket)
        .map((frame) => frame.type)
        .slice(-2),
    ).toEqual(['graph-save', 'graph-publish']);
    expect(store.getSnapshot().saving).toBe(false);
    expect(store.getSnapshot().publishing).toBe(true);
  });

  it('cancels the publish when the save it waited on is refused, and says why', async () => {
    const { socket } = await opened();
    store.edit((document) => moveNode(document, START, { x: 40, y: 92 }));
    store.publish();
    const save = frameOf(socket, 'graph-save');

    socket.deliver(refusalTo(save.id, 'the draft moved on under you'));

    expect(sent(socket).filter((frame) => frame.type === 'graph-publish')).toEqual([]);
    const state = store.getSnapshot();
    expect(state.saving).toBe(false);
    expect(state.publishing).toBe(false);
    expect(state.dirty).toBe(true);
    expect(state.problem).toBe('the draft moved on under you');
  });

  it('is clean after a publish lands, and asks for the graph again to learn the new draft', async () => {
    const { socket } = await opened();
    store.publish();
    const publish = frameOf(socket, 'graph-publish');
    const opensBefore = sent(socket).filter((frame) => frame.type === 'graph-open').length;

    socket.deliver(JSON.stringify({ type: 'graph-published', replyTo: publish.id, version: 2 }));

    const state = store.getSnapshot();
    expect(state.dirty).toBe(false);
    expect(state.publishing).toBe(false);
    // The published list and the new draft's number are the hub's to say, so
    // neither is written here: the re-ask is what brings them.
    expect(state.published.map((row) => row.version)).toEqual([1]);
    expect(sent(socket).filter((frame) => frame.type === 'graph-open')).toHaveLength(
      opensBefore + 1,
    );
  });

  it('keeps an edit made while the publish was out, and takes the new draft’s number around it', async () => {
    const { socket } = await opened();
    store.publish();
    const publish = frameOf(socket, 'graph-publish');
    store.edit((document) => moveNode(document, START, { x: 40, y: 92 }));

    socket.deliver(JSON.stringify({ type: 'graph-published', replyTo: publish.id, version: 2 }));

    // What was published is the draft the hub held, not the edit made since:
    // the edit is still unsaved and still on screen.
    expect(store.getSnapshot().dirty).toBe(true);
    expect(store.getSnapshot().document?.nodes[0]?.position).toEqual({ x: 40, y: 92 });

    // The re-asked answer is the hub's new draft, a copy of what was stamped.
    socket.deliver(
      hubFrames.graphDocument
        .replace('"draftVersion":2', '"draftVersion":3')
        .replace(
          '"published":[{"version":1,"publishedAt":1756000000000}]',
          '"published":[{"version":1,"publishedAt":1756000000000},{"version":2,"publishedAt":1756000600000}]',
        ),
    );

    const state = store.getSnapshot();
    expect(state.draftVersion).toBe(3);
    expect(state.published.map((row) => row.version)).toEqual([1, 2]);
    expect(state.dirty).toBe(true);
    expect(state.document?.nodes[0]?.position).toEqual({ x: 40, y: 92 });
  });

  it('shows a refusal to its own frame in the hub’s words, and ignores one to another', async () => {
    const { socket } = await opened();
    store.publish();
    const publish = frameOf(socket, 'graph-publish');

    socket.deliver(refusalTo(publish.id + 500, 'somebody else’s problem'));
    expect(store.getSnapshot().problem).toBeNull();

    socket.deliver(refusalTo(publish.id, 'no action of that name exists on this build'));

    const state = store.getSnapshot();
    expect(state.problem).toBe('no action of that name exists on this build');
    expect(state.publishing).toBe(false);
  });

  it('shows a refusal to the open', async () => {
    const { socket } = await open();
    const openFrame = frameOf(socket, 'graph-open');

    socket.deliver(refusalTo(openFrame.id, 'this hub has no graph by that id'));

    expect(store.getSnapshot().problem).toBe('this hub has no graph by that id');
  });

  it('asks again when the connection comes back and nothing is unsaved', async () => {
    const { socket } = await opened();
    socket.close();
    timers.fireAll();
    await settle();
    const second = sockets.sockets[1];
    if (second === undefined) throw new Error('the hub store did not redial');

    second.open();
    second.deliver(hubFrames.welcome);

    expect(sent(second).filter((frame) => frame.type === 'graph-open')).toEqual([
      { type: 'graph-open', id: expect.any(Number), nodeId: 'hub-10' },
    ]);
    // The draft is still on screen while the answer is on its way.
    expect(store.getSnapshot().document).not.toBeNull();
  });

  it('keeps an unsaved draft across a reconnection rather than asking for the hub’s copy', async () => {
    const { socket } = await opened();
    store.edit((document) => moveNode(document, START, { x: 40, y: 92 }));
    socket.close();
    timers.fireAll();
    await settle();
    const second = sockets.sockets[1];
    if (second === undefined) throw new Error('the hub store did not redial');

    second.open();
    second.deliver(hubFrames.welcome);

    expect(sent(second).filter((frame) => frame.type === 'graph-open')).toEqual([]);
    expect(store.getSnapshot().dirty).toBe(true);
    expect(store.getSnapshot().document?.nodes[0]?.position).toEqual({ x: 40, y: 92 });
  });

  /** Drops the socket and lets the hub store redial; the welcome is the caller's to deliver. */
  async function dropped(socket: FakeSocket): Promise<FakeSocket> {
    socket.close();
    timers.fireAll();
    await settle();
    const second = sockets.sockets[1];
    if (second === undefined) throw new Error('the hub store did not redial');
    return second;
  }

  it('lets Save be pressed again when the connection drops with a save out', async () => {
    const { socket } = await opened();
    store.edit((document) => moveNode(document, START, { x: 40, y: 92 }));
    store.save();
    expect(store.getSnapshot().saving).toBe(true);

    const second = await dropped(socket);

    // The hub store forgot the frame without a refusal; the draft is still
    // unsaved, so Save has to come back rather than spin for ever.
    expect(store.getSnapshot().saving).toBe(false);
    expect(store.getSnapshot().dirty).toBe(true);
    expect(store.getSnapshot().problem).toMatch(/dropped/);

    second.open();
    second.deliver(hubFrames.welcome);
    store.save();
    expect(sent(second).filter((frame) => frame.type === 'graph-save')).toHaveLength(1);
  });

  it('stops publishing when the connection drops with a publish out, and asks for the graph again', async () => {
    const { socket } = await opened();
    store.publish();
    expect(store.getSnapshot().publishing).toBe(true);

    const second = await dropped(socket);
    second.open();
    second.deliver(hubFrames.welcome);

    expect(store.getSnapshot().publishing).toBe(false);
    expect(sent(second).filter((frame) => frame.type === 'graph-open')).toHaveLength(1);
  });

  it('asks again when the connection drops before the first answer', async () => {
    const { socket } = await open();

    const second = await dropped(socket);
    second.open();
    second.deliver(hubFrames.welcome);

    expect(sent(second).filter((frame) => frame.type === 'graph-open')).toHaveLength(1);
    second.deliver(hubFrames.graphDocument);
    expect(store.getSnapshot().document).not.toBeNull();
  });

  it('holds the selection, which is the inspector’s subject', async () => {
    await opened();

    store.select(START);
    expect(store.getSnapshot().selection).toBe('start');
    store.select(null);
    expect(store.getSnapshot().selection).toBeNull();
  });

  it('drops a selection whose node was removed by an edit', async () => {
    await opened();
    store.select(START);

    store.edit((document) => ({
      ok: true,
      document: { nodes: document.nodes.slice(1), edges: [] },
    }));

    expect(store.getSnapshot().selection).toBeNull();
  });

  it('saves nothing on the way out when the last subscriber leaves', async () => {
    const { socket, stop } = await opened();
    store.edit((document) => moveNode(document, START, { x: 40, y: 92 }));

    stop();

    // A closed screen does not save behind the person's back: a graph draft
    // is the hub's, Save is a button, and a write nobody pressed would replace
    // the draft with an edit they may have been walking away from.
    expect(sent(socket).filter((frame) => frame.type === 'graph-save')).toEqual([]);
    expect(store.getSnapshot().dirty).toBe(true);
  });

  describe('run', () => {
    /** The hub's yes to a run, addressed to the frame this store sent. */
    function startedFor(frameId: number): string {
      const captured = JSON.parse(hubFrames.graphRunStarted) as { replyTo: number };
      return JSON.stringify({ ...captured, replyTo: frameId });
    }

    it('sends the run with the input, and holds the run once the hub names it and reports it', async () => {
      const { socket } = await opened();

      store.run({ language: 'rust' });

      const run = frameOf(socket, 'graph-run');
      expect(run).toMatchObject({ nodeId: 'hub-10', input: { language: 'rust' } });
      expect(store.getSnapshot().starting).toBe(true);
      expect(store.getSnapshot().run).toBeNull();

      socket.deliver(startedFor(run.id));
      expect(store.getSnapshot().starting).toBe(false);

      socket.deliver(hubFrames.graphRunStateRunning);
      expect(store.getSnapshot().run).toMatchObject({
        runId: 'hub-11',
        number: 1,
        status: 'running',
        step: 3,
      });
    });

    it('ignores a run of another graph', async () => {
      const { socket } = await opened();

      // The fixture's succeeded run is of the smoke-test graph, not this one.
      socket.deliver(hubFrames.graphRunStateSucceeded);

      expect(store.getSnapshot().run).toBeNull();
    });

    it('shows the graph’s newest run whoever started it, once the hub reports one', async () => {
      const { socket } = await opened();

      socket.deliver(hubFrames.graphRunStateCancelled);
      expect(store.getSnapshot().run).toMatchObject({ number: 1, status: 'cancelled' });

      socket.deliver(hubFrames.graphRunStateFailed);
      expect(store.getSnapshot().run).toMatchObject({ number: 2, status: 'failed' });

      // An older run reported again does not take the strip back.
      socket.deliver(hubFrames.graphRunStateCancelled);
      expect(store.getSnapshot().run).toMatchObject({ number: 2 });
    });

    it('asks where the run stands when it opens, and holds Run until the hub answers', async () => {
      const { socket } = await open();
      socket.deliver(hubFrames.graphDocument);

      expect(sent(socket).filter((frame) => frame.type === 'graph-run-read')).toEqual([
        { type: 'graph-run-read', id: expect.any(Number), nodeId: 'hub-10' },
      ]);
      expect(store.getSnapshot().readingRun).toBe(true);
      const before = sent(socket).length;
      store.run({});
      expect(sent(socket).length).toBe(before);

      socket.deliver(noneFor(frameOf(socket, 'graph-run-read').id));

      expect(store.getSnapshot().readingRun).toBe(false);
      expect(store.getSnapshot().run).toBeNull();
      store.run({});
      expect(sent(socket).filter((frame) => frame.type === 'graph-run')).toHaveLength(1);
    });

    it('takes the run in the answer to its read, when the graph has one', async () => {
      const { socket } = await open();
      socket.deliver(hubFrames.graphDocument);

      socket.deliver(
        latestFor(frameOf(socket, 'graph-run-read').id, hubFrames.graphRunStateRunning),
      );

      expect(store.getSnapshot().readingRun).toBe(false);
      expect(store.getSnapshot().run).toMatchObject({ runId: 'hub-11', status: 'running' });
    });

    it('asks again on a reconnection, and marks the run it holds stale until the answer lands', async () => {
      const { socket } = await opened();
      store.run({});
      socket.deliver(startedFor(frameOf(socket, 'graph-run').id));
      socket.deliver(hubFrames.graphRunStateRunning);
      expect(store.getSnapshot().runStale).toBe(false);

      const second = await dropped(socket);

      // Held, and no longer vouched for: the hub sends nothing about a run
      // while the socket is down, and this one may have ended meanwhile.
      expect(store.getSnapshot().run).toMatchObject({ runId: 'hub-11', status: 'running' });
      expect(store.getSnapshot().runStale).toBe(true);
      expect(store.getSnapshot().readingRun).toBe(true);

      second.open();
      second.deliver(hubFrames.welcome);
      expect(sent(second).filter((frame) => frame.type === 'graph-run-read')).toEqual([
        { type: 'graph-run-read', id: expect.any(Number), nodeId: 'hub-10' },
      ]);

      // The answer: the run ended while nobody here was listening.
      second.deliver(
        latestFor(frameOf(second, 'graph-run-read').id, hubFrames.graphRunStateCancelled),
      );
      expect(store.getSnapshot().run).toMatchObject({ runId: 'hub-11', status: 'cancelled' });
      expect(store.getSnapshot().runStale).toBe(false);
      expect(store.getSnapshot().readingRun).toBe(false);
      store.run({});
      expect(sent(second).filter((frame) => frame.type === 'graph-run')).toHaveLength(1);
    });

    it('drops the run it holds when the hub says the graph has never run', async () => {
      const { socket } = await opened();
      socket.deliver(hubFrames.graphRunStateRunning);
      const second = await dropped(socket);
      second.open();
      second.deliver(hubFrames.welcome);

      second.deliver(noneFor(frameOf(second, 'graph-run-read').id));

      expect(store.getSnapshot().run).toBeNull();
      expect(store.getSnapshot().runStale).toBe(false);
    });

    it('draws no run live when it is mounted again while the connection is down', async () => {
      const { socket, stop } = await opened();
      // The rest of the app, which keeps the connection up while the screen
      // is away.
      hub.subscribe(() => {});
      socket.deliver(hubFrames.graphRunStateRunning);
      stop();
      const second = await dropped(socket);

      // The screen is opened again before the socket is back: the run the
      // hub store held went with the socket, so nothing here is drawn live
      // and Cancel has nothing to send.
      const remounted = createGraphStore({ hub, nodeId: GRAPH });
      remounted.subscribe(() => {});
      expect(remounted.getSnapshot().run).toBeNull();
      expect(remounted.getSnapshot().readingRun).toBe(true);
      remounted.cancelRun();
      expect(sent(second).filter((frame) => frame.type === 'graph-run-cancel')).toEqual([]);

      second.open();
      second.deliver(hubFrames.welcome);
      second.deliver(noneFor(frameOf(second, 'graph-run-read').id));

      // And the answer to its read is taken, not passed over.
      expect(remounted.getSnapshot().readingRun).toBe(false);
      expect(remounted.getSnapshot().run).toBeNull();
    });

    it('refuses to cancel a stale run: the hub is the one to ask, and it is being asked', async () => {
      const { socket } = await opened();
      socket.deliver(hubFrames.graphRunStateRunning);
      const second = await dropped(socket);
      second.open();
      second.deliver(hubFrames.welcome);
      const before = sent(second).length;

      store.cancelRun();

      expect(sent(second).length).toBe(before);
    });

    it('treats a run parked at a HUMAN node as open: no second run, and Cancel reaches the hub', async () => {
      const { socket } = await opened();
      store.run({});
      socket.deliver(startedFor(frameOf(socket, 'graph-run').id));
      socket.deliver(waitingHere());
      expect(store.getSnapshot().run).toMatchObject({ status: 'waiting' });

      store.run({});
      expect(sent(socket).filter((frame) => frame.type === 'graph-run')).toHaveLength(1);

      store.cancelRun();
      expect(sent(socket).filter((frame) => frame.type === 'graph-run-cancel')).toEqual([
        { type: 'graph-run-cancel', id: expect.any(Number), runId: 'hub-17' },
      ]);
    });

    it('holds a waiting run stale across a reconnection until the read says it still waits', async () => {
      const { socket } = await opened();
      socket.deliver(waitingHere());
      const second = await dropped(socket);

      expect(store.getSnapshot().run).toMatchObject({ runId: 'hub-17', status: 'waiting' });
      expect(store.getSnapshot().runStale).toBe(true);
      store.cancelRun();
      second.open();
      second.deliver(hubFrames.welcome);
      expect(sent(second).filter((frame) => frame.type === 'graph-run-cancel')).toEqual([]);

      second.deliver(waitingHere());

      expect(store.getSnapshot().run).toMatchObject({ runId: 'hub-17', status: 'waiting' });
      expect(store.getSnapshot().runStale).toBe(false);
    });

    it('does not send a second run while one of its own is in flight', async () => {
      const { socket } = await opened();
      store.run({});
      const first = frameOf(socket, 'graph-run');
      socket.deliver(startedFor(first.id));
      socket.deliver(hubFrames.graphRunStateRunning);
      const before = sent(socket).length;

      store.run({});

      expect(sent(socket).length).toBe(before);
    });

    it('cancels its run and clears the cancelling flag on the hub’s yes', async () => {
      const { socket } = await opened();
      store.run({});
      socket.deliver(startedFor(frameOf(socket, 'graph-run').id));
      socket.deliver(hubFrames.graphRunStateRunning);

      store.cancelRun();

      const cancel = frameOf(socket, 'graph-run-cancel');
      expect(cancel).toMatchObject({ runId: 'hub-11' });
      expect(store.getSnapshot().cancelling).toBe(true);

      const captured = JSON.parse(hubFrames.graphRunCancelled) as { replyTo: number };
      socket.deliver(JSON.stringify({ ...captured, replyTo: cancel.id }));
      socket.deliver(hubFrames.graphRunStateCancelled);

      expect(store.getSnapshot().cancelling).toBe(false);
      expect(store.getSnapshot().run?.status).toBe('cancelled');
    });

    it('does nothing on a cancel with no run of its own in flight', async () => {
      const { socket } = await opened();
      const before = sent(socket).length;

      store.cancelRun();

      expect(sent(socket).length).toBe(before);
    });

    it('asks where the run stands when the connection drops with a run out, and allows no second Run until it knows', async () => {
      const { socket } = await opened();
      store.run({});
      expect(store.getSnapshot().starting).toBe(true);

      const second = await dropped(socket);

      // The hub store forgot the frame without a refusal, so the start comes
      // back -- but the hub may well have started the run before the socket
      // went, and a second Run now would be a second run. So the store asks,
      // and Run waits for the answer.
      expect(store.getSnapshot().starting).toBe(false);
      expect(store.getSnapshot().readingRun).toBe(true);
      second.open();
      second.deliver(hubFrames.welcome);
      expect(sent(second).filter((frame) => frame.type === 'graph-run-read')).toHaveLength(1);
      store.run({});
      expect(sent(second).filter((frame) => frame.type === 'graph-run')).toHaveLength(0);

      // It had: the screen learns the run it never got the started reply for,
      // and can cancel it.
      second.deliver(hubFrames.graphRunStateRunning);
      expect(store.getSnapshot().run).toMatchObject({ runId: 'hub-11', status: 'running' });
      store.cancelRun();
      expect(frameOf(second, 'graph-run-cancel')).toMatchObject({ runId: 'hub-11' });
    });

    it('lets Run be pressed again once the hub says nothing started', async () => {
      const { socket } = await opened();
      store.run({});
      const second = await dropped(socket);
      second.open();
      second.deliver(hubFrames.welcome);

      second.deliver(noneFor(frameOf(second, 'graph-run-read').id));

      store.run({});
      expect(sent(second).filter((frame) => frame.type === 'graph-run')).toHaveLength(1);
    });

    it('stops cancelling when the connection drops with a cancel out', async () => {
      const { socket } = await opened();
      store.run({});
      socket.deliver(startedFor(frameOf(socket, 'graph-run').id));
      socket.deliver(hubFrames.graphRunStateRunning);
      store.cancelRun();
      expect(store.getSnapshot().cancelling).toBe(true);

      await dropped(socket);

      expect(store.getSnapshot().cancelling).toBe(false);
    });

    it('takes the hub’s refusal of a run as the problem and stops starting', async () => {
      const { socket } = await opened();
      store.run({});
      const run = frameOf(socket, 'graph-run');

      socket.deliver(
        refusalTo(run.id, 'this graph has no published version to run; publish it first'),
      );

      expect(store.getSnapshot().starting).toBe(false);
      expect(store.getSnapshot().problem).toBe(
        'this graph has no published version to run; publish it first',
      );
    });
  });
});
