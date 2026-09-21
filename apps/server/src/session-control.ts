import type {
  Activity,
  Provider,
  RefusalCode,
  SessionDescriptor,
  SessionHold,
  SessionId,
  SessionRef,
  StoreDescriptor,
  StoreId,
} from '@agentplex/protocol';
import type { Clock, Logger } from '@agentplex/node-shared';
import { type ProviderRegistry, discoverStoreSessions } from '@agentplex/providers';
import type { LaunchApprovals, OpenLaunchApproval } from './approval-launch.js';
import type { DirectoryGuard } from './directory-browse.js';
import type { Terminal, TerminalManager, TerminalOutcome } from './terminal-manager.js';
import { readWorkingTrees, type WorkingTree } from './working-tree.js';

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
 *   * A plain spawn runs in the store's own path, as this server resolved it at
 *     boot. That is the start that has always existed, and a frame could not
 *     have supplied it.
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
   * `null` for the store's own path.
   *
   * A claim like every other thing off a wire, and checked like one: it reaches
   * a spawn only through `browse.allow`, and only as `cwd`.
   */
  readonly directory: string | null;
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
  const { stores, providers, terminals, workingTree, browse, approvals, clock } = dependencies;
  const logger = dependencies.logger.child({ part: 'sessions' });

  const storeOf = (storeId: StoreId): StoreDescriptor | undefined =>
    stores.find((store) => store.storeId === storeId);

  /** The live terminals for one store, whichever session each is on. */
  const liveIn = (storeId: StoreId): readonly Terminal[] =>
    terminals.terminals.filter(
      (terminal) => terminal.storeId === storeId && terminal.run.exit === null,
    );

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
        // The store's own path when the instruction named no directory, which
        // is the start that has always existed; otherwise the project's, once
        // this machine has agreed to open it.
        const cwd = await spawnDirectory(store, request.directory);
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

      const opened = await approvals?.open(store, adapter.permissionHook);
      const launch = adapter.resume({
        store,
        session,
        cwd: descriptor.cwd,
        approval: opened?.approval ?? null,
      });
      const resumed = terminals.resume(session, launch);
      retireWith(resumed, opened ?? null);
      logger.info('session resume', {
        ...session,
        ok: resumed.ok,
        asks: opened !== undefined && opened !== null,
      });
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
      return {
        ok: true,
        storeId: session.storeId,
        sessionId: session.sessionId,
        terminalId: holder.terminalId,
      };
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
   * Where a spawn runs: the store's own path, or a project's directory this
   * machine has agreed to open.
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
    store: StoreDescriptor,
    directory: string | null,
  ): Promise<
    | { readonly ok: true; readonly directory: string }
    | { readonly ok: false; readonly code: RefusalCode; readonly problem: string }
  > {
    if (directory === null) return { ok: true, directory: store.path };
    const allowed = await browse.allow(directory);
    if (allowed.ok) return { ok: true, directory: allowed.directory };
    return { ok: false, code: allowed.code, problem: allowed.problem };
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
        branch: reading?.branch ?? null,
        uncommitted: reading?.uncommitted ?? null,
      };
    });
  }

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
