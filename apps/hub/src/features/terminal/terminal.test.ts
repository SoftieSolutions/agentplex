import { describe, expect, it } from 'vitest';
import {
  encodeTerminalChunk,
  parseHubFrame,
  sessionIdSchema,
  startIdSchema,
  storeIdSchema,
  type ClientTerminalTarget,
  type HubFrame,
  type ServerRegistrationId,
  type SessionHolder,
  type StartId,
  type StoreId,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import { readyProvider } from '@agentplex/providers/testing';
import { serverAddressSchema } from '../pairing/pairing.js';
import type {
  ServerConnectionPhase,
  ServerConnectionReport,
  StreamInstruction,
  StreamOutcome,
  TerminalOutputFrame,
} from '../servers/servers.js';
import type { HubStateSnapshot, SessionRow, StoreView } from '../fleet-state/fleet-state.js';
import {
  createTerminal,
  MAX_BUFFERED_CLIENT_BYTES,
  type Terminal,
  type TerminalClient,
} from './terminal.js';

/**
 * The subscription set, driven with fake sockets and a fake server leg.
 *
 * What is real here is the bookkeeping, which is the whole of what this feature
 * is: which client is watching which terminal, how a chunk finds them, what
 * happens to the one subscription two of them share when one leaves, and what a
 * socket that dies without a word costs. The wire on both sides is a seam --
 * the client is something that takes a frame and says how far behind it is, and
 * the server is something that is handed a frame and answers when the test
 * says so.
 *
 * Answering by hand is the point rather than a convenience. A server writes a
 * subscription's reply and the scrollback it just promised in the same turn,
 * and a relay that let a microtask in between would hand a client its history
 * before the frame that counts it. Every `answer` below is called where a real
 * one would be, so an ordering bug has somewhere to show.
 *
 * The end-to-end claims -- a real server, a real pty, real replay -- are in
 * `tests/hub-server/src/terminal-relay.integration.test.ts`. This is the file
 * for the cases a fleet cannot conveniently produce.
 */

const logger = createLogger('error', () => {});

const WORK = storeIdSchema.parse('store-work');
const QUIET = sessionIdSchema.parse('session-quiet');
const ATTIC = 'registration-attic' as ServerRegistrationId;
const WORKSHOP = 'registration-workshop' as ServerRegistrationId;
const START = startIdSchema.parse('start-2f9c');

/** What the hub was handed to put on a server, and who is waiting on it. */
interface Put {
  readonly registrationId: ServerRegistrationId;
  readonly frame: StreamInstruction;
  readonly answer: (outcome: StreamOutcome) => void;
}

interface FakeServers {
  stream(
    registrationId: ServerRegistrationId,
    frame: StreamInstruction,
    answer: (outcome: StreamOutcome) => void,
  ): void;
  readonly put: readonly Put[];
  /** The frames of one type, in order, for the assertions about fan-out. */
  of(type: StreamInstruction['type']): readonly Put[];
}

function fakeServers(): FakeServers {
  const put: Put[] = [];
  return {
    stream(registrationId, frame, answer): void {
      put.push({ registrationId, frame, answer });
    },
    get put(): readonly Put[] {
      return put;
    },
    of(type): readonly Put[] {
      return put.filter((one) => one.frame.type === type);
    },
  };
}

interface FakeClient extends TerminalClient {
  readonly received: readonly HubFrame[];
  /** How far behind this socket is pretending to be, in bytes. */
  behind: number;
}

function fakeClient(): FakeClient {
  const received: HubFrame[] = [];
  const client: FakeClient = {
    behind: 0,
    send(frame: HubFrame): void {
      // Through the parser a client would use, because a frame the relay sends
      // that a client cannot read has not been sent in any sense that matters.
      const parsed = parseHubFrame(JSON.parse(JSON.stringify(frame)));
      if (!parsed.ok) throw new Error(`the relay sent an unreadable frame: ${parsed.reason}`);
      received.push(parsed.value);
    },
    get bufferedBytes(): number {
      return client.behind;
    },
    get received(): readonly HubFrame[] {
      return received;
    },
  };
  return client;
}

function server(
  registrationId: ServerRegistrationId,
  label: string,
  phase: ServerConnectionPhase = 'connected',
): ServerConnectionReport {
  return {
    registrationId,
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    providers: [readyProvider()],
    stores: [WORK],
    connectedSince: phase === 'connected' ? 1 : null,
    staleSince: phase === 'stale' ? 2 : null,
    lastConnectedAt: 1,
    failedAttempts: 0,
    problem: null,
    staleReason: null,
  };
}

function row(
  holder: SessionHolder | null,
  reportedBy: readonly ServerRegistrationId[],
): SessionRow {
  return {
    ref: { storeId: WORK, sessionId: QUIET },
    descriptor: {
      storeId: WORK,
      sessionId: QUIET,
      provider: 'claude',
      status: 'awaiting-input',
      updatedAt: 1,
      cwd: null,
      branch: null,
      title: null,
      uncommitted: null,
    },
    source: reportedBy[0] ?? ATTIC,
    reportedBy,
    reportedAt: 1,
    reachable: true,
    holder,
  };
}

/** A fleet with one store, and whatever servers and session rows a case needs. */
function fleet(
  servers: readonly ServerConnectionReport[],
  sessions: readonly SessionRow[],
): HubStateSnapshot {
  const store: StoreView = {
    storeId: WORK,
    servers,
    reachable: servers.some((one) => one.phase === 'connected'),
    unreachableSince: null,
    lastReachableAt: 1,
    sessions,
  };
  return { version: 1, stores: [store], servers, candidates: [] };
}

interface Harness {
  readonly terminal: Terminal;
  readonly servers: FakeServers;
}

function harness(state: HubStateSnapshot): Harness {
  const servers = fakeServers();
  return {
    terminal: createTerminal({ state: { snapshot: () => state }, servers, logger }),
    servers,
  };
}

/** The ordinary case: one connected machine holding the session. */
function oneMachine(): Harness {
  return harness(
    fleet([server(ATTIC, 'attic')], [row({ server: ATTIC, stoppable: true }, [ATTIC])]),
  );
}

const SESSION_TARGET: ClientTerminalTarget = {
  by: 'session',
  storeId: WORK,
  sessionId: QUIET,
};

/** The server's reply to a subscribe, with however much history it is claiming. */
function subscribed(replayChunks: number, droppedBytes = 0): StreamOutcome {
  return {
    ok: true,
    answer: {
      type: 'session-subscribed',
      replyTo: 1,
      storeId: WORK,
      sessionId: QUIET,
      startId: null,
      replayChunks,
      droppedBytes,
    },
  };
}

/** One chunk as a server would put it on the wire, addressed by session. */
function output(text: string, droppedChunks = 0): TerminalOutputFrame {
  return {
    type: 'terminal-output',
    storeId: WORK,
    sessionId: QUIET,
    startId: null,
    chunk: encodeTerminalChunk(new TextEncoder().encode(text)),
    droppedChunks,
  };
}

function chunks(client: FakeClient): readonly string[] {
  return client.received
    .filter((frame) => frame.type === 'terminal-output')
    .map((frame) => new TextDecoder().decode(Buffer.from(frame.chunk, 'base64')));
}

describe('a client subscribing to a session', () => {
  it('forwards the subscribe to the holder, aimed the way the server leg aims', () => {
    const { terminal, servers } = oneMachine();

    terminal.subscribe(fakeClient(), 2, SESSION_TARGET);

    expect(servers.put).toHaveLength(1);
    expect(servers.put[0]?.registrationId).toBe(ATTIC);
    expect(servers.put[0]?.frame).toEqual({
      type: 'session-subscribe',
      target: { by: 'session', storeId: WORK, sessionId: QUIET },
    });
  });

  it("answers with the server's own numbers, and then the history, in that order", () => {
    const { terminal, servers } = oneMachine();
    const client = fakeClient();

    terminal.subscribe(client, 2, SESSION_TARGET);
    // Where a real reply is read: synchronously, before the frames that follow
    // it on the wire.
    servers.put[0]?.answer(subscribed(2, 4_096));
    terminal.deliver(ATTIC, output('older\r\n'));
    terminal.deliver(ATTIC, output('newer\r\n'));
    terminal.deliver(ATTIC, output('live\r\n'));

    expect(client.received[0]).toEqual({
      type: 'session-subscribed',
      replyTo: 2,
      storeId: WORK,
      sessionId: QUIET,
      startId: null,
      // Passed through. The hub knows nothing about how much of a session's
      // history exists and is not the one to say.
      replayChunks: 2,
      droppedBytes: 4_096,
    });
    expect(chunks(client)).toEqual(['older\r\n', 'newer\r\n', 'live\r\n']);
  });

  it('passes the chunk through as the characters it arrived as', () => {
    const { terminal, servers } = oneMachine();
    const client = fakeClient();
    // Box drawing and an emoji: the two things a decode-and-re-encode ruins,
    // and the reason nothing between the pty and the browser reads these bytes.
    const drawn = encodeTerminalChunk(new TextEncoder().encode('┌──┐ 🙂'));

    terminal.subscribe(client, 2, SESSION_TARGET);
    servers.put[0]?.answer(subscribed(0));
    terminal.deliver(ATTIC, { ...output(''), chunk: drawn });

    const relayed = client.received.find((frame) => frame.type === 'terminal-output');
    expect(relayed?.type === 'terminal-output' ? relayed.chunk : null).toBe(drawn);
  });

  it('refuses a second subscribe to the same terminal rather than replaying twice', () => {
    const { terminal, servers } = oneMachine();
    const client = fakeClient();

    terminal.subscribe(client, 2, SESSION_TARGET);
    servers.put[0]?.answer(subscribed(0));
    terminal.subscribe(client, 3, SESSION_TARGET);

    expect(client.received.at(-1)).toMatchObject({
      type: 'refusal',
      replyTo: 3,
      code: 'refused',
      message: 'this connection is already watching that terminal',
    });
    expect(servers.of('session-subscribe')).toHaveLength(1);
  });

  it("passes the server's refusal back to the client that asked", () => {
    const { terminal, servers } = oneMachine();
    const client = fakeClient();

    terminal.subscribe(client, 2, SESSION_TARGET);
    servers.put[0]?.answer({
      ok: false,
      code: 'refused',
      problem: 'this server is not running session session-quiet',
    });

    expect(client.received).toEqual([
      {
        type: 'refusal',
        replyTo: 2,
        code: 'refused',
        message: 'this server is not running session session-quiet',
        holder: null,
      },
    ]);
    // And the watch is gone, so nothing later fans out to a pane that was told
    // no.
    terminal.deliver(ATTIC, output('after\r\n'));
    expect(chunks(client)).toEqual([]);
  });
});

describe('two clients on one session', () => {
  it('both see the stream, off one subscription each but one copy of the bytes', () => {
    const { terminal, servers } = oneMachine();
    const first = fakeClient();
    const second = fakeClient();

    terminal.subscribe(first, 2, SESSION_TARGET);
    servers.put[0]?.answer(subscribed(0));
    terminal.subscribe(second, 2, SESSION_TARGET);
    servers.put[1]?.answer(subscribed(0));

    terminal.deliver(ATTIC, output('shared\r\n'));

    expect(chunks(first)).toEqual(['shared\r\n']);
    expect(chunks(second)).toEqual(['shared\r\n']);
  });

  it("keeps the second viewer's replay out of the first viewer's pane", () => {
    const { terminal, servers } = oneMachine();
    const first = fakeClient();
    const second = fakeClient();

    terminal.subscribe(first, 2, SESSION_TARGET);
    servers.put[0]?.answer(subscribed(0));
    terminal.deliver(ATTIC, output('live\r\n'));

    // The second viewer joins, and the server replays the scrollback on the
    // same frames live output uses. Without the count on the reply claiming
    // them, that history would be fanned out to the first pane as if the agent
    // had printed it all over again.
    terminal.subscribe(second, 2, SESSION_TARGET);
    servers.put[1]?.answer(subscribed(1));
    terminal.deliver(ATTIC, output('live\r\n'));
    terminal.deliver(ATTIC, output('after\r\n'));

    expect(chunks(first)).toEqual(['live\r\n', 'after\r\n']);
    expect(chunks(second)).toEqual(['live\r\n', 'after\r\n']);
  });

  it('unsubscribes at the server only when the last of them leaves', () => {
    const { terminal, servers } = oneMachine();
    const first = fakeClient();
    const second = fakeClient();

    terminal.subscribe(first, 2, SESSION_TARGET);
    servers.put[0]?.answer(subscribed(0));
    terminal.subscribe(second, 2, SESSION_TARGET);
    servers.put[1]?.answer(subscribed(0));

    terminal.unsubscribe(first, 3, SESSION_TARGET);
    expect(servers.of('session-unsubscribe')).toEqual([]);
    // Answered from the hub's own books: there was no server frame to wait for,
    // and a client whose answer depended on one would hang on whether somebody
    // else happened to be watching.
    expect(first.received.at(-1)).toEqual({ type: 'session-unsubscribed', replyTo: 3 });
    terminal.deliver(ATTIC, output('after\r\n'));
    expect(chunks(first)).toEqual([]);
    expect(chunks(second)).toEqual(['after\r\n']);

    terminal.unsubscribe(second, 3, SESSION_TARGET);
    expect(servers.of('session-unsubscribe')).toHaveLength(1);
    expect(servers.of('session-unsubscribe')[0]?.frame).toEqual({
      type: 'session-unsubscribe',
      target: { by: 'session', storeId: WORK, sessionId: QUIET },
    });
  });

  it('gives back the watch of a socket that died without saying so', () => {
    const { terminal, servers } = oneMachine();
    const gone = fakeClient();
    const staying = fakeClient();

    terminal.subscribe(gone, 2, SESSION_TARGET);
    servers.put[0]?.answer(subscribed(0));
    terminal.subscribe(staying, 2, SESSION_TARGET);
    servers.put[1]?.answer(subscribed(0));

    terminal.forget(gone);

    expect(servers.of('session-unsubscribe')).toEqual([]);
    terminal.forget(staying);
    // The count a server evicts by has to come back down, and a socket that
    // crashed never sends the frame that would lower it.
    expect(servers.of('session-unsubscribe')).toHaveLength(1);
  });

  it('swallows the history of a subscribe whose client left before the reply', () => {
    const { terminal, servers } = oneMachine();
    const staying = fakeClient();
    const leaving = fakeClient();

    terminal.subscribe(staying, 2, SESSION_TARGET);
    servers.put[0]?.answer(subscribed(0));
    terminal.subscribe(leaving, 2, SESSION_TARGET);
    terminal.forget(leaving);
    servers.put[1]?.answer(subscribed(2));

    terminal.deliver(ATTIC, output('history\r\n'));
    terminal.deliver(ATTIC, output('history\r\n'));
    terminal.deliver(ATTIC, output('live\r\n'));

    // The scrollback was already on its way and belongs to nobody. Fanning it
    // out would repaint the remaining pane with its own past.
    expect(chunks(staying)).toEqual(['live\r\n']);
    expect(leaving.received.filter((frame) => frame.type === 'terminal-output')).toEqual([]);
  });
});

describe('a client too far behind to be sent output', () => {
  it('drops whole chunks and counts them onto the next one that gets through', () => {
    const { terminal, servers } = oneMachine();
    const client = fakeClient();

    terminal.subscribe(client, 2, SESSION_TARGET);
    servers.put[0]?.answer(subscribed(0));

    terminal.deliver(ATTIC, output('first\r\n'));
    client.behind = MAX_BUFFERED_CLIENT_BYTES + 1;
    terminal.deliver(ATTIC, output('lost\r\n'));
    terminal.deliver(ATTIC, output('lost\r\n'));
    client.behind = 0;
    terminal.deliver(ATTIC, output('back\r\n'));

    expect(chunks(client)).toEqual(['first\r\n', 'back\r\n']);
    const counts = client.received
      .filter((frame) => frame.type === 'terminal-output')
      .map((frame) => frame.droppedChunks);
    // Zero, and then the two that did not fit -- cumulative, so a reader
    // comparing it with the last value it saw learns the size of the gap.
    expect(counts).toEqual([0, 2]);
  });

  it("adds the server leg's losses to its own, because the viewer lost both", () => {
    const { terminal, servers } = oneMachine();
    const client = fakeClient();

    terminal.subscribe(client, 2, SESSION_TARGET);
    servers.put[0]?.answer(subscribed(0));
    client.behind = MAX_BUFFERED_CLIENT_BYTES + 1;
    terminal.deliver(ATTIC, output('lost\r\n', 3));
    client.behind = 0;
    terminal.deliver(ATTIC, output('back\r\n', 3));

    const relayed = client.received.find((frame) => frame.type === 'terminal-output');
    expect(relayed?.type === 'terminal-output' ? relayed.droppedChunks : null).toBe(4);
  });

  it('never drops the history a subscription promised', () => {
    const { terminal, servers } = oneMachine();
    const client = fakeClient();
    client.behind = MAX_BUFFERED_CLIENT_BYTES + 1;

    terminal.subscribe(client, 2, SESSION_TARGET);
    servers.put[0]?.answer(subscribed(2));
    terminal.deliver(ATTIC, output('older\r\n'));
    terminal.deliver(ATTIC, output('newer\r\n'));
    terminal.deliver(ATTIC, output('live\r\n'));

    // `replayChunks` promised exactly those two frames, and a gate that dropped
    // one would make that number a lie about a pane's own scrollback. The live
    // chunk after them is dropped, which is the rule doing its job.
    expect(chunks(client)).toEqual(['older\r\n', 'newer\r\n']);
  });
});

describe('a subscription by start handle', () => {
  const started = { registrationId: ATTIC, startId: START, storeId: WORK };
  const startTarget: ClientTerminalTarget = { by: 'start', startId: 7 };

  /** A spawn whose provider has not written a session id yet. */
  function pending(): { harness: Harness; client: FakeClient } {
    const held = harness(fleet([server(ATTIC, 'attic')], []));
    const client = fakeClient();
    held.terminal.noteStart(client, 7, started);
    return { harness: held, client };
  }

  it("names the start by the hub's own handle on the server leg", () => {
    const { harness: held, client } = pending();

    held.terminal.subscribe(client, 7, startTarget);

    expect(held.servers.put[0]?.frame).toEqual({
      type: 'session-subscribe',
      // The hub's name for the start, not the client's frame id: a `StartId`
      // is what this hub and that server share, and it is what survives a
      // redial.
      target: { by: 'start', startId: START },
    });
  });

  it("answers under the client's own handle, which is the only name it has", () => {
    const { harness: held, client } = pending();

    held.terminal.subscribe(client, 7, startTarget);
    held.servers.put[0]?.answer({
      ok: true,
      answer: {
        type: 'session-subscribed',
        replyTo: 1,
        storeId: WORK,
        sessionId: null,
        startId: START,
        replayChunks: 0,
        droppedBytes: 0,
      },
    });

    expect(client.received[0]).toMatchObject({
      type: 'session-subscribed',
      replyTo: 7,
      sessionId: null,
      startId: 7,
    });
  });

  it('keeps the output flowing once the provider names the session', () => {
    const { harness: held, client } = pending();
    held.terminal.subscribe(client, 7, startTarget);
    held.servers.put[0]?.answer(subscribed(0));

    held.terminal.deliver(ATTIC, {
      ...output('before\r\n'),
      sessionId: null,
      startId: START,
    });

    // The report that says which session this start became. Exact, off the
    // server, rather than guessed from what appeared around the same time.
    held.terminal.noteStarts(ATTIC, WORK, [{ startId: START, sessionId: QUIET }]);

    // And now a chunk that carries only the session id, as a frame would once
    // the server had stopped tagging it. It has to reach the same pane.
    held.terminal.deliver(ATTIC, { ...output('after\r\n'), startId: null });

    expect(chunks(client)).toEqual(['before\r\n', 'after\r\n']);
  });

  it('delivers a chunk once, however many of its names match', () => {
    const { harness: held, client } = pending();
    held.terminal.subscribe(client, 7, startTarget);
    held.servers.put[0]?.answer(subscribed(0));
    held.terminal.noteStarts(ATTIC, WORK, [{ startId: START, sessionId: QUIET }]);

    held.terminal.deliver(ATTIC, { ...output('once\r\n'), startId: START });

    expect(chunks(client)).toEqual(['once\r\n']);
  });

  it('refuses a handle this connection never received', () => {
    const { terminal } = oneMachine();
    const stranger = fakeClient();

    terminal.subscribe(stranger, 9, { by: 'start', startId: 7 });

    expect(stranger.received).toEqual([
      {
        type: 'refusal',
        replyTo: 9,
        code: 'refused',
        message: 'this connection did not start that session',
        holder: null,
      },
    ]);
  });

  it('forgets a start with the socket that made it', () => {
    const { harness: held, client } = pending();

    held.terminal.forget(client);
    held.terminal.subscribe(client, 7, startTarget);

    expect(client.received.at(-1)).toMatchObject({
      type: 'refusal',
      message: 'this connection did not start that session',
    });
  });
});

describe('typing into a session', () => {
  it('goes to the holder, and says nothing when it worked', () => {
    const { terminal, servers } = oneMachine();
    const client = fakeClient();

    terminal.input(client, 2, SESSION_TARGET, 'yes\r');
    servers.put[0]?.answer({ ok: true, answer: null });

    expect(servers.put[0]?.registrationId).toBe(ATTIC);
    expect(servers.put[0]?.frame).toEqual({
      type: 'terminal-input',
      target: { by: 'session', storeId: WORK, sessionId: QUIET },
      data: 'yes\r',
    });
    expect(client.received).toEqual([]);
  });

  it('refuses a write the server could not deliver, naming this frame', () => {
    const { terminal, servers } = oneMachine();
    const client = fakeClient();

    terminal.input(client, 2, SESSION_TARGET, 'yes\r');
    servers.put[0]?.answer({
      ok: false,
      code: 'refused',
      problem: 'that session has ended and cannot be typed into',
    });

    expect(client.received).toEqual([
      {
        type: 'refusal',
        replyTo: 2,
        code: 'refused',
        message: 'that session has ended and cannot be typed into',
        holder: null,
      },
    ]);
  });

  it('sends a resize to the holder in the same way', () => {
    const { terminal, servers } = oneMachine();

    terminal.resize(fakeClient(), 2, SESSION_TARGET, { cols: 96, rows: 30 });

    expect(servers.put[0]?.frame).toEqual({
      type: 'terminal-resize',
      target: { by: 'session', storeId: WORK, sessionId: QUIET },
      size: { cols: 96, rows: 30 },
    });
  });

  it('takes input from either of two viewers and lets the pty sort it out', () => {
    const { terminal, servers } = oneMachine();
    const first = fakeClient();
    const second = fakeClient();

    terminal.input(first, 2, SESSION_TARGET, 'l');
    terminal.input(second, 2, SESSION_TARGET, 's');

    // Two hands on one keyboard is what a terminal is. A hub that serialised
    // these would be inventing a turn-taking rule neither the protocol nor the
    // program on the far end has.
    expect(servers.of('terminal-input').map((one) => one.frame)).toEqual([
      { type: 'terminal-input', target: SESSION_TARGET, data: 'l' },
      { type: 'terminal-input', target: SESSION_TARGET, data: 's' },
    ]);
  });
});

describe('a terminal the hub cannot reach', () => {
  it('refuses a subscribe and names the machine, because a blank pane does not', () => {
    const { terminal, servers } = harness(
      fleet([server(WORKSHOP, 'workshop', 'stale')], [row(null, [WORKSHOP])]),
    );
    const client = fakeClient();

    terminal.subscribe(client, 2, SESSION_TARGET);

    expect(client.received).toEqual([
      {
        type: 'refusal',
        replyTo: 2,
        code: 'refused',
        message: 'the hub cannot reach workshop right now',
        holder: null,
      },
    ]);
    expect(servers.put).toEqual([]);
  });

  it('refuses input to a disconnected holder the same way', () => {
    const { terminal } = harness(
      fleet([server(WORKSHOP, 'workshop', 'stale')], [row(null, [WORKSHOP])]),
    );
    const client = fakeClient();

    terminal.input(client, 2, SESSION_TARGET, 'yes\r');

    expect(client.received.at(-1)).toMatchObject({
      type: 'refusal',
      message: 'the hub cannot reach workshop right now',
    });
  });

  it('refuses a session no machine reports at all', () => {
    const { terminal } = harness(fleet([server(ATTIC, 'attic')], []));
    const client = fakeClient();

    terminal.subscribe(client, 2, SESSION_TARGET);

    expect(client.received.at(-1)).toMatchObject({
      type: 'refusal',
      message: 'no server the hub can see reports that session',
    });
  });

  it('refuses a store nothing has mounted', () => {
    const { terminal } = harness(fleet([server(ATTIC, 'attic')], []));
    const client = fakeClient();
    const elsewhere: StoreId = storeIdSchema.parse('store-nowhere');

    terminal.subscribe(client, 2, { by: 'session', storeId: elsewhere, sessionId: QUIET });

    expect(client.received.at(-1)).toMatchObject({
      type: 'refusal',
      message: 'no server the hub is paired with has that store mounted',
    });
  });

  it('refuses a start handle whose machine has gone stale, naming it', () => {
    const { terminal } = harness(fleet([server(WORKSHOP, 'workshop', 'stale')], []));
    const client = fakeClient();
    const held: StartId = START;
    terminal.noteStart(client, 7, { registrationId: WORKSHOP, startId: held, storeId: WORK });

    terminal.subscribe(client, 7, { by: 'start', startId: 7 });

    expect(client.received.at(-1)).toMatchObject({
      type: 'refusal',
      message: 'the hub cannot reach workshop right now',
    });
  });
});

describe('an unsubscribe for a terminal nobody is watching', () => {
  it('is refused rather than answered, and nothing is put to a server', () => {
    const { terminal, servers } = oneMachine();
    const client = fakeClient();

    terminal.unsubscribe(client, 2, SESSION_TARGET);

    expect(client.received).toEqual([
      {
        type: 'refusal',
        replyTo: 2,
        code: 'refused',
        message: 'this connection is not watching that terminal',
        holder: null,
      },
    ]);
    expect(servers.put).toEqual([]);
  });
});
