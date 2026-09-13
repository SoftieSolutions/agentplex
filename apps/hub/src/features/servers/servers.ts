import type {
  FrameId,
  HubId,
  HubToServerFrame,
  ProviderReadiness,
  RefusalCode,
  ServerId,
  ServerRegistrationId,
  ServerToHubFrame,
  SessionDescriptor,
  SessionHold,
  StoreId,
} from '@agentplex/protocol';
import type { Clock, Logger, SocketDialer, Timers } from '@agentplex/node-shared';
import type { Pairing, ServerAddress } from '../pairing/pairing.js';
import { createExponentialBackoff, type BackoffPolicy } from './backoff.js';
import { startDialLoop, type DialLoop } from './dial-loop.js';
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
 * The handshake's own failures, plus the three the dial loop can produce: a
 * connection that was up and ended, a server that answered with a different
 * identity than the one paired, and the hub failing on its own side. They are
 * kept apart because they are different things for a person to do -- wait,
 * re-pair, or look at the hub -- and because only some of them are worth
 * retrying quickly.
 */
export type StaleReason = HandshakeFailureReason | 'dropped' | 'identity-changed' | 'hub-error';

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
 * report; `attention.ts` builds the store-level answers on top of it and
 * carries the rest of the argument.
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
 * decision somebody takes.
 */
type WithoutFrameId<Frame> = Frame extends { id: FrameId } ? Omit<Frame, 'id'> : never;

export type ServerInstruction = WithoutFrameId<
  Extract<HubToServerFrame, { type: 'session-start' | 'session-stop' | 'directory-list' }>
>;

/** What a server answers an instruction with when it did it. */
export type ServerAnswer = Extract<
  ServerToHubFrame,
  { type: 'session-started' | 'session-stopped' | 'directory-listing' }
>;

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

  return {
    async sync(): Promise<void> {
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
          }),
        );
      }
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
