import type {
  Provider,
  RefusalCode,
  SessionDescriptor,
  SessionHold,
  SessionId,
  SessionRef,
  StoreDescriptor,
  StoreId,
} from '@agentplex/protocol';
import type { Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import type { ProviderRegistry } from './providers/provider-registry.js';
import { discoverStoreSessions } from './providers/store-discovery.js';
import type { Terminal, TerminalManager, TerminalOutcome } from './terminal-manager.js';

/**
 * What a server does when a hub tells it to run a session.
 *
 * The instruction that arrives names a store, a provider and at most a session
 * id. Everything a process actually needs -- an executable, an argv, a working
 * directory, an environment -- is resolved here, on this machine, out of the
 * two things that are allowed to produce it: the store this server has mounted,
 * and the adapter registered for that provider. Nothing off the wire reaches a
 * spawn, and there is no field on the frame through which it could.
 *
 * The working directory is the clearest case. `SpawnRequest.cwd` is the store's
 * own path as this server resolved it at boot, and a resume's is whatever the
 * provider itself recorded in the transcript, read back by the adapter. A hub
 * cannot influence either, which is what makes a stolen client token worth a
 * session in a store somebody already mounted rather than a shell anywhere on
 * the machine.
 *
 * The one-live-process-per-session rule is enforced here as well as at the hub.
 * The hub refuses the case only it can see -- a session held by a different
 * server on the same volume -- and this refuses the case only it can see, which
 * is anything that started between the hub reading its state and the
 * instruction arriving. Neither check makes the other redundant.
 */

export interface SessionControllerDependencies {
  /** What this server has mounted. A store not in here cannot be run in. */
  readonly stores: readonly StoreDescriptor[];
  readonly providers: ProviderRegistry;
  readonly terminals: TerminalManager;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface StartSessionRequest {
  readonly storeId: StoreId;
  /** The session to resume, or `null` to start one the provider will name. */
  readonly sessionId: SessionId | null;
  readonly provider: Provider;
  readonly prompt: string | null;
}

/**
 * What this server did, or why it did nothing.
 *
 * `hold` names the live process when that is the reason, so a hub whose view
 * was a moment out of date is told the fact it was missing rather than only
 * that it was wrong.
 */
export type SessionOutcome =
  | {
      readonly ok: true;
      readonly storeId: StoreId;
      /** `null` for a spawn: the provider has not written its id yet. */
      readonly sessionId: SessionId | null;
    }
  | {
      readonly ok: false;
      readonly code: RefusalCode;
      readonly problem: string;
      readonly hold: SessionHold | null;
    };

/** One server's whole view of one store, as it sends it. */
export interface StoreReport {
  readonly storeId: StoreId;
  readonly sessions: readonly SessionDescriptor[];
  readonly holding: readonly SessionHold[];
}

export interface SessionController {
  start(request: StartSessionRequest): Promise<SessionOutcome>;
  stop(session: SessionRef): SessionOutcome;
  /**
   * Everything this server can see in one store, and what it is running there.
   *
   * Scanning rather than reading a cache, because the answer is a claim about
   * the disk right now and this is what the hub publishes. It also does the two
   * pieces of bookkeeping that only a scan can do: it joins a freshly spawned
   * terminal to the session id the provider has since written, and it hands
   * each session's derived status back to the terminal holding it, which is
   * what decides whether a stop may be offered.
   */
  report(storeId: StoreId): Promise<StoreReport | null>;
}

export function createSessionController(
  dependencies: SessionControllerDependencies,
): SessionController {
  const { stores, providers, terminals, clock } = dependencies;
  const logger = dependencies.logger.child({ part: 'sessions' });

  const storeOf = (storeId: StoreId): StoreDescriptor | undefined =>
    stores.find((store) => store.storeId === storeId);

  /** The live terminals for one store, whichever session each is on. */
  const liveIn = (storeId: StoreId): readonly Terminal[] =>
    terminals.terminals.filter(
      (terminal) => terminal.storeId === storeId && terminal.run.exit === null,
    );

  const answer = (storeId: StoreId, outcome: TerminalOutcome): SessionOutcome => {
    if (outcome.ok) {
      return { ok: true, storeId, sessionId: outcome.terminal.session?.sessionId ?? null };
    }
    return {
      ok: false,
      code: 'refused',
      problem: outcome.problem,
      hold:
        outcome.holder === null || outcome.holder.sessionId === null
          ? null
          : { sessionId: outcome.holder.sessionId, stoppable: outcome.holder.stoppable },
    };
  };

  return {
    async start(request: StartSessionRequest): Promise<SessionOutcome> {
      const store = storeOf(request.storeId);
      if (store === undefined) {
        // The hub asked a machine that does not have the volume. Its own view
        // of what this server has mounted is out of date, which is a fact worth
        // returning plainly rather than a spawn to attempt in some other
        // directory.
        return {
          ok: false,
          code: 'refused',
          problem: 'this server does not have that store mounted',
          hold: null,
        };
      }

      // Parsed, never cast: a provider name is a claim like any other, and the
      // registry is the only thing that turns one into an adapter.
      const found = providers.lookup(request.provider);
      if (!found.ok) {
        return { ok: false, code: 'refused', problem: found.problem, hold: null };
      }
      const { adapter } = found;

      if (request.sessionId === null) {
        // The store's own path, resolved by this server at boot. The frame
        // could not have supplied one, and this is the only value there is.
        const launch = adapter.spawn({ store, cwd: store.path, prompt: request.prompt });
        const started = terminals.spawn(store, launch);
        logger.info('session spawn', { storeId: store.storeId, ok: started.ok });
        return answer(store.storeId, started);
      }

      const session: SessionRef = { storeId: store.storeId, sessionId: request.sessionId };

      // A resume needs the directory the session already ran in, and only the
      // provider's own files know it. Nobody gets to choose it: a session
      // resumed elsewhere is a different session that happens to share a
      // history, and every relative path in that history now points somewhere
      // else.
      const known = await discover(store);
      const descriptor = known.find((one) => one.sessionId === request.sessionId);
      if (descriptor === undefined) {
        return {
          ok: false,
          code: 'refused',
          problem: 'this server cannot find that session in that store',
          hold: null,
        };
      }

      const launch = adapter.resume({ store, session, cwd: descriptor.cwd });
      const resumed = terminals.resume(session, launch);
      logger.info('session resume', { ...session, ok: resumed.ok });
      return answer(store.storeId, resumed);
    },

    stop(session: SessionRef): SessionOutcome {
      const holder = terminals.holder(session);
      if (holder === undefined) {
        return {
          ok: false,
          code: 'refused',
          problem: 'this server is not running that session',
          hold: null,
        };
      }

      // The terminal id is looked up here and never travels: the hub addressed
      // a session, and the process handle stays on the machine that owns it.
      const stopped = terminals.stop(holder.terminalId);
      if (!stopped.ok) {
        return {
          ok: false,
          code: 'refused',
          problem: stopped.problem,
          hold: { sessionId: session.sessionId, stoppable: holder.stoppable },
        };
      }

      logger.info('session stopped', { ...session });
      return { ok: true, storeId: session.storeId, sessionId: session.sessionId };
    },

    async report(storeId: StoreId): Promise<StoreReport | null> {
      const store = storeOf(storeId);
      if (store === undefined) return null;

      const sessions = await discover(store);
      bindSpawned(store.storeId, sessions);

      // Derived once, by the adapter, and handed to the terminal holding the
      // session. It is what `stoppable` is computed from, so a status nobody
      // fed back would leave every terminal reporting `unknown` and every
      // session offering a stop button.
      for (const descriptor of sessions) {
        terminals.observe({ storeId, sessionId: descriptor.sessionId }, descriptor.status);
      }

      return { storeId, sessions, holding: holdsIn(storeId) };
    },
  };

  async function discover(store: StoreDescriptor): Promise<readonly SessionDescriptor[]> {
    const found = await discoverStoreSessions(store, {
      registry: providers,
      clock,
      liveness: terminals,
    });
    for (const { provider, subject, problem } of found.problems) {
      // A session that cannot be read costs itself, never the listing.
      logger.warn('session unreadable', { provider, subject, problem });
    }
    return found.sessions;
  }

  /** What this server is running in a store, in the form the hub reads it. */
  function holdsIn(storeId: StoreId): readonly SessionHold[] {
    const holds: SessionHold[] = [];
    for (const terminal of liveIn(storeId)) {
      const session = terminal.session;
      if (session === null) continue;
      holds.push({ sessionId: session.sessionId, stoppable: terminal.stoppable });
    }
    return holds;
  }

  /**
   * Joins a terminal this server spawned to the session id the provider has
   * since written.
   *
   * A spawn cannot name its session up front -- that would mean `--session-id`,
   * the flag family that splits a history in two -- so the id has to be found
   * afterwards, and a scan is the only thing that can find it. The join is by
   * time: a session whose provider first wrote to it at or after a terminal
   * started, that no live terminal already holds, is that terminal's.
   *
   * It binds only when exactly one session fits, and that is the conservative
   * direction rather than the convenient one. Binding the wrong session would
   * make this server claim to hold a session somebody else is running, which is
   * the one claim the hub acts on: it would refuse a legitimate start and offer
   * a stop button aimed at the wrong process. An unbound terminal is merely a
   * session the hub does not yet know is held, which the next scan fixes.
   */
  function bindSpawned(storeId: StoreId, sessions: readonly SessionDescriptor[]): void {
    const unbound = liveIn(storeId)
      .filter((terminal) => terminal.session === null)
      .sort((left, right) => left.run.startedAt - right.run.startedAt);
    if (unbound.length === 0) return;

    const claimed = new Set(holdsIn(storeId).map((hold) => hold.sessionId));

    for (const terminal of unbound) {
      const candidates = sessions.filter(
        (session) => !claimed.has(session.sessionId) && session.updatedAt >= terminal.run.startedAt,
      );

      const [only] = candidates;
      if (only === undefined || candidates.length > 1) {
        logger.info('a spawned terminal has no session id yet', {
          storeId,
          candidates: candidates.length,
        });
        continue;
      }

      const bound = terminals.bind(terminal.terminalId, only.sessionId);
      if (!bound.ok) {
        logger.warn('could not bind a spawned terminal', {
          storeId,
          sessionId: only.sessionId,
          problem: bound.problem,
        });
        continue;
      }

      claimed.add(only.sessionId);
      logger.info('spawned terminal bound to its session', {
        storeId,
        sessionId: only.sessionId,
      });
    }
  }
}
