import { describe, expect, it } from 'vitest';
import {
  decodeTerminalChunk,
  parseServerToHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  sessionIdSchema,
  storeDescriptorSchema,
  type HubToServerFrame,
  type ServerToHubFrame,
  type SessionId,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import {
  createFakeMessageSocket,
  PEER_GONE,
  type FakeMessageSocket,
} from '@agentplex/node-shared/testing';
import type { FakePty, FakePtyFactory } from '@agentplex/pty/testing';
import type { Launch } from '@agentplex/providers';
import type { ServerIdentity } from '@agentplex/providers';
import { readyProvider } from '@agentplex/providers/testing';
import { serveHubConnection } from './hub-connection.js';
import {
  createFakeSessionController,
  type FakeSessionController,
} from './fake-session-controller.js';
import { createFakeTerminals } from './fake-terminals.js';
import type { TerminalManager } from './terminal-manager.js';

/**
 * The terminal frames, end to end against the real server.
 *
 * A fake hub on one end of a real socket seam, the real connection state
 * machine, the real terminal manager, the real pty supervisor, and a fake pty
 * at the bottom because a unit test cannot fork one. Every frame in this file
 * is JSON that goes through the parser that owns its direction, in both
 * directions: the hub end reads what the server says with
 * `parseServerToHubFrame`, so a frame this server could not send is a failure
 * here rather than a surprise on a wire.
 *
 * It lives beside the server rather than in `tests/hub-server`, because the
 * hub does not speak these frames yet: its half is a separate ticket, and a
 * suite there would be testing a hub that has nothing to say.
 *
 * What is faked is the store scan and nothing else. The controller answers
 * starts and reports out of values a test sets, because discovery is a disk
 * and a provider's files; the terminals those starts land in are real, and so
 * is every byte that comes back off one.
 */

const identity: ServerIdentity = {
  serverId: 'server-under-test' as ServerIdentity['serverId'],
  token: 'the-right-token',
};

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/claude' });
const SESSION_A = sessionIdSchema.parse('session-a');

const logger = createLogger('error', () => {});

const launch: Launch = {
  ok: true,
  plan: {
    command: 'claude',
    args: [],
    cwd: STORE.path,
    env: {},
    scrubEnvPrefixes: ['CLAUDE'],
  },
};

interface Harness {
  readonly socket: FakeMessageSocket;
  readonly terminals: TerminalManager;
  readonly sessions: FakeSessionController;
  readonly factory: FakePtyFactory;
  /** Everything the server said, through the parser that owns the direction. */
  frames(): readonly ServerToHubFrame[];
  /** As the hub sends one: typed, stringified, and parsed on the way in. */
  send(frame: HubToServerFrame): Promise<void>;
}

function harness(scrollbackBytes?: number): Harness {
  const { terminals, factory } = createFakeTerminals(
    scrollbackBytes === undefined ? {} : { scrollbackBytes },
  );
  const sessions = createFakeSessionController({
    reports: [{ storeId: STORE.storeId, sessions: [], holding: [] }],
  });
  const socket = createFakeMessageSocket();
  serveHubConnection(socket, {
    identity,
    stores: [STORE],
    providers: [readyProvider()],
    sessions,
    terminals,
    logger,
  });

  return {
    socket,
    terminals,
    sessions,
    factory,
    frames() {
      return socket.sent.map((text) => {
        const parsed = parseTextFrame(parseServerToHubFrame, text);
        if (!parsed.ok) throw new Error(`the server sent an unparseable frame: ${parsed.reason}`);
        return parsed.value;
      });
    },
    async send(frame: HubToServerFrame) {
      socket.receive(JSON.stringify(frame));
      await settle();
    },
  };
}

/** Delivery is asynchronous, as it is on a real socket. */
const settle = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 0));

async function handshaken(scrollbackBytes?: number): Promise<Harness> {
  const test = harness(scrollbackBytes);
  await test.send({
    type: 'handshake',
    id: 1,
    protocolVersion: PROTOCOL_VERSION,
    hubId: 'hub-under-test' as never,
    token: identity.token,
  });
  return test;
}

/**
 * Starts a session the way the hub does, and gives back the pty underneath it.
 *
 * The controller answers with the terminal the manager actually opened, which
 * is what a real start does: the terminal id never crosses the wire, and the
 * connection is what joins the start handle to it.
 */
async function start(test: Harness, startId: number): Promise<FakePty> {
  const opened = test.terminals.spawn(STORE, launch);
  if (!opened.ok) throw new Error(`the spawn should have opened: ${opened.problem}`);
  test.sessions.answerWith({
    ok: true,
    storeId: STORE.storeId,
    sessionId: null,
    terminalId: opened.terminal.terminalId,
  });
  await test.send({
    type: 'session-start',
    id: startId,
    storeId: STORE.storeId,
    sessionId: null,
    provider: 'claude',
    prompt: null,
  });
  const pty = test.factory.last;
  if (pty === undefined) throw new Error('the spawn opened no pty');
  return pty;
}

const outputs = (test: Harness) =>
  test.frames().filter((frame) => frame.type === 'terminal-output');

const chunks = (test: Harness): Uint8Array[] =>
  outputs(test).map((frame) => decodeTerminalChunk(frame.chunk));

describe('terminal frames against a real server', () => {
  it('attaches to a spawn by the start that made it, before the session has a name', async () => {
    const test = await handshaken();
    await start(test, 4);

    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });

    expect(test.frames().at(-1)).toEqual({
      type: 'session-subscribed',
      replyTo: 5,
      storeId: STORE.storeId,
      sessionId: null,
      startId: 4,
      replayChunks: 0,
      droppedBytes: 0,
    });
  });

  it('carries every byte a pty can produce, unchanged, in both directions of the encoding', async () => {
    // The reason output is not a string. A chunk with every byte value in it
    // is the strongest available statement that nothing on this path decodes
    // terminal output as text, which is what corrupts exactly the sessions
    // that draw boxes and print emoji.
    const test = await handshaken();
    const pty = await start(test, 4);
    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });

    const every = Uint8Array.from({ length: 256 }, (_, at) => at);
    pty.emit(every);
    await settle();

    expect(chunks(test)).toEqual([every]);
  });

  it('keeps a UTF-8 sequence the pty split across two reads split in exactly the same place', async () => {
    const test = await handshaken();
    const pty = await start(test, 4);
    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });

    const whole = new TextEncoder().encode('┌─ diff ─┐ 🚀');
    pty.emit(whole.subarray(0, 5));
    pty.emit(whole.subarray(5));
    await settle();

    const rejoined = new Uint8Array(whole.length);
    let at = 0;
    for (const chunk of chunks(test)) {
      rejoined.set(chunk, at);
      at += chunk.length;
    }
    expect(rejoined).toEqual(whole);
  });

  it('replays the scrollback after the reply and before the live stream', async () => {
    const test = await handshaken();
    const pty = await start(test, 4);
    pty.emit('before anybody watched\r\n');
    await settle();

    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });
    pty.emit('and after\r\n');
    await settle();

    expect(chunks(test).map((chunk) => new TextDecoder().decode(chunk))).toEqual([
      'before anybody watched\r\n',
      'and after\r\n',
    ]);
  });

  it('says how much of the beginning is gone rather than passing a tail off as the whole session', async () => {
    const test = await handshaken(8);
    const pty = await start(test, 4);
    pty.emit('the first line, long gone\r\n');
    pty.emit('the second');
    await settle();

    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });

    // A byte count rather than a flag: a pane can say how much it is not
    // showing, and `> 0` is still the flag for one that only wants to say it
    // is showing a tail.
    expect(test.frames().find((frame) => frame.type === 'session-subscribed')).toMatchObject({
      replayChunks: 1,
      droppedBytes: 27,
    });
  });

  it('is the same frame shape whether a session was silent or had its beginning dropped', async () => {
    // The whole point of the reply. A pane that starts mid-stream and a pane
    // showing a session that has done nothing are opposite facts, and before
    // the next byte arrives they look identical on screen. These two numbers
    // are what separates them, and they arrive before any of the bytes do.
    const silent = await handshaken(8);
    await start(silent, 4);
    await silent.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });

    const busy = await handshaken(8);
    const pty = await start(busy, 4);
    pty.emit('an hour of output, gone\r\n');
    pty.emit('what is left');
    await settle();
    await busy.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });

    expect(silent.frames().find((frame) => frame.type === 'session-subscribed')).toMatchObject({
      replayChunks: 0,
      droppedBytes: 0,
    });
    expect(busy.frames().find((frame) => frame.type === 'session-subscribed')).toMatchObject({
      replayChunks: 1,
      droppedBytes: 25,
    });
  });

  it('counts the replay frames that follow it, so a reader knows where history ends', async () => {
    // The socket is ordered and the replay is written in the same turn as the
    // reply, so the next `replayChunks` chunks are history and everything
    // after them is live. Without the count a client cannot tell a replay that
    // is finished from one that has not started, which is the same blank pane
    // as a session that has printed nothing.
    const test = await handshaken();
    const pty = await start(test, 4);
    pty.emit('first\r\n');
    pty.emit('second\r\n');
    pty.emit('third\r\n');
    await settle();

    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });
    pty.emit('live\r\n');
    await settle();

    const subscribed = test.frames().find((frame) => frame.type === 'session-subscribed');
    expect(subscribed).toMatchObject({ replayChunks: 3, droppedBytes: 0 });

    const decoded = chunks(test).map((chunk) => new TextDecoder().decode(chunk));
    const count = subscribed?.type === 'session-subscribed' ? subscribed.replayChunks : -1;
    expect(decoded.slice(0, count)).toEqual(['first\r\n', 'second\r\n', 'third\r\n']);
    expect(decoded.slice(count)).toEqual(['live\r\n']);
  });

  it('counts dropped chunks on every chunk of output, at zero until something drops them', async () => {
    const test = await handshaken();
    const pty = await start(test, 4);
    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });

    pty.emit('anything');
    await settle();

    expect(outputs(test).map((frame) => frame.droppedChunks)).toEqual([0]);
  });

  it('names the session on its output as soon as the provider has named it', async () => {
    const test = await handshaken();
    const pty = await start(test, 4);
    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });

    bind(test, SESSION_A);
    pty.emit('named now');
    await settle();

    expect(outputs(test).at(-1)).toMatchObject({ sessionId: SESSION_A, startId: 4 });
  });

  it('writes what the hub says the user typed, as they typed it, and says nothing back', async () => {
    const test = await handshaken();
    const pty = await start(test, 4);
    const before = test.frames().length;

    await test.send({
      type: 'terminal-input',
      id: 6,
      target: { by: 'start', startId: 4 },
      data: 'pnpm test\r',
    });

    expect(pty.written).toEqual(['pnpm test\r']);
    // The terminal acknowledges input by echoing it. A frame per keystroke
    // would restate what the user can already see.
    expect(test.frames()).toHaveLength(before);
  });

  it('resizes the pty, which is the one thing on the copy-paste-scroll list that crosses', async () => {
    const test = await handshaken();
    const pty = await start(test, 4);

    await test.send({
      type: 'terminal-resize',
      id: 6,
      target: { by: 'start', startId: 4 },
      size: { cols: 120, rows: 40 },
    });

    expect(pty.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('refuses input for a session it is not running, naming the frame that asked', async () => {
    const test = await handshaken();

    await test.send({
      type: 'terminal-input',
      id: 6,
      target: { by: 'session', storeId: STORE.storeId, sessionId: SESSION_A },
      data: 'ls\r',
    });

    expect(test.frames().at(-1)).toMatchObject({
      type: 'session-refused',
      replyTo: 6,
      code: 'refused',
      hold: null,
    });
  });

  it('refuses a subscription to a start that never happened on this connection', async () => {
    const test = await handshaken();

    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 99 } });

    expect(test.frames().at(-1)).toMatchObject({ type: 'session-refused', replyTo: 5 });
  });

  it('answers nothing about a terminal before a handshake', async () => {
    const test = harness();

    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });

    expect(test.frames()).toEqual([
      { type: 'protocol-error', code: 'bad-request', message: expect.any(String) },
    ]);
  });
});

describe('detaching from a terminal', () => {
  it('gives the watcher back and leaves the session running', async () => {
    const test = await handshaken();
    const pty = await start(test, 4);
    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });

    await test.send({ type: 'session-unsubscribe', id: 6, target: { by: 'start', startId: 4 } });

    expect(test.frames().at(-1)).toEqual({ type: 'session-unsubscribed', replyTo: 6 });
    expect(terminalOf(test).watchers).toBe(0);
    // The rule detaching must not break: a closing tab is not a decision about
    // an agent that is mid-work.
    expect(pty.kills).toBe(0);
    expect(terminalOf(test).run.exit).toBeNull();
  });

  it('stops sending output once the last watcher has let go', async () => {
    const test = await handshaken();
    const pty = await start(test, 4);
    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });
    await test.send({ type: 'session-unsubscribe', id: 6, target: { by: 'start', startId: 4 } });

    pty.emit('nobody is listening');
    await settle();

    expect(outputs(test)).toHaveLength(0);
  });

  it('refuses an unsubscribe from something this connection never subscribed to', async () => {
    const test = await handshaken();
    await start(test, 4);

    await test.send({ type: 'session-unsubscribe', id: 6, target: { by: 'start', startId: 4 } });

    expect(test.frames().at(-1)).toMatchObject({ type: 'session-refused', replyTo: 6 });
  });

  it('treats the socket closing as the same detach, and still closes nothing', async () => {
    // The convergence that matters: a frame and a dropped connection reach one
    // release. A socket that let go some other way would leave the count only
    // ever rising, and the longest-unwatched eviction rule reading a number
    // that can never fall.
    const test = await handshaken();
    const pty = await start(test, 4);
    await test.send({ type: 'session-subscribe', id: 5, target: { by: 'start', startId: 4 } });
    expect(terminalOf(test).watchers).toBe(1);

    test.socket.closeFromPeer(PEER_GONE);
    await settle();

    expect(terminalOf(test).watchers).toBe(0);
    expect(pty.kills).toBe(0);
    expect(terminalOf(test).run.exit).toBeNull();
  });
});

describe('start provenance in the report', () => {
  it('tags the spawn with the start that asked for it, before it has a session id', async () => {
    const test = await handshaken();

    await start(test, 4);

    expect(reports(test).at(-1)).toMatchObject({ starts: [{ startId: 4, sessionId: null }] });
  });

  it('reports the pair once discovery has named the session, and then stops', async () => {
    // Exact, never heuristic: the hub is told which start produced which
    // session rather than matching them up by time.
    const test = await handshaken();
    await start(test, 4);
    bind(test, SESSION_A);

    await test.send({ type: 'session-stop', id: 7, storeId: STORE.storeId, sessionId: SESSION_A });
    await test.send({ type: 'session-stop', id: 8, storeId: STORE.storeId, sessionId: SESSION_A });

    // A report on the handshake, one for the start, then one per stop: the
    // third is the first one sent after discovery named the session.
    const [, , named, afterwards] = reports(test);
    expect(named).toMatchObject({ starts: [{ startId: 4, sessionId: SESSION_A }] });
    expect(afterwards).toMatchObject({ starts: [] });
  });
});

/** The one terminal this server opened, for the counts only it can answer. */
function terminalOf(test: Harness) {
  const terminal = test.terminals.terminals[0];
  if (terminal === undefined) throw new Error('the server opened no terminal');
  return terminal;
}

/** What discovery does when the provider has written its session id. */
function bind(test: Harness, sessionId: SessionId): void {
  const bound = test.terminals.bind(terminalOf(test).terminalId, sessionId);
  if (!bound.ok) throw new Error(`the terminal should have bound: ${bound.problem}`);
}

const reports = (test: Harness) => test.frames().filter((frame) => frame.type === 'store-report');
