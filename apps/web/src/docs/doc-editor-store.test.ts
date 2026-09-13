import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  nodeIdSchema,
  parseClientFrame,
  parseTextFrame,
  type ClientFrame,
} from '@agentplex/protocol';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { createDocEditorStore, type DocEditorStore } from './doc-editor-store.js';
import { isDirty } from './editor-model.js';

/**
 * The editor store against a real hub store, driven through a fake socket with
 * the frames a real hub sent.
 *
 * The frame ids line up with the capture rather than being coerced: the
 * captured conversation is an editor's -- a document read, written, and
 * written again once the machine had gone away -- so this test starts its own
 * id counter where that conversation's replies start. Matching an answer to
 * the frame that asked is the property under test, and a test that fudged the
 * ids would be testing nothing.
 */

const NODE = nodeIdSchema.parse('hub-5');
/** The read the capture answered with `docContent` carried this id. */
const FIRST_ID = 9;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sentFrames(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the store sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

interface Harness {
  readonly hub: HubStore;
  readonly editor: DocEditorStore;
  readonly sockets: ReturnType<typeof createFakeSocketFactory>;
  readonly hubTimers: ReturnType<typeof createFakeTimers>;
  readonly idle: ReturnType<typeof createFakeTimers>;
}

function harness(firstId = FIRST_ID): Harness {
  const sockets = createFakeSocketFactory();
  const hubTimers = createFakeTimers();
  const idle = createFakeTimers();
  let last = firstId - 1;
  const hub = createHubStore({
    fetchTicket: () => Promise.resolve('ticket'),
    createSocket: (ticket) => sockets.create(ticket),
    timers: hubTimers,
    frameIds: { next: () => frameIdSchema.parse((last += 1)) },
  });
  const editor = createDocEditorStore({ hub, nodeId: NODE, timers: idle });
  return { hub, editor, sockets, hubTimers, idle };
}

/**
 * Connects the hub first, and only then looks at the document: the connection
 * belongs to the page and the pane arrives into one, which is also what makes
 * the hello the frame before the read.
 */
async function open(h: Harness): Promise<{ socket: FakeSocket; detach: () => void }> {
  const holdConnection = h.hub.subscribe(() => {});
  await settle();
  const socket = h.sockets.sockets[0];
  if (socket === undefined) throw new Error('no socket was dialled');
  socket.open();
  socket.deliver(hubFrames.welcome);
  const stopEditor = h.editor.subscribe(() => {});
  return {
    socket,
    detach: () => {
      stopEditor();
      holdConnection();
    },
  };
}

describe('reading the document', () => {
  it('asks for it as soon as anything looks at the pane', async () => {
    const h = harness();
    const { socket, detach } = await open(h);
    expect(sentFrames(socket).at(-1)).toEqual({ type: 'doc-open', id: 10, nodeId: 'hub-5' });
    // Until the machine answers there is nothing to edit, and the editor says
    // so by not being loaded: the pane draws a read-only box.
    expect(h.editor.getSnapshot().loaded).toBe(false);
    detach();
  });

  it('adopts the characters and the machine time the hub answered with', async () => {
    const h = harness();
    const { socket, detach } = await open(h);
    socket.deliver(hubFrames.docContent);
    const state = h.editor.getSnapshot();
    expect(state.loaded).toBe(true);
    expect(state.text).toBe(
      '# Plan\n\n- read the failing test\n- fix the refresh loop\n- write it up\n',
    );
    expect(state.savedAt).toBe(3);
    expect(isDirty(state)).toBe(false);
    detach();
  });

  it('stays empty and read-only when the machine is away, holding the hub sentence', async () => {
    // The refusal captured here answers a save rather than a read, and it is
    // the same no either way: it is delivered against this editor's open frame
    // to assert what an editor does with one.
    const h = harness(11);
    const { socket, detach } = await open(h);
    expect(sentFrames(socket).at(-1)).toEqual({ type: 'doc-open', id: 12, nodeId: 'hub-5' });
    socket.deliver(hubFrames.refusalDocAway);
    const state = h.editor.getSnapshot();
    expect(state.loaded).toBe(false);
    expect(state.text).toBe('');
    expect(state.refusal).toContain('mbp-robert is not connected right now');
    detach();
  });
});

describe('writing it back', () => {
  it('sends one save when the typing stops, and clears on the machine time', async () => {
    const h = harness();
    const { socket, detach } = await open(h);
    socket.deliver(hubFrames.docContent);

    const edited =
      '# Plan\n\n- read the failing test\n- fix the refresh loop\n- write it up\n- ship it\n';
    h.editor.setText('# Plan\n\n- read');
    h.editor.setText('# Plan\n\n- read the failing');
    h.editor.setText(edited);
    expect(isDirty(h.editor.getSnapshot())).toBe(true);
    // Nothing has gone out yet: a keystroke is not a write.
    expect(sentFrames(socket).filter((frame) => frame.type === 'doc-save')).toEqual([]);

    h.idle.fireAll();
    expect(sentFrames(socket).filter((frame) => frame.type === 'doc-save')).toEqual([
      { type: 'doc-save', id: 11, nodeId: 'hub-5', content: edited },
    ]);

    socket.deliver(hubFrames.docSavedAfterOpen);
    const state = h.editor.getSnapshot();
    expect(state.savedAt).toBe(4);
    expect(isDirty(state)).toBe(false);
    detach();
  });

  it('keeps every character when the machine that holds the file has gone', async () => {
    const h = harness();
    const { socket, detach } = await open(h);
    socket.deliver(hubFrames.docContent);
    h.editor.setText(
      '# Plan\n\n- read the failing test\n- fix the refresh loop\n- write it up\n- ship it\n',
    );
    h.idle.fireAll();
    socket.deliver(hubFrames.docSavedAfterOpen);

    const unsent = '# Plan\n\n- everything above, and this line nobody received\n';
    h.editor.setText(unsent);
    h.editor.save();
    socket.deliver(hubFrames.refusalDocAway);

    const state = h.editor.getSnapshot();
    expect(state.text).toBe(unsent);
    expect(state.refusal).toContain('the machine that wrote a document is the only one');
    // Still owed: the next save carries it, whenever the machine is back.
    expect(isDirty(state)).toBe(true);
    detach();
  });

  it('sends what is owed when the pane closes rather than losing it', async () => {
    const h = harness();
    const { socket, detach } = await open(h);
    socket.deliver(hubFrames.docContent);
    h.editor.setText('written on the way out');
    detach();
    expect(sentFrames(socket).at(-1)).toEqual({
      type: 'doc-save',
      id: 11,
      nodeId: 'hub-5',
      content: 'written on the way out',
    });
  });
});

describe('across a reconnection', () => {
  async function redial(h: Harness): Promise<FakeSocket> {
    const before = h.sockets.sockets.length;
    h.hubTimers.fireAll();
    await settle();
    const socket = h.sockets.sockets[before];
    if (socket === undefined) throw new Error('the retry did not dial');
    socket.open();
    socket.deliver(hubFrames.welcome);
    return socket;
  }

  it('keeps unsaved work and does not read over it', async () => {
    const h = harness();
    const { socket, detach } = await open(h);
    socket.deliver(hubFrames.docContent);
    h.editor.setText('what somebody typed while the hub was away');

    socket.drop();
    const second = await redial(h);

    expect(h.editor.getSnapshot().text).toBe('what somebody typed while the hub was away');
    expect(sentFrames(second).filter((frame) => frame.type === 'doc-open')).toEqual([]);
    detach();
  });

  it("re-reads a document nobody has edited, because the file is the machine's", async () => {
    const h = harness();
    const { socket, detach } = await open(h);
    socket.deliver(hubFrames.docContent);

    socket.drop();
    const second = await redial(h);

    // The file is editable on the machine that holds it -- by a person, or by
    // the agent the document was written for -- so a clean editor asks again
    // rather than showing a copy it can no longer vouch for.
    expect(sentFrames(second).filter((frame) => frame.type === 'doc-open')).toEqual([
      { type: 'doc-open', id: 12, nodeId: 'hub-5' },
    ]);
    detach();
  });
});

describe('when the connection cannot carry anything', () => {
  it('says so and keeps the text rather than pretending to save', async () => {
    const h = harness();
    const { socket, detach } = await open(h);
    socket.deliver(hubFrames.docContent);
    h.editor.setText('work nobody has taken');
    // A protocol error is the one failure the store does not retry: the build
    // is wrong, not the weather.
    socket.deliver(hubFrames.protocolError);

    h.editor.save();
    const state = h.editor.getSnapshot();
    expect(state.text).toBe('work nobody has taken');
    expect(state.refusal).toContain('could not read a frame');
    detach();
  });
});
