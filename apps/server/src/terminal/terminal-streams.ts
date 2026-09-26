import type {
  ServerTerminalTarget,
  SessionId,
  SessionStartTag,
  StartId,
  StoreId,
  TerminalSize,
} from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import type { GrantId } from '@agentplex/providers';
import type { Terminal, TerminalManager, TerminalStart, WatcherId } from './terminal-manager.js';

/**
 * One hub connection's standing interest in this server's terminals.
 *
 * The terminals themselves outlive every connection -- a socket comes and
 * goes, and the agents this server forked go on running across both -- so what
 * belongs to a connection is exactly this: which terminals it is watching,
 * and the detaches it owes back.
 *
 * The starts are not among them, and that is the change this file no longer
 * makes. A start tag used to be the id of the `session-start` frame on this
 * socket, which meant a hub that dropped between forking a spawn and the
 * provider naming it came back to a terminal it had started and could no
 * longer address. The tag is the hub's own `StartId` now and it lives on the
 * terminal manager; what is left here is per connection because it genuinely
 * is -- which of that grant's starts this socket has already been told the
 * session id for.
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
  /** The start the asking hub made, if it made one, and `null` otherwise. */
  readonly startId: StartId | null;
  readonly chunk: Uint8Array;
  /**
   * Chunks this stream threw away before this one, over the life of the stream.
   *
   * Counted here rather than at the socket because it belongs to a stream and
   * not to a connection's whole output: two terminals on one congested socket
   * lose different amounts, and a single number over the socket could not tell
   * a pane which of them was missing anything.
   */
  readonly droppedChunks: number;
}

/**
 * Whether a chunk went out, or was thrown away because the connection is behind.
 *
 * The answer comes back from the sink rather than being decided here, because
 * only the thing holding the socket knows whether the socket is keeping up --
 * and only this knows which stream to charge the loss to. So the sink decides
 * and this counts, which is one rule in each of the two places that can state
 * it, rather than a socket reaching into a subscription or a subscription
 * reaching into a socket.
 */
export type TerminalDelivery = 'sent' | 'dropped';

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
  readonly startId: StartId | null;
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
  /**
   * Who every watch taken here is counted against: this connection.
   *
   * The manager counts watchers by name rather than by handle so that a socket
   * that died without detaching can still be swept -- `release` takes one
   * connection off every terminal at once. `detachAll` below is the orderly
   * path and this is the name the disorderly one needs, and they agree because
   * both are this one id.
   */
  readonly watcher: WatcherId;
  /**
   * The grant this connection authenticated with, or `null` before it has.
   *
   * A function rather than a value because the grant is resolved by the
   * handshake and this is built before it, on a socket that has proved nothing
   * yet. Nothing that reads it is reachable until the connection is
   * established, so `null` is a state no start ever observes -- and answering
   * it as "this grant has no such start" rather than throwing keeps that true
   * even if some later frame path forgets to check the state first.
   *
   * It is what scopes every start here: a start id is minted by one hub and
   * means nothing to another, so a connection may only name, and may only be
   * told about, the starts made under its own grant.
   */
  readonly grant: () => GrantId | null;
  /**
   * Where a chunk goes. The connection turns it into a frame; this does not.
   *
   * Answers whether it actually went, because a sink that cannot say so leaves
   * the only honest alternatives as queueing without a bound -- which is the
   * denial of service this answers -- or dropping without telling anyone,
   * and a terminal that silently omits output looks exactly like a session
   * that produced none.
   */
  onOutput(output: TerminalOutput): TerminalDelivery;
  readonly logger: Logger;
}

export interface TerminalStreams {
  /**
   * Records that a start this connection carried produced a terminal.
   *
   * The handle is the hub's, not this socket's, so the record goes to the
   * terminal manager and is found again by the next connection this grant
   * makes. This is the call, and the grant it is filed under is this
   * connection's.
   */
  noteStart(startId: StartId, terminalId: string): void;
  subscribe(target: ServerTerminalTarget): AttachOutcome;
  unsubscribe(target: ServerTerminalTarget): StreamOutcome;
  write(target: ServerTerminalTarget, data: string): StreamOutcome;
  resize(target: ServerTerminalTarget, size: TerminalSize): StreamOutcome;
  /**
   * The start provenance to put in this store's next report, and the taking is
   * the point: a start is reported to this connection until it has been
   * reported with the session id the provider wrote, and not one report longer.
   *
   * Per connection rather than per start, which is what a tag on the terminal
   * manager makes possible and what a reconnecting hub needs: the start itself
   * is still held, so the next connection this grant makes is told about it
   * again -- once, with whatever name the session has by then -- rather than
   * finding a spawn it started and cannot address.
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

export function createTerminalStreams({
  terminals,
  watcher,
  grant,
  onOutput,
  logger,
}: TerminalStreamsDependencies): TerminalStreams {
  const streams = new Map<string, Stream>();
  /** The same streams, by the target that asked, so a detach needs no lookup. */
  const byTarget = new Map<string, Stream>();
  /** Starts this connection has already been sent with a session id on them. */
  const identified = new Set<StartId>();

  /** This grant's starts, as the manager holds them. Empty before the handshake. */
  const starts = (): readonly TerminalStart[] => {
    const grantId = grant();
    return grantId === null ? [] : terminals.starts(grantId);
  };

  const startIdOf = (terminalId: string): StartId | null =>
    starts().find((start) => start.terminalId === terminalId)?.startId ?? null;

  /**
   * The terminal a frame is about, or nothing.
   *
   * A session resolves to the live terminal holding it when there is one, and
   * otherwise to a terminal whose process has ended: the session somebody most
   * wants to read is frequently the one that just stopped, and its bytes are
   * here rather than in the transcript.
   */
  const resolve = (target: ServerTerminalTarget): Terminal | undefined => {
    if (target.by === 'start') {
      const start = starts().find((held) => held.startId === target.startId);
      return start === undefined ? undefined : terminals.terminal(start.terminalId);
    }
    const held = terminals.terminals.filter(
      (terminal) =>
        terminal.storeId === target.storeId && terminal.session?.sessionId === target.sessionId,
    );
    return held.find((terminal) => terminal.run.exit === null) ?? held[0];
  };

  const describe = (target: ServerTerminalTarget): string =>
    target.by === 'start'
      ? `this server has no terminal for start ${target.startId}`
      : `this server is not running session ${target.sessionId}`;

  /** A target's name, so two frames naming one thing count as one subscriber. */
  const keyOf = (target: ServerTerminalTarget): string =>
    target.by === 'start'
      ? `start ${target.startId}`
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
    noteStart(startId: StartId, terminalId: string): void {
      const grantId = grant();
      // Unreachable while a start can only arrive on an established
      // connection, and refused rather than asserted because the alternative
      // is a tag filed under nobody.
      if (grantId === null) {
        logger.warn('a start arrived before this connection had a grant', { terminalId });
        return;
      }
      terminals.noteStart(terminalId, startId, grantId);
    },

    subscribe(target: ServerTerminalTarget): AttachOutcome {
      const terminal = resolve(target);
      if (terminal === undefined) return { ok: false, problem: describe(target) };

      const key = keyOf(target);
      // A session target outlives its terminal: once the agent exits and the
      // session is resumed, the same key resolves to a new one. The old watch
      // is given back first, or the exited terminal stays watched and the cap
      // can never evict it. Kept to a moved target so a repeat subscribe to
      // the same terminal does not re-watch it and reset its dropped count.
      const previous = byTarget.get(key);
      if (previous !== undefined && previous.terminal.terminalId !== terminal.terminalId) {
        release(key);
      }
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
      stream.detach = terminal.watch(watcher, (chunk) => {
        const delivery = onOutput({
          storeId: terminal.storeId,
          // Read per chunk rather than captured: a spawn is named by the
          // provider while its terminal is already producing output, and the
          // frames after that point say so.
          sessionId: terminal.session?.sessionId ?? null,
          startId: startIdOf(terminal.terminalId),
          chunk,
          // The count as it stood before this chunk, so a reader comparing it
          // with the last one it saw learns of a gap that opened between them.
          droppedChunks: stream.droppedChunks,
        });
        // Counted after the attempt, so the chunk that is dropped is the one
        // reported on the next chunk that gets through rather than on itself.
        // The terminal goes on running and the scrollback goes on filling
        // either way: nothing here slows a child down, which is the whole
        // reason this is a count and not a pause.
        if (delivery === 'dropped') stream.droppedChunks += 1;
      });

      logger.info('terminal subscription attached', {
        storeId: terminal.storeId,
        by: target.by,
        replayChunks: replay.length,
        droppedBytes,
      });
      return { ok: true, attachment: attachmentOf(terminal, replay, droppedBytes) };
    },

    unsubscribe(target: ServerTerminalTarget): StreamOutcome {
      const key = keyOf(target);
      if (!byTarget.has(key)) {
        return { ok: false, problem: 'this connection is not watching that session' };
      }
      release(key);
      return { ok: true };
    },

    write(target: ServerTerminalTarget, data: string): StreamOutcome {
      const terminal = resolve(target);
      if (terminal === undefined) return { ok: false, problem: describe(target) };
      if (terminal.run.exit !== null) {
        // Said rather than swallowed. A run drops a write after an exit, which
        // is the right thing for a keystroke that raced the process ending and
        // the wrong thing to leave a user guessing about.
        return { ok: false, problem: 'that session has ended and cannot be typed into' };
      }
      if (terminal.pause === 'paused') {
        // The whole of a pause on this machine. Only `paused` withholds the
        // keyboard: while a pause is merely requested the turn is still
        // running and typing is the one control the user has left over it.
        return { ok: false, problem: 'that session is paused; resume it to type into it' };
      }
      terminal.run.write(data);
      return { ok: true };
    },

    resize(target: ServerTerminalTarget, size: TerminalSize): StreamOutcome {
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
      for (const { startId, terminalId } of starts()) {
        // The manager forgets a start when it closes the terminal it named, so
        // this cannot be undefined. Skipped rather than asserted because the
        // cost of being wrong is a report with one tag missing, and the cost of
        // asserting is a store report nobody gets.
        const terminal = terminals.terminal(terminalId);
        if (terminal === undefined) continue;
        if (identified.has(startId) || terminal.storeId !== storeId) continue;

        const sessionId = terminal.session?.sessionId ?? null;
        tags.push({ startId, sessionId });
        // Reported to this connection with an id once, and then never again:
        // this reader has the pair it needed. The start itself stays on the
        // manager, so the next connection this grant makes is told once too.
        if (sessionId !== null) identified.add(startId);
      }
      return tags;
    },

    detachAll(): void {
      for (const key of [...byTarget.keys()]) release(key);
    },
  };
}
