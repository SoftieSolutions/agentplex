import type { HubId, ServerId, StoreId } from '@agentplex/protocol';
import type { Clock } from '../../shared/clock.js';
import type { Logger } from '../../shared/logger.js';
import {
  closure,
  CLOSE_NORMAL,
  CLOSE_POLICY,
  type MessageSocket,
  type SocketDialer,
} from '../../shared/message-socket.js';
import type { Timers } from '../../shared/timers.js';
import type { Database } from '../db/database.js';
import { recordHandshake } from '../pairing/record-handshake.js';
import {
  handshakeWithServer,
  type DialTarget,
  type HandshakeFailureReason,
  type HandshakeOutcome,
} from '../pairing/server-handshake.js';
import type { ServerAddress } from '../pairing/server-address.js';
import type {
  LiveServerRegistration,
  ServerRegistrationId,
} from '../pairing/server-registrations.js';
import type { BackoffPolicy } from './backoff.js';
import { startHeartbeat } from './connection-heartbeat.js';

/**
 * One paired server, kept connected.
 *
 * The handshake below this runs once and answers with what happened. This is
 * the part that decides *when*: dial, hold what it got, and when that ends --
 * refused, dropped, or never reached at all -- wait and dial again. It is one
 * object per pairing because a pairing is the unit the operator revokes, the
 * unit a token belongs to, and the unit that can be down while every other one
 * is up.
 *
 * The rule it exists to enforce is the one the connectivity design states
 * plainly: an unreachable server keeps its rows, marked stale, and its
 * sessions leave the attention count. So nothing here deletes anything. A
 * server that has been unreachable for a week still has its pairing, still has
 * its stores, and still reports the last time it was actually up -- labelled
 * with an age, never presented as current. A badge you cannot clear by looking
 * is worse than none, and the only way to keep that promise is for the thing
 * holding the socket to say honestly that it is not holding one.
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
 * The handshake's own failures, plus the three this layer can produce: a
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
 * supervisor's lifecycle reachable from a listing.
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

export interface ServerConnectionDependencies {
  readonly database: Database;
  readonly dialer: SocketDialer;
  /** Which hub is dialling. The server cannot tell two of them apart otherwise. */
  readonly hubId: HubId;
  readonly timers: Timers;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly backoff: BackoffPolicy;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  /**
   * How long to wait before retrying a refusal only a person can fix.
   *
   * A wrong token and a protocol mismatch are not transient: nothing changes
   * until somebody re-pairs the server or upgrades one of the two builds.
   * Retrying those on the same fast curve as a sleeping laptop means dialling
   * a server every half second to be told no, which fills a log with one
   * repeated fact. Retrying is still right -- re-pairing is exactly what fixes
   * it, and the hub should notice without being restarted -- so it is a floor
   * on the wait rather than giving up.
   */
  readonly refusedRetryMs?: number;
  /**
   * Called after every change, with what the change produced.
   *
   * The seam the reducer attaches to. It is a callback rather than an event
   * emitter because there is one consumer and the ordering matters: whatever
   * builds a snapshot has to see the states in the order they happened.
   */
  readonly onChange?: (report: ServerConnectionReport) => void;
}

const DEFAULT_REFUSED_RETRY_MS = 60_000;

/** Nothing gets faster by dialling again. Only a person changes these. */
const NEEDS_A_PERSON: ReadonlySet<StaleReason> = new Set<StaleReason>([
  'unauthorized',
  'protocol-version',
  'identity-changed',
]);

export interface ServerConnection {
  /** What this connection is, right now. */
  readonly report: ServerConnectionReport;
  /**
   * Stops dialling and closes whatever is held. Resolves when the loop has
   * actually finished, so a hub shutdown cannot leave a dial in flight.
   */
  stop(): Promise<void>;
}

export function startServerConnection(
  registration: LiveServerRegistration,
  dependencies: ServerConnectionDependencies,
): ServerConnection {
  const { database, dialer, hubId, timers, clock, backoff } = dependencies;
  const logger = dependencies.logger.child({
    registrationId: registration.id,
    server: registration.label,
  });
  const refusedRetryMs = dependencies.refusedRetryMs ?? DEFAULT_REFUSED_RETRY_MS;
  const target: DialTarget = { address: registration.address, token: registration.token };

  let phase: ServerConnectionPhase = 'connecting';
  let serverId: ServerId | null = registration.serverId;
  let stores: readonly StoreId[] = [];
  let connectedSince: number | null = null;
  let staleSince: number | null = null;
  let lastConnectedAt: number | null = registration.lastConnectedAt;
  let failedAttempts = 0;
  let problem: string | null = null;
  let staleReason: StaleReason | null = null;

  let stopped = false;
  let held: MessageSocket | null = null;

  // Resolved by `stop`. Everything the loop waits on races against it, so a
  // shutdown does not have to wait out a backoff or a handshake deadline.
  let beginStopping = (): void => {};
  const stopping = new Promise<'stopping'>((resolve) => {
    beginStopping = () => void resolve('stopping');
  });

  const report = (): ServerConnectionReport => ({
    registrationId: registration.id,
    label: registration.label,
    address: registration.address,
    serverId,
    phase,
    stores,
    connectedSince,
    staleSince,
    lastConnectedAt,
    failedAttempts,
    problem,
    staleReason,
  });

  const changed = (): void => dependencies.onChange?.(report());

  const goStale = (reason: StaleReason, why: string): void => {
    // The spell began at the first failure. A retry that fails again is the
    // same spell continuing, and moving this would make a server that has been
    // down all week report that it went down half a second ago.
    if (phase !== 'stale') staleSince = clock.now();
    phase = 'stale';
    connectedSince = null;
    staleReason = reason;
    problem = why;
    failedAttempts += 1;
    logger.warn('server unreachable', { reason, problem: why, since: staleSince, failedAttempts });
    changed();
  };

  const goConnected = (id: ServerId, mounted: readonly StoreId[]): void => {
    phase = 'connected';
    serverId = id;
    stores = mounted;
    connectedSince = clock.now();
    lastConnectedAt = connectedSince;
    staleSince = null;
    staleReason = null;
    problem = null;
    failedAttempts = 0;
    logger.info('server connected', { serverId: id, stores: mounted.length });
    changed();
  };

  /** Waits out the backoff, or returns early because the hub is stopping. */
  const waitToRetry = async (): Promise<void> => {
    const scheduled = backoff.delayMs(failedAttempts);
    const delay =
      staleReason !== null && NEEDS_A_PERSON.has(staleReason)
        ? Math.max(scheduled, refusedRetryMs)
        : scheduled;

    logger.info('retrying', { inMs: delay, failedAttempts, reason: staleReason });
    let cancel: () => void = () => {};
    const slept = new Promise<void>((resolve) => {
      cancel = timers.schedule(delay, resolve);
    });
    await Promise.race([slept, stopping]);
    cancel();
  };

  /** Holds an established connection until it ends or the hub stops. */
  const hold = async (socket: MessageSocket, nextFrameId: () => number): Promise<void> => {
    held = socket;
    const heartbeat = startHeartbeat(socket, {
      timers,
      logger,
      nextFrameId,
      ...(dependencies.heartbeatIntervalMs === undefined
        ? {}
        : { intervalMs: dependencies.heartbeatIntervalMs }),
      ...(dependencies.heartbeatTimeoutMs === undefined
        ? {}
        : { timeoutMs: dependencies.heartbeatTimeoutMs }),
    });

    const closed = new Promise<void>((resolve) => {
      socket.onClose(() => resolve());
    });
    await Promise.race([closed, stopping]);

    heartbeat.stop();
    held = null;
    if (stopped) socket.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
  };

  /**
   * One dial and handshake, abandoned if the hub stops while it is in flight.
   *
   * Abandoned, not cancelled: a dial cannot be taken back. What the guard on
   * the promise does is make sure that a socket handed over after the hub
   * stopped is closed rather than left open with nobody holding it.
   */
  const attemptHandshake = async (): Promise<HandshakeOutcome | 'stopping'> => {
    const attempt = handshakeWithServer(target, {
      dialer,
      hubId,
      timers,
      logger,
      ...(dependencies.handshakeTimeoutMs === undefined
        ? {}
        : { timeoutMs: dependencies.handshakeTimeoutMs }),
    });

    void attempt.then((outcome) => {
      if (stopped && outcome.ok) outcome.socket.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
    });

    return Promise.race([attempt, stopping]);
  };

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const outcome = await attemptHandshake();
        if (stopped || outcome === 'stopping') break;

        if (!outcome.ok) {
          goStale(outcome.reason, outcome.problem);
          await waitToRetry();
          continue;
        }

        const recorded = await recordHandshake(database, clock, registration.id, {
          serverId: outcome.serverId,
          stores: outcome.stores,
        });

        if (stopped) {
          outcome.socket.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
          break;
        }

        if (recorded.kind === 'revoked') {
          // The operator said this server may no longer be dialled, and the
          // fact that it answered does not undo that. Nothing to retry.
          outcome.socket.close(closure(CLOSE_NORMAL, 'this pairing has been revoked'));
          logger.info('pairing revoked; not dialling again');
          stopped = true;
          break;
        }

        if (recorded.kind === 'identity-changed') {
          outcome.socket.close(closure(CLOSE_POLICY, 'this pairing names a different server'));
          goStale(
            'identity-changed',
            `this pairing was completed with ${recorded.paired}, and the server now calls itself ${recorded.presented}; pair the machine again`,
          );
          await waitToRetry();
          continue;
        }

        // The database's list, not the server's: it is deduplicated there, and
        // a server reporting one volume under two mounts is one store.
        goConnected(
          outcome.serverId,
          recorded.stores.map((store) => store.storeId),
        );
        await hold(outcome.socket, outcome.nextFrameId);
        if (stopped) break;

        goStale('dropped', 'the connection to the server ended');
        await waitToRetry();
      } catch (error) {
        // The hub's own side failed -- almost certainly the database. The
        // server is not at fault and its rows are untouched, but the hub
        // cannot claim a connection it failed to record, so it says so with a
        // reason that points at itself rather than blaming the machine.
        held?.close(closure(CLOSE_NORMAL, 'the hub could not record this connection'));
        held = null;
        goStale('hub-error', `the hub could not record the connection: ${String(error)}`);
        await waitToRetry();
      }
    }

    phase = 'stopped';
    connectedSince = null;
    held = null;
    changed();
  };

  const finished = run();

  return {
    get report(): ServerConnectionReport {
      return report();
    },
    stop(): Promise<void> {
      stopped = true;
      beginStopping();
      held?.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
      return finished;
    },
  };
}
