import {
  parseServerToHubFrame,
  parseTextFrame,
  type FrameId,
  type HubId,
  type HubToServerFrame,
  type RefusalCode,
  type ServerId,
  type ServerRegistrationId,
  type ServerToHubFrame,
  type SessionDescriptor,
  type SessionHold,
  type StoreId,
} from '@agentplex/protocol';
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
import type { LiveServerRegistration } from '../pairing/server-registrations.js';
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

/**
 * What the hub asks a connected server to do.
 *
 * The instruction frames themselves, minus the id: a frame id is unique within
 * one connection and the connection is the only thing that can mint one, so a
 * caller that supplied its own would be numbering frames on a socket it does
 * not own. Derived from the wire union rather than restated, so that a field
 * added to an instruction is a field this carries, without an edit.
 */
type WithoutFrameId<Frame> = Frame extends { id: FrameId } ? Omit<Frame, 'id'> : never;

export type SessionInstruction = WithoutFrameId<
  Extract<HubToServerFrame, { type: 'session-start' | 'session-stop' }>
>;

/** What a server answers an instruction with when it did it. */
export type SessionAnswer = Extract<
  ServerToHubFrame,
  { type: 'session-started' | 'session-stopped' }
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
  | { readonly ok: true; readonly answer: SessionAnswer }
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

/**
 * How long an instruction may go unanswered.
 *
 * Longer than the handshake deadline, because a start is not a round trip on a
 * socket: the server scans a store and forks a process behind it. Short enough
 * that a client is not left with a spinner nothing will ever resolve -- a
 * deadline missed here is reported as a refusal the user can act on, and the
 * heartbeat is what decides whether the machine itself is still there.
 */
export const DEFAULT_INSTRUCTION_TIMEOUT_MS = 30_000;

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
  /**
   * Called with every store report this server sends, unsolicited.
   *
   * The reducer's other seam. Reports arrive whole and on the server's own
   * schedule -- after a handshake, and after anything it did changes what it is
   * running -- so there is nothing here to request and nothing to correlate.
   */
  readonly onReport?: (report: ServerStoreReport) => void;
  readonly instructionTimeoutMs?: number;
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
   * Puts one instruction to this server and waits for its answer.
   *
   * Refuses rather than throwing when there is no connection to put it on: a
   * machine that is asleep is the ordinary state of a laptop, and the caller
   * has a client waiting for a sentence either way. Queueing it until the
   * server comes back was the alternative and is worse -- a start that lands
   * ten minutes later, on a session the user has since opened somewhere else,
   * is an instruction nobody would still authorise.
   */
  ask(instruction: SessionInstruction): Promise<InstructionOutcome>;
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
  const instructionTimeoutMs = dependencies.instructionTimeoutMs ?? DEFAULT_INSTRUCTION_TIMEOUT_MS;
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
  /**
   * How to speak on the connection now held, or `null` when there is none.
   *
   * Set when a handshake settles and cleared when the socket ends, so that "is
   * there a connection to put this on" has one answer rather than a phase and a
   * socket that can disagree.
   */
  let speak: ((instruction: SessionInstruction) => Promise<InstructionOutcome>) | null = null;

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

  /**
   * The instructions this connection is waiting on answers to.
   *
   * Keyed by the frame id each was sent with, which is what a reply names. A
   * connection that ends settles every one of them as a refusal: an instruction
   * whose answer can no longer arrive is not a promise to leave pending, and
   * the client waiting on it is owed a sentence.
   */
  const outstanding = new Map<FrameId, (outcome: InstructionOutcome) => void>();

  const settleAll = (problem: string): void => {
    const waiting = [...outstanding.values()];
    outstanding.clear();
    for (const settle of waiting) settle({ ok: false, code: 'internal', problem, hold: null });
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

  const deliverReport = (report: ServerStoreReport): void => {
    if (pendingReports !== null) {
      pendingReports.push(report);
      return;
    }
    dependencies.onReport?.(report);
  };

  /**
   * Routes what a server says on an established connection.
   *
   * One parser for the direction, and the discriminated union it returns is
   * switched on rather than re-checked: an answer goes to whoever asked, a
   * report goes to the reducer, and the handshake frames belong to a handshake
   * that is already over. `pong` is the heartbeat's, which reads this socket
   * itself.
   */
  const receive = (frame: ServerToHubFrame): void => {
    switch (frame.type) {
      case 'session-started':
      case 'session-stopped': {
        outstanding.get(frame.replyTo)?.({ ok: true, answer: frame });
        outstanding.delete(frame.replyTo);
        return;
      }
      case 'session-refused': {
        outstanding.get(frame.replyTo)?.({
          ok: false,
          code: frame.code,
          problem: frame.message,
          hold: frame.hold,
        });
        outstanding.delete(frame.replyTo);
        return;
      }
      case 'store-report': {
        deliverReport({
          registrationId: registration.id,
          storeId: frame.storeId,
          sessions: frame.sessions,
          holding: frame.holding,
        });
        return;
      }
      case 'handshake-accepted':
      case 'handshake-rejected':
      case 'pong':
      case 'protocol-error':
        return;
    }
  };

  /**
   * Starts reading a socket the handshake just settled, before anything is
   * awaited on it.
   *
   * Subscribed here rather than in `hold` because there is a database write
   * between the two, and a listener attached after it would miss whatever the
   * server said in the meantime -- which is exactly when a server says the most,
   * since accepting a handshake is what makes it report its stores.
   */
  let frameIds: () => number = () => 0;

  const listen = (socket: MessageSocket, nextFrameId: () => number): void => {
    pendingReports = [];
    // The handshake's counter, continued: a frame id is unique within one
    // connection and the handshake already spent the first one. Both the
    // heartbeat and the instructions below draw from this same one.
    frameIds = nextFrameId;

    socket.onMessage((text) => {
      const parsed = parseTextFrame(parseServerToHubFrame, text);
      // Unreadable text is not this listener's to complain about, and it is not
      // silently ignored either: the handshake's parser owns the connection's
      // protocol errors, and a server that has started talking nonsense fails
      // the heartbeat that is asking it questions on the same socket.
      if (parsed.ok) receive(parsed.value);
    });

    speak = (instruction: SessionInstruction): Promise<InstructionOutcome> =>
      new Promise<InstructionOutcome>((resolve) => {
        const id = nextFrameId();
        let cancelDeadline: () => void = () => {};

        const settle = (outcome: InstructionOutcome): void => {
          cancelDeadline();
          resolve(outcome);
        };

        outstanding.set(id, settle);
        cancelDeadline = timers.schedule(instructionTimeoutMs, () => {
          if (!outstanding.delete(id)) return;
          // The connection is left alone. A server that is slow to answer one
          // instruction is not a server that has gone away, and that judgement
          // belongs to the heartbeat, which is asking its own question on the
          // same socket and closes when it goes unanswered.
          logger.warn('the server did not answer an instruction', {
            instruction: instruction.type,
            afterMs: instructionTimeoutMs,
          });
          resolve({
            ok: false,
            code: 'internal',
            problem: `the server did not answer within ${instructionTimeoutMs}ms`,
            hold: null,
          });
        });

        send(socket, { ...instruction, id });
      });
  };

  /** Lets through what arrived while the hub was recording the connection. */
  const deliverPendingReports = (): void => {
    const waiting = pendingReports ?? [];
    pendingReports = null;
    for (const report of waiting) dependencies.onReport?.(report);
  };

  /** Holds an established connection until it ends or the hub stops. */
  const hold = async (socket: MessageSocket): Promise<void> => {
    held = socket;
    const heartbeat = startHeartbeat(socket, {
      timers,
      logger,
      nextFrameId: frameIds,
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
    speak = null;
    pendingReports = null;
    settleAll('the connection to the server ended before it answered');
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

        // Before the database write below, so that nothing the server says in
        // the meantime is lost. Reports are buffered until the connection is
        // recorded; instructions cannot be put yet, because nothing above knows
        // this server is connected.
        listen(outcome.socket, outcome.nextFrameId);

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
        // After the state says this server is connected, because the reducer
        // refuses sessions from a server it has no connection for -- correctly,
        // and this is the ordering that keeps that from being a lie.
        deliverPendingReports();
        await hold(outcome.socket);
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
    ask(instruction: SessionInstruction): Promise<InstructionOutcome> {
      const speaking = speak;
      if (speaking === null) {
        return Promise.resolve({
          ok: false,
          code: 'refused',
          problem: `the hub is not connected to ${registration.label}`,
          hold: null,
        });
      }
      return speaking(instruction);
    },
    stop(): Promise<void> {
      stopped = true;
      beginStopping();
      held?.close(closure(CLOSE_NORMAL, 'the hub is stopping'));
      return finished;
    },
  };
}

/**
 * The one place an instruction becomes characters.
 *
 * Typed on the way out, so that a change to a frame's shape is a compile error
 * here rather than something the server's parser discovers.
 */
function send(socket: MessageSocket, frame: HubToServerFrame): void {
  socket.send(JSON.stringify(frame));
}
