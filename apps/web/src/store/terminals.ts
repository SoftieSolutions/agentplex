import {
  decodeTerminalChunk,
  type ClientFrame,
  type ClientTerminalTarget,
  type FrameId,
  type HubFrame,
  type SessionId,
  type SessionRef,
  type StoreId,
  type SubscriptionEndReason,
  type TerminalSize,
} from '@agentplex/protocol';
import { createTerminalFeed, type TerminalFeed } from '../terminal/chunk-feed.js';
import { encodeClientFrame } from './commands.js';
import type { StoreSocket } from './connection.js';
import type { FrameIds } from './frame-ids.js';
import type { TerminalWatchView } from './views.js';

/**
 * Every terminal this client is watching: the subscriptions, the bytes, and
 * the handful of facts about them a pane has to be able to state.
 *
 * The hub store owns the socket and the one hub-frame switch; the terminal
 * frames it reads are handed here, already narrowed to their type, and what
 * this file publishes goes onto the snapshot under `terminals`.
 */

/**
 * One name for one terminal, so two frames naming it are one subscription.
 *
 * JSON and not a joined string, for the reason the session key it replaces
 * was: a store id and a session id are opaque, and a separator that can
 * appear inside one of them is a collision waiting for the store that uses
 * it. The `by` discriminator is part of the key because a start handle and a
 * session are two different things to watch, right up until the hub says
 * which session a start became — and even then the pane goes on being
 * answered under the name it asked with.
 */
export function terminalKey(target: ClientTerminalTarget): string {
  return target.by === 'start'
    ? JSON.stringify(['start', target.startId])
    : JSON.stringify(['session', target.storeId, target.sessionId]);
}

/** The same key for a session named by a frame rather than by a target. */
function sessionTerminalKey(storeId: StoreId, sessionId: SessionId): string {
  return JSON.stringify(['session', storeId, sessionId]);
}

/**
 * One watched terminal as the store holds it: the published facts, plus the
 * bookkeeping a subscription needs and a pane has no use for.
 */
interface TerminalRecord {
  readonly key: string;
  readonly target: ClientTerminalTarget;
  readonly feed: TerminalFeed;
  /** How many panes are looking. The last one leaving sends the unsubscribe. */
  watchers: number;
  attached: boolean;
  session: SessionRef | null;
  replayChunks: number;
  droppedBytes: number;
  droppedChunks: number;
  printed: boolean;
  problem: string | null;
  ended: SubscriptionEndReason | null;
  /**
   * How much this pane had already been shown when its subscription was
   * re-established, in bytes over this feed's whole life, or `null` when none
   * of that has happened.
   *
   * A position rather than a flag, because the flag has to go out again. The
   * output a replay duplicates is everything this pane held at that moment --
   * the bytes below this position -- and the feed evicts oldest first, so the
   * moment it has thrown away that much, the older copy of the repeat is gone
   * and only the replayed one is left. `feed.dropped` is the same count on the
   * same scale, which is what makes the comparison exact rather than a guess
   * at how much a replay was worth.
   */
  resumedAbove: number | null;
  /**
   * The id of the `session-subscribe` this record's subscription was asked
   * with, or `null` when there is none outstanding.
   *
   * Kept for as long as the subscription stands rather than forgotten when it
   * is first answered, because the hub answers it more than once: a machine
   * that dropped and came back is re-subscribed on this client's behalf, and
   * the fresh `session-subscribed` names the frame this pane asked with. It is
   * also what a refusal about this terminal names, which is why the entry it
   * indexes is the one place both are matched.
   */
  subscribeId: FrameId | null;
  /**
   * The last size the pane gave for this terminal, said again each time the
   * hub answers the subscription.
   *
   * A size is not a keystroke and not a command: it stays true until the next
   * one, so a reconnection that did not carry it would leave the process on
   * the far end laying its screen out against a window that is no longer
   * there.
   */
  size: TerminalSize | null;
  /** The session key this was indexed under as well, once a reply named one. */
  bound: string | null;
  /**
   * The view this record was last published as, or `null` before its first.
   *
   * Handed out again whenever nothing it states has moved, so a pane reading
   * one terminal is not re-rendered because another printed.
   */
  view: TerminalWatchView | null;
}

/**
 * Whether two views state the same facts.
 *
 * Every field by identity except `session`, which a reply restates as a fresh
 * object naming the same session; a session is its two names.
 */
function sameView(a: TerminalWatchView, b: TerminalWatchView): boolean {
  return (
    a.target === b.target &&
    a.feed === b.feed &&
    a.attached === b.attached &&
    sameSession(a.session, b.session) &&
    a.replayChunks === b.replayChunks &&
    a.droppedBytes === b.droppedBytes &&
    a.droppedChunks === b.droppedChunks &&
    a.evicted === b.evicted &&
    a.printed === b.printed &&
    a.problem === b.problem &&
    a.ended === b.ended &&
    a.resumed === b.resumed
  );
}

function sameSession(a: SessionRef | null, b: SessionRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.storeId === b.storeId && a.sessionId === b.sessionId;
}

/** What a terminal frame this client sent is waiting to be told about. */
type TerminalAsk = 'subscribe' | 'unsubscribe' | 'input' | 'resize';

type Frame<T extends HubFrame['type']> = Extract<HubFrame, { type: T }>;

export interface TerminalsDependencies {
  /** The socket, while the connection is established; `null` otherwise. */
  live(): StoreSocket | null;
  readonly frameIds: FrameIds;
  /** How big one watched terminal's buffer may get, in bytes. */
  readonly feedBytes: number;
  /** The terminal facts changed; this is every one of them, whole. */
  publish(terminals: ReadonlyMap<string, TerminalWatchView>): void;
}

export interface Terminals {
  /** Standing interest in one terminal; the returned function gives it back. */
  watch(target: ClientTerminalTarget): () => void;
  /** Puts a keystroke on the wire; `false` when there was nothing to send it on. */
  input(target: ClientTerminalTarget, data: string): boolean;
  /** Remembers the viewer's size, and sends it while attached. */
  resize(target: ClientTerminalTarget, size: TerminalSize): void;
  /** Asks again for every terminal, on a fresh connection. */
  resubscribe(): void;
  /** Asks again for a terminal refused by start handle, now that the start is answered. */
  retryByStart(startId: FrameId): void;
  /** The connection is gone: every watch is standing interest again. */
  detach(): void;
  subscribed(frame: Frame<'session-subscribed'>): void;
  unsubscribed(frame: Frame<'session-unsubscribed'>): void;
  ended(frame: Frame<'session-subscription-ended'>): void;
  output(frame: Frame<'terminal-output'>): void;
  /**
   * A refusal, if it is about a terminal frame this client sent: said on the
   * pane, and answered `true`. `false` means it is somebody else's to file.
   */
  refused(frame: Frame<'refusal'>): boolean;
}

export function createTerminals(dependencies: TerminalsDependencies): Terminals {
  const { frameIds, feedBytes } = dependencies;

  /** Every watched terminal, by the key of the target the pane named. */
  const terminals = new Map<string, TerminalRecord>();
  /**
   * Start-addressed records, indexed again by the session they turned out to
   * be, so output carrying only a session id still finds them.
   *
   * A second index rather than a re-keyed map, because both names stay true:
   * the hub goes on stamping this client's own start handle on every frame
   * for that watch, and the pane goes on being answered under the name it
   * asked with. The hub's relay keeps the same two names for the same reason.
   */
  const rebound = new Map<string, Set<TerminalRecord>>();
  /** Terminal frames this client sent, by the id a refusal would name. */
  const terminalReplies = new Map<FrameId, { readonly key: string; readonly ask: TerminalAsk }>();

  /**
   * Whether both copies of a re-established feed are still in this pane's
   * buffer. Read where it is published rather than stored, because what moves
   * it is the feed evicting, which is not an event this store hears about.
   */
  function stillRepeating(record: TerminalRecord): boolean {
    return record.resumedAbove !== null && record.feed.dropped < record.resumedAbove;
  }

  /**
   * Publishes the terminal facts, and nothing else.
   *
   * Called only when one of them actually changed. A chunk arriving is not
   * one of them: bytes go to the feed, and the pane's emulator reads them
   * from there without React ever hearing about it.
   *
   * A terminal whose facts did not move is published as the object it was
   * last time, so one pane's first byte is not every other pane's re-render.
   * Each view is built and compared rather than tracked with a dirty flag
   * set at every mutation: two of its facts -- `evicted` and `resumed` -- move
   * when the feed evicts, which is not an event this store hears, and a flag
   * one mutation site forgot would publish a stale fact rather than an extra
   * render.
   */
  function publishTerminals(): void {
    const views = new Map<string, TerminalWatchView>();
    for (const [key, record] of terminals) {
      const view: TerminalWatchView = {
        target: record.target,
        feed: record.feed,
        attached: record.attached,
        session: record.session,
        replayChunks: record.replayChunks,
        droppedBytes: record.droppedBytes,
        droppedChunks: record.droppedChunks,
        evicted: record.feed.truncated,
        printed: record.printed,
        problem: record.problem,
        ended: record.ended,
        resumed: stillRepeating(record),
      };
      if (record.view === null || !sameView(record.view, view)) record.view = view;
      views.set(key, record.view);
    }
    dependencies.publish(views);
  }

  /**
   * Puts one terminal frame on the wire and remembers what it was, so that a
   * refusal reaches the pane that asked rather than the screen-wide "the hub
   * said no" that every other command shares.
   *
   * Answered with the id, or `null` when there was nothing to send it on.
   */
  function sendTerminalFrame(
    ask: TerminalAsk,
    key: string,
    build: (id: FrameId) => ClientFrame,
  ): FrameId | null {
    const wire = dependencies.live();
    if (wire === null) return null;
    const id = frameIds.next();
    terminalReplies.set(id, { key, ask });
    wire.send(encodeClientFrame(build(id)));
    return id;
  }

  /**
   * Asks for one terminal. The size the viewer has waits for the answer: a
   * resize for a terminal this connection is not yet watching is a frame the
   * hub can only refuse, and `session-subscribed` is where it goes out.
   */
  function subscribeTerminal(record: TerminalRecord): void {
    record.subscribeId = sendTerminalFrame('subscribe', record.key, (id) => ({
      type: 'session-subscribe',
      id,
      target: record.target,
    }));
  }

  /** Every terminal a chunk belongs to, each once however many names found it. */
  function recipientsOf(
    storeId: StoreId,
    sessionId: SessionId | null,
    startId: FrameId | null,
  ): Set<TerminalRecord> {
    const matched = new Set<TerminalRecord>();
    if (startId !== null) {
      const byStart = terminals.get(terminalKey({ by: 'start', startId }));
      if (byStart !== undefined) matched.add(byStart);
    }
    if (sessionId !== null) {
      const key = sessionTerminalKey(storeId, sessionId);
      const bySession = terminals.get(key);
      if (bySession !== undefined) matched.add(bySession);
      for (const record of rebound.get(key) ?? []) matched.add(record);
    }
    return matched;
  }

  /**
   * Asks again for a terminal this connection was refused by start handle.
   *
   * The race this exists for is real and is not the hub's fault: a pane opens
   * in the click that sends the start, so its subscribe can arrive while the
   * hub is still waiting for a machine to fork the process, and a handle the
   * hub has not recorded yet is a handle it must refuse -- "this connection
   * did not start that session" is the right answer to a handle that is not
   * there, and would be the wrong answer to hold open.
   *
   * So the client asks again on the one frame that says the handle now exists.
   * Only a record that is not attached, because a subscription that was
   * answered needs nothing, and a second subscribe to a terminal this
   * connection is already watching is refused by the hub on purpose.
   *
   * And only when nothing is outstanding, which is the same rule read for the
   * other order the race can come out in. The hub may read the first subscribe
   * *after* it sends this reply, in which case that subscribe is about to
   * succeed and this connection is not attached yet -- so a retry here would
   * be the second subscribe the hub refuses as a duplicate, and the pane would
   * carry "the hub said no" for the rest of its life beside a terminal that is
   * working perfectly. A subscribe with no answer yet is a subscribe that may
   * still be answered; there is nothing to ask again for.
   */
  function retrySubscribeByStart(startId: FrameId): void {
    const key = terminalKey({ by: 'start', startId });
    const record = terminals.get(key);
    if (record === undefined || record.attached) return;
    for (const asked of terminalReplies.values()) {
      if (asked.key === key && asked.ask === 'subscribe') return;
    }
    // The refusal that sent the pane here is answered rather than left on
    // screen beside a terminal that is about to work.
    record.problem = null;
    publishTerminals();
    subscribeTerminal(record);
  }

  /** Forgets the second name a start-addressed record was given. */
  function unbind(record: TerminalRecord): void {
    if (record.bound === null) return;
    const held = rebound.get(record.bound);
    held?.delete(record);
    if (held?.size === 0) rebound.delete(record.bound);
    record.bound = null;
  }

  /**
   * A start-addressed record learns which session it turned out to be.
   *
   * The moment a pending pane becomes a session's pane. The record keeps its
   * start-addressed key -- the hub still answers to it -- and gains a second
   * name, so a chunk carrying only the session id reaches it too.
   *
   * Taken off the hub's own frames rather than guessed from what arrived
   * around the same time: a spawn and a scan racing is exactly the case where
   * guessing by timing attaches a pane to somebody else's agent. Two frames
   * can carry the answer and both are read, because which of them arrives
   * first is not this store's to decide. The subscription's reply carries it
   * when the provider had already named the session; for the spawn this whole
   * path exists for it has not, and the first frame that can say so is a chunk
   * of output carrying both names -- which is the server's reading of its own
   * store report, relayed down the terminal path rather than inferred here.
   *
   * Answers whether anything changed, so the output path does not publish a
   * snapshot per chunk.
   */
  function nameStart(record: TerminalRecord, storeId: StoreId, sessionId: SessionId): boolean {
    if (record.target.by !== 'start' || record.session !== null) return false;
    record.session = { storeId, sessionId };
    unbind(record);
    const key = sessionTerminalKey(storeId, sessionId);
    record.bound = key;
    const held = rebound.get(key) ?? new Set<TerminalRecord>();
    held.add(record);
    rebound.set(key, held);
    return true;
  }

  return {
    watch(target: ClientTerminalTarget): () => void {
      const key = terminalKey(target);
      const existing = terminals.get(key);
      if (existing !== undefined) {
        // One subscription per target, however many panes. The hub refuses a
        // second subscribe to one terminal from one connection -- a second
        // asks for a second replay -- so the right answer for a second pane
        // is the buffer the first one filled.
        existing.watchers += 1;
      } else {
        const record: TerminalRecord = {
          key,
          target,
          feed: createTerminalFeed({ maxBytes: feedBytes }),
          watchers: 1,
          attached: false,
          session:
            target.by === 'session'
              ? { storeId: target.storeId, sessionId: target.sessionId }
              : null,
          replayChunks: 0,
          droppedBytes: 0,
          droppedChunks: 0,
          printed: false,
          problem: null,
          ended: null,
          resumedAbove: null,
          subscribeId: null,
          size: null,
          bound: null,
          view: null,
        };
        terminals.set(key, record);
        // New interest on a live connection is sent now; on a dead one it is
        // not queued — the replay on the next welcome is what carries it.
        subscribeTerminal(record);
        publishTerminals();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const record = terminals.get(key);
        if (record === undefined) return;
        record.watchers -= 1;
        if (record.watchers > 0) return;
        terminals.delete(key);
        unbind(record);
        // The standing interest is over, so the id that named it names nothing.
        if (record.subscribeId !== null) terminalReplies.delete(record.subscribeId);
        // The partner of the subscribe, and the whole difference between
        // closing a tab and killing an agent: the count this gives back is
        // the one the server evicts terminals by, and detaching closes
        // nothing.
        sendTerminalFrame('unsubscribe', key, (id) => ({
          type: 'session-unsubscribe',
          id,
          target,
        }));
        publishTerminals();
      };
    },

    input(target: ClientTerminalTarget, data: string): boolean {
      // Answered only when it fails, which is the wire's rule and this
      // one's: a terminal acknowledges input by echoing it, so `delivered`
      // means it went out. A write that could not be made still comes back,
      // as a refusal naming this frame, and lands on the pane.
      const sent = sendTerminalFrame('input', terminalKey(target), (id) => ({
        type: 'terminal-input',
        id,
        target,
        data,
      }));
      return sent !== null;
    },

    resize(target: ClientTerminalTarget, size: TerminalSize): void {
      const key = terminalKey(target);
      // A target nothing watches has no subscription for the hub to route a
      // resize to, and no record to remember it on: nothing to do. No pane
      // lands here, since a pane mounts its terminal only once it watches.
      const record = terminals.get(key);
      if (record === undefined) return;
      // Remembered whether or not it can be sent: the size is what the pane
      // currently is, and the next `session-subscribed` -- this connection's
      // first, or the one after a redial -- is when the far end hears it.
      record.size = size;
      if (!record.attached) return;
      sendTerminalFrame('resize', key, (id) => ({
        type: 'terminal-resize',
        id,
        target,
        size,
      }));
    },

    resubscribe(): void {
      for (const record of terminals.values()) subscribeTerminal(record);
    },

    retryByStart: retrySubscribeByStart,

    /**
     * The connection is gone: every watch is standing interest again rather
     * than an attachment.
     *
     * The records survive, because the panes do — a subscription is interest
     * and not a request, and the next welcome replays it. What does not survive
     * is everything that was true of *that* connection: nothing is attached to
     * a socket that is closed, `droppedChunks` counts one link's losses and the
     * link is gone, and a refusal the last connection gave is not a fact about
     * the next one. The buffered bytes stay: they are what the emulator is
     * showing, and a pane does not go blank because a socket did.
     */
    detach(): void {
      terminalReplies.clear();
      if (terminals.size === 0) return;
      for (const record of terminals.values()) {
        record.attached = false;
        record.droppedChunks = 0;
        record.problem = null;
        // Why a subscription ended is a fact about the connection that carried
        // it, and that connection is gone: what a pane shows now is the store's
        // own phase, which says the hub itself is unreachable.
        record.ended = null;
        record.subscribeId = null;
      }
      publishTerminals();
    },

    subscribed(frame: Frame<'session-subscribed'>): void {
      const asked = terminalReplies.get(frame.replyTo);
      // Not deleted, unlike every other correlation here. This one names a
      // standing interest rather than a question: the hub subscribes again
      // on this pane's behalf when the machine holding the session comes
      // back, and answers that under the id this pane asked with. Dropping
      // the entry on the first reply would leave the second one -- the one
      // that says how much history is being replayed into a pane with a gap
      // in it -- matching nothing.
      const record = asked === undefined ? undefined : terminals.get(asked.key);
      if (record === undefined) return;

      // A reply to a subscription that was interrupted, rather than the
      // first one. What follows it is the machine's scrollback as it stands
      // now, written after bytes this pane already has -- so what is already
      // here is what the replay is about to say again.
      if (record.printed) record.resumedAbove = record.feed.dropped + record.feed.bytes;
      record.attached = true;
      // The size the pane last reported, said now and by the store: the
      // pane's pacer never reports a size twice, so a size it gave before
      // this answer -- or before a machine coming back re-answered it --
      // reaches the far end here or not at all.
      const size = record.size;
      if (size !== null) {
        sendTerminalFrame('resize', record.key, (id) => ({
          type: 'terminal-resize',
          id,
          target: record.target,
          size,
        }));
      }
      record.ended = null;
      record.problem = null;
      record.replayChunks = frame.replayChunks;
      record.droppedBytes = frame.droppedBytes;
      if (record.target.by === 'start') {
        // A subscription by start handle, answered by a hub that already
        // knows the session: `nameStart` is where a pending record stops
        // being pending, whichever frame brings the news.
        if (frame.sessionId !== null) nameStart(record, frame.storeId, frame.sessionId);
      } else {
        record.session =
          frame.sessionId === null ? null : { storeId: frame.storeId, sessionId: frame.sessionId };
      }
      publishTerminals();
    },

    unsubscribed(frame: Frame<'session-unsubscribed'>): void {
      // The books were closed when the last pane left; this says the hub
      // agrees. Nothing to publish: a pane that is gone has no notice to
      // show, and one still here never asked for this.
      terminalReplies.delete(frame.replyTo);
    },

    ended(frame: Frame<'session-subscription-ended'>): void {
      // Addressed by the target this pane asked with, which is the name it
      // is keyed by here -- including the start handle of a spawn nobody has
      // named yet, which no frame addressed by session id could reach.
      const record = terminals.get(terminalKey(frame.target));
      if (record === undefined) return;

      record.attached = false;
      record.ended = frame.reason;
      // The bytes stay. They are what the emulator has painted, and a pane
      // whose feed stopped is still showing the last of a session rather
      // than nothing.
      if (frame.reason === 'session-ended' && record.subscribeId !== null) {
        // The hub has given this subscription back: there is no terminal on
        // the other end to re-attach to, so the id it was asked with will
        // never name another frame.
        terminalReplies.delete(record.subscribeId);
        record.subscribeId = null;
      }
      publishTerminals();
    },

    output(frame: Frame<'terminal-output'>): void {
      const chunk = decodeTerminalChunk(frame.chunk);
      for (const record of recipientsOf(frame.storeId, frame.sessionId, frame.startId)) {
        const evicted = record.feed.truncated;
        const repeating = stillRepeating(record);
        record.feed.push(chunk);
        // The frame that names a spawn, in the ordinary case. A subscription
        // made before the provider wrote its session id was answered with a
        // `null` one, and output is what carries the answer afterwards: the
        // server puts the session on every chunk from the moment it binds
        // the terminal to it.
        const named =
          frame.sessionId === null ? false : nameStart(record, frame.storeId, frame.sessionId);
        // Only the facts, and only when one of them moved. The bytes went
        // to the feed above and the emulator has them already; publishing
        // per chunk would re-render the app at the speed the agent prints.
        const changed =
          named ||
          !record.printed ||
          record.droppedChunks !== frame.droppedChunks ||
          evicted !== record.feed.truncated ||
          // This chunk may have pushed the older copy of a repeat out of the
          // buffer, which is a fact about the label and moves nothing else.
          repeating !== stillRepeating(record);
        record.printed = true;
        // Cumulative and only ever increasing, so the newest frame is the
        // whole count; a reader comparing it with the last one it saw gets
        // the size of the gap.
        record.droppedChunks = frame.droppedChunks;
        if (changed) publishTerminals();
      }
    },

    refused(frame: Frame<'refusal'>): boolean {
      const asked = terminalReplies.get(frame.replyTo);
      if (asked === undefined) return false;
      terminalReplies.delete(frame.replyTo);
      const record = terminals.get(asked.key);
      if (record === undefined) return true;
      // Said on the pane rather than in the screen-wide refusal: this is
      // a no about one terminal, and the user is looking at it. A blank
      // rectangle and a machine that is asleep draw the same thing.
      record.problem = frame.message;
      if (asked.ask === 'subscribe') {
        record.attached = false;
        record.subscribeId = null;
      }
      publishTerminals();
      return true;
    },
  };
}
