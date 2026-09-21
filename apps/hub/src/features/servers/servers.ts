import type {
  FrameId,
  HubId,
  HubToServerFrame,
  ProviderReadiness,
  RefusalCode,
  ServerAddress,
  ServerDraining,
  ServerId,
  ServerRegistrationId,
  ServerToHubFrame,
  SessionDescriptor,
  SessionHold,
  SessionStartTag,
  StoreId,
} from '@agentplex/protocol';
import type { Clock, Logger, SocketDialer, Timers } from '@agentplex/node-shared';
import type { Pairing } from '../pairing/pairing.js';
import { createExponentialBackoff, type BackoffPolicy } from './backoff.js';
import { startDialLoop, type DialLoop } from './dial-loop.js';
import type { ApprovalRequested, ApprovalSettled, ApprovalWithdrawn } from './frame-router.js';
import type { HandshakeFailureReason } from './server-handshake.js';
import { createMessageSocketTransports, type ServerTransportOpener } from './transport.js';

/**
 * Every paired server, kept connected.
 *
 * One dial loop per live pairing and nothing more: the interesting rules are
 * all in there, and this is the part that knows which pairings exist and owns
 * their lifecycle. Keeping the two apart matters because they fail differently
 * -- one server being unreachable is normal and must cost only itself, whereas
 * the list of pairings being unreadable is the hub being broken.
 *
 * There is no fleet-wide state here, deliberately. No "how many are up", no
 * shared backoff, no queue. Servers are independent by design: no
 * server-to-server coordination exists anywhere in this system, and a
 * supervisor that grew a shared notion of health would be the first place it
 * appeared.
 *
 * This file is also the feature's entry, so every type below is the vocabulary
 * another feature reads a server's connectivity in. They are defined here
 * rather than in whichever file happens to produce them, so that nothing
 * outside this folder has to name a file inside it. What a connection is made
 * of sits underneath: `dial-loop.ts` decides when to connect, `transport.ts`
 * is the seam it speaks through, and `frame-router.ts` and
 * `instruction-channel.ts` are what that seam is built from.
 */

/**
 * Where a connection is, as one word.
 *
 * `connecting` is only ever the first attempt. Once a server has been stale it
 * stays stale while the hub redials, because a dial in flight is not evidence
 * of anything and a state that flickered between the two on every retry would
 * make the label unreadable exactly when it matters.
 */
export type ServerConnectionPhase = 'connecting' | 'connected' | 'stale' | 'stopped';

/**
 * Why a server is stale.
 *
 * The handshake's own failures, plus the four the dial loop can produce: a
 * connection that was up and ended, one that ended after the server said it
 * was going down, a server that answered with a different identity than the
 * one paired, and the hub failing on its own side. They are kept apart because
 * they are different things for a person to do -- wait, re-pair, or look at the
 * hub -- and because they are not retried on the same schedule: `draining` is
 * the one case where the machine itself said when to come back.
 */
export type StaleReason =
  HandshakeFailureReason | 'dropped' | 'identity-changed' | 'hub-error' | 'draining';

/**
 * Everything the rest of the hub may know about one server's connectivity.
 *
 * A value, not the object: whoever reads this is deciding what to show or what
 * to count, and handing them something with a `stop()` on it would make the
 * lifecycle reachable from a listing.
 */
export interface ServerConnectionReport {
  readonly registrationId: ServerRegistrationId;
  readonly label: string;
  readonly address: ServerAddress;
  /** What the server calls itself, once a handshake has said so. */
  readonly serverId: ServerId | null;
  readonly phase: ServerConnectionPhase;
  /**
   * The stores this server reported when it was last connected, deduplicated
   * as the database holds them.
   *
   * Kept when the server goes stale, because that is what "keeps its rows,
   * marked stale" means: the last thing known stays visible with its age
   * attached, rather than the store list emptying out and reading as a machine
   * that has nothing mounted.
   */
  readonly stores: readonly StoreId[];
  /**
   * What that machine reported it can start, from the last handshake.
   *
   * Kept while it is stale for the reason the store list is, and read by the
   * scheduler: a start aimed at a machine whose `claude` is missing is refused
   * here, where the fact is, rather than sent to a server that would fork a pty
   * into nothing and report a session that appeared and vanished.
   *
   * Empty until a handshake has said otherwise -- for a pairing that has never
   * connected there is nothing known, and nothing known is what an empty list
   * means. A start against a machine in that state is already refused for not
   * being connected.
   */
  readonly providers: readonly ProviderReadiness[];
  /** When the connection now held was established. `null` unless connected. */
  readonly connectedSince: number | null;
  /**
   * When this unreachable spell began -- the first failure, not the most
   * recent retry. `null` unless stale. This is the age on the label.
   */
  readonly staleSince: number | null;
  /**
   * When the hub last held a connection to this server, ever, including before
   * a restart. `null` means it never has, which is a pairing that has never
   * worked rather than a machine that is asleep.
   */
  readonly lastConnectedAt: number | null;
  /** Consecutive failed attempts in this spell. Zero while connected. */
  readonly failedAttempts: number;
  /** What went wrong, in words, for a log line and the pairing screen. */
  readonly problem: string | null;
  readonly staleReason: StaleReason | null;
  /**
   * The shutdown this machine announced, or `null` for one that has announced
   * none.
   *
   * Set while the phase is still `connected`, and that is the decision this
   * field exists to record. A drain is not a connection ending: the server
   * keeps its sockets open through it deliberately, so that whoever is watching
   * an agent sees the last of its output, and the hub goes on asking and being
   * answered. Folding it into the phase would take a live connection off every
   * screen to describe something that has not happened yet, and would leave
   * nothing to say when the close actually comes.
   *
   * Kept through that close, beside `staleReason: 'draining'`, for the reason
   * the store list is kept: it is the last thing the machine actually said, and
   * a row that dropped it would read as a machine that simply vanished. A
   * handshake clears it -- a server that is answering again is not going down.
   */
  readonly draining: ServerDraining | null;
}

/**
 * Whether this server's sessions count toward attention.
 *
 * Only a connection the hub is actually holding. `connecting` does not count
 * either: a dial in flight is not evidence of anything, and the honest
 * direction to be wrong in is the one that under-counts. A reconnect that takes
 * a few seconds therefore lowers the count for those seconds -- which is a
 * badge that comes back, rather than one that was never true.
 *
 * A pure function of the report rather than a column or a query, and that is
 * the decision worth stating: attention is a claim about *now*, and the only
 * thing that knows whether a server is reachable now is the thing holding the
 * socket. It lives on the entry file because it is how other features read a
 * report; `attention.ts` beside it builds the store-level answers on top and
 * carries the rest of the argument. That file is about reachability, which is
 * a different question from the `features/attention` feature: this decides
 * whether a session *can* be answered, and that records whether somebody said
 * they had seen it.
 */
export function countsTowardAttention(report: ServerConnectionReport): boolean {
  return report.phase === 'connected';
}

/**
 * What the hub asks a connected server to do.
 *
 * The instruction frames themselves, minus the id: a frame id is unique within
 * one connection and the connection is the only thing that can mint one, so a
 * caller that supplied its own would be numbering frames on a socket it does
 * not own. Derived from the wire union rather than restated, so that a field
 * added to an instruction is a field this carries, without an edit.
 *
 * It was `ServerInstruction` until AGX-238 put a directory listing on the same
 * channel, and the rename is the honest half of that: an `ask` that carries
 * something which is not about a session should not be typed as though it were.
 * The set is still a list rather than every frame with an id -- a handshake and
 * a ping are the connection's own, not a caller's -- so adding one here stays a
 * decision somebody takes. The three document frames are the second such
 * addition, and the name has earned itself twice over.
 */
type WithoutFrameId<Frame> = Frame extends { id: FrameId } ? Omit<Frame, 'id'> : never;

export type ServerInstruction = WithoutFrameId<
  Extract<
    HubToServerFrame,
    {
      type:
        'session-start' | 'session-stop' | 'directory-list' | 'doc-write' | 'doc-read' | 'doc-list';
    }
  >
>;

/** What a server answers an instruction with when it did it. */
export type ServerAnswer = Extract<
  ServerToHubFrame,
  {
    type:
      | 'session-started'
      | 'session-stopped'
      | 'directory-listing'
      | 'doc-written'
      | 'doc-content'
      | 'doc-listing';
  }
>;

/**
 * What the hub puts to a server about one of its terminals.
 *
 * The four terminal frames the hub sends, minus the id, for the reason an
 * instruction is one: a frame id is unique within a connection and only the
 * connection can mint one. Kept apart from `ServerInstruction` because the two
 * are answered differently -- a start has exactly one reply, and two of these
 * have no reply at all when they work.
 */
export type StreamInstruction = WithoutFrameId<
  Extract<
    HubToServerFrame,
    { type: 'session-subscribe' | 'session-unsubscribe' | 'terminal-input' | 'terminal-resize' }
  >
>;

/** What a server answers a subscribe or an unsubscribe with when it did it. */
export type StreamAnswer = Extract<
  ServerToHubFrame,
  { type: 'session-subscribed' | 'session-unsubscribed' }
>;

/**
 * One decision on its way to the machine holding the blocked process.
 *
 * Its own kind of instruction, because it is answered in its own way: there is
 * no reply on the way it worked. A granted command may run for ten minutes and
 * the server acknowledges nothing, so `ask` would time the decision out at
 * thirty seconds and call a working one a failure -- what actually happened
 * arrives unsolicited as `approval-settled`. Only a refusal comes back, and
 * only the hub that asked is owed it.
 */
export type DecideInstruction = WithoutFrameId<
  Extract<HubToServerFrame, { type: 'approval-decide' }>
>;

/**
 * Why a decision was not put to a hook, in the words a client is told.
 *
 * No `hold` and no answer half: nothing here names a live process, and the
 * only thing this path can say is that nothing was applied.
 */
export interface DecideRefusal {
  readonly code: RefusalCode;
  readonly problem: string;
}

/**
 * What a machine says about its own approvals, unsolicited.
 *
 * One object with three methods rather than three dependencies, because they
 * are one seam: the feature on the other side of it is the only thing that
 * holds an open request, and a wiring that had two of the three attached would
 * be a hub that shows a question nobody can end. The frames arrive already
 * discriminated -- see `frame-router.ts` -- so nothing downstream re-reads a
 * `type`.
 */
export interface ServerApprovalReports {
  requested(registrationId: ServerRegistrationId, frame: ApprovalRequested): void;
  withdrawn(registrationId: ServerRegistrationId, frame: ApprovalWithdrawn): void;
  settled(registrationId: ServerRegistrationId, frame: ApprovalSettled): void;
}

/**
 * One chunk of a terminal's output, exactly as the frame carries it.
 *
 * On the entry file because the relay reads one, and a feature reaches this one
 * through this file alone. Derived from the wire union rather than restated,
 * which is the same reason the instructions above are: a field added to the
 * frame is a field this carries, without an edit and without a second shape to
 * keep in step with the first.
 */
export type TerminalOutputFrame = Extract<ServerToHubFrame, { type: 'terminal-output' }>;

/**
 * What came back about a terminal frame, as a value.
 *
 * `answer` is `null` when the server said nothing at all, which is what success
 * looks like for an input and a resize: a terminal acknowledges a keystroke by
 * echoing it, and only a write that could not be delivered gets a frame. So
 * that case is settled by a deadline rather than by a reply, and whoever wanted
 * to hear about a failure has by then heard everything there was.
 *
 * It carries no `hold`. A hold names the machine already running a session,
 * which is an answer to "may I start this" and never to "may I watch it".
 */
export type StreamOutcome =
  | { readonly ok: true; readonly answer: StreamAnswer | null }
  | { readonly ok: false; readonly code: RefusalCode; readonly problem: string };

/**
 * What came back, as a value.
 *
 * A refusal is not an exception: a server saying "that session is already
 * running here" is the system working, and the answer has to reach the client
 * that asked rather than unwinding a stack. `hold` names the live process when
 * that was the reason, exactly as the server sent it.
 */
export type InstructionOutcome =
  | { readonly ok: true; readonly answer: ServerAnswer }
  | {
      readonly ok: false;
      readonly code: RefusalCode;
      readonly problem: string;
      readonly hold: SessionHold | null;
    };

/** One server's whole view of one store, as it arrived off the wire. */
export interface ServerStoreReport {
  readonly registrationId: ServerRegistrationId;
  readonly storeId: StoreId;
  readonly sessions: readonly SessionDescriptor[];
  readonly holding: readonly SessionHold[];
  /**
   * Which of this hub's starts produced which session, for as long as that is
   * not obvious.
   *
   * Carried through rather than dropped here because it has a reader now: the
   * relay watches a spawn by the start handle that asked for it, and this is
   * the frame that says which session that start became. The reducer wants
   * none of it -- a start is not a session and a tag is not a row -- so it goes
   * past the reducer to the one feature that needs it.
   */
  readonly starts: readonly SessionStartTag[];
}

export interface ServersDependencies {
  /**
   * Which servers this hub may dial, and what a completed handshake records.
   * The feature that owns those rows, as a seam: nothing in this folder reads
   * the `servers` table itself.
   */
  readonly pairing: Pairing;
  readonly dialer: SocketDialer;
  /** Which hub is dialling. The server cannot tell two of them apart otherwise. */
  readonly hubId: HubId;
  readonly timers: Timers;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Shared by every connection: it is a schedule, and it holds no state. */
  readonly backoff?: BackoffPolicy;
  /**
   * How the hub speaks to a server once it is connected. Defaults to the one
   * implementation there is -- a handshake, then frames on a socket -- and is
   * a dependency because it is the seam AGX-224 replaces.
   */
  readonly transports?: ServerTransportOpener;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly refusedRetryMs?: number;
  /** Called whenever any server's connectivity changes. The fleet state's seam. */
  readonly onChange?: (report: ServerConnectionReport) => void;
  /** Called with every store report any server sends. The fleet state's other seam. */
  readonly onReport?: (report: ServerStoreReport) => void;
  /**
   * Called with every chunk of terminal output any server sends. The relay's
   * seam.
   *
   * Synchronous, and it matters here more than anywhere else in this file: the
   * history a subscription replays travels on this frame, in order, straight
   * after the reply that says how many frames of it there are. Anything that
   * deferred one of these would reorder a terminal, and a terminal read out of
   * order is not a slightly wrong terminal -- an escape sequence that arrives
   * after what it was meant to position paints somewhere else.
   */
  readonly onStream?: (registrationId: ServerRegistrationId, output: TerminalOutputFrame) => void;
  /**
   * Called with everything any server says about an approval. The approvals
   * feature's seam.
   *
   * Carries the registration with every frame, because the machine is what a
   * decision is addressed to and the frame does not name it: the hub chose the
   * connection, and a machine telling a hub which machine it is would be a
   * field nothing could check.
   */
  readonly onApprovals?: ServerApprovalReports;
  readonly instructionTimeoutMs?: number;
}

export interface Servers {
  /**
   * Matches what is running to the pairings in the database: starts one for a
   * pairing that has none, and stops one whose pairing has been revoked or
   * deleted.
   *
   * Called at startup and by whatever changes a pairing. It reads rather than
   * being told what changed, because the database is the authority on which
   * servers this hub may dial and a supervisor that tracked that separately
   * would be a second answer to the same question.
   *
   * Nothing is dialled until it is first called. That is what lets the hub
   * build everything that watches a connectivity change before the first one
   * can happen, without anybody holding a half-built reference to this.
   *
   * Callable as often as anything changes, and syncs never overlap: each waits
   * for the one before it to finish. Until a client could pair, this was called
   * once at startup and the question never came up; now two clients unpairing
   * and pairing in the same turn of the loop is an ordinary afternoon. The race
   * it closes is narrow and real -- stopping a departed connection is awaited,
   * so a second sync could read the table in that gap and start a second dial
   * loop for a pairing the first was about to start, leaving a server dialled
   * twice with only one loop reachable to stop.
   */
  sync(): Promise<void>;
  /** What every paired server's connectivity is, right now. */
  snapshot(): readonly ServerConnectionReport[];
  /**
   * Puts an instruction to one paired server, by registration.
   *
   * Addressed by `ServerRegistrationId` because that is the hub's own name for
   * a machine and the one every decision above here is made in: the scheduler
   * chose a registration, and a seam that took a `ServerId` would make every
   * caller translate between two names for one thing.
   *
   * A registration this hub is not supervising is a refusal rather than a
   * throw, for the same reason an unreachable one is: both are answers a client
   * is waiting for, and neither is exceptional.
   */
  ask(
    registrationId: ServerRegistrationId,
    instruction: ServerInstruction,
  ): Promise<InstructionOutcome>;
  /**
   * Puts a terminal frame to one paired server, and calls back with what it
   * said.
   *
   * A callback and not a promise, which is the one thing about this seam worth
   * arguing. A promise settles on a microtask, and a server writes a
   * subscription's reply and the scrollback it promised in the same turn: a
   * relay that resolved a promise would send a client its history before the
   * frame that says how much history there is, and the count on that frame
   * would be a lie about frames the client had already been given. Answering
   * where the frame is read keeps the relay in the order the wire was in.
   *
   * A server this hub has no connection to is a refusal rather than a throw,
   * for the reason `ask` gives: there is a client waiting for a sentence either
   * way, and a machine that is asleep is the ordinary state of a laptop.
   */
  stream(
    registrationId: ServerRegistrationId,
    frame: StreamInstruction,
    answer: (outcome: StreamOutcome) => void,
  ): void;
  /**
   * Puts one decision to the machine holding the blocked process, and waits on
   * nothing.
   *
   * `refused` is called when the machine would not take it, and never when it
   * did: silence is what a server that handed a decision to a hook says, and
   * what the hook then did comes back unsolicited as `approval-settled`. So
   * this returns nothing -- a promise here would be a promise most callers
   * could only resolve by waiting out a deadline, and the caller that matters
   * is waiting for the settlement rather than for this.
   *
   * A machine this hub has no connection to is a refusal rather than a throw,
   * for the reason `ask` gives, and it is the honest answer: an approval that
   * cannot be reached is one nobody's tap can apply.
   */
  decide(
    registrationId: ServerRegistrationId,
    instruction: DecideInstruction,
    refused: (refusal: DecideRefusal) => void,
  ): void;
  stop(): Promise<void>;
}

export function createServers(dependencies: ServersDependencies): Servers {
  const { pairing, dialer, hubId, timers, clock } = dependencies;
  const logger = dependencies.logger.child({ part: 'connections' });
  const backoff = dependencies.backoff ?? createExponentialBackoff();
  const transports =
    dependencies.transports ??
    createMessageSocketTransports({
      dialer,
      hubId,
      timers,
      logger,
      ...(dependencies.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: dependencies.handshakeTimeoutMs }),
      ...(dependencies.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: dependencies.heartbeatIntervalMs }),
      ...(dependencies.heartbeatTimeoutMs === undefined
        ? {}
        : { heartbeatTimeoutMs: dependencies.heartbeatTimeoutMs }),
      ...(dependencies.instructionTimeoutMs === undefined
        ? {}
        : { instructionTimeoutMs: dependencies.instructionTimeoutMs }),
    });

  const connections = new Map<ServerRegistrationId, DialLoop>();
  let stopped = false;

  /**
   * The tail of the sync queue: what a new sync waits for before it reads the
   * table.
   *
   * Settled rather than fulfilled, so one sync that throws does not strand
   * every later one; the failure still reaches the caller that asked for it,
   * through the promise `sync` hands back rather than through this one.
   */
  let syncing: Promise<unknown> = Promise.resolve();

  /**
   * One pass: read the table, stop what is no longer paired, dial what is not
   * yet connected. `sync` is the queue around it, and the two are apart so that
   * the ordering rule lives in one place rather than inside the work it orders.
   */
  async function reconcile(): Promise<void> {
    if (stopped) return;

    // Live pairings only: a revoked registration has no token, which is
    // exactly the shape that cannot be dialled, and the pairing feature is
    // where that narrowing is done.
    const registrations = await pairing.listServers();
    const live = new Set(registrations.map((registration) => registration.id));

    // Gone first: a revoked pairing must stop being dialled before anything
    // else happens, because the operator's revocation is the one instruction
    // here that is about denying access.
    const departing = [...connections].filter(([id]) => !live.has(id));
    for (const [id, connection] of departing) {
      connections.delete(id);
      logger.info('pairing gone; stopping', { registrationId: id });
      await connection.stop();
    }

    for (const registration of registrations) {
      if (connections.has(registration.id)) continue;

      logger.info('dialling', {
        registrationId: registration.id,
        server: registration.label,
      });
      connections.set(
        registration.id,
        startDialLoop(registration, {
          pairing,
          transports,
          timers,
          clock,
          logger,
          backoff,
          ...(dependencies.refusedRetryMs === undefined
            ? {}
            : { refusedRetryMs: dependencies.refusedRetryMs }),
          ...(dependencies.onChange === undefined ? {} : { onChange: dependencies.onChange }),
          ...(dependencies.onReport === undefined ? {} : { onReport: dependencies.onReport }),
          ...(dependencies.onStream === undefined ? {} : { onStream: dependencies.onStream }),
          ...(dependencies.onApprovals === undefined
            ? {}
            : { onApprovals: dependencies.onApprovals }),
        }),
      );
    }
  }

  return {
    sync(): Promise<void> {
      const next = syncing.then(reconcile, reconcile);
      syncing = next.catch(() => undefined);
      return next;
    },

    snapshot(): readonly ServerConnectionReport[] {
      return [...connections.values()].map((connection) => connection.report);
    },

    ask(
      registrationId: ServerRegistrationId,
      instruction: ServerInstruction,
    ): Promise<InstructionOutcome> {
      const connection = connections.get(registrationId);
      if (connection === undefined) {
        return Promise.resolve({
          ok: false,
          code: 'refused',
          problem: 'this hub has no such server paired',
          hold: null,
        });
      }
      return connection.ask(instruction);
    },

    stream(
      registrationId: ServerRegistrationId,
      frame: StreamInstruction,
      answer: (outcome: StreamOutcome) => void,
    ): void {
      const connection = connections.get(registrationId);
      if (connection === undefined) {
        answer({ ok: false, code: 'refused', problem: 'this hub has no such server paired' });
        return;
      }
      connection.stream(frame, answer);
    },

    decide(
      registrationId: ServerRegistrationId,
      instruction: DecideInstruction,
      refused: (refusal: DecideRefusal) => void,
    ): void {
      const connection = connections.get(registrationId);
      if (connection === undefined) {
        refused({ code: 'refused', problem: 'this hub has no such server paired' });
        return;
      }
      connection.decide(instruction, refused);
    },

    async stop(): Promise<void> {
      stopped = true;
      const running = [...connections.values()];
      connections.clear();
      // Together rather than one after another: they are independent, and a
      // shutdown that stopped them in series would wait for each in turn.
      await Promise.all(running.map((connection) => connection.stop()));
      logger.info('connections stopped', { servers: running.length });
    },
  };
}
