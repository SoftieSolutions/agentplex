import { describe, expect, it } from 'vitest';
import {
  sessionIdSchema,
  startIdSchema,
  storeDescriptorSchema,
  type ServerTerminalTarget,
  type SessionId,
  type StartId,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import type { FakePtyFactory } from '@agentplex/pty/testing';
import type { GrantId, Launch, LaunchPlan } from '@agentplex/providers';
import { createFakeTerminals, type FakeTerminalsOptions } from './fake-terminals.js';
import type { TerminalManager } from './terminal-manager.js';
import {
  createTerminalStreams,
  type TerminalAttachment,
  type TerminalDelivery,
  type TerminalOutput,
  type TerminalStreams,
} from './terminal-streams.js';

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/claude' });
const SESSION_A = sessionIdSchema.parse('session-a');

const PLAN: LaunchPlan = {
  command: 'claude',
  args: [],
  cwd: '/volumes/claude',
  env: {},
  scrubEnvPrefixes: ['CLAUDE'],
};
const launch: Launch = { ok: true, plan: PLAN };

const logger = createLogger('error', () => {});

/**
 * The connection these streams belong to.
 *
 * The manager counts watchers by name rather than by handle, so what a terminal
 * reports is who is watching it and not how many; every assertion below names
 * this one.
 */
const WATCHER = 'connection-under-test';

/**
 * The grant that connection authenticated with, and one belonging to a second
 * hub.
 *
 * Starts are scoped to a grant rather than to a connection, which is what lets
 * a hub that redialled be told again what it started -- and what keeps a start
 * id, which one hub minted and the other has never heard of, out of the other
 * hub's reports.
 */
const GRANT = 'grant-under-test' as GrantId;
const OTHER_GRANT = 'grant-another-hub' as GrantId;

/** One hub-minted start handle. Opaque, and the same across that hub's sockets. */
const START = startIdSchema.parse('start-7');

interface Harness {
  readonly terminals: TerminalManager;
  readonly streams: TerminalStreams;
  /**
   * Another connection over the same terminals: a hub that redialled, or a
   * second hub with a grant of its own.
   *
   * Its output goes to the same arrays, which no test that uses it reads --
   * what a second connection is for here is what it is told about starts.
   */
  connect(options?: { readonly grant?: GrantId; readonly watcher?: string }): TerminalStreams;
  readonly factory: FakePtyFactory;
  /** Everything the connection was handed and took, in order. */
  readonly output: readonly TerminalOutput[];
  /** Everything it was handed and refused, in order. */
  readonly refused: readonly TerminalOutput[];
  /** Whether the connection is taking chunks. A congested one is not. */
  congest(congested: boolean): void;
}

function harness(options: FakeTerminalsOptions = {}): Harness {
  const { terminals, factory } = createFakeTerminals(options);
  const output: TerminalOutput[] = [];
  const refused: TerminalOutput[] = [];
  let congested = false;
  const connect = (options: { readonly grant?: GrantId; readonly watcher?: string } = {}) =>
    createTerminalStreams({
      terminals,
      watcher: options.watcher ?? WATCHER,
      grant: () => options.grant ?? GRANT,
      onOutput: (chunk): TerminalDelivery => {
        if (congested) {
          refused.push(chunk);
          return 'dropped';
        }
        output.push(chunk);
        return 'sent';
      },
      logger,
    });

  return {
    terminals,
    streams: connect(),
    connect,
    factory,
    output,
    refused,
    congest: (value: boolean) => void (congested = value),
  };
}

/** Spawns a terminal with no session id yet, as a real spawn arrives. */
function spawn(terminals: TerminalManager): string {
  const opened = terminals.spawn(STORE, launch);
  if (!opened.ok) throw new Error(`the spawn should have opened: ${opened.problem}`);
  return opened.terminal.terminalId;
}

const bySession = (sessionId: SessionId): ServerTerminalTarget => ({
  by: 'session',
  storeId: STORE.storeId,
  sessionId,
});

const byStart = (startId: StartId): ServerTerminalTarget => ({ by: 'start', startId });

const text = (chunk: Uint8Array): string => new TextDecoder().decode(chunk);

describe('createTerminalStreams subscribing', () => {
  it('hands back the scrollback it read before it attached, so there is no gap', () => {
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    factory.last?.emit('before anybody watched\r\n');

    const attached = streams.subscribe(bySession(SESSION_A));

    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.attachment.replay.map(text)).toEqual(['before anybody watched\r\n']);
    expect(attached.attachment.sessionId).toBe(SESSION_A);
  });

  it('streams what the pty says afterwards, addressed by the session', () => {
    const { terminals, streams, factory, output } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    streams.subscribe(bySession(SESSION_A));

    factory.last?.emit('live\r\n');

    expect(output).toHaveLength(1);
    expect(text(output[0]?.chunk ?? new Uint8Array())).toBe('live\r\n');
    expect(output[0]).toMatchObject({
      storeId: STORE.storeId,
      sessionId: SESSION_A,
      startId: null,
    });
  });

  it('counts no dropped chunks while the connection is taking them', () => {
    const { terminals, streams, factory, output } = harness();
    attachToStart(terminals, streams, START);
    factory.last?.emit('anything');

    expect(output[0]?.droppedChunks).toBe(0);
  });

  it('charges a refused chunk to its own stream and reports it on the next one through', () => {
    // The connection decides whether it can take a chunk, because only it can
    // see the socket; this decides which stream lost one, because only it
    // knows. The count arrives on the next chunk that gets through rather than
    // on the one that was lost, which is the only frame there is to put it on.
    const { terminals, streams, factory, output, refused, congest } = harness();
    attachToStart(terminals, streams, START);

    factory.last?.emit('the hub is keeping up');
    congest(true);
    factory.last?.emit('lost');
    factory.last?.emit('lost as well');
    congest(false);
    factory.last?.emit('the hub caught up');

    expect(refused.map((chunk) => text(chunk.chunk))).toEqual(['lost', 'lost as well']);
    expect(output.map((chunk) => [text(chunk.chunk), chunk.droppedChunks])).toEqual([
      ['the hub is keeping up', 0],
      ['the hub caught up', 2],
    ]);
  });

  it('keeps the count rising rather than reporting one gap and forgetting it', () => {
    // Cumulative, so a reader that compares with the last value it saw learns
    // the size of each gap, and one that does not still sees a number saying
    // the stream is lossy.
    const { terminals, streams, factory, output, congest } = harness();
    attachToStart(terminals, streams, START);

    congest(true);
    factory.last?.emit('gone');
    congest(false);
    factory.last?.emit('through');
    congest(true);
    factory.last?.emit('gone too');
    congest(false);
    factory.last?.emit('through again');

    expect(output.map((chunk) => chunk.droppedChunks)).toEqual([1, 2]);
  });

  it('goes on filling the scrollback for chunks the connection could not take', () => {
    // Dropping is a decision about the wire and not about the session. The
    // child is never slowed down and its recent output is still there, so a
    // hub that catches up and re-subscribes is replayed what it missed.
    const { terminals, streams, factory, congest } = harness();
    const { terminalId } = attachToStart(terminals, streams, START);
    terminals.bind(terminalId, SESSION_A);

    congest(true);
    factory.last?.emit('dropped on the wire, kept on the machine');
    congest(false);

    const attached = streams.subscribe(bySession(SESSION_A));
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.attachment.replay.map(text)).toEqual([
      'dropped on the wire, kept on the machine',
    ]);
  });

  it('attaches to a spawn by the start that made it, before the session has a name', () => {
    // The pending-pane case: the provider has not written a session id yet and
    // the terminal is already producing output.
    const { terminals, streams, factory, output } = harness();
    const { attachment } = attachToStart(terminals, streams, START);

    factory.last?.emit('starting up\r\n');

    expect(attachment.sessionId).toBeNull();
    expect(attachment.startId).toBe(START);
    expect(output[0]).toMatchObject({ sessionId: null, startId: START });
  });

  it('names the session as soon as it has one, on a subscription made by start', () => {
    const { terminals, streams, factory, output } = harness();
    const { terminalId } = attachToStart(terminals, streams, START);

    terminals.bind(terminalId, SESSION_A);
    factory.last?.emit('named now\r\n');

    expect(output[0]).toMatchObject({ sessionId: SESSION_A, startId: START });
  });

  it('says how much of the beginning is gone rather than passing a tail off as all of it', () => {
    const { terminals, streams, factory } = harness({ scrollbackBytes: 8 });
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    factory.last?.emit('the first line, long gone\r\n');
    factory.last?.emit('the second');

    const attached = streams.subscribe(bySession(SESSION_A));

    expect(attached.ok && attached.attachment.droppedBytes).toBe(27);
    expect(attached.ok && attached.attachment.replay).toHaveLength(1);
  });

  it('separates a session that has produced nothing from one whose beginning is gone', () => {
    // The two opposite facts. Both attachments replay less than the whole
    // session; only one of them is missing anything, and an attachment that
    // could not say which would make a pane guess.
    const { terminals, streams } = harness({ scrollbackBytes: 8 });
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);

    const attached = streams.subscribe(bySession(SESSION_A));

    expect(attached.ok && attached.attachment.replay).toEqual([]);
    expect(attached.ok && attached.attachment.droppedBytes).toBe(0);
  });

  it('refuses a subscription to a session this server is not running', () => {
    const { streams } = harness();

    const attached = streams.subscribe(bySession(sessionIdSchema.parse('session-elsewhere')));

    expect(attached.ok).toBe(false);
  });

  it('refuses a subscription to a start that has not happened on this connection', () => {
    const { streams } = harness();

    expect(streams.subscribe(byStart(startIdSchema.parse('start-nobody-made'))).ok).toBe(false);
  });

  it('sends one copy of a chunk however many targets are watching that terminal', () => {
    // A pending pane subscribed by start and a settled pane subscribed by
    // session are two subscriptions to one process. The wire carries the bytes
    // once; the peer fans them out, which is what the two ids on the frame are
    // for.
    const { terminals, streams, factory, output } = harness();
    const { terminalId } = attachToStart(terminals, streams, START);
    terminals.bind(terminalId, SESSION_A);
    streams.subscribe(bySession(SESSION_A));

    factory.last?.emit('once\r\n');

    expect(output).toHaveLength(1);
  });

  it('lets go of the old terminal when a session target now names a new one', () => {
    // A session whose agent exited and was resumed is a second terminal under
    // the same target. A subscription that moved to it but kept the first
    // watched would leave a dead terminal the cap can never evict.
    const { terminals, streams, factory } = harness({ cap: 2 });
    const first = terminals.resume({ storeId: STORE.storeId, sessionId: SESSION_A }, launch);
    if (!first.ok) throw new Error(`the first resume should have opened: ${first.problem}`);
    streams.subscribe(bySession(SESSION_A));
    factory.ptys[0]?.close({ exitCode: 0, signal: null });

    const second = terminals.resume({ storeId: STORE.storeId, sessionId: SESSION_A }, launch);
    if (!second.ok) throw new Error(`the second resume should have opened: ${second.problem}`);
    const attached = streams.subscribe(bySession(SESSION_A));

    const idA = first.terminal.terminalId;
    const idB = second.terminal.terminalId;
    expect(attached.ok).toBe(true);
    expect(terminals.terminal(idA)?.watchers).toEqual([]);
    expect(terminals.terminal(idB)?.watchers).toEqual([WATCHER]);
    expect(factory.ptys).toHaveLength(2);

    const third = terminals.resume(
      { storeId: STORE.storeId, sessionId: sessionIdSchema.parse('session-b') },
      launch,
    );

    expect(third.ok).toBe(true);
    expect(factory.ptys).toHaveLength(3);
    expect(terminals.terminal(idA)).toBeUndefined();
  });

  it('keeps one watch when the same target subscribes to the same terminal again', () => {
    // Re-subscribing is not moving: detaching and watching again would reset
    // the dropped count and read the replay a second time for nothing.
    const { terminals, streams, factory, output } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    streams.subscribe(bySession(SESSION_A));

    const again = streams.subscribe(bySession(SESSION_A));
    factory.last?.emit('once\r\n');

    expect(again.ok).toBe(true);
    expect(terminals.terminal(terminalId)?.watchers).toEqual([WATCHER]);
    expect(output).toHaveLength(1);
  });
});

describe('createTerminalStreams detaching', () => {
  it('gives the watcher count back, so the eviction rule reads a number that can fall', () => {
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    streams.subscribe(bySession(SESSION_A));
    expect(terminals.terminal(terminalId)?.watchers).toEqual([WATCHER]);

    const detached = streams.unsubscribe(bySession(SESSION_A));

    expect(detached.ok).toBe(true);
    expect(terminals.terminal(terminalId)?.watchers).toEqual([]);
  });

  it('never closes the terminal: a closing tab is not a decision about a session', () => {
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    streams.subscribe(bySession(SESSION_A));

    streams.unsubscribe(bySession(SESSION_A));

    expect(factory.last?.kills).toBe(0);
    expect(terminals.terminal(terminalId)?.run.exit).toBeNull();
  });

  it('stops delivering once the last target has let go', () => {
    const { terminals, streams, factory, output } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    streams.subscribe(bySession(SESSION_A));
    streams.unsubscribe(bySession(SESSION_A));

    factory.last?.emit('nobody is listening\r\n');

    expect(output).toHaveLength(0);
    expect(terminals.terminal(terminalId)?.run.exit).toBeNull();
  });

  it('holds the terminal while another target is still watching it', () => {
    const { terminals, streams, factory, output } = harness();
    const { terminalId } = attachToStart(terminals, streams, START);
    terminals.bind(terminalId, SESSION_A);
    streams.subscribe(bySession(SESSION_A));

    streams.unsubscribe(byStart(START));
    factory.last?.emit('still watched\r\n');

    expect(output).toHaveLength(1);
    expect(terminals.terminal(terminalId)?.watchers).toEqual([WATCHER]);
  });

  it('refuses an unsubscribe from something this connection never subscribed to', () => {
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);

    expect(streams.unsubscribe(bySession(SESSION_A)).ok).toBe(false);
  });

  it('counts a watcher off once however many times the same target lets go', () => {
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    streams.subscribe(bySession(SESSION_A));

    streams.unsubscribe(bySession(SESSION_A));
    streams.unsubscribe(bySession(SESSION_A));

    expect(terminals.terminal(terminalId)?.watchers).toEqual([]);
  });

  it('gives every count back when the socket goes, through the same path a frame takes', () => {
    // A lid closing and a tab closing reach the same release. A socket that
    // dropped its subscriptions some other way would be a second rule to keep
    // in step with the first, and the symptom would be terminals that are
    // watched forever and can never be evicted.
    const { terminals, streams, factory } = harness();
    const first = spawn(terminals);
    terminals.bind(first, SESSION_A);
    streams.subscribe(bySession(SESSION_A));
    const { terminalId: second } = attachToStart(terminals, streams, START);

    streams.detachAll();

    expect(terminals.terminal(first)?.watchers).toEqual([]);
    expect(terminals.terminal(second)?.watchers).toEqual([]);
    expect(factory.ptys.every((pty) => pty.kills === 0)).toBe(true);
    expect(terminals.terminal(first)?.run.exit).toBeNull();
  });
});

describe('createTerminalStreams input and resize', () => {
  it('writes what the user typed into the pty, as they typed it', () => {
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);

    const written = streams.write(bySession(SESSION_A), 'pnpm test\r');

    expect(written.ok).toBe(true);
    expect(factory.last?.written).toEqual(['pnpm test\r']);
  });

  it('takes input for a terminal nobody is watching: typing is not subscribing', () => {
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);

    expect(streams.write(bySession(SESSION_A), 'y\r').ok).toBe(true);
    expect(factory.last?.written).toEqual(['y\r']);
  });

  it('refuses input for a session this server is not running', () => {
    const { streams } = harness();

    expect(streams.write(bySession(SESSION_A), 'ls\r').ok).toBe(false);
  });

  it('refuses input for a session whose process has ended, rather than dropping it silently', () => {
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    factory.last?.close({ exitCode: 0, signal: null });

    expect(streams.write(bySession(SESSION_A), 'ls\r').ok).toBe(false);
  });

  it('refuses input for a paused session in a sentence, and writes nothing', () => {
    // The whole of what a pause is on this machine: the process is untouched
    // and its keyboard is withheld. The words are what the client shows.
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    terminals.observe({ storeId: STORE.storeId, sessionId: SESSION_A }, 'idle');
    terminals.pause(terminalId);

    expect(streams.write(bySession(SESSION_A), 'ls\r')).toEqual({
      ok: false,
      problem: 'that session is paused; resume it to type into it',
    });
    expect(factory.last?.written).toEqual([]);
  });

  it('still takes input while a pause is only requested: the turn has not ended', () => {
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    terminals.observe({ storeId: STORE.storeId, sessionId: SESSION_A }, 'working');
    terminals.pause(terminalId);

    expect(streams.write(bySession(SESSION_A), 'y\r').ok).toBe(true);
    expect(factory.last?.written).toEqual(['y\r']);
  });

  it('still resizes a paused session: the screen is the viewer\u2019s, not the agent\u2019s', () => {
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    terminals.observe({ storeId: STORE.storeId, sessionId: SESSION_A }, 'idle');
    terminals.pause(terminalId);

    expect(streams.resize(bySession(SESSION_A), { cols: 80, rows: 24 }).ok).toBe(true);
    expect(factory.last?.resizes).toEqual([{ cols: 80, rows: 24 }]);
  });

  it('takes input again while a re-armed pause waits for the next boundary', () => {
    // A paused session seen working again is mid-turn, and mid-turn the
    // keyboard is the one control the user has: the pause is back to a
    // request, and only `paused` withholds the keyboard.
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    terminals.observe({ storeId: STORE.storeId, sessionId: SESSION_A }, 'idle');
    terminals.pause(terminalId);
    expect(streams.write(bySession(SESSION_A), 'ls\r').ok).toBe(false);

    terminals.observe({ storeId: STORE.storeId, sessionId: SESSION_A }, 'working');

    expect(terminals.terminal(terminalId)?.pause).toBe('requested');
    expect(streams.write(bySession(SESSION_A), 'y\r').ok).toBe(true);
    expect(factory.last?.written).toEqual(['y\r']);
  });

  it('takes input again once the session is unpaused', () => {
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);
    terminals.observe({ storeId: STORE.storeId, sessionId: SESSION_A }, 'idle');
    terminals.pause(terminalId);
    terminals.unpause(terminalId);

    expect(streams.write(bySession(SESSION_A), 'ls\r').ok).toBe(true);
    expect(factory.last?.written).toEqual(['ls\r']);
  });

  it('resizes the pty to the size the viewer actually has', () => {
    const { terminals, streams, factory } = harness();
    const terminalId = spawn(terminals);
    terminals.bind(terminalId, SESSION_A);

    const resized = streams.resize(bySession(SESSION_A), { cols: 120, rows: 40 });

    expect(resized.ok).toBe(true);
    expect(factory.last?.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('resizes a spawn addressed by its start handle', () => {
    const { terminals, streams, factory } = harness();
    attachToStart(terminals, streams, START);

    expect(streams.resize(byStart(START), { cols: 100, rows: 30 }).ok).toBe(true);
    expect(factory.last?.resizes).toEqual([{ cols: 100, rows: 30 }]);
  });
});

describe('createTerminalStreams start provenance', () => {
  it('reports a start with no session id yet, so a pending pane has something to be', () => {
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(START, terminalId);

    expect(streams.takeStartTags(STORE.storeId)).toEqual([{ startId: START, sessionId: null }]);
  });

  it('reports the pair once the provider has named the session, and then stops', () => {
    // Exact, never heuristic: the reader is told which start produced which
    // session rather than being left to match them up by time. Once this
    // connection has been told, repeating the handle to it buys nothing.
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(START, terminalId);
    streams.takeStartTags(STORE.storeId);

    terminals.bind(terminalId, SESSION_A);

    expect(streams.takeStartTags(STORE.storeId)).toEqual([
      { startId: START, sessionId: SESSION_A },
    ]);
    expect(streams.takeStartTags(STORE.storeId)).toEqual([]);
  });

  it('says nothing about a start in another store', () => {
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(START, terminalId);

    expect(
      streams.takeStartTags(
        storeDescriptorSchema.parse({ storeId: 'store-b', path: '/b' }).storeId,
      ),
    ).toEqual([]);
  });

  it('drops a start whose terminal is gone rather than naming one that is not there', () => {
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(START, terminalId);
    terminals.closeAll();

    expect(streams.takeStartTags(STORE.storeId)).toEqual([]);
  });

  it('tells a hub that redialled what it started, with no session id yet', () => {
    // The whole of this change, on the server side. The socket the start
    // arrived on is gone and the provider has still written nothing, so the
    // start handle is the only name that spawn has -- and the hub that minted
    // it is the one asking. A tag held against the socket would be lost here,
    // and the hub would be watching a terminal it could no longer address.
    const { terminals, streams, connect } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(START, terminalId);
    streams.takeStartTags(STORE.storeId);

    const redialled = connect({ watcher: 'connection-after-the-drop' });

    expect(redialled.takeStartTags(STORE.storeId)).toEqual([{ startId: START, sessionId: null }]);
  });

  it('tells the reconnected hub the pair as soon as the provider names it', () => {
    const { terminals, streams, connect } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(START, terminalId);

    const redialled = connect({ watcher: 'connection-after-the-drop' });
    terminals.bind(terminalId, SESSION_A);

    // Once, with the id, and then not again: the same rule the first
    // connection was under, applied to this one on its own terms.
    expect(redialled.takeStartTags(STORE.storeId)).toEqual([
      { startId: START, sessionId: SESSION_A },
    ]);
    expect(redialled.takeStartTags(STORE.storeId)).toEqual([]);
  });

  it('says nothing to a hub that did not make the start', () => {
    // A start id is minted by one hub and means nothing to another, so the
    // other hub is not told one. It is not being kept from anything: it sees
    // the session itself the moment the provider names it, like every other
    // session in a store it can already read.
    const { terminals, streams, connect } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(START, terminalId);

    const otherHub = connect({ grant: OTHER_GRANT, watcher: 'connection-of-another-hub' });

    expect(otherHub.takeStartTags(STORE.storeId)).toEqual([]);
  });

  it('refuses another hub a subscription by a start handle it never minted', () => {
    const { terminals, streams, connect } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(START, terminalId);

    const otherHub = connect({ grant: OTHER_GRANT, watcher: 'connection-of-another-hub' });

    expect(otherHub.subscribe(byStart(START)).ok).toBe(false);
  });
});

/** Spawns, records the start, and subscribes by it: the pending-pane sequence. */
function attachToStart(
  terminals: TerminalManager,
  streams: TerminalStreams,
  startId: StartId,
): { readonly terminalId: string; readonly attachment: TerminalAttachment } {
  const terminalId = spawn(terminals);
  streams.noteStart(startId, terminalId);
  const attached = streams.subscribe(byStart(startId));
  if (!attached.ok) throw new Error(`the subscription should have attached: ${attached.problem}`);
  return { terminalId, attachment: attached.attachment };
}
