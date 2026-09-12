import type {
  FrameId,
  SessionId,
  SessionStartTag,
  StoreId,
  TerminalSize,
  TerminalTarget,
} from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import type { Terminal, TerminalManager } from './terminal-manager.js';

/**
 * One hub connection's standing interest in this server's terminals.
 *
 * The terminals themselves outlive every connection -- a socket comes and
 * goes, and the agents this server forked go on running across both -- so what
 * belongs to a connection is exactly this: which terminals it is watching,
 * which starts it made, and the detaches it owes back.
 *
 * Three rules hold it together.
 *
 * - **Detaching is a frame, and closing the socket is the same detach.** The
 *   watcher count is what the terminal manager evicts by, and a count that only
 *   ever goes up would make the longest-unwatched rule choose between terminals
 *   that all claim to be watched. `release` below is the only thing that hands
 *   a watch back, and both the `session-unsubscribe` frame and the socket
 *   closing go through it. Neither closes a terminal: sessions outlive tabs and
 *   sockets, a lid closing is not a decision.
 * - **One stream per terminal, not per subscriber.** A pending pane watching by
 *   start handle and a settled pane watching by session are two subscriptions
 *   to one process. The bytes cross the wire once, carrying both the session
 *   and the start handle, and the peer fans them out; a copy per subscription
 *   would multiply the busiest path on the wire by the number of tabs.
 * - **Nothing here names a terminal to a peer.** A terminal id is this
 *   server's own bookkeeping for a process on its own machine. Frames address
 *   a session or a start handle, and this is where either is turned into a
 *   terminal, which is the same reason a stop carries no pid.
 */

/** One chunk to put on the wire, addressed by what the session is. */
export interface TerminalOutput {
  readonly storeId: StoreId;
  /** `null` while the provider has not named the session yet. */
  readonly sessionId: SessionId | null;
  /** The start this connection made, when it made it, and `null` otherwise. */
  readonly startId: FrameId | null;
  readonly chunk: Uint8Array;
  /** Chunks this stream threw away before this one. Zero until AGX-209 lands. */
  readonly droppedChunks: number;
}

/**
 * What a subscription attached to.
 *
 * `replay` is the scrollback as it stood when the watch was attached, read
 * before attaching rather than after: that ordering is the one with no gap
 * between the history and the live stream, and it is the ordering
 * `terminal-manager.ts` prescribes for exactly that reason.
 *
 * It is a bounded tail and not the session, so it travels with the one number
 * that says so. An empty `replay` with `droppedBytes` at zero is a session
 * that has printed nothing; an empty one is otherwise impossible, because the
 * scrollback never evicts its last chunk. Those two are opposite facts that a
 * pane cannot tell apart from the bytes alone.
 */
export interface TerminalAttachment {
  readonly storeId: StoreId;
  readonly sessionId: SessionId | null;
  readonly startId: FrameId | null;
  /** Bytes printed before `replay` begins, so the peer can size what is gone. */
  readonly droppedBytes: number;
  readonly replay: readonly Uint8Array[];
}

export type AttachOutcome =
  | { readonly ok: true; readonly attachment: TerminalAttachment }
  | { readonly ok: false; readonly problem: string };

/** A refusal in words, or nothing to say. Neither carries a terminal. */
export type StreamOutcome =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

export interface TerminalStreamsDependencies {
  /** The terminals this server holds. Injected: they outlive this connection. */
  readonly terminals: TerminalManager;
  /** Where a chunk goes. The connection turns it into a frame; this does not. */
  onOutput(output: TerminalOutput): void;
  readonly logger: Logger;
}

export interface TerminalStreams {
  /**
   * Records that a start on this connection produced a terminal.
   *
   * The start handle is the id of the frame that asked, which makes it local
   * to this connection and meaningless on another. That is what makes it safe
   * to answer subscriptions with, and why nothing keeps it once the session
   * has a name of its own.
   */
  noteStart(startId: FrameId, terminalId: string): void;
  subscribe(target: TerminalTarget): AttachOutcome;
  unsubscribe(target: TerminalTarget): StreamOutcome;
  write(target: TerminalTarget, data: string): StreamOutcome;
  resize(target: TerminalTarget, size: TerminalSize): StreamOutcome;
  /**
   * The start provenance to put in this store's next report, and the taking is
   * the point: a start is reported until it has been reported with the session
   * id the provider wrote, and not one report longer.
   */
  takeStartTags(storeId: StoreId): readonly SessionStartTag[];
  /** The socket went away. Every watch this connection held is given back. */
  detachAll(): void;
}

/** A terminal this connection is watching, and the targets that asked for it. */
interface Stream {
  readonly terminal: Terminal;
  readonly targets: Set<string>;
  detach: () => void;
  droppedChunks: number;
}

/** A start this connection made, and whether its session has been reported. */
interface StartRecord {
  readonly terminalId: string;
  identified: boolean;
}

export function createTerminalStreams({
  terminals,
  onOutput,
  logger,
}: TerminalStreamsDependencies): TerminalStreams {
  const streams = new Map<string, Stream>();
  /** The same streams, by the target that asked, so a detach needs no lookup. */
  const byTarget = new Map<string, Stream>();
  const starts = new Map<FrameId, StartRecord>();

  const startIdOf = (terminalId: string): FrameId | null => {
    for (const [startId, record] of starts) {
      if (record.terminalId === terminalId) return startId;
    }
    return null;
  };

  /**
   * The terminal a frame is about, or nothing.
   *
   * A session resolves to the live terminal holding it when there is one, and
   * otherwise to a terminal whose process has ended: the session somebody most
   * wants to read is frequently the one that just stopped, and its bytes are
   * here rather than in the transcript.
   */
  const resolve = (target: TerminalTarget): Terminal | undefined => {
    if (target.by === 'start') {
      const record = starts.get(target.startId);
      return record === undefined ? undefined : terminals.terminal(record.terminalId);
    }
    const held = terminals.terminals.filter(
      (terminal) =>
        terminal.storeId === target.storeId && terminal.session?.sessionId === target.sessionId,
    );
    return held.find((terminal) => terminal.run.exit === null) ?? held[0];
  };

  const describe = (target: TerminalTarget): string =>
    target.by === 'start'
      ? `this server has no terminal for start ${String(target.startId)}`
      : `this server is not running session ${target.sessionId}`;

  /** A target's name, so two frames naming one thing count as one subscriber. */
  const keyOf = (target: TerminalTarget): string =>
    target.by === 'start'
      ? `start ${String(target.startId)}`
      : `session ${target.storeId} ${target.sessionId}`;

  /**
   * The one place a watch is given back.
   *
   * Both ends of the connection reach it: the `session-unsubscribe` frame and
   * the socket closing. A second path that dropped subscriptions its own way
   * would be a second rule to keep in step, and the symptom would be terminals
   * that are watched forever and can never be evicted.
   *
   * It never kills anything. The detach it calls is the terminal manager's,
   * which counts a watcher off and does nothing else.
   */
  const release = (key: string): void => {
    const stream = byTarget.get(key);
    if (stream === undefined) return;
    byTarget.delete(key);
    stream.targets.delete(key);
    if (stream.targets.size > 0) return;
    stream.detach();
    streams.delete(stream.terminal.terminalId);
  };

  const attachmentOf = (
    terminal: Terminal,
    replay: readonly Uint8Array[],
    droppedBytes: number,
  ): TerminalAttachment => ({
    storeId: terminal.storeId,
    sessionId: terminal.session?.sessionId ?? null,
    startId: startIdOf(terminal.terminalId),
    droppedBytes,
    replay,
  });

  return {
    noteStart(startId: FrameId, terminalId: string): void {
      starts.set(startId, { terminalId, identified: false });
    },

    subscribe(target: TerminalTarget): AttachOutcome {
      const terminal = resolve(target);
      if (terminal === undefined) return { ok: false, problem: describe(target) };

      const key = keyOf(target);
      const existing = streams.get(terminal.terminalId);
      if (existing !== undefined) {
        // A second target on a stream that is already running joins it, and is
        // replayed what the terminal holds now. It is not a second watch: one
        // process, one subscription to it, one copy of every chunk.
        existing.targets.add(key);
        byTarget.set(key, existing);
        return {
          ok: true,
          attachment: attachmentOf(terminal, terminal.run.scrollback(), terminal.run.droppedBytes),
        };
      }

      // Read before attaching, and nothing is awaited in between, so no chunk
      // can arrive between the history and the live stream that follows it.
      const replay = terminal.run.scrollback();
      const droppedBytes = terminal.run.droppedBytes;

      const stream: Stream = {
        terminal,
        targets: new Set([key]),
        detach: () => undefined,
        droppedChunks: 0,
      };
      streams.set(terminal.terminalId, stream);
      byTarget.set(key, stream);
      stream.detach = terminal.watch((chunk) => {
        onOutput({
          storeId: terminal.storeId,
          // Read per chunk rather than captured: a spawn is named by the
          // provider while its terminal is already producing output, and the
          // frames after that point say so.
          sessionId: terminal.session?.sessionId ?? null,
          startId: startIdOf(terminal.terminalId),
          chunk,
          droppedChunks: stream.droppedChunks,
        });
      });

      logger.info('terminal subscription attached', {
        storeId: terminal.storeId,
        by: target.by,
        replayChunks: replay.length,
        droppedBytes,
      });
      return { ok: true, attachment: attachmentOf(terminal, replay, droppedBytes) };
    },

    unsubscribe(target: TerminalTarget): StreamOutcome {
      const key = keyOf(target);
      if (!byTarget.has(key)) {
        return { ok: false, problem: 'this connection is not watching that session' };
      }
      release(key);
      return { ok: true };
    },

    write(target: TerminalTarget, data: string): StreamOutcome {
      const terminal = resolve(target);
      if (terminal === undefined) return { ok: false, problem: describe(target) };
      if (terminal.run.exit !== null) {
        // Said rather than swallowed. A run drops a write after an exit, which
        // is the right thing for a keystroke that raced the process ending and
        // the wrong thing to leave a user guessing about.
        return { ok: false, problem: 'that session has ended and cannot be typed into' };
      }
      terminal.run.write(data);
      return { ok: true };
    },

    resize(target: TerminalTarget, size: TerminalSize): StreamOutcome {
      const terminal = resolve(target);
      if (terminal === undefined) return { ok: false, problem: describe(target) };
      if (terminal.run.exit !== null) {
        return { ok: false, problem: 'that session has ended and cannot be resized' };
      }
      terminal.run.resize(size.cols, size.rows);
      return { ok: true };
    },

    takeStartTags(storeId: StoreId): readonly SessionStartTag[] {
      const tags: SessionStartTag[] = [];
      for (const [startId, record] of [...starts]) {
        const terminal = terminals.terminal(record.terminalId);
        if (terminal === undefined) {
          // Evicted, or forgotten at shutdown. A handle pointing at nothing is
          // worse than no handle: it names a start that is not running here.
          starts.delete(startId);
          continue;
        }
        if (record.identified || terminal.storeId !== storeId) continue;

        const sessionId = terminal.session?.sessionId ?? null;
        tags.push({ startId, sessionId });
        // Reported with an id once, and then never again: the reader has the
        // pair it needed, and a handle local to one connection is not a name
        // to keep repeating.
        if (sessionId !== null) record.identified = true;
      }
      return tags;
    },

    detachAll(): void {
      for (const key of [...byTarget.keys()]) release(key);
    },
  };
}
