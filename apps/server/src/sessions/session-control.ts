import type {
  Activity,
  Provider,
  RefusalCode,
  SessionDescriptor,
  SessionHold,
  SessionId,
  SessionPause,
  SessionRef,
  StoreDescriptor,
  StoreId,
} from '@agentplex/protocol';
import { SESSION_BRANCH_MAX_CHARS } from '@agentplex/protocol';
import type { Clock, Logger, Timers } from '@agentplex/node-shared';
import {
  PID_RECYCLE_TOLERANCE_MS,
  type LiveProcess,
  type ProcessProbe,
  type ProviderAdapter,
  type ProviderRegistry,
  type SessionOrigin,
  discoverStoreSessions,
} from '@agentplex/providers';
import type { LaunchApprovals, OpenLaunchApproval } from '../approvals/approval-launch.js';
import type { DirectoryGuard } from '../directories/directory-browse.js';
import {
  KILL_GRACE_MS,
  type Terminal,
  type TerminalManager,
  type TerminalOutcome,
} from '../terminal/terminal-manager.js';
import { readWorkingTrees, type WorkingTree } from '../working-tree/working-tree.js';
import type { ProcessSignaller } from './process-signaller.js';

/**
 * What a server does when a hub tells it to run a session.
 *
 * The instruction that arrives names a store, a provider, at most a session id
 * and at most a directory. The executable, the argv and the environment are
 * resolved here, on this machine, out of the two things that are allowed to
 * produce them: the store this server has mounted, and the adapter registered
 * for that provider. No argv element and no environment variable comes off the
 * wire, and there is no field on the frame through which one could.
 *
 * The working directory is the one that is not like the others, and it is worth
 * reading the whole rule rather than the headline. Three of them exist:
 *
 *   * A resume runs where the provider itself recorded the session ran, read
 *     back out of the transcript by the adapter. Nobody chooses it, and a start
 *     that named both a session and a directory is refused rather than served
 *     with one of the two.
 *   * A plain spawn runs in the home directory of the account this server runs
 *     as, which `main` read once at boot. Not the store's own path: a store is
 *     the provider's own state, and the providers' working-directory guard
 *     refuses to start an agent there on every launch. A frame could not have
 *     supplied the home directory either, and that guard still judges it.
 *   * A spawn in a project runs in the directory on the instruction -- and only
 *     if `browse.allow` says this machine will open it: an existing directory
 *     whose real path sits under a root *this machine's operator* configured,
 *     a list nothing on the wire can add to and which is empty by default. A
 *     machine nobody has configured runs no project start at all, and says so.
 *
 * The third is the amended rule and not a hole in the old one. What a stolen
 * client token is worth is still bounded by somebody's configuration: a session
 * in a store already mounted, or a session in a directory an operator listed.
 * It was never bounded by "no path crosses" alone -- it is bounded by there
 * being nowhere a path can reach that this machine has not already agreed to.
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
  /**
   * How a scan finds out what git says about the directories it just read: the
   * branch, and what is uncommitted.
   *
   * A dependency rather than something built here, for the reason the terminals
   * are: it starts a child, and the runner underneath it fixes what a child
   * inherits, which only `main` may decide.
   */
  readonly workingTree: WorkingTree;
  /**
   * Whether this machine will open a directory that arrived on an instruction.
   *
   * The guard half of the browser and not the browser itself, so that nothing
   * on a session start's path can list anybody's disk. The rule it applies is
   * the same one a browse passes, over the same roots, in the same file -- a
   * second containment test here would be a second answer to the question that
   * decides whether a spawn is bounded.
   */
  readonly browse: DirectoryGuard;
  /**
   * How a launch is given a way to ask this machine before it runs a tool, or
   * `null` on a server that has none.
   *
   * It is prepared here because here is where a launch is built, and it is
   * retired when the process ends because a launch is exactly what a hook's
   * secret belongs to: there is no session id at a spawn -- the provider mints
   * its own moments later -- so the launch is the only thing there is to key on.
   *
   * `null` is a server that could not open the socket hooks connect to, or one
   * whose providers have no hook to point at it. Its sessions run and its
   * agents ask at their own terminals, which is what a machine with no
   * agentplex on it does.
   */
  readonly approvals: LaunchApprovals | null;
  /**
   * The home directory of the account this server runs as, where a start that
   * names no project runs.
   *
   * On the `--system` tier that is `/var/lib/agentplex`, and stores are set up
   * as `<home>/.claude`, so a store sits under the home and never the reverse:
   * the guard every launch passes accepts the home where it refuses the store.
   * Injected rather than read here because it is a fact about the machine, and
   * a test has to be able to name one.
   */
  readonly homeDirectory: string;
  /**
   * How a retake ends a process this server did not start. Injected because a
   * test cannot supply one that ignores SIGHUP, and because the only real one
   * belongs in `main`, where every signal this server can send is in one place.
   */
  readonly signaller: ProcessSignaller;
  /**
   * The process table, which is what a retake asks whether the process it
   * signalled has gone. Not the provider's registry: that is the process's own
   * bookkeeping, and Claude Code drops its entry while it is still handling
   * the SIGHUP.
   */
  readonly processes: ProcessProbe;
  /** A retake's polls and its grace before SIGKILL, which a test fires by hand. */
  readonly timers: Timers;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface StartSessionRequest {
  readonly storeId: StoreId;
  /** The session to resume, or `null` to start one the provider will name. */
  readonly sessionId: SessionId | null;
  readonly provider: Provider;
  readonly prompt: string | null;
  /**
   * Where to spawn, when the hub is starting this session in a project, and
   * `null` for the home directory of the account this server runs as.
   *
   * A claim like every other thing off a wire, and checked like one: it reaches
   * a spawn only through `browse.allow`, and only as `cwd`.
   */
  readonly directory: string | null;
}

/**
 * A session to take over from a provider process outside agentplex.
 *
 * Named, like a stop, and never a process: the pid comes out of the provider's
 * own registry, verified at the moment it is signalled.
 */
export interface RetakeSessionRequest {
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  /** Which adapter knows where this provider registers its processes. */
  readonly provider: Provider;
}

/**
 * A process a retake sent SIGHUP: the one the adapter verified, and when, by
 * this server's clock, the signal went.
 *
 * The moment is kept because a pid reissued to somebody else belongs to a
 * process started after it, and that is the only thing that tells a reissue
 * from the same process dated later by a clock that stepped forward.
 */
interface SignalledProcess {
  readonly process: LiveProcess;
  readonly signalledAt: number;
}

/** How often a retake asks whether the process it signalled has gone. */
export const RETAKE_POLL_MS = 250;

/**
 * How long a retake waits for the process to go before it gives up: the grace
 * a process gets before SIGKILL, and two seconds after it for the kernel to
 * take a killed process down and the registry to say so.
 */
export const RETAKE_BOUND_MS = KILL_GRACE_MS + 2_000;

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
      /**
       * This server's own name for the process that was started.
       *
       * It never crosses a wire -- a terminal id is a handle on a process on
       * this machine, and a peer that could name one could name any of them.
       * It is on the outcome because the connection has to be able to join the
       * start handle it was asked with to the terminal that answered, which is
       * the only way a subscription can reach a spawn before the provider has
       * named the session.
       */
      readonly terminalId: string;
    }
  | {
      readonly ok: false;
      readonly code: RefusalCode;
      readonly problem: string;
      readonly hold: SessionHold | null;
    };

/**
 * What became of a pause or a resume: the pause the session is now under, or a
 * refusal in the shape a start's has. Both instructions answer with this one
 * type because both leave the session under some pause -- `none` after a
 * resume -- and the connection reads that word to know what it is confirming.
 */
export type PauseOutcome =
  | {
      readonly ok: true;
      readonly storeId: StoreId;
      readonly sessionId: SessionId;
      readonly pause: SessionPause;
    }
  | {
      readonly ok: false;
      readonly code: RefusalCode;
      readonly problem: string;
      readonly hold: SessionHold | null;
    };

export interface TranscriptSessionRequest {
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  /**
   * Which adapter reads the file, named by the hub off the row it already
   * holds for this session.
   *
   * A name and never an argument, exactly as a start's is: the registry is the
   * only thing that turns one into an adapter, and a name nobody implements is
   * a refusal rather than an `undefined` three calls later. It is on the
   * instruction rather than being searched for here because the hub knows the
   * answer and this server would otherwise walk every provider's layout to
   * rediscover it.
   */
  readonly provider: Provider;
  /** How many activities to answer with, bounded by the protocol on the way in. */
  readonly count: number;
}

/**
 * The tail of one session's work, or why this machine will not produce it.
 *
 * A `code` beside the problem, like a start's refusal and unlike the adapter's,
 * because the two failures reach a person differently: `refused` is this
 * machine understanding the request and declining it -- a store it does not
 * have, a provider it cannot drive, a session that is not there -- and
 * `internal` is this machine breaking on its own side, where retrying may work.
 * There is no `hold`: a transcript is a file, and no live process is the reason
 * one cannot be read.
 */
export type TranscriptOutcome =
  | {
      readonly ok: true;
      readonly activities: readonly Activity[];
      /** Whether the session did more before the oldest of these. */
      readonly olderExist: boolean;
    }
  | { readonly ok: false; readonly code: RefusalCode; readonly problem: string };

/** One server's whole view of one store, as it sends it. */
export interface StoreReport {
  readonly storeId: StoreId;
  readonly sessions: readonly SessionDescriptor[];
  readonly holding: readonly SessionHold[];
}

export interface SessionController {
  start(request: StartSessionRequest): Promise<SessionOutcome>;
  /**
   * Ends the process an outside terminal is running a session in, and resumes
   * the session here. Answers as a resume does, or refuses in words; it never
   * signals a process it could not verify at that moment, nor one mid-turn.
   */
  retake(request: RetakeSessionRequest): Promise<SessionOutcome>;
  stop(session: SessionRef): SessionOutcome;
  /** Withholds a session's input from its next turn boundary. Kills nothing. */
  pause(session: SessionRef): PauseOutcome;
  /** Lifts the pause. The process was never touched, so there is nothing to restart. */
  resume(session: SessionRef): PauseOutcome;
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
  /**
   * One session's transcript, as the activities the provider's own file
   * records.
   *
   * Beside `report` rather than folded into it, because they answer different
   * questions at different rates: a report is every session in a store, sent
   * unasked every couple of seconds, and reduces each session to one line; this
   * is one session's history, read because somebody opened it, and never sent
   * unasked. Nothing is cached between the two -- the file is the truth, and a
   * transcript held from the last scan would be a screen showing what a session
   * was doing a minute ago.
   */
  transcript(request: TranscriptSessionRequest): Promise<TranscriptOutcome>;
}

export function createSessionController(
  dependencies: SessionControllerDependencies,
): SessionController {
  const {
    stores,
    providers,
    terminals,
    workingTree,
    browse,
    approvals,
    homeDirectory,
    signaller,
    processes,
    timers,
    clock,
  } = dependencies;
  const logger = dependencies.logger.child({ part: 'sessions' });

  const storeOf = (storeId: StoreId): StoreDescriptor | undefined =>
    stores.find((store) => store.storeId === storeId);

  /** The live terminals for one store, whichever session each is on. */
  const liveIn = (storeId: StoreId): readonly Terminal[] =>
    terminals.terminals.filter(
      (terminal) => terminal.storeId === storeId && terminal.run.exit === null,
    );

  /**
   * Every session one of this server's own terminals has held, by store, for
   * the life of this process.
   *
   * Kept here rather than read off the terminal table because the table
   * forgets: an exited terminal is the first thing the cap evicts, and the
   * session it held is exactly the one a later spawn must not take. One id per
   * session this server ever ran is a set that stays small.
   */
  const ours = new Map<StoreId, Set<SessionId>>();

  /**
   * The sessions a retake is taking over right now, by store.
   *
   * Only this server can know it. Between the SIGHUP and the resume the
   * signalled process drops its registry entry and may already have a dead
   * pid while it flushes its transcript, so a scan in that window sees the
   * session run by nothing -- and a start or a second retake acting on that
   * scan would put a second process on the transcript the first still writes.
   * Claimed before a retake's first await and released when it settles,
   * whichever way.
   */
  const retaking = new Map<StoreId, Set<SessionId>>();

  const isRetaking = (session: SessionRef): boolean =>
    retaking.get(session.storeId)?.has(session.sessionId) === true;

  /**
   * The process each retake signalled and has not yet seen end, by store and
   * session: the pid, with the start date the adapter verified for it and the
   * moment it was signalled.
   *
   * A retake that gives up at its bound leaves a process this server signalled
   * still holding the pid, and Claude Code dropped its registry entry when the
   * SIGHUP arrived, so a scan reads the session as run by nothing. Kept until
   * the process table says that pid is dead or holds a later process, and
   * asked again at every start and retake of the session, because nothing
   * else on this machine still knows the process is there.
   */
  const outstanding = new Map<StoreId, Map<SessionId, SignalledProcess>>();

  const signalledFor = (session: SessionRef): SignalledProcess | undefined =>
    outstanding.get(session.storeId)?.get(session.sessionId);

  function rememberSignalled(session: SessionRef, signalled: SignalledProcess): void {
    const inStore = outstanding.get(session.storeId) ?? new Map<SessionId, SignalledProcess>();
    outstanding.set(session.storeId, inStore);
    inStore.set(session.sessionId, signalled);
  }

  function forgetSignalled(session: SessionRef): void {
    const inStore = outstanding.get(session.storeId);
    if (inStore === undefined) return;
    inStore.delete(session.sessionId);
    if (inStore.size === 0) outstanding.delete(session.storeId);
  }

  function oursIn(storeId: StoreId): Set<SessionId> {
    const known = ours.get(storeId) ?? new Set<SessionId>();
    ours.set(storeId, known);
    for (const terminal of terminals.terminals) {
      if (terminal.storeId !== storeId || terminal.session === null) continue;
      known.add(terminal.session.sessionId);
    }
    return known;
  }

  /**
   * Ties one launch's secret and settings file to the life of its process.
   *
   * Both ends of it are here because both are the same fact. A launch that
   * never started -- an adapter's refusal, a cap with nothing evictable behind
   * it -- is retired at once rather than leaving a live secret and a file
   * behind for a process that does not exist; one that did start is retired
   * when it exits, which is the moment the hook it points at can no longer be
   * running. `whenExited` settles whatever ended the process, including
   * an eviction and a shutdown, so there is no path that ends a process and
   * skips this -- and it settles for a caller that arrives after the exit,
   * which a subscription would not.
   */
  const retireWith = (outcome: TerminalOutcome, opened: OpenLaunchApproval | null): void => {
    if (opened === null) return;
    if (!outcome.ok) {
      opened.close();
      return;
    }
    void outcome.terminal.run.whenExited().then(() => void opened.close());
  };

  const answer = (storeId: StoreId, outcome: TerminalOutcome): SessionOutcome => {
    if (outcome.ok) {
      return {
        ok: true,
        storeId,
        sessionId: outcome.terminal.session?.sessionId ?? null,
        terminalId: outcome.terminal.terminalId,
      };
    }
    return {
      ok: false,
      code: 'refused',
      problem: outcome.problem,
      hold:
        outcome.holder === null || outcome.holder.sessionId === null
          ? null
          : {
              sessionId: outcome.holder.sessionId,
              stoppable: outcome.holder.stoppable,
              pause: outcome.holder.pause,
            },
    };
  };

  const notRunning = (): PauseOutcome => ({
    ok: false,
    code: 'refused',
    problem: 'this server is not running that session',
    hold: null,
  });

  const refused = (problem: string): SessionOutcome => ({
    ok: false,
    code: 'refused',
    problem,
    hold: null,
  });

  /** The refusal for a session one of this server's own terminals holds, naming the hold. */
  const alreadyHeld = (session: SessionRef): SessionOutcome => {
    const holder = terminals.holder(session);
    return {
      ok: false,
      code: 'refused',
      problem: 'this server is already running that session',
      hold:
        holder === undefined
          ? null
          : { sessionId: session.sessionId, stoppable: holder.stoppable, pause: holder.pause },
    };
  };

  /** The refusal for a session a retake here is in the middle of taking over. */
  const takingOver = (): SessionOutcome =>
    refused('agentplex is taking that session over on this machine; try again once it has');

  /** The refusal for a session whose signalled process has not been seen to end. */
  const stillSignalled = (): SessionOutcome =>
    refused(
      'the process agentplex signalled for that session has not exited yet, ' +
        'so this server will not start another beside it',
    );

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
        // The server account's home directory when the instruction named no
        // directory; otherwise the project's, once this machine has agreed to
        // open it. Either way the adapter's own guard judges it next.
        const cwd = await spawnDirectory(request.directory);
        if (!cwd.ok) {
          logger.info('session spawn refused', {
            storeId: store.storeId,
            directory: request.directory,
            problem: cwd.problem,
          });
          return { ok: false, code: cwd.code, problem: cwd.problem, hold: null };
        }

        const opened = await approvals?.open(store, adapter.permissionHook);
        const launch = adapter.spawn({
          store,
          cwd: cwd.directory,
          prompt: request.prompt,
          approval: opened?.approval ?? null,
        });
        const started = terminals.spawn(store, launch);
        retireWith(started, opened ?? null);
        logger.info('session spawn', {
          storeId: store.storeId,
          ok: started.ok,
          asks: opened !== undefined && opened !== null,
        });
        return answer(store.storeId, started);
      }

      if (request.directory !== null) {
        // Refused rather than ignored. A resume runs where its own transcript
        // says it ran, so an instruction carrying both was asking for two
        // different directories, and serving either would be choosing one
        // without saying so. The hub refuses this too; this is the half that
        // holds when the hub's view is a version behind.
        return {
          ok: false,
          code: 'refused',
          problem:
            'a session resumes in the directory its own transcript recorded, ' +
            'so a resume cannot be started in a directory',
          hold: null,
        };
      }

      return await resumeSession(store, adapter, {
        storeId: store.storeId,
        sessionId: request.sessionId,
      });
    },

    async retake(request: RetakeSessionRequest): Promise<SessionOutcome> {
      const store = storeOf(request.storeId);
      if (store === undefined) return refused('this server does not have that store mounted');

      const found = providers.lookup(request.provider);
      if (!found.ok) return refused(found.problem);
      const { adapter } = found;

      const session: SessionRef = { storeId: store.storeId, sessionId: request.sessionId };
      if (isRetaking(session)) return takingOver();
      const claimed = retaking.get(store.storeId) ?? new Set<SessionId>();
      retaking.set(store.storeId, claimed);
      claimed.add(session.sessionId);
      let outcome: SessionOutcome;
      try {
        outcome = await retakeSession(store, adapter, session);
      } finally {
        claimed.delete(session.sessionId);
        // A store's set goes with its last claim, so the map holds only the
        // retakes in flight rather than every store ever retaken in.
        if (claimed.size === 0 && retaking.get(store.storeId) === claimed) {
          retaking.delete(store.storeId);
        }
      }
      logger.info('session retake', {
        ...session,
        ok: outcome.ok,
        ...(outcome.ok ? {} : { problem: outcome.problem }),
      });
      return outcome;
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
          hold: { sessionId: session.sessionId, stoppable: holder.stoppable, pause: holder.pause },
        };
      }

      logger.info('session stopped', { ...session });
      return {
        ok: true,
        storeId: session.storeId,
        sessionId: session.sessionId,
        terminalId: holder.terminalId,
      };
    },

    pause(session: SessionRef): PauseOutcome {
      const holder = terminals.holder(session);
      if (holder === undefined) return notRunning();

      const paused = terminals.pause(holder.terminalId);
      if (!paused.ok) {
        return {
          ok: false,
          code: 'refused',
          problem: paused.problem,
          hold: { sessionId: session.sessionId, stoppable: holder.stoppable, pause: holder.pause },
        };
      }
      logger.info('session pause', { ...session, pause: paused.pause });
      return {
        ok: true,
        storeId: session.storeId,
        sessionId: session.sessionId,
        pause: paused.pause,
      };
    },

    resume(session: SessionRef): PauseOutcome {
      const holder = terminals.holder(session);
      if (holder === undefined) return notRunning();

      const resumed = terminals.unpause(holder.terminalId);
      if (!resumed.ok) {
        return {
          ok: false,
          code: 'refused',
          problem: resumed.problem,
          hold: { sessionId: session.sessionId, stoppable: holder.stoppable, pause: holder.pause },
        };
      }
      logger.info('session resumed', { ...session });
      return { ok: true, storeId: session.storeId, sessionId: session.sessionId, pause: 'none' };
    },

    async report(storeId: StoreId): Promise<StoreReport | null> {
      const store = storeOf(storeId);
      if (store === undefined) return null;

      const { sessions, origins } = await discover(store);
      bindSpawned(store.storeId, sessions, origins);

      // Derived once, by the adapter, and handed to the terminal holding the
      // session. It is what `stoppable` is computed from, so a status nobody
      // fed back would leave every terminal reporting `unknown` and every
      // session offering a stop button.
      for (const descriptor of sessions) {
        terminals.observe({ storeId, sessionId: descriptor.sessionId }, descriptor.status);
      }

      return {
        storeId,
        sessions: await withWorkingTree(store, sessions),
        holding: holdsIn(storeId),
      };
    },

    async transcript(request: TranscriptSessionRequest): Promise<TranscriptOutcome> {
      const store = storeOf(request.storeId);
      if (store === undefined) {
        // The hub asked a machine that does not have the volume, which is its
        // own view of the fleet being out of date rather than anything to
        // retry. The same sentence a start gets, for the same reason.
        return {
          ok: false,
          code: 'refused',
          problem: 'this server does not have that store mounted',
        };
      }

      // Parsed, never cast: a provider name off a frame is a claim, and the
      // registry is the only thing that turns one into an adapter.
      const found = providers.lookup(request.provider);
      if (!found.ok) return { ok: false, code: 'refused', problem: found.problem };

      let read;
      try {
        read = await found.adapter.transcript({
          store,
          session: { storeId: store.storeId, sessionId: request.sessionId },
          limit: request.count,
        });
      } catch (error) {
        // An adapter is somebody else's code once this is open source, and one
        // that throws must cost its own answer rather than the connection. The
        // same treatment `discoverStoreSessions` gives a broken adapter.
        logger.error('a provider adapter failed to read a transcript', {
          storeId: request.storeId,
          sessionId: request.sessionId,
          provider: request.provider,
          problem: String(error),
        });
        return {
          ok: false,
          code: 'internal',
          problem: 'this server could not read that transcript',
        };
      }

      // The adapter's own words, not a sentence composed here. Only it knows
      // where it looked and what it found there, and a session that has been
      // deleted since the hub's last scan is the ordinary case rather than a
      // fault of this machine.
      if (!read.ok) return { ok: false, code: 'refused', problem: read.problem };

      return {
        ok: true,
        activities: read.transcript.activities,
        olderExist: read.transcript.olderExist,
      };
    },
  };

  /**
   * Where a spawn runs: the home directory of the account this server runs
   * as, or a project's directory this machine has agreed to open.
   *
   * The home directory is passed on unjudged. Whether a provider may run there
   * is the adapter's working-directory guard's question, asked on every launch,
   * and it refuses a home that is the store, as it refuses the store itself.
   *
   * The allowed directory is the one that was asked for rather than the one it
   * resolved to, which is the decision `directory-browse.ts` argues: the
   * spawned session reports this string as its `cwd`, and the hub files it
   * under the project keyed by exactly that string.
   *
   * Between this check and the spawn is a window in which the directory could
   * be replaced, which is true of every check against a filesystem and is why
   * the bound that matters is the root list rather than this instant: an
   * operator configured a subtree, and nothing in that window moves the subtree.
   */
  async function spawnDirectory(
    directory: string | null,
  ): Promise<
    | { readonly ok: true; readonly directory: string }
    | { readonly ok: false; readonly code: RefusalCode; readonly problem: string }
  > {
    if (directory === null) return { ok: true, directory: homeDirectory };
    const allowed = await browse.allow(directory);
    if (allowed.ok) return { ok: true, directory: allowed.directory };
    return { ok: false, code: allowed.code, problem: allowed.problem };
  }

  /**
   * The resume half of a start, and the last step of a retake.
   *
   * A resume needs the directory the session already ran in, and only the
   * provider's own files know it. Nobody gets to choose it: a session resumed
   * elsewhere is a different session that happens to share a history, and
   * every relative path in that history now points somewhere else.
   *
   * After a retake the session must also read as run by no process at all --
   * `none`, a look that found nothing. The process the retake ended has gone,
   * but a look that could not be made (`unknown`) is not proof that nothing
   * else took the session in the meantime, and a second process on one
   * transcript damages it for both.
   */
  async function resumeSession(
    store: StoreDescriptor,
    adapter: ProviderAdapter,
    session: SessionRef,
    after: 'start' | 'retake' = 'start',
  ): Promise<SessionOutcome> {
    // After a retake every refusal here comes once the process it replaces
    // has gone -- the checks that could run first did -- and saying only why
    // would leave the reader thinking the session runs on where it was. The
    // one refusal that already says the process ended is left as it is.
    const afterward = (outcome: SessionOutcome): SessionOutcome =>
      after === 'retake' && !outcome.ok
        ? {
            ...outcome,
            problem: `that session was stopped, but it could not be started here: ${outcome.problem}`,
          }
        : outcome;

    if (after === 'start' && !(await signalledHasEnded(session))) {
      logger.info('session resume refused', {
        ...session,
        problem: 'its signalled process runs on',
      });
      return stillSignalled();
    }

    const { sessions: known, origins } = await discover(store);
    // The same join a report makes, made here off the same scan. A terminal
    // this server spawned is not bound to its session until a report finds
    // it, and in that window a resume would start a second process on the
    // transcript its own first one is writing; bound, it meets the hold rule
    // in `terminals.resume` below like any session this server runs.
    bindSpawned(store.storeId, known, origins);
    const descriptor = known.find((one) => one.sessionId === session.sessionId);
    if (descriptor === undefined) {
      return afterward(refused('this server cannot find that session in that store'));
    }

    if (after === 'retake' && descriptor.process !== 'none') {
      return refused(
        'the process running that session ended, but this server cannot confirm ' +
          'that nothing else runs it, so it did not resume it',
      );
    }

    const refusal = runningElsewhere(session, origins.get(session.sessionId)?.pid ?? null);
    if (refusal !== null) {
      logger.info('session resume refused', { ...session, problem: refusal });
      return afterward(refused(refusal));
    }

    const opened = await approvals?.open(store, adapter.permissionHook);
    // After the last await and before the launch, with nothing between, so no
    // retake can claim the session after this looked. The scan above cannot
    // see a takeover: the process it signalled reads as gone while it flushes.
    // A retake's own resume holds the claim, so it is the one not asked.
    if (after === 'start' && isRetaking(session)) {
      opened?.close();
      logger.info('session resume refused', { ...session, problem: 'a retake is taking it over' });
      return takingOver();
    }
    // A retake that began and gave up inside the awaits above leaves its
    // record behind it; one asked about at the top was dead or is gone.
    if (after === 'start' && signalledFor(session) !== undefined) {
      opened?.close();
      logger.info('session resume refused', {
        ...session,
        problem: 'its signalled process runs on',
      });
      return stillSignalled();
    }
    const launch = adapter.resume({
      store,
      session,
      cwd: descriptor.cwd,
      approval: opened?.approval ?? null,
    });
    const resumed = terminals.resume(session, launch);
    retireWith(resumed, opened ?? null);
    if (resumed.ok) oursIn(store.storeId).add(session.sessionId);
    logger.info('session resume', {
      ...session,
      ok: resumed.ok,
      asks: opened !== undefined && opened !== null,
      after,
    });
    return afterward(answer(store.storeId, resumed));
  }

  /**
   * Ends the outside process running a session, then resumes it here.
   *
   * Every refusal that can be known beforehand is made before anything is
   * signalled: the session's phase, its transcript, a sealed manager, a cap
   * with every terminal watched, and a launch the adapter will not plan. Three
   * can be learned only afterwards, and each says so: a process that has not
   * ended by the bound, something else taking the session while it went, and
   * a launch that fails once it has gone. Those are not quite all: the
   * snapshot of the manager can change while the process ends, which is a
   * launch that fails and is worded as one.
   *
   * The signal goes to a pid the adapter verified in the same breath --
   * nothing awaited between the second `liveProcess` and the SIGHUP -- because
   * a pid is stale the moment it is read and this one is about to be ended.
   *
   * Only at the prompt or at a question. `idle` and `waiting` are a process
   * whose transcript already holds everything it did; a turn in flight, a
   * command somebody typed, or a process that did not say are all work that
   * ending it would cut off, and the person running it is the one to stop it.
   */
  async function retakeSession(
    store: StoreDescriptor,
    adapter: ProviderAdapter,
    session: SessionRef,
  ): Promise<SessionOutcome> {
    if (terminals.isRunning(session)) return alreadyHeld(session);
    // An earlier retake's process, still on the pid it was signalled at. The
    // registry no longer names it, so the look below would find nothing to end
    // and say only that it cannot tell what runs the session.
    if (!(await signalledHasEnded(session))) return stillSignalled();

    // First look: the refusals that need no scan, before paying for one.
    const first = await liveProcessOf(store, adapter, session);
    if (!first.ok) return first.outcome;
    const before = retakeable(first.process);
    if (!before.ok) return refused(before.problem);

    // A terminal of this server's that is not yet bound to its session would
    // otherwise be the "outside" process this is about to end.
    const { sessions: known, origins } = await discover(store);
    bindSpawned(store.storeId, known, origins);
    if (terminals.isRunning(session)) return alreadyHeld(session);
    const descriptor = known.find((one) => one.sessionId === session.sessionId);
    if (descriptor === undefined) {
      return refused('this server cannot find that session in that store');
    }

    // Nothing is ended that cannot be resumed. A claude nobody has spoken to
    // has a registry entry and no transcript, and `--resume` would find no
    // conversation; ending it would close somebody's terminal for nothing.
    const transcript = await transcriptOf(store, adapter, session);
    if (!transcript) {
      return refused(
        'this server finds no transcript to resume that session from, so it ends nothing',
      );
    }

    // What the resume after the signal would refuse, refused before it: a
    // sealed manager, a cap with every terminal watched, and a launch the
    // adapter will not plan. The plan is made without an approval, which adds
    // only a settings file to argv; what a plan is refused for is the working
    // directory, and that is the session's own.
    const room = terminals.openRefusal();
    if (room !== null) return refused(room);
    const planned = adapter.resume({ store, session, cwd: descriptor.cwd, approval: null });
    if (!planned.ok) return refused(planned.problem);

    // The re-verify, and the signal straight after it.
    //
    // A gap remains, accepted rather than closed. The re-verify awaits the
    // probe's date for the pid -- a `/proc` read on Linux, a `ps` run on macOS
    // -- and the SIGHUP goes after it, so a claude that exits on its own inside
    // that await, with the kernel handing its pid to a new process inside the
    // same await, would have the SIGHUP land on the newcomer. Only signalling
    // through a pidfd rules that out, and Node offers none and macOS has no
    // equivalent. Accepted because both halves have to happen within one read:
    // Linux hands out pids in rising order and reaches one again only after
    // wrapping the whole range, and an idle claude at its prompt has no reason
    // to exit in that beat. The SIGKILL in `untilEnded` carries the same gap
    // after its poll's date, with a process likelier to exit in it because it
    // was asked to, and the reuse in the same beat still has to happen too.
    const now = await liveProcessOf(store, adapter, session);
    if (!now.ok) return now.outcome;
    const target = retakeable(now.process);
    if (!target.ok) return refused(target.problem);
    if (ownPid(target.process.pid)) return alreadyHeld(session);

    const signalled: SignalledProcess = { process: target.process, signalledAt: clock.now() };
    const hung = signaller.signal(target.process.pid, 'SIGHUP');
    if (!hung.ok) {
      return refused(`this server could not end the process running that session: ${hung.problem}`);
    }
    rememberSignalled(session, signalled);
    logger.info('session retake signalled', {
      ...session,
      pid: target.process.pid,
      signal: 'SIGHUP',
    });

    const ended = await untilEnded(session, signalled);
    if (ended !== null) return refused(ended);
    forgetSignalled(session);

    return await resumeSession(store, adapter, session, 'retake');
  }

  /**
   * Waits for a signalled process to go, sending SIGKILL once the grace is
   * spent, and answers `null` when it has gone or the words for why not.
   *
   * Asked of the process table, never of the provider's registry: Claude Code
   * removes its entry while it handles SIGHUP and then runs its SessionEnd
   * hooks and flushes its transcript, so an entry that has gone is a process
   * that may still be writing. The process has gone when its pid is dead, or
   * when the pid now dates to a process started after the signal -- the
   * kernel issued it again, which it does only once the process that held it
   * has exited. Any other date that is not the process's own is the clock,
   * not the kernel, and is waited out like a pid that could not be dated.
   *
   * Polled every `RETAKE_POLL_MS` and counted in polls rather than read off
   * the clock: a timer fires no earlier than it was set for, so the count is a
   * floor on the time waited, which is the direction the grace has to err in.
   * The SIGKILL goes only to a pid the poll just before it dated to the
   * process that was signalled, for the reason the SIGHUP waited on a
   * verification.
   */
  async function untilEnded(
    session: SessionRef,
    signalled: SignalledProcess,
  ): Promise<string | null> {
    const { pid } = signalled.process;
    let waited = 0;
    let killed = false;
    for (;;) {
      await new Promise<void>((resolve) => timers.schedule(RETAKE_POLL_MS, resolve));
      waited += RETAKE_POLL_MS;

      const now = await stillRunning(signalled);
      if (now === 'gone') return null;
      if (waited >= RETAKE_BOUND_MS) {
        return now === 'same'
          ? 'the process running that session did not end, so this server did not resume it'
          : 'this server could not tell whether the process running that session ended, ' +
              'so it did not resume it';
      }
      if (now === 'same' && !killed && waited >= KILL_GRACE_MS) {
        killed = true;
        const sent = signaller.signal(pid, 'SIGKILL');
        if (!sent.ok) {
          return `this server could not end the process running that session: ${sent.problem}`;
        }
        logger.info('session retake signalled', { ...session, pid, signal: 'SIGKILL' });
      }
    }
  }

  /**
   * Whether the process a retake signalled for this session has been seen to
   * end, asking the process table again now, and forgetting it once it has.
   * `true` when no retake left one.
   */
  async function signalledHasEnded(session: SessionRef): Promise<boolean> {
    const signalled = signalledFor(session);
    if (signalled === undefined) return true;
    if ((await stillRunning(signalled)) !== 'gone') return false;
    // Only the record that was asked about: a retake may have signalled the
    // session again while the probe answered.
    if (signalledFor(session) === signalled) forgetSignalled(session);
    return true;
  }

  /**
   * Whether the pid a retake signalled still holds the process it signalled.
   *
   * `gone` is a dead pid, or a reissued one: a pid the kernel handed out
   * again only once the holder exited, and so only ever to a process started
   * after the signal. A date has to be later than the process verified and no
   * earlier than the signal to say that. The tolerance is the registry's own,
   * here because two readings of one process's start are not promised to agree
   * to the millisecond, and reading the same process as a different one would
   * resume beside it.
   * `unknown` is a live pid this machine could not date this time, or one
   * whose date no reissue explains: earlier than the process verified, or
   * between that and the signal. A clock stepped under the probe does explain
   * them -- the Linux one re-reads boot time on every call -- and that is the
   * same process read wrong. Neither is counted ended, and neither is killed.
   */
  async function stillRunning({
    process,
    signalledAt,
  }: SignalledProcess): Promise<'same' | 'gone' | 'unknown'> {
    if (!(await processes.isAlive(process.pid))) return 'gone';
    const startedAt = await processes.startedAt(process.pid);
    if (startedAt === null) return 'unknown';
    if (startedAt > process.startedAt + PID_RECYCLE_TOLERANCE_MS) {
      return startedAt >= signalledAt - PID_RECYCLE_TOLERANCE_MS ? 'gone' : 'unknown';
    }
    if (startedAt < process.startedAt - PID_RECYCLE_TOLERANCE_MS) return 'unknown';
    return 'same';
  }

  /**
   * The adapter's answer, with a throwing adapter costing its own retake: an
   * adapter is somebody else's code once this is open source.
   */
  async function liveProcessOf(
    store: StoreDescriptor,
    adapter: ProviderAdapter,
    session: SessionRef,
  ): Promise<
    | { readonly ok: true; readonly process: LiveProcess | null }
    | { readonly ok: false; readonly outcome: SessionOutcome }
  > {
    try {
      return { ok: true, process: await adapter.liveProcess(store, session) };
    } catch (error) {
      logger.error('a provider adapter failed to name a process', {
        ...session,
        provider: adapter.provider,
        problem: String(error),
      });
      return {
        ok: false,
        outcome: {
          ok: false,
          code: 'internal',
          problem: 'this server could not tell which process runs that session',
          hold: null,
        },
      };
    }
  }

  /** Whether the adapter can read this session's transcript, which a resume continues. */
  async function transcriptOf(
    store: StoreDescriptor,
    adapter: ProviderAdapter,
    session: SessionRef,
  ): Promise<boolean> {
    try {
      return (await adapter.transcript({ store, session, limit: 1 })).ok;
    } catch {
      return false;
    }
  }

  /** The process that may be ended now, or why none may. */
  function retakeable(
    process: LiveProcess | null,
  ):
    | { readonly ok: true; readonly process: LiveProcess }
    | { readonly ok: false; readonly problem: string } {
    if (process === null) {
      return {
        ok: false,
        problem: 'this server cannot tell which process runs it, so it ends none',
      };
    }
    switch (process.phase) {
      case 'idle':
      case 'waiting':
        return { ok: true, process };
      case 'working':
      case 'unknown':
        return {
          ok: false,
          problem:
            'that session is working elsewhere; it can be retaken only while it is idle or waiting',
        };
    }
  }

  /** Whether one of this server's own live terminals is this pid. */
  function ownPid(pid: number): boolean {
    return terminals.terminals.some(
      (terminal) => terminal.run.exit === null && terminal.run.pid === pid,
    );
  }

  /**
   * The directory a session's branch and diffstat are about.
   *
   * The provider's own record of where the session ran, which is the checkout
   * the agent is editing, and the store's path for a session whose provider
   * does not say. Neither comes off a frame: one was read out of a transcript
   * on this disk and the other was resolved by this server at boot. What makes
   * that safe to spawn against is not where it came from but what happens next
   * -- it reaches `git.status` and `git.diff`, whose parsers refuse anything
   * that is not an absolute path free of NULs, and a refusal is a `null` on one
   * descriptor.
   */
  function directoryOf(store: StoreDescriptor, session: SessionDescriptor): string {
    return session.cwd ?? store.path;
  }

  /**
   * The same descriptors, each carrying what git said about its directory.
   *
   * Attached here rather than in discovery because only this layer has the
   * operation seam, and attached at all because the alternative is a client
   * asking per session over the wire: the hub would have to relay a question it
   * cannot answer, and the answer would arrive a round trip after the row it
   * belongs to. A session whose directory was not read keeps the `null` it came
   * with, which costs that session and never the report.
   */
  async function withWorkingTree(
    store: StoreDescriptor,
    sessions: readonly SessionDescriptor[],
  ): Promise<readonly SessionDescriptor[]> {
    if (sessions.length === 0) return sessions;

    const found = await readWorkingTrees(
      sessions.map((session) => directoryOf(store, session)),
      workingTree,
    );

    return sessions.map((session) => {
      const reading = found.get(directoryOf(store, session));
      return {
        ...session,
        branch: boundedBranch(reading?.branch ?? null),
        uncommitted: reading?.uncommitted ?? null,
      };
    });
  }

  async function discover(store: StoreDescriptor): Promise<{
    readonly sessions: readonly SessionDescriptor[];
    readonly origins: ReadonlyMap<SessionId, SessionOrigin>;
  }> {
    const found = await discoverStoreSessions(store, {
      registry: providers,
      clock,
      liveness: terminals,
    });
    for (const { provider, subject, problem } of found.problems) {
      // A session that cannot be read costs itself, never the listing.
      logger.warn('session unreadable', { provider, subject, problem });
    }
    return { sessions: found.sessions, origins: found.origins };
  }

  /**
   * Why a resume must not start, when the provider's adapter verified a
   * process on the session that is not this server's to hold -- or `null`.
   *
   * Two processes on one transcript interleave their writes into it, and the
   * session is damaged for both, so a verified pid this server did not fork
   * is a refusal. A session this server holds itself is left to the hold
   * rule, which names the hold. A pid one of this server's live terminals
   * owns while holding some other session is this server's process too, and
   * the words say so rather than blaming a terminal outside agentplex.
   *
   * Only a verified pid refuses. An adapter that could not look reports none,
   * and refusing on that would make every session of a provider without a
   * registry unresumable. The pid never reaches the words: it is this
   * machine's process table, and the hub has no use for it.
   */
  function runningElsewhere(session: SessionRef, pid: number | null): string | null {
    if (pid === null || terminals.isRunning(session)) return null;
    const ours = terminals.terminals.some(
      (terminal) => terminal.run.exit === null && terminal.run.pid === pid,
    );
    return ours
      ? 'this server is already running that session'
      : 'that session is running outside agentplex on this machine';
  }

  /** What this server is running in a store, in the form the hub reads it. */
  function holdsIn(storeId: StoreId): readonly SessionHold[] {
    const holds: SessionHold[] = [];
    for (const terminal of liveIn(storeId)) {
      const session = terminal.session;
      if (session === null) continue;
      holds.push({
        sessionId: session.sessionId,
        stoppable: terminal.stoppable,
        pause: terminal.pause,
      });
    }
    return holds;
  }

  /**
   * Joins a terminal this server spawned to the session id the provider has
   * since written.
   *
   * A spawn cannot name its session up front -- that would mean `--session-id`,
   * the flag family that splits a history in two -- so the id has to be found
   * afterwards, and a scan is the only thing that can find it. Two passes, the
   * certain one first.
   *
   * By pid: a session whose adapter verified the very process this terminal
   * forked is this terminal's, whatever its dates say. That holds only when
   * the spawn exec'd the provider, which is what a launch plan does.
   *
   * By time, for whatever the pid could not settle, and only among sessions
   * no verified process is running: a session with a pid that the first pass
   * did not bind is being run by somebody else's process, including one our
   * own terminal handed a new id to, and timing must not take it from them.
   * Of those, a session the provider *first* wrote to at or after the
   * terminal started, that none of this server's terminals has ever held, is
   * the terminal's. Ever, not now: once a terminal's process exits its
   * provider stops vouching for it, so the session it held is pid-less,
   * unheld and newer than every spawn still waiting -- the one session timing
   * would pick, and the one this server knows is not theirs.
   * The first write and never the last: a session somebody opened an hour ago
   * and spoke to a second ago was written to after the terminal started, and
   * it is not the terminal's.
   *
   * Timing binds only when exactly one session fits, and that is the
   * conservative direction rather than the convenient one. Binding the wrong
   * session would make this server claim to hold a session somebody else is
   * running, which is the one claim the hub acts on: it would refuse a
   * legitimate start and offer a stop button aimed at the wrong process. An
   * unbound terminal is merely a session the hub does not yet know is held,
   * which the next scan fixes.
   */
  function bindSpawned(
    storeId: StoreId,
    sessions: readonly SessionDescriptor[],
    origins: ReadonlyMap<SessionId, SessionOrigin>,
  ): void {
    const claimed = oursIn(storeId);
    const unbound = liveIn(storeId)
      .filter((terminal) => terminal.session === null)
      .sort((left, right) => left.run.startedAt - right.run.startedAt);
    if (unbound.length === 0) return;

    const unclaimed = (session: SessionDescriptor): boolean => !claimed.has(session.sessionId);

    const untimed: Terminal[] = [];
    for (const terminal of unbound) {
      const own = sessions.find(
        (session) => unclaimed(session) && origins.get(session.sessionId)?.pid === terminal.run.pid,
      );
      if (own === undefined) {
        untimed.push(terminal);
        continue;
      }
      if (bindOne(storeId, terminal, own.sessionId, 'pid')) claimed.add(own.sessionId);
    }

    for (const terminal of untimed) {
      const candidates = sessions.filter((session) => {
        const origin = origins.get(session.sessionId);
        return (
          unclaimed(session) &&
          origin !== undefined &&
          origin.pid === null &&
          origin.createdAt >= terminal.run.startedAt
        );
      });

      const [only] = candidates;
      if (only === undefined || candidates.length > 1) {
        logger.info('a spawned terminal has no session id yet', {
          storeId,
          candidates: candidates.length,
        });
        continue;
      }

      if (bindOne(storeId, terminal, only.sessionId, 'time')) claimed.add(only.sessionId);
    }
  }

  function bindOne(
    storeId: StoreId,
    terminal: Terminal,
    sessionId: SessionId,
    by: 'pid' | 'time',
  ): boolean {
    const bound = terminals.bind(terminal.terminalId, sessionId);
    if (!bound.ok) {
      logger.warn('could not bind a spawned terminal', {
        storeId,
        sessionId,
        problem: bound.problem,
      });
      return false;
    }
    logger.info('spawned terminal bound to its session', { storeId, sessionId, by });
    return true;
  }
}

/**
 * A branch name as the descriptor may carry it, or `null`.
 *
 * git bounds a ref name nowhere and the descriptor does, so a name past the
 * bound is possible and has to cost something smaller than the store report.
 * It costs the branch: a clipped prefix is not the branch the checkout is on,
 * and `null` already means "no name to show", which claims nothing.
 */
function boundedBranch(branch: string | null): string | null {
  return branch !== null && branch.length <= SESSION_BRANCH_MAX_CHARS ? branch : null;
}
