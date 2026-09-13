import type { ProviderReadiness, ServerDraining, ServerId, StoreId } from '@agentplex/protocol';
import {
  type Clock,
  type Logger,
  closure,
  CLOSE_NORMAL,
  CLOSE_POLICY,
  type Timers,
} from '@agentplex/node-shared';
import type { LiveServerRegistration, Pairing } from '../pairing/pairing.js';
import type { BackoffPolicy } from './backoff.js';
import type { DrainingNotice } from './frame-router.js';
import type { DialTarget } from './server-handshake.js';
import type {
  InstructionOutcome,
  ServerConnectionPhase,
  ServerConnectionReport,
  ServerStoreReport,
  ServerInstruction,
  StaleReason,
} from './servers.js';
import type {
  ServerTransport,
  ServerTransportOpener,
  ServerTransportOutcome,
} from './transport.js';

/**
 * One paired server, kept connected.
 *
 * The transport below this connects once and answers with what happened. This
 * is the part that decides *when*: dial, hold what it got, and when that ends
 * -- refused, dropped, or never reached at all -- wait and dial again. It is
 * one object per pairing because a pairing is the unit the operator revokes,
 * the unit a token belongs to, and the unit that can be down while every other
 * one is up.
 *
 * Nothing here touches a socket. What a connection *is* lives behind
 * `ServerTransport`, and this file sees exactly three things about one: it can
 * be asked something, it says when a report arrives, and it ends. That is the
 * whole of the seam AGX-224 replaces, and keeping the loop on this side of it
 * is what makes the replacement a new transport rather than a new loop.
 *
 * One end of a connection can also be told what is about to happen to it. A
 * server that is going down says so first and keeps its sockets open while it
 * closes its turns, so this file holds a third state beside up and down: a
 * connection that is good, answering, and about to end. What that buys is the
 * close afterwards being expected -- named as a drain rather than a drop, and
 * dialled again when the machine said it would be back rather than half a
 * second later, which is the difference between a hub that waits and a hub
 * that hammers a box that is trying to shut down.
 *
 * The rule it exists to enforce is the one the connectivity design states
 * plainly: an unreachable server keeps its rows, marked stale, and its
 * sessions leave the attention count. So nothing here deletes anything. A
 * server that has been unreachable for a week still has its pairing, still has
 * its stores, and still reports the last time it was actually up -- labelled
 * with an age, never presented as current. A badge you cannot clear by looking
 * is worse than none, and the only way to keep that promise is for the thing
 * holding the connection to say honestly that it is not holding one.
 */

export interface DialLoopDependencies {
  /** What a completed handshake is recorded through. */
  readonly pairing: Pairing;
  /** How a connection is opened: the one seam to the wire. */
  readonly transports: ServerTransportOpener;
  readonly timers: Timers;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly backoff: BackoffPolicy;
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
   * The seam the fleet state attaches to. It is a callback rather than an
   * event emitter because there is one consumer and the ordering matters:
   * whatever builds a snapshot has to see the states in the order they
   * happened.
   */
  readonly onChange?: (report: ServerConnectionReport) => void;
  /**
   * Called with every store report this server sends, unsolicited.
   *
   * The fleet state's other seam. Reports arrive whole and on the server's own
   * schedule -- after a handshake, and after anything it did changes what it is
   * running -- so there is nothing here to request and nothing to correlate.
   */
  readonly onReport?: (report: ServerStoreReport) => void;
}

const DEFAULT_REFUSED_RETRY_MS = 60_000;

/**
 * What to say about a connection that ended the way its server said it would.
 *
 * The count is in the sentence because it is the difference between a machine
 * somebody should leave alone for a minute and one that had work on it when it
 * went. It is the count as of the notice and is described as such: whether
 * those sessions reached a boundary or were killed at the end of the grace is
 * the next handshake's answer, and this end cannot know it.
 */
function drainClosureWords(sessions: number): string {
  if (sessions === 0) return 'the server said it was shutting down, and then closed the connection';
  const named = sessions === 1 ? '1 session' : `${String(sessions)} sessions`;
  return `the server said it was shutting down with ${named} finishing, and then closed the connection`;
}

/** Nothing gets faster by dialling again. Only a person changes these. */
const NEEDS_A_PERSON: ReadonlySet<StaleReason> = new Set<StaleReason>([
  'unauthorized',
  'protocol-version',
  'identity-changed',
]);

export interface DialLoop {
  /** What this connection is, right now. */
  readonly report: ServerConnectionReport;
  /**
   * Puts one instruction to this server and waits for its answer.
   *
   * Refuses rather than throwing when there is no connection to put it on: a
   * machine that is asleep is the ordinary state of a laptop, and the caller
   * has a client waiting for a sentence either way. Queueing it until the
   * server comes back was the alternative and is worse -- a start that lands
   * ten minutes later, on a session the user has since opened somewhere else,
   * is an instruction nobody would still authorise.
   */
  ask(instruction: ServerInstruction): Promise<InstructionOutcome>;
  /**
   * Stops dialling and closes whatever is held. Resolves when the loop has
   * actually finished, so a hub shutdown cannot leave a dial in flight.
   */
  stop(): Promise<void>;
}

export function startDialLoop(
  registration: LiveServerRegistration,
  dependencies: DialLoopDependencies,
): DialLoop {
  const { pairing, transports, timers, clock, backoff } = dependencies;
  const logger = dependencies.logger.child({
    registrationId: registration.id,
    server: registration.label,
  });
  const refusedRetryMs = dependencies.refusedRetryMs ?? DEFAULT_REFUSED_RETRY_MS;
  const target: DialTarget = { address: registration.address, token: registration.token };

  let phase: ServerConnectionPhase = 'connecting';
  let serverId: ServerId | null = registration.serverId;
  let stores: readonly StoreId[] = [];
  let providers: readonly ProviderReadiness[] = [];
  let connectedSince: number | null = null;
  let staleSince: number | null = null;
  let lastConnectedAt: number | null = registration.lastConnectedAt;
  let failedAttempts = 0;
  let problem: string | null = null;
  let staleReason: StaleReason | null = null;
  /**
   * What this machine last said about going down, or `null`.
   *
   * Kept across the close it precedes rather than cleared at it, because it is
   * what makes the close legible: the reason the connection ended and the wait
   * before the next dial are both read off this, and both happen after the
   * socket is gone. Cleared by a handshake, which is the one event that says
   * the machine is not going down after all -- or has already gone and come
   * back, which amounts to the same thing for a row on a screen.
   */
  let draining: ServerDraining | null = null;

  let stopped = false;
  /**
   * The connection now held, or `null` when there is none.
   *
   * Set the moment a handshake settles and cleared when it ends, so that "is
   * there a connection to put this on" has one answer. It used to be two -- a
   * socket and the function that spoke on it -- which could disagree for the
   * length of a database write.
   */
  let held: ServerTransport | null = null;

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
    providers,
    connectedSince,
    staleSince,
    lastConnectedAt,
    failedAttempts,
    problem,
    staleReason,
    draining,
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

  const goConnected = (
    id: ServerId,
    mounted: readonly StoreId[],
    reported: readonly ProviderReadiness[],
  ): void => {
    phase = 'connected';
    serverId = id;
    stores = mounted;
    providers = reported;
    connectedSince = clock.now();
    lastConnectedAt = connectedSince;
    staleSince = null;
    staleReason = null;
    problem = null;
    failedAttempts = 0;
    // A machine that has just completed a handshake is not the machine that
    // was shutting down, even when it is the same box: whatever it was
    // draining is over, and the sessions it names below are the ones it has
    // now rather than the ones it was closing.
    draining = null;
    logger.info('server connected', {
      serverId: id,
      stores: mounted.length,
      providers: reported.map(({ provider, state }) => `${provider}:${state}`),
    });
    changed();
  };

  /**
   * The shortest this wait may be, whatever the curve says.
   *
   * Two reasons put a floor under a retry, and they are opposite kinds of
   * fact. A refusal only a person can fix gets one because nothing changes
   * until somebody acts, so dialling every half second only fills a log. A
   * drain gets one because the machine said when to come back: it is closing
   * its turns and then going down, and a hub that dialled at the first backoff
   * step would spend the whole grace window being refused by a server it was
   * told to leave alone. Honouring what it said is bounded by the backoff's own
   * ceiling, because a machine that names an hour must not take the hub off the
   * air for one -- and it is the whole grace even when the close came sooner,
   * since a server that finished draining early is still restarting.
   */
  const waitFloorMs = (): number => {
    if (staleReason === 'draining' && draining !== null) {
      return Math.min(draining.graceMs, backoff.ceilingMs);
    }
    if (staleReason !== null && NEEDS_A_PERSON.has(staleReason)) return refusedRetryMs;
    return 0;
  };

  /** Waits out the backoff, or returns early because the hub is stopping. */
  const waitToRetry = async (): Promise<void> => {
    const scheduled = backoff.delayMs(failedAttempts);
    const delay = Math.max(scheduled, waitFloorMs());

    logger.info('retrying', { inMs: delay, failedAttempts, reason: staleReason });
    let cancel: () => void = () => {};
    const slept = new Promise<void>((resolve) => {
      cancel = timers.schedule(delay, resolve);
    });
    await Promise.race([slept, stopping]);
    cancel();
  };

  /**
   * Reports that arrived before the hub had recorded the connection.
   *
   * A server sends its stores the moment it accepts a handshake, and the hub
   * has a database write to finish before it can say the connection exists.
   * That gap is real on a wire and not an artefact of any test: the reports
   * are held here and delivered once there is somewhere to put them, rather
   * than being dropped and waited out until the server next has a reason to
   * speak. `null` once the connection is established and reports go straight
   * through.
   */
  let pendingReports: ServerStoreReport[] | null = null;

  /**
   * A drain notice that arrived in that same gap, held for the same reason.
   *
   * Rare to the point of being a race nobody would hit on purpose -- the
   * machine would have to begin shutting down in the moment between accepting
   * a handshake and the hub finishing a database write -- and held anyway,
   * because the alternative is worse than dropping it: `goConnected` clears the
   * drain for the new connection, so a notice applied before it would be wiped
   * by the very handshake it arrived on, and the hub would forget a shutdown it
   * had been told about.
   */
  let pendingDrain: DrainingNotice | null = null;

  /**
   * Takes hold of a connection the transport just settled, before anything is
   * awaited on it.
   *
   * The handlers are attached here rather than after the database write below,
   * because handlers attached after it would miss whatever the server said in
   * the meantime -- which is exactly when a server says the most, since
   * accepting a handshake is what makes it report its stores.
   */
  /**
   * Takes down what a server said about going down.
   *
   * Dated here rather than on the frame, because the frame carries a duration
   * and not a deadline: the two machines' clocks disagree, so the end that
   * receives it is the end that can say when it arrived. The phase is left
   * exactly as it is -- this connection is up, and everything it could do a
   * moment ago it can still do.
   */
  const noteDraining = (notice: DrainingNotice): void => {
    draining = {
      since: clock.now(),
      graceMs: notice.graceMs,
      sessions: [...notice.sessions],
    };
    logger.info('server draining', {
      graceMs: notice.graceMs,
      sessions: notice.sessions.length,
    });
    changed();
  };

  const take = (transport: ServerTransport): void => {
    held = transport;
    pendingReports = [];
    pendingDrain = null;
    transport.watch({
      onReport: (frame) => {
        const arrived: ServerStoreReport = {
          registrationId: registration.id,
          storeId: frame.storeId,
          sessions: frame.sessions,
          holding: frame.holding,
        };
        if (pendingReports !== null) {
          pendingReports.push(arrived);
          return;
        }
        dependencies.onReport?.(arrived);
      },
      onDraining: (notice) => {
        if (pendingReports !== null) {
          pendingDrain = notice;
          return;
        }
        noteDraining(notice);
      },
    });
  };

  /** Lets through what arrived while the hub was recording the connection. */
  const deliverPending = (): void => {
    const waiting = pendingReports ?? [];
    pendingReports = null;
    for (const arrived of waiting) dependencies.onReport?.(arrived);

    const announced = pendingDrain;
    pendingDrain = null;
    if (announced !== null) noteDraining(announced);
  };

  /** Holds an established connection until it ends or the hub stops. */
  const hold = async (transport: ServerTransport): Promise<void> => {
    await Promise.race([transport.closed, stopping]);

    held = null;
    pendingReports = null;
    pendingDrain = null;
    if (stopped) transport.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
  };

  /**
   * One dial and handshake, abandoned if the hub stops while it is in flight.
   *
   * Abandoned, not cancelled: a dial cannot be taken back. What the guard on
   * the promise does is make sure that a connection handed over after the hub
   * stopped is closed rather than left open with nobody holding it.
   */
  const attemptConnection = async (): Promise<ServerTransportOutcome | 'stopping'> => {
    const attempt = transports.open(target);

    void attempt.then((outcome) => {
      if (stopped && outcome.ok) {
        outcome.transport.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
      }
    });

    return Promise.race([attempt, stopping]);
  };

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const outcome = await attemptConnection();
        if (stopped || outcome === 'stopping') break;

        if (!outcome.ok) {
          goStale(outcome.reason, outcome.problem);
          await waitToRetry();
          continue;
        }

        // Before the database write below, so that nothing the server says in
        // the meantime is lost. Reports are buffered until the connection is
        // recorded; instructions cannot be put yet, because nothing above knows
        // this server is connected.
        take(outcome.transport);

        const recorded = await pairing.recordHandshake(registration.id, {
          serverId: outcome.serverId,
          stores: outcome.stores,
        });

        if (stopped) {
          outcome.transport.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
          break;
        }

        if (recorded.kind === 'revoked') {
          // The operator said this server may no longer be dialled, and the
          // fact that it answered does not undo that. Nothing to retry.
          outcome.transport.close(closure(CLOSE_NORMAL, 'this pairing has been revoked'));
          logger.info('pairing revoked; not dialling again');
          stopped = true;
          break;
        }

        if (recorded.kind === 'identity-changed') {
          outcome.transport.close(closure(CLOSE_POLICY, 'this pairing names a different server'));
          goStale(
            'identity-changed',
            `this pairing was completed with ${recorded.paired}, and the server now calls itself ${recorded.presented}; pair the machine again`,
          );
          await waitToRetry();
          continue;
        }

        // The database's list, not the server's: it is deduplicated there, and
        // a server reporting one volume under two mounts is one store.
        // The stores come from the database and the providers from the frame,
        // and the asymmetry is deliberate: a store has a durable row the hub
        // deduplicates, and a provider's readiness is a reading this server
        // took at its own boot with nothing on the hub's side to reconcile it
        // against.
        goConnected(
          outcome.serverId,
          recorded.stores.map((store) => store.storeId),
          outcome.providers,
        );
        // After the state says this server is connected, because the fleet
        // state refuses sessions from a server it has no connection for --
        // correctly, and this is the ordering that keeps that from being a lie.
        deliverPending();
        await hold(outcome.transport);
        if (stopped) break;

        // The close a drain warned about is a different event from a machine
        // that went quiet, and only this end has both halves to join: the
        // notice arrived on the connection that has just ended. Saying
        // `dropped` here would throw away the one fact that tells an operator
        // to wait rather than go and look at the machine.
        if (draining === null) {
          goStale('dropped', 'the connection to the server ended');
        } else {
          goStale('draining', drainClosureWords(draining.sessions.length));
        }
        await waitToRetry();
      } catch (error) {
        // The hub's own side failed -- almost certainly the database. The
        // server is not at fault and its rows are untouched, but the hub
        // cannot claim a connection it failed to record, so it says so with a
        // reason that points at itself rather than blaming the machine.
        held?.close(closure(CLOSE_NORMAL, 'the hub could not record this connection'));
        held = null;
        pendingReports = null;
        pendingDrain = null;
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
    ask(instruction: ServerInstruction): Promise<InstructionOutcome> {
      const transport = held;
      if (transport === null) {
        return Promise.resolve({
          ok: false,
          code: 'refused',
          problem: `the hub is not connected to ${registration.label}`,
          hold: null,
        });
      }
      return transport.ask(instruction);
    },
    stop(): Promise<void> {
      stopped = true;
      beginStopping();
      held?.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
      return finished;
    },
  };
}
