import type {
  ClientTerminalTarget,
  FrameId,
  HubFrame,
  ServerRegistrationId,
  ServerTerminalTarget,
  SessionId,
  SessionStartTag,
  StartId,
  StoreId,
  TerminalSize,
} from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import type { HubStateSnapshot } from '../fleet-state/fleet-state.js';
import type { StreamInstruction, StreamOutcome, TerminalOutputFrame } from '../servers/servers.js';
import { routeTerminal } from './target-routing.js';

/**
 * The middle of the terminal path: server to the clients watching, and
 * keystrokes back.
 *
 * A relay and deliberately nothing more. It does not parse terminal bytes, does
 * not store them and does not interpret them. The `chunk` a server sends is the
 * characters a client receives, the same string, because terminal output is
 * opaque: a session drawing a box or printing an emoji is a byte sequence that
 * only an emulator can read, and anything between the pty and the browser that
 * decoded it would have to re-encode it, which is where the half code points
 * and the broken box edges come from. So the bytes are never touched here --
 * `terminal.ts` in the protocol says why they travel as base64 at all, and this
 * file's whole contribution to that argument is to do nothing with them.
 *
 * ## What is actually held here
 *
 * Two sets that look symmetrical and are not. A **watch** is one client's
 * standing interest in one terminal; an **upstream** is the hub's own
 * subscription to the server holding it, and there is one of those per (server,
 * target) however many clients are watching. The bytes cross the server leg
 * once and are fanned out here, for the reason the server fans one terminal out
 * to two of its own subscriptions: a copy per viewer would multiply the busiest
 * path on the wire by the number of open tabs.
 *
 * The server solves its half of this in `terminal-streams.ts`, and its answer
 * is not this one. It counts watchers against terminals it owns, to decide what
 * to evict; the hub counts clients against subscriptions it is borrowing, to
 * decide when to give one back. The rule both share is the one that costs
 * something to get wrong: **a socket closing is a detach**, and it is the same
 * detach the frame takes. A client that disappears without unsubscribing would
 * otherwise leave an upstream watched forever, and the server's eviction rule
 * would be choosing between terminals that all claim to have an audience.
 *
 * ## The gap a start handle fills, twice
 *
 * A spawn has no session id until the provider writes one, so a pane opened on
 * a fresh start has to be addressable by the start instead. There are two names
 * for one start -- the client's own `session-start` frame id, and the `StartId`
 * the hub minted for the server -- and this is the only place that knows both.
 * The map from one to the other is written when a client's start succeeds, read
 * when that client subscribes, and dies with the socket, because a client's
 * handle means nothing on any other connection.
 *
 * When the provider finally names the session, the server says so in its next
 * store report, and the upstream is re-keyed here so that output carrying the
 * session id still reaches the pane that asked by the start. Exact, off the
 * report, rather than guessed from what appeared around the same time: a spawn
 * and a scan racing is precisely the case where guessing by timing attaches a
 * pane to somebody else's agent.
 */

/**
 * How much a client socket may be behind before this starts throwing its chunks
 * away.
 *
 * The server's rule, adopted rather than re-argued: `MAX_BUFFERED_OUTPUT_BYTES`
 * in `hub-connection.ts` carries the whole of it -- why a slow reader is
 * dropped rather than queued, why the pty is never paused for one, and why
 * whole chunks and never part of one. The same number for the same reason, and
 * per client socket because congestion is per link: one viewer on a phone must
 * not cost another viewer of the same session a single byte.
 *
 * What differs is only where the loss is charged. The server counts per stream
 * per connection, and so does this, which means a client watching two sessions
 * over one wedged socket is told which of the two is missing output.
 */
export const MAX_BUFFERED_CLIENT_BYTES = 1024 * 1024;

/**
 * One client socket, as the relay sees it.
 *
 * Two members, and the second is the one that could not be left out: `send`
 * cannot fail and cannot block, so without a reading of how far behind the
 * socket is, the only available behaviour for a stream nobody is reading is to
 * queue it all. `MessageSocket` says the rest.
 *
 * An interface rather than the socket itself because the relay has no business
 * closing a client, reading its frames, or knowing it authenticated: what it
 * may do is put a frame on one and ask whether it is keeping up.
 */
export interface TerminalClient {
  send(frame: HubFrame): void;
  readonly bufferedBytes: number;
}

/** One start this hub made, as the client that asked for it can name it. */
export interface ClientStart {
  readonly registrationId: ServerRegistrationId;
  /** The name the hub minted and the server knows the start by. */
  readonly startId: StartId;
  readonly storeId: StoreId;
}

export interface TerminalDependencies {
  /** The state a target is resolved against, read per frame. */
  readonly state: { snapshot(): HubStateSnapshot };
  /**
   * How a terminal frame reaches one paired server.
   *
   * Narrow on purpose: the relay may put a terminal frame to a machine and may
   * not start anything, stop anything, or ask which machines exist. The seam
   * answers where the reply is read rather than on a promise -- see
   * `servers.ts` for why a microtask would reorder a terminal.
   */
  readonly servers: {
    stream(
      registrationId: ServerRegistrationId,
      frame: StreamInstruction,
      answer: (outcome: StreamOutcome) => void,
    ): void;
  };
  readonly logger: Logger;
}

export interface Terminal {
  /**
   * A client asks to watch a terminal, by session or by its own start handle.
   *
   * Answered with `session-subscribed` and then the history the server
   * replayed, in order, before anything live -- which is the order the server
   * wrote them in, kept.
   */
  subscribe(client: TerminalClient, replyTo: FrameId, target: ClientTerminalTarget): void;
  /** A client gives a watch back. The terminal is untouched: detaching closes nothing. */
  unsubscribe(client: TerminalClient, replyTo: FrameId, target: ClientTerminalTarget): void;
  /** Keystrokes for a terminal. Silent on success, refused when they go nowhere. */
  input(client: TerminalClient, replyTo: FrameId, target: ClientTerminalTarget, data: string): void;
  /** The viewer's size. Silent on success, like the input beside it. */
  resize(
    client: TerminalClient,
    replyTo: FrameId,
    target: ClientTerminalTarget,
    size: TerminalSize,
  ): void;
  /**
   * A client's start succeeded: remember what this hub called it.
   *
   * The one writer of the client-handle map. It is written here rather than by
   * the sessions feature because the handle is the asking socket's and means
   * nothing off it -- a registry of everybody's handles would be a second thing
   * that has to be told when a socket goes away.
   */
  noteStart(client: TerminalClient, handle: FrameId, start: ClientStart): void;
  /**
   * A server said which of this hub's starts became which session.
   *
   * Off the store report's `starts`, which is the only exact answer there is,
   * and the moment a pending pane stops being pending.
   */
  noteStarts(
    registrationId: ServerRegistrationId,
    storeId: StoreId,
    starts: readonly SessionStartTag[],
  ): void;
  /** A chunk of output from a server, on its way to whoever is watching. */
  deliver(registrationId: ServerRegistrationId, output: TerminalOutputFrame): void;
  /** The socket went away. Every watch it held is given back and its starts forgotten. */
  forget(client: TerminalClient): void;
}

/** The hub's own subscription to one terminal on one server. */
interface Upstream {
  readonly key: string;
  readonly registrationId: ServerRegistrationId;
  /** How the server leg addresses it. Fixed: a subscription is re-keyed, never re-aimed. */
  readonly target: ServerTerminalTarget;
  readonly watches: Set<Watch>;
  /**
   * History still on its way, oldest first.
   *
   * A subscription's replay travels on the same frame live output does, so the
   * only thing that says which frames are history is the count on the reply
   * that precedes them. Each entry claims that many of the next chunks for the
   * one watch that asked -- without it, a second viewer joining a session would
   * replay its whole scrollback into the first viewer's pane as if the agent
   * had just printed it again.
   */
  readonly replays: Replay[];
  /** The session key this was re-keyed under, once a report named one. */
  bound: string | null;
}

interface Replay {
  /** `null` when the client went away mid-replay: the frames are swallowed. */
  readonly watch: Watch | null;
  remaining: number;
}

/** One client's standing interest in one terminal. */
interface Watch {
  readonly client: TerminalClient;
  /** The target as the client named it, which is what an unsubscribe names too. */
  readonly clientKey: string;
  readonly upstream: Upstream;
  /**
   * The client's own start handle, on every frame this watch produces.
   *
   * The protocol answers a subscription with both names, and this is the half
   * only the hub can supply: the client's handle for a start it made. `null`
   * for a pane watching a session this client did not start, which is most of
   * them.
   */
  readonly clientStartId: FrameId | null;
  /** Chunks thrown away on the hub-to-client leg for this watch alone. */
  dropped: number;
  /** Set when the client has been sent its reply. Nothing live reaches it before. */
  attached: boolean;
  released: boolean;
}

export function createTerminal(dependencies: TerminalDependencies): Terminal {
  const { state, servers } = dependencies;
  const logger = dependencies.logger.child({ part: 'terminal' });

  const upstreams = new Map<string, Upstream>();
  /**
   * Start-addressed upstreams, indexed again by the session they turned out to
   * be, so that output carrying only a session id still finds them.
   *
   * A second index rather than a re-keyed map, because both names stay true:
   * the server goes on reporting the start, and a pane that asked by the start
   * goes on being answered under it.
   */
  const rebound = new Map<string, Set<Upstream>>();
  const watches = new Map<TerminalClient, Map<string, Watch>>();
  const starts = new Map<TerminalClient, Map<FrameId, ClientStart>>();
  /** Which session each of this hub's starts became, as the reports said so. */
  const named = new Map<StartId, { readonly storeId: StoreId; readonly sessionId: SessionId }>();

  const refuse = (client: TerminalClient, replyTo: FrameId, problem: string): void =>
    client.send({ type: 'refusal', replyTo, code: 'refused', message: problem, holder: null });

  const watchesOf = (client: TerminalClient): Map<string, Watch> => {
    const held = watches.get(client) ?? new Map<string, Watch>();
    watches.set(client, held);
    return held;
  };

  const startsOf = (client: TerminalClient): Map<FrameId, ClientStart> => {
    const held = starts.get(client) ?? new Map<FrameId, ClientStart>();
    starts.set(client, held);
    return held;
  };

  /**
   * Gives one watch back, and the upstream with it when it was the last.
   *
   * The one place a watch ends, reached by the unsubscribe frame and by a
   * socket closing alike. A second path would be a second rule to keep in step,
   * and the symptom would be a server watching a terminal for an audience that
   * left.
   */
  const release = (watch: Watch, detach = true): void => {
    if (watch.released) return;
    watch.released = true;
    watchesOf(watch.client).delete(watch.clientKey);

    const { upstream } = watch;
    upstream.watches.delete(watch);
    if (upstream.watches.size > 0) return;

    upstreams.delete(upstream.key);
    if (upstream.bound !== null) {
      const bound = rebound.get(upstream.bound);
      bound?.delete(upstream);
      if (bound?.size === 0) rebound.delete(upstream.bound);
    }

    // Nothing to give back when the server never gave it: a subscribe it
    // refused left no watcher on any terminal, and a detach for one would be
    // the hub asking a machine to undo something it declined to do.
    if (!detach) return;

    servers.stream(
      upstream.registrationId,
      { type: 'session-unsubscribe', target: upstream.target },
      (outcome) => {
        if (outcome.ok) return;
        // Nothing to tell a client: the client that left is gone, and the ones
        // still here are watching other terminals. What is left is a line for
        // whoever is reading the log, because a server that refuses a detach is
        // a server counting an audience that is not there.
        logger.warn('a server refused a detach', {
          registrationId: upstream.registrationId,
          problem: outcome.problem,
        });
      },
    );
  };

  /** One chunk to one watch, unless that socket is too far behind to take it. */
  const relayTo = (watch: Watch, output: TerminalOutputFrame, history: boolean): void => {
    // History is never gated, for the reason the server does not gate its own:
    // `replayChunks` promised exactly these frames, and a drop would make that
    // number a lie about a pane's own scrollback. It is bounded already -- one
    // scrollback, once per subscription, rather than a rate.
    if (!history && watch.client.bufferedBytes > MAX_BUFFERED_CLIENT_BYTES) {
      watch.dropped += 1;
      return;
    }

    watch.client.send({
      type: 'terminal-output',
      storeId: output.storeId,
      sessionId: output.sessionId,
      // The client's own handle, never the hub's: a `StartId` is the name the
      // hub and the server share, and it means nothing on a browser's socket.
      startId: watch.clientStartId,
      // Untouched. Not decoded, not re-encoded, not measured: the string the
      // server sent is the string the client gets.
      chunk: output.chunk,
      // Both legs' losses, because both are losses this viewer suffered, and a
      // reader comparing this with the last value it saw wants the size of the
      // gap in what it is being shown rather than in one hop of it.
      droppedChunks: output.droppedChunks + watch.dropped,
    });
  };

  const fanOut = (upstream: Upstream, output: TerminalOutputFrame): void => {
    const replaying = upstream.replays[0];
    if (replaying !== undefined) {
      replaying.remaining -= 1;
      if (replaying.remaining <= 0) upstream.replays.shift();
      const { watch } = replaying;
      if (watch !== null && !watch.released) relayTo(watch, output, true);
      return;
    }

    for (const watch of upstream.watches) {
      if (watch.attached) relayTo(watch, output, false);
    }
  };

  /**
   * The reply to a subscribe, where it was read.
   *
   * Everything below happens inside the turn that read the frame off the
   * socket, which is what keeps the client's `session-subscribed` ahead of the
   * history that follows it on the wire.
   */
  const attachTo = (watch: Watch, replyTo: FrameId, outcome: StreamOutcome): void => {
    if (!outcome.ok) {
      release(watch, false);
      refuse(watch.client, replyTo, outcome.problem);
      return;
    }

    // Narrowed on the frame the server sent rather than assumed from what was
    // asked: a peer that answered a subscribe with a detach is out of step, and
    // taking its word would leave a pane attached to nothing.
    const answer = outcome.answer;
    if (answer === null || answer.type !== 'session-subscribed') {
      release(watch, false);
      refuse(watch.client, replyTo, 'the server did not answer that subscription');
      return;
    }

    if (watch.released) {
      // The socket went away while the subscribe was in flight. The history is
      // still on its way and belongs to nobody, so it is claimed and dropped
      // rather than fanned out to the other viewers as if it were live.
      if (answer.replayChunks > 0) {
        watch.upstream.replays.push({ watch: null, remaining: answer.replayChunks });
      }
      return;
    }

    watch.attached = true;
    if (answer.replayChunks > 0) {
      watch.upstream.replays.push({ watch, remaining: answer.replayChunks });
    }

    watch.client.send({
      type: 'session-subscribed',
      replyTo,
      storeId: answer.storeId,
      sessionId: answer.sessionId,
      startId: watch.clientStartId,
      // The server's numbers, passed through. The hub knows nothing about how
      // much of a session's history exists and is not the one to say.
      replayChunks: answer.replayChunks,
      droppedBytes: answer.droppedBytes,
    });
  };

  /** Puts one terminal frame to the holder, refusing the client when it cannot. */
  const put = (
    client: TerminalClient,
    replyTo: FrameId,
    target: ClientTerminalTarget,
    frame: (aimed: ServerTerminalTarget) => StreamInstruction,
  ): void => {
    const routed = routeTerminal(state.snapshot(), startsOf(client), target);
    if (!routed.ok) {
      refuse(client, replyTo, routed.problem);
      return;
    }

    servers.stream(routed.registrationId, frame(routed.target), (outcome) => {
      // Silent on success, like the server leg: a terminal acknowledges input
      // by echoing it, and the case a user cannot see for themselves is the one
      // that gets a frame.
      if (outcome.ok) return;
      refuse(client, replyTo, outcome.problem);
    });
  };

  return {
    subscribe(client: TerminalClient, replyTo: FrameId, target: ClientTerminalTarget): void {
      const clientKey = clientKeyOf(target);
      const held = watchesOf(client);
      if (held.has(clientKey)) {
        // Idempotence would be the wrong answer: a second subscribe asks for a
        // second replay, and a client that wants one detaches first. Saying so
        // is better than quietly answering with a history it did not ask for.
        refuse(client, replyTo, 'this connection is already watching that terminal');
        return;
      }

      const routed = routeTerminal(state.snapshot(), startsOf(client), target);
      if (!routed.ok) {
        refuse(client, replyTo, routed.problem);
        return;
      }

      const key = `${routed.registrationId} ${serverKeyOf(routed.target)}`;
      let upstream = upstreams.get(key);
      if (upstream === undefined) {
        upstream = {
          key,
          registrationId: routed.registrationId,
          target: routed.target,
          watches: new Set(),
          replays: [],
          bound: null,
        };
        upstreams.set(key, upstream);
      }

      const watch: Watch = {
        client,
        clientKey,
        upstream,
        clientStartId: handleFor(startsOf(client), named, target),
        dropped: 0,
        attached: false,
        released: false,
      };
      upstream.watches.add(watch);
      held.set(clientKey, watch);

      logger.debug('client watching a terminal', {
        registrationId: routed.registrationId,
        by: target.by,
        watching: upstream.watches.size,
      });

      // One subscribe per client, even when the upstream already exists. The
      // server joins the second one to the stream it is already running -- one
      // watch on the terminal, one copy of every chunk on the wire -- and
      // answers it with the scrollback as it stands, which is the only way a
      // second viewer gets a history at all.
      servers.stream(
        routed.registrationId,
        { type: 'session-subscribe', target: routed.target },
        (outcome) => attachTo(watch, replyTo, outcome),
      );
    },

    unsubscribe(client: TerminalClient, replyTo: FrameId, target: ClientTerminalTarget): void {
      const watch = watchesOf(client).get(clientKeyOf(target));
      if (watch === undefined) {
        refuse(client, replyTo, 'this connection is not watching that terminal');
        return;
      }

      release(watch);
      // Answered from the hub's own books rather than by waiting for the
      // server, because there may be no server frame at all: one of two viewers
      // leaving is a detach the server never hears about, and a client whose
      // answer depended on that would hang on whether somebody else was
      // watching.
      client.send({ type: 'session-unsubscribed', replyTo });
    },

    input(
      client: TerminalClient,
      replyTo: FrameId,
      target: ClientTerminalTarget,
      data: string,
    ): void {
      // Two viewers typing into one session interleave at the pty, and that is
      // the pty's problem rather than this one's: a terminal is a shared
      // device, two hands on one keyboard is what it does, and a hub that
      // serialised keystrokes would be inventing a turn-taking rule neither the
      // protocol nor the program on the other end has.
      put(client, replyTo, target, (aimed) => ({ type: 'terminal-input', target: aimed, data }));
    },

    resize(
      client: TerminalClient,
      replyTo: FrameId,
      target: ClientTerminalTarget,
      size: TerminalSize,
    ): void {
      put(client, replyTo, target, (aimed) => ({ type: 'terminal-resize', target: aimed, size }));
    },

    noteStart(client: TerminalClient, handle: FrameId, start: ClientStart): void {
      startsOf(client).set(handle, start);
    },

    noteStarts(
      registrationId: ServerRegistrationId,
      storeId: StoreId,
      reported: readonly SessionStartTag[],
    ): void {
      for (const tag of reported) {
        if (tag.sessionId === null) continue;
        named.set(tag.startId, { storeId, sessionId: tag.sessionId });

        const upstream = upstreams.get(`${registrationId} start ${tag.startId}`);
        if (upstream === undefined || upstream.bound !== null) continue;

        // The one exact moment a pending pane becomes a session's pane. The
        // upstream keeps its start-addressed key -- the server still answers to
        // it -- and gains a second name, so a chunk carrying only the session id
        // reaches the same client.
        const key = `${registrationId} session ${storeId} ${tag.sessionId}`;
        upstream.bound = key;
        const bound = rebound.get(key) ?? new Set<Upstream>();
        bound.add(upstream);
        rebound.set(key, bound);
        logger.debug('a watched start became a session', {
          registrationId,
          storeId,
          sessionId: tag.sessionId,
        });
      }
    },

    deliver(registrationId: ServerRegistrationId, output: TerminalOutputFrame): void {
      // A set, because one upstream may be found under both of its names and a
      // chunk delivered twice is a chunk the emulator paints twice.
      const matched = new Set<Upstream>();

      if (output.startId !== null) {
        const byStart = upstreams.get(`${registrationId} start ${output.startId}`);
        if (byStart !== undefined) matched.add(byStart);
      }

      if (output.sessionId !== null) {
        const key = `${registrationId} session ${output.storeId} ${output.sessionId}`;
        const bySession = upstreams.get(key);
        if (bySession !== undefined) matched.add(bySession);
        for (const upstream of rebound.get(key) ?? []) matched.add(upstream);
      }

      for (const upstream of matched) fanOut(upstream, output);
    },

    forget(client: TerminalClient): void {
      const held = watches.get(client);
      watches.delete(client);
      // Taken first: releasing mutates the map that was just handed over, and
      // iterating one while it is being emptied is a bug waiting for the second
      // watch.
      for (const watch of [...(held?.values() ?? [])]) release(watch);

      const made = starts.get(client);
      starts.delete(client);
      // A start handle is this socket's, and the session a start became is only
      // ever read back through a handle: with the socket gone there is nothing
      // left that could ask.
      for (const start of made?.values() ?? []) named.delete(start.startId);
    },
  };
}

/** A client's name for a target, so two frames naming one terminal are one watch. */
function clientKeyOf(target: ClientTerminalTarget): string {
  return target.by === 'start'
    ? `start ${target.startId}`
    : `session ${target.storeId} ${target.sessionId}`;
}

/** The same, for the server leg's target, whose start handle is the hub's. */
function serverKeyOf(target: ServerTerminalTarget): string {
  return target.by === 'start'
    ? `start ${target.startId}`
    : `session ${target.storeId} ${target.sessionId}`;
}

/**
 * The client's own start handle for this terminal, or `null`.
 *
 * A subscription by start is answered under the handle it used. One by session
 * is answered under a handle only when this client is the one that started that
 * session -- which is what the protocol asks for, and it is answerable because
 * the reports said which start became which session.
 */
function handleFor(
  made: ReadonlyMap<FrameId, ClientStart>,
  named: ReadonlyMap<StartId, { readonly storeId: StoreId; readonly sessionId: SessionId }>,
  target: ClientTerminalTarget,
): FrameId | null {
  if (target.by === 'start') return target.startId;

  for (const [handle, start] of made) {
    const became = named.get(start.startId);
    if (became?.storeId === target.storeId && became.sessionId === target.sessionId) return handle;
  }
  return null;
}
