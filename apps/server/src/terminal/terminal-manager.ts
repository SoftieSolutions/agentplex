import type {
  SessionId,
  SessionPause,
  SessionRef,
  SessionStatus,
  StartId,
  StoreDescriptor,
  StoreId,
} from '@agentplex/protocol';
import { DEFAULT_TERMINAL_CAP, type Clock, type Timers } from '@agentplex/node-shared';
import type { GrantId, Launch, SessionLiveness } from '@agentplex/providers';
import type { LaunchOptions, PtyExit, PtyRun, PtySupervisor } from '@agentplex/pty';

/**
 * The terminal manager: how many agents may be live at once, and who holds a
 * session.
 *
 * The supervisor below it knows how to start one process and nothing about the
 * others. Every rule that is about the *set* of running agents lives here, and
 * there are only four of them:
 *
 * - **A cap, with longest-unwatched eviction.** A client attaches to a session
 *   the moment it is opened, which is only safe because opening the tenth one
 *   cannot cost an unbounded amount of machine. When the cap is reached the
 *   terminal whose last watcher left longest ago is closed. That is safe
 *   because a terminal is not a session: the transcript is on disk, and a
 *   closed terminal is resumed by resuming the session.
 * - **Nothing else closes a terminal.** No idle timer, no close-on-detach.
 *   Sessions outlive tabs and sockets — a lid closing is not a decision — and
 *   an agent that is mid-work keeps working with nobody watching. Only the cap
 *   and server shutdown close anything.
 * - **One live process per session id.** Two agents on one transcript is the
 *   corruption there is no recovery from; the second one is refused and the
 *   refusal names the live holder, so the answer is "it is running over here"
 *   rather than "no". The way out is stopping the holder — and a holder that is
 *   working is not offered that either, because interrupting a turn mid-tool is
 *   how a half-applied edit gets left on disk.
 * - **A sealed manager starts nothing more.** Shutdown seals it before it waits
 *   for anything, because a drain that is still accepting starts is a drain
 *   that never ends. It is one-way: nothing unseals a manager, because the only
 *   thing that seals one is a process that is on its way out.
 *
 * The hub is the authority on the third rule across servers, since it is the
 * only thing that sees every server attached to a store. This is the same rule
 * enforced where the processes actually are: a server that took an instruction
 * from a hub with a stale view must still refuse it.
 *
 * ## Two hubs, one machine
 *
 * A server may be paired with more than one hub, and none of the three rules is
 * per hub. That is a decision and not an omission.
 *
 * **Any paired hub may watch any terminal.** A store is a volume both hubs have
 * mounted and both can already read the transcript off it, so refusing the live
 * bytes to the hub that did not start the session would withhold the slower
 * copy of something already readable, and would do it on the basis of who
 * *started* a session -- which is not part of a session's identity.
 * `{ storeId, sessionId }` is, and it never names a machine, so by the same
 * argument it never names a hub. When there is a reason to say no it will be a
 * scope on a grant, which is where that goes.
 *
 * **What the cap needs instead is a watcher set.** Given cross-hub watching,
 * "how many watchers" stopped being a question the eviction rule could act on:
 * it cannot tell that the terminal it is about to close is the only one a
 * second hub is watching, and it cannot drop the watchers of a connection that
 * died without detaching. `WatcherId` below is the answer, and `release` is
 * what a closing socket calls.
 *
 * **A start tag is the one thing here that is per hub.** It is the hub's own
 * name for the act of starting, minted before the instruction was sent, and it
 * lives here rather than on the connection the instruction arrived on -- which
 * is the whole point of it. A spawn has no session id until the provider
 * writes one, so between the fork and the first scan the start tag is the only
 * name it has, and a tag held by a socket would be lost exactly when the socket
 * drops: the hub would redial into a terminal it started and could no longer
 * name, forever if the provider never named the session. Held against the
 * terminal, it outlives every connection the terminal does.
 *
 * The grant is on the tag because a start id means nothing to the hub that did
 * not mint it. Scoping by grant and not by `hubId` for the reason `WatcherId`
 * is not a `hubId`: a grant is a record this server minted and a hub id is a
 * name a peer asserts.
 */

/**
 * How long a hung-up agent has to go before it is killed, in milliseconds.
 *
 * Every close sends SIGHUP first, because that is what a terminal closing
 * sends and what an agent's TUI is written to clean up on: flush its
 * transcript, restore the tty, take its children down. An agent that catches
 * it and carries on would otherwise hold its session forever with no terminal
 * left to reach it, so after this long it gets SIGKILL, which nothing can
 * catch.
 *
 * Three seconds, and the number is chosen against the unit rather than for its
 * own sake. `scripts/install.sh` writes `TimeoutStopSec=20s` and a drain budget
 * of 15 s from one pair of numbers, and `DEFAULT_DRAIN_MS` in
 * `daemon-settings.ts` matches it, so a shutdown that spends its whole budget
 * waiting for turns has a five-second margin before systemd's own SIGKILL. The
 * grace is spent inside that margin, and the exits have to be reported and the
 * sockets closed after it. Five would be the whole margin and would race
 * systemd's kill; three leaves two.
 */
export const KILL_GRACE_MS = 3_000;

/**
 * Who is watching, rather than how many.
 *
 * One hub connection, identified by something the server minted. It is not a
 * `hubId`: that arrives on the handshake and a hub in possession of a token can
 * claim to be any hub, so keying the eviction rule on it would let a peer make
 * a terminal unevictable by asserting a name. It is not a grant id either, and
 * that is the finer distinction: one grant may hold two connections -- a hub
 * reconnecting before the old socket has finished closing -- and one of them
 * dying must not detach the other's watchers.
 *
 * A count was what this was, and a count is the thing the cap could not reason
 * about. It cannot say whose watcher it is, so a connection that vanished
 * without detaching left a terminal pinned against eviction forever, and no
 * caller could ask "is this terminal watched by anyone other than me".
 */
export type WatcherId = string;

/**
 * A start this server was asked to make, and the terminal it produced.
 *
 * The `storeId` and the session are not on it: both are facts about the
 * terminal, which the holder of one of these looks up, and copying them here
 * would be two records to keep in step while a spawn is being named.
 */
export interface TerminalStart {
  /** The hub's own name for the start, as it arrived on `session-start`. */
  readonly startId: StartId;
  /** This server's name for the process that start produced. Never on a wire. */
  readonly terminalId: string;
}

export interface TerminalManagerDependencies {
  /** The one thing that starts processes. Injected, so a test forks nothing. */
  readonly supervisor: PtySupervisor;
  /** Every "how long unwatched" here is a value a test sets, never a `Date.now()`. */
  readonly clock: Clock;
  /** Where the kill after a hangup is scheduled, so a test fires it rather than waits. */
  readonly timers: Timers;
  readonly cap?: number;
  /** How long a hangup is given before the kill. `KILL_GRACE_MS` unless a test says. */
  readonly killGraceMs?: number;
}

/**
 * One live terminal: a run, plus who is watching it and what it is doing.
 *
 * `terminalId` is the run's id rather than a second identifier, because a
 * terminal holds exactly one run for its whole life — eviction closes the
 * terminal, it does not recycle it — and two ids for one thing is two ids to
 * get out of step in a log.
 */
export interface Terminal {
  readonly terminalId: string;
  readonly storeId: StoreId;
  /**
   * The session this terminal drives, or `null` until it is known.
   *
   * A resume knows it. A spawn cannot: the provider mints its own session id
   * and writes it, and agentplex naming it up front would mean `--session-id`,
   * the flag family that splits a history in two. Discovery finds the id
   * moments later and `bind` attaches it.
   */
  readonly session: SessionRef | null;
  readonly run: PtyRun;
  /** The last status anybody derived for this session. `unknown` until then. */
  readonly status: SessionStatus;
  /**
   * The connections watching right now, in the order they attached.
   *
   * A set rather than a number so that the cap can tell a terminal nobody is
   * watching from one a second hub is the only watcher of, and so that a
   * connection closing can take its own watchers off without knowing how many
   * anybody else has.
   */
  readonly watchers: readonly WatcherId[];
  /**
   * Epoch ms when the last watcher left, or `null` while somebody is watching.
   *
   * A terminal nobody has attached to yet is unwatched from the moment it
   * opened, rather than being a special case that eviction can never reach.
   */
  readonly unwatchedSince: number | null;
  /** Whether a stop may be offered. False while the agent is mid-turn. */
  readonly stoppable: boolean;
  /** How paused this terminal's session is. `paused` withholds its input. */
  readonly pause: SessionPause;
  /**
   * Attaches a watcher: it receives output, and it holds the terminal against
   * eviction until it detaches. Returns the detach, which is idempotent —
   * a socket that closes twice must not count a watcher off twice.
   *
   * Scrollback is not replayed here; a watcher that wants history reads
   * `run.scrollback()` first, which is the only ordering that lets it do so
   * without a gap.
   */
  watch(watcher: WatcherId, listener: (chunk: Uint8Array) => void): () => void;
}

/**
 * A live terminal as it is named to whoever was refused.
 *
 * Flat, and without the run, because its purpose is to be reported: "that
 * session is running on this terminal, this pid, and here is whether you may
 * stop it". A caller that has the terminal in hand uses `Terminal`.
 */
export interface TerminalHolder {
  readonly terminalId: string;
  readonly storeId: StoreId;
  readonly sessionId: SessionId | null;
  readonly pid: number;
  /** Epoch ms the process started, so a caller can say how long it has held. */
  readonly startedAt: number;
  readonly status: SessionStatus;
  /** How many distinct connections are watching, not how many times they attached. */
  readonly watchers: number;
  readonly stoppable: boolean;
  readonly pause: SessionPause;
}

/**
 * A refusal names a holder when there is one to name, and `null` when the
 * refusal is about something else — an adapter that said no, a cap with
 * nothing evictable behind it, a terminal that does not exist.
 *
 * `null` rather than an absent property so that every refusal has the same
 * shape and no caller has to remember which kinds carry a holder.
 */
export type TerminalOutcome =
  | { readonly ok: true; readonly terminal: Terminal }
  | {
      readonly ok: false;
      readonly problem: string;
      readonly holder: TerminalHolder | null;
    };

export type StopOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: string;
      readonly holder: TerminalHolder | null;
    };

/**
 * A pause that was taken says how far it got. `paused` is at once; `requested`
 * is recorded and honoured when the turn ends. Never `none`: a refusal is the
 * other arm.
 */
export type PauseOutcome =
  | { readonly ok: true; readonly pause: Exclude<SessionPause, 'none'> }
  | {
      readonly ok: false;
      readonly problem: string;
      readonly holder: TerminalHolder | null;
    };

/**
 * Extends `SessionLiveness` because the sessions this server started itself are
 * exactly what discovery cannot see: an adapter reads its provider's registry,
 * this knows what it forked. Handing the manager to discovery is one wire
 * rather than a second bookkeeping of pids.
 */
export interface TerminalManager extends SessionLiveness {
  /** Starts a session this store does not have yet. The id arrives with `bind`. */
  spawn(store: StoreDescriptor, launch: Launch, options?: LaunchOptions): TerminalOutcome;
  /** Reattaches to a session that exists. Refused when a live terminal holds it. */
  resume(session: SessionRef, launch: Launch, options?: LaunchOptions): TerminalOutcome;
  /** Names a spawned terminal's session once discovery has read the id off disk. */
  bind(terminalId: string, sessionId: SessionId): TerminalOutcome;
  /**
   * Records that one grant's start produced this terminal.
   *
   * Separate from `spawn` and `resume` rather than an argument to them, because
   * a start id is the asking hub's name for what it asked and the manager's
   * rules are about processes: nothing in the cap, the eviction order or the
   * one-live-process rule reads one. It is bookkeeping the manager holds on a
   * connection's behalf, and holding it is the entire feature.
   */
  noteStart(terminalId: string, startId: StartId, grantId: GrantId): void;
  /**
   * The starts one grant made that this server still holds a terminal for.
   *
   * Scoped to the grant and never merged across them: a start id minted by one
   * hub means nothing to another, so a second hub is told nothing about this
   * one's starts. It learns about the session itself as soon as the provider
   * names it, like any other session in the store.
   *
   * A tag whose terminal is gone is gone: a handle pointing at nothing is worse
   * than no handle, because it names a start that is not running here.
   */
  starts(grantId: GrantId): readonly TerminalStart[];
  /** Records the status somebody derived for a session, if a terminal holds it. */
  observe(session: SessionRef, status: SessionStatus): void;
  terminal(terminalId: string): Terminal | undefined;
  /** The live terminal for a session, in the form a refusal reports it. */
  holder(session: SessionRef): TerminalHolder | undefined;
  readonly terminals: readonly Terminal[];
  /**
   * Detaches everything one connection was watching, everywhere.
   *
   * A socket that closes is a watcher that is gone, and the terminal has no
   * other way to find out: a detach is returned to whoever attached, and a
   * connection that died is not there to call it. Without this the count of
   * watchers only ever rises, and a terminal nobody can see becomes one the cap
   * may never evict.
   */
  release(watcher: WatcherId): void;
  /**
   * Ends the process: a hangup, then a kill if it is still there after the
   * grace. The terminal stays, because its output is what to read next.
   *
   * It answers once the hangup is sent, not once the process is gone. A caller
   * that has to know when it is gone awaits `run.whenExited()`.
   */
  stop(terminalId: string): StopOutcome;
  /**
   * Withholds the terminal's input from its next turn boundary, killing nothing.
   *
   * At once when the last derived status is a boundary -- anything derived
   * that is not `working` -- and otherwise recorded, to be taken by `observe`
   * when a boundary is derived. `unknown` is not a boundary: an adapter that
   * could not tell what the session is doing cannot tell that it is between
   * turns either, so a request against it waits for a status somebody could
   * read. Idempotent: a second pause answers with where the first got to.
   *
   * Not a one-way door. A `paused` session observed `working` again drops
   * back to `requested`, and the pause is taken at the next boundary.
   */
  pause(terminalId: string): PauseOutcome;
  /**
   * Lifts a pause or a pending request. `unpause` rather than `resume` because
   * `resume` on this manager already means reattaching to a session, and the
   * two are different acts on different things: one opens a process, this
   * opens a keyboard. Idempotent on a terminal that was never paused.
   */
  unpause(terminalId: string): StopOutcome;
  /**
   * Refuses every new terminal from here on, and touches none of the live ones.
   *
   * The first step of a draining shutdown, and separate from `closeAll` because
   * the whole point of a drain is the stretch of time between them: the agents
   * this server is holding go on working, and nothing new joins them. Idempotent.
   */
  seal(): void;
  readonly sealed: boolean;
  /**
   * Shutdown. The one thing besides the cap that closes a terminal.
   *
   * Every terminal is gone from the manager by the time this returns; the
   * promise settles when every process has exited, the ones that ignored the
   * hangup included, because a server that says it has stopped while its
   * agents run on has left them to nobody.
   */
  closeAll(): Promise<void>;
}

interface TerminalRecord {
  readonly terminalId: string;
  readonly storeId: StoreId;
  readonly run: PtyRun;
  sessionId: SessionId | null;
  status: SessionStatus;
  pause: SessionPause;
  /** Watcher to how many times it attached: one hub may open two tabs on one terminal. */
  readonly watchers: Map<WatcherId, number>;
  unwatchedSince: number | null;
  /** The one termination in flight, so a second stop neither hangs up nor schedules again. */
  terminating: Promise<PtyExit> | null;
}

/**
 * The record and the view over it, held together.
 *
 * The view is made once and kept, so that `manager.terminal(id)` answers with
 * the same object every time and a caller may hold on to one. It reads through
 * to the record rather than copying it, so a caller holding a terminal from
 * before a watcher attached is not looking at a stale count.
 */
interface TerminalEntry {
  readonly record: TerminalRecord;
  readonly view: Terminal;
}

export function createTerminalManager({
  supervisor,
  clock,
  timers,
  cap = DEFAULT_TERMINAL_CAP,
  killGraceMs = KILL_GRACE_MS,
}: TerminalManagerDependencies): TerminalManager {
  const terminals = new Map<string, TerminalEntry>();
  /**
   * Terminals already closed whose process has not exited yet.
   *
   * Out of `terminals`, because a closed terminal is not one anybody may
   * watch, stop or count against the cap. Still here, because until its
   * process has gone it is the live holder of its session: an evicted agent
   * that ignored the hangup is running on that transcript for the whole grace,
   * and a resume let through in that window is two agents on one session.
   */
  const closing = new Set<TerminalRecord>();
  /** Every live start, by the grant that made it. Pruned when a terminal closes. */
  const startsByGrant = new Map<GrantId, Map<StartId, string>>();
  let sealed = false;

  const liveHolderOf = (session: SessionRef): TerminalRecord | undefined => {
    const records = [...[...terminals.values()].map((entry) => entry.record), ...closing];
    return records.find(
      (record) =>
        record.storeId === session.storeId &&
        record.sessionId === session.sessionId &&
        record.run.exit === null,
    );
  };

  /**
   * Ends a terminal's process: SIGHUP now, SIGKILL after the grace if it is
   * still running, and the kill cancelled the moment it exits.
   *
   * Idempotent, because a drain stops a terminal and shutdown then closes the
   * same one: the second caller gets the first one's promise rather than a
   * second hangup and a second kill on the timer. It settles when the process
   * has exited, and at once for one that already had.
   */
  const terminate = (record: TerminalRecord): Promise<PtyExit> => {
    if (record.terminating !== null) return record.terminating;
    const { run } = record;
    record.terminating = run.whenExited();
    if (run.exit !== null) return record.terminating;

    run.kill('SIGHUP');
    const cancel = timers.schedule(killGraceMs, () => run.kill('SIGKILL'));
    void record.terminating.then(cancel);
    return record.terminating;
  };

  const open = (
    storeId: StoreId,
    sessionId: SessionId | null,
    launch: Launch,
    options: LaunchOptions | undefined,
  ): TerminalOutcome => {
    // An adapter's refusal is an answer somebody already gave, and it costs
    // nothing to give it back. Checked before the cap on purpose: evicting a
    // terminal to make room for a launch that was never going to happen would
    // close a session over a typo in a working directory.
    if (!launch.ok) return { ok: false, problem: launch.problem, holder: null };

    // Before the cap and before the holder check, because neither is the
    // reason: a sealed manager has no answer that involves starting something,
    // and evicting a terminal to make room on a server that is going down would
    // close a session for nothing.
    if (sealed) {
      return { ok: false, problem: 'this server is shutting down', holder: null };
    }

    if (sessionId !== null) {
      const held = liveHolderOf({ storeId, sessionId });
      if (held !== undefined) {
        return {
          ok: false,
          problem: `session ${sessionId} is already running on terminal ${held.terminalId} (pid ${held.run.pid})`,
          holder: holderOf(held),
        };
      }
    }

    const room = makeRoom();
    if (room !== null) return { ok: false, problem: room, holder: null };

    const started = supervisor.launch(launch, options);
    if (!started.ok) return { ok: false, problem: started.problem, holder: null };

    const entry = track(started.run, storeId, sessionId, clock.now());
    terminals.set(entry.record.terminalId, entry);
    return { ok: true, terminal: entry.view };
  };

  /** Closes terminals until there is room for one more, or says why it cannot. */
  const makeRoom = (): string | null => {
    while (terminals.size >= cap) {
      const evictable = [...terminals.values()]
        .map((entry) => entry.record)
        .filter((record) => record.watchers.size === 0)
        // Two tiers, and the first one is free: a terminal whose process has
        // already exited costs a scrollback nobody is reading, so it goes
        // before any live agent does. Within a tier it is longest-unwatched.
        // `unwatchedSince` is never null here — a watched terminal was already
        // filtered out — and the fallback keeps that a total order rather than
        // a cast.
        .sort(
          (left, right) =>
            rank(left) - rank(right) || (left.unwatchedSince ?? 0) - (right.unwatchedSince ?? 0),
        );

      const oldest = evictable[0];
      if (oldest === undefined) {
        return `the terminal cap of ${cap} is reached and every terminal is being watched`;
      }
      // Not awaited: the start that asked for room is not held up by the
      // agent it displaced. `close` keeps that agent the holder of its session
      // until it has gone, which is what makes not waiting safe.
      void close(oldest);
    }
    return null;
  };

  /**
   * Takes a terminal out of the manager at once, and answers when its process
   * has exited.
   */
  const close = (record: TerminalRecord): Promise<PtyExit> => {
    const exited = terminate(record);
    if (record.run.exit === null) {
      closing.add(record);
      void exited.then(() => closing.delete(record));
    }
    // The supervisor is told to forget it as well, so that "how many are
    // running" has one answer rather than two that drift.
    supervisor.forget(record.terminalId);
    terminals.delete(record.terminalId);
    // And every start that named it, for the same reason: the one thing worse
    // than a hub not being told which terminal its start produced is being
    // told a terminal that is no longer here.
    for (const [grantId, held] of startsByGrant) {
      for (const [startId, terminalId] of held) {
        if (terminalId === record.terminalId) held.delete(startId);
      }
      if (held.size === 0) startsByGrant.delete(grantId);
    }
    return exited;
  };

  const track = (
    run: PtyRun,
    storeId: StoreId,
    sessionId: SessionId | null,
    openedAt: number,
  ): TerminalEntry => {
    const record: TerminalRecord = {
      terminalId: run.runId,
      storeId,
      run,
      sessionId,
      // Not `working`, however likely that is. The status is derived from a
      // transcript by an adapter, and guessing it here would put an
      // unverifiable claim in front of a user and a stop button behind it.
      status: 'unknown',
      pause: 'none',
      watchers: new Map(),
      unwatchedSince: openedAt,
      terminating: null,
    };
    return { record, view: viewOf(record, clock) };
  };

  return {
    spawn(store: StoreDescriptor, launch: Launch, options?: LaunchOptions): TerminalOutcome {
      return open(store.storeId, null, launch, options);
    },

    resume(session: SessionRef, launch: Launch, options?: LaunchOptions): TerminalOutcome {
      return open(session.storeId, session.sessionId, launch, options);
    },

    bind(terminalId: string, sessionId: SessionId): TerminalOutcome {
      const entry = terminals.get(terminalId);
      if (entry === undefined) {
        return { ok: false, problem: `no terminal ${terminalId}`, holder: null };
      }
      const { record } = entry;

      const held = liveHolderOf({ storeId: record.storeId, sessionId });
      if (held !== undefined && held !== record) {
        // Refused rather than resolved: both processes are already running, and
        // which of them should die is not a decision this can make on its own.
        // It stays unbound, and it is named in the refusal either way.
        return {
          ok: false,
          problem: `session ${sessionId} is already held by terminal ${held.terminalId}`,
          holder: holderOf(held),
        };
      }

      record.sessionId = sessionId;
      return { ok: true, terminal: entry.view };
    },

    noteStart(terminalId: string, startId: StartId, grantId: GrantId): void {
      // A start for a terminal that is already gone is not recorded: it would
      // be pruned by the next close it outlived and reported as running in the
      // meantime.
      if (!terminals.has(terminalId)) return;
      const held = startsByGrant.get(grantId) ?? new Map<StartId, string>();
      held.set(startId, terminalId);
      startsByGrant.set(grantId, held);
    },

    starts(grantId: GrantId): readonly TerminalStart[] {
      const held = startsByGrant.get(grantId);
      if (held === undefined) return [];
      return [...held].map(([startId, terminalId]) => ({ startId, terminalId }));
    },

    observe(session: SessionRef, status: SessionStatus): void {
      const record = liveHolderOf(session);
      if (record === undefined) return;
      record.status = status;
      // The one place a request becomes a pause, and the one place a pause
      // becomes a request again. The scan that derived this status is what
      // says the turn ended, and nothing else may say so; the same scan is
      // what says a paused session has started a turn after all -- an
      // approval answered through the gate lets the agent go on, and a pause
      // taken on a stale status can land mid-turn -- and then the boundary
      // the pause claimed is gone. Dropping back to `requested` keeps the
      // keyboard open for the turn and takes the pause at the next boundary,
      // where `paused` left standing would refuse input to a session that
      // is working. Only `working` re-arms: `unknown` is no evidence either way.
      if (record.pause === 'requested' && atBoundary(status)) record.pause = 'paused';
      else if (record.pause === 'paused' && status === 'working') record.pause = 'requested';
    },

    terminal(terminalId: string): Terminal | undefined {
      return terminals.get(terminalId)?.view;
    },

    holder(session: SessionRef): TerminalHolder | undefined {
      const record = liveHolderOf(session);
      return record === undefined ? undefined : holderOf(record);
    },

    get terminals(): readonly Terminal[] {
      return [...terminals.values()].map((entry) => entry.view);
    },

    isRunning(session: SessionRef): boolean {
      return liveHolderOf(session) !== undefined;
    },

    release(watcher: WatcherId): void {
      for (const { record } of terminals.values()) {
        if (!record.watchers.has(watcher)) continue;
        // The whole of one connection's hold, however many times it attached.
        // A socket does not half close.
        record.watchers.delete(watcher);
        if (record.watchers.size === 0) record.unwatchedSince = clock.now();
      }
    },

    stop(terminalId: string): StopOutcome {
      const record = terminals.get(terminalId)?.record;
      if (record === undefined) {
        return { ok: false, problem: `no terminal ${terminalId}`, holder: null };
      }
      if (!stoppable(record.status)) {
        return {
          ok: false,
          problem: `terminal ${terminalId} is working: stopping it mid-turn can leave a half-applied edit behind`,
          holder: holderOf(record),
        };
      }

      // The terminal survives its process. A session that was just stopped is
      // the one somebody most wants to read, and the bytes are here rather than
      // in the transcript. It is the cheapest thing to evict from now on.
      void terminate(record);
      return { ok: true };
    },

    pause(terminalId: string): PauseOutcome {
      const record = terminals.get(terminalId)?.record;
      if (record === undefined) {
        return { ok: false, problem: `no terminal ${terminalId}`, holder: null };
      }
      if (record.run.exit !== null) {
        return {
          ok: false,
          problem: `terminal ${terminalId} has exited: there is no turn left to pause`,
          holder: null,
        };
      }
      if (record.pause === 'none') {
        record.pause = atBoundary(record.status) ? 'paused' : 'requested';
      }
      return { ok: true, pause: record.pause };
    },

    unpause(terminalId: string): StopOutcome {
      const record = terminals.get(terminalId)?.record;
      if (record === undefined) {
        return { ok: false, problem: `no terminal ${terminalId}`, holder: null };
      }
      if (record.run.exit !== null) {
        return {
          ok: false,
          problem: `terminal ${terminalId} has exited: there is nothing to resume`,
          holder: null,
        };
      }
      record.pause = 'none';
      return { ok: true };
    },

    seal(): void {
      sealed = true;
    },

    get sealed(): boolean {
      return sealed;
    },

    async closeAll(): Promise<void> {
      // Every record out before the first await, so that a caller which does
      // not wait -- a test tearing down, a shutdown that has other things to
      // close in the meantime -- finds the manager already empty.
      const exits = [...terminals.values()].map(({ record }) => close(record));
      await Promise.all(exits);
    },
  };
}

/** Exited first, then live. Two tiers, so the free eviction is taken first. */
function rank(record: TerminalRecord): number {
  return record.run.exit === null ? 1 : 0;
}

/**
 * Only `working` withholds the stop.
 *
 * `unknown` does not, and that is the deliberate direction: a session whose
 * transcript nobody could parse would otherwise be unkillable, and the only way
 * out of it would be an eviction nobody asked for. Withholding a stop from a
 * session that is waiting on a person would be worse still — waiting is exactly
 * when stopping is safe.
 */
function stoppable(status: SessionStatus): boolean {
  return status !== 'working';
}

/**
 * A turn boundary: a status somebody derived that is not mid-turn.
 *
 * Stricter than `stoppable` on exactly one value. A stop lets `unknown`
 * through because the alternative is an unkillable session; a pause holds
 * `unknown` back because the alternative is claiming a session is set down
 * between turns when nobody could read whether it is between turns at all.
 */
function atBoundary(status: SessionStatus): boolean {
  return status !== 'working' && status !== 'unknown';
}

function attach(record: TerminalRecord, watcher: WatcherId): void {
  record.watchers.set(watcher, (record.watchers.get(watcher) ?? 0) + 1);
}

/**
 * One attachment off, and the clock set only when the last watcher leaves.
 *
 * A tab closing while another is open has not left the terminal unwatched, and
 * dating it then would make eviction pick a session somebody is looking at.
 * The same holds one level up: a connection with two tabs on one terminal is
 * still watching after the first closes.
 */
function detach(record: TerminalRecord, watcher: WatcherId, clock: Clock): void {
  const held = record.watchers.get(watcher);
  if (held === undefined) return;
  if (held > 1) {
    record.watchers.set(watcher, held - 1);
    return;
  }
  record.watchers.delete(watcher);
  if (record.watchers.size === 0) record.unwatchedSince = clock.now();
}

function holderOf(record: TerminalRecord): TerminalHolder {
  return {
    terminalId: record.terminalId,
    storeId: record.storeId,
    sessionId: record.sessionId,
    pid: record.run.pid,
    startedAt: record.run.startedAt,
    status: record.status,
    watchers: record.watchers.size,
    stoppable: stoppable(record.status),
    pause: record.pause,
  };
}

function viewOf(record: TerminalRecord, clock: Clock): Terminal {
  return {
    terminalId: record.terminalId,
    storeId: record.storeId,
    run: record.run,

    get session(): SessionRef | null {
      return record.sessionId === null
        ? null
        : { storeId: record.storeId, sessionId: record.sessionId };
    },

    get status(): SessionStatus {
      return record.status;
    },

    get watchers(): readonly WatcherId[] {
      return [...record.watchers.keys()];
    },

    get unwatchedSince(): number | null {
      return record.unwatchedSince;
    },

    get stoppable(): boolean {
      return stoppable(record.status);
    },

    get pause(): SessionPause {
      return record.pause;
    },

    watch(watcher: WatcherId, listener: (chunk: Uint8Array) => void): () => void {
      const unsubscribe = record.run.subscribe(listener);
      attach(record, watcher);
      record.unwatchedSince = null;

      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        unsubscribe();
        detach(record, watcher, clock);
      };
    },
  };
}
