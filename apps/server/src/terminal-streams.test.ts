import { describe, expect, it } from 'vitest';
import {
  sessionIdSchema,
  storeDescriptorSchema,
  type SessionId,
  type TerminalTarget,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import type { FakePtyFactory } from '@agentplex/pty/testing';
import type { Launch, LaunchPlan } from '@agentplex/providers';
import { createFakeTerminals } from './fake-terminals.js';
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

interface Harness {
  readonly terminals: TerminalManager;
  readonly streams: TerminalStreams;
  readonly factory: FakePtyFactory;
  /** Everything the connection was handed and took, in order. */
  readonly output: readonly TerminalOutput[];
  /** Everything it was handed and refused, in order. */
  readonly refused: readonly TerminalOutput[];
  /** Whether the connection is taking chunks. A congested one is not. */
  congest(congested: boolean): void;
}

/**
 * Who this connection's watches are counted against.
 *
 * The manager counts watchers by name rather than by handle, so what a terminal
 * reports is the set of connections holding it rather than a number. A suite
 * with one connection in it still asserts on the set: the count is the thing
 * that stopped being the whole answer.
 */
const WATCHER = 'connection-under-test';

function harness(scrollbackBytes?: number): Harness {
  const { terminals, factory } = createFakeTerminals(
    scrollbackBytes === undefined ? {} : { scrollbackBytes },
  );
  const output: TerminalOutput[] = [];
  const refused: TerminalOutput[] = [];
  let congested = false;
  const streams = createTerminalStreams({
    terminals,
    watcher: WATCHER,
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
    streams,
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

const bySession = (sessionId: SessionId): TerminalTarget => ({
  by: 'session',
  storeId: STORE.storeId,
  sessionId,
});

const byStart = (startId: number): TerminalTarget => ({ by: 'start', startId });

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
    attachToStart(terminals, streams, 7);
    factory.last?.emit('anything');

    expect(output[0]?.droppedChunks).toBe(0);
  });

  it('charges a refused chunk to its own stream and reports it on the next one through', () => {
    // The connection decides whether it can take a chunk, because only it can
    // see the socket; this decides which stream lost one, because only it
    // knows. The count arrives on the next chunk that gets through rather than
    // on the one that was lost, which is the only frame there is to put it on.
    const { terminals, streams, factory, output, refused, congest } = harness();
    attachToStart(terminals, streams, 7);

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
    attachToStart(terminals, streams, 7);

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
    const { terminalId } = attachToStart(terminals, streams, 7);
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
    const { attachment } = attachToStart(terminals, streams, 7);

    factory.last?.emit('starting up\r\n');

    expect(attachment.sessionId).toBeNull();
    expect(attachment.startId).toBe(7);
    expect(output[0]).toMatchObject({ sessionId: null, startId: 7 });
  });

  it('names the session as soon as it has one, on a subscription made by start', () => {
    const { terminals, streams, factory, output } = harness();
    const { terminalId } = attachToStart(terminals, streams, 7);

    terminals.bind(terminalId, SESSION_A);
    factory.last?.emit('named now\r\n');

    expect(output[0]).toMatchObject({ sessionId: SESSION_A, startId: 7 });
  });

  it('says how much of the beginning is gone rather than passing a tail off as all of it', () => {
    const { terminals, streams, factory } = harness(8);
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
    const { terminals, streams } = harness(8);
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

    expect(streams.subscribe(byStart(99)).ok).toBe(false);
  });

  it('sends one copy of a chunk however many targets are watching that terminal', () => {
    // A pending pane subscribed by start and a settled pane subscribed by
    // session are two subscriptions to one process. The wire carries the bytes
    // once; the peer fans them out, which is what the two ids on the frame are
    // for.
    const { terminals, streams, factory, output } = harness();
    const { terminalId } = attachToStart(terminals, streams, 7);
    terminals.bind(terminalId, SESSION_A);
    streams.subscribe(bySession(SESSION_A));

    factory.last?.emit('once\r\n');

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
    const { terminalId } = attachToStart(terminals, streams, 7);
    terminals.bind(terminalId, SESSION_A);
    streams.subscribe(bySession(SESSION_A));

    streams.unsubscribe(byStart(7));
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
    const { terminalId: second } = attachToStart(terminals, streams, 7);

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
    attachToStart(terminals, streams, 7);

    expect(streams.resize(byStart(7), { cols: 100, rows: 30 }).ok).toBe(true);
    expect(factory.last?.resizes).toEqual([{ cols: 100, rows: 30 }]);
  });
});

describe('createTerminalStreams start provenance', () => {
  it('reports a start with no session id yet, so a pending pane has something to be', () => {
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(7, terminalId);

    expect(streams.takeStartTags(STORE.storeId)).toEqual([{ startId: 7, sessionId: null }]);
  });

  it('reports the pair once the provider has named the session, and then stops', () => {
    // Exact, never heuristic: the reader is told which start produced which
    // session rather than being left to match them up by time. Once it has
    // been told, repeating a handle local to one connection buys nothing.
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(7, terminalId);
    streams.takeStartTags(STORE.storeId);

    terminals.bind(terminalId, SESSION_A);

    expect(streams.takeStartTags(STORE.storeId)).toEqual([{ startId: 7, sessionId: SESSION_A }]);
    expect(streams.takeStartTags(STORE.storeId)).toEqual([]);
  });

  it('says nothing about a start in another store', () => {
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(7, terminalId);

    expect(
      streams.takeStartTags(
        storeDescriptorSchema.parse({ storeId: 'store-b', path: '/b' }).storeId,
      ),
    ).toEqual([]);
  });

  it('drops a start whose terminal is gone rather than naming one that is not there', () => {
    const { terminals, streams } = harness();
    const terminalId = spawn(terminals);
    streams.noteStart(7, terminalId);
    terminals.closeAll();

    expect(streams.takeStartTags(STORE.storeId)).toEqual([]);
  });
});

/** Spawns, records the start, and subscribes by it: the pending-pane sequence. */
function attachToStart(
  terminals: TerminalManager,
  streams: TerminalStreams,
  startId: number,
): { readonly terminalId: string; readonly attachment: TerminalAttachment } {
  const terminalId = spawn(terminals);
  streams.noteStart(startId, terminalId);
  const attached = streams.subscribe(byStart(startId));
  if (!attached.ok) throw new Error(`the subscription should have attached: ${attached.problem}`);
  return { terminalId, attachment: attached.attachment };
}
