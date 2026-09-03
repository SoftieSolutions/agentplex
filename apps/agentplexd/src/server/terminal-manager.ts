import type {
  SessionId,
  SessionRef,
  SessionStatus,
  StoreDescriptor,
  StoreId,
} from '@agentplex/protocol';
import type { Clock } from '../shared/clock.js';
import type { Launch } from './providers/provider-adapter.js';
import type { SessionLiveness } from './providers/store-discovery.js';
import type { LaunchOptions, PtyRun, PtySupervisor } from './pty-supervisor.js';

/**
 * The terminal manager: how many agents may be live at once, and who holds a
 * session.
 *
 * The supervisor below it knows how to start one process and nothing about the
 * others. Every rule that is about the *set* of running agents lives here, and
 * there are only three of them:
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
 *
 * The hub is the authority on the last rule across servers, since it is the
 * only thing that sees every server attached to a store. This is the same rule
 * enforced where the processes actually are: a server that took an instruction
 * from a hub with a stale view must still refuse it.
 */

/**
 * Terminals a machine can hold at once, absent configuration.
 *
 * Each one is a forked agent plus its scrollback, and the number is a guess at
 * a laptop rather than at a server. It is deliberately larger than the number
 * of sessions a person watches at once and small enough that the eviction rule
 * gets exercised rather than being theatre nobody ever reaches.
 */
export const DEFAULT_TERMINAL_CAP = 8;

export interface TerminalManagerDependencies {
  /** The one thing that starts processes. Injected, so a test forks nothing. */
  readonly supervisor: PtySupervisor;
  /** Every "how long unwatched" here is a value a test sets, never a `Date.now()`. */
  readonly clock: Clock;
  readonly cap?: number;
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
  readonly watchers: number;
  /**
   * Epoch ms when the last watcher left, or `null` while somebody is watching.
   *
   * A terminal nobody has attached to yet is unwatched from the moment it
   * opened, rather than being a special case that eviction can never reach.
   */
  readonly unwatchedSince: number | null;
  /** Whether a stop may be offered. False while the agent is mid-turn. */
  readonly stoppable: boolean;
  /**
   * Attaches a watcher: it receives output, and it holds the terminal against
   * eviction until it detaches. Returns the detach, which is idempotent —
   * a socket that closes twice must not count a watcher off twice.
   *
   * Scrollback is not replayed here; a watcher that wants history reads
   * `run.scrollback()` first, which is the only ordering that lets it do so
   * without a gap.
   */
  watch(listener: (chunk: Uint8Array) => void): () => void;
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
  readonly watchers: number;
  readonly stoppable: boolean;
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
  /** Records the status somebody derived for a session, if a terminal holds it. */
  observe(session: SessionRef, status: SessionStatus): void;
  terminal(terminalId: string): Terminal | undefined;
  /** The live terminal for a session, in the form a refusal reports it. */
  holder(session: SessionRef): TerminalHolder | undefined;
  readonly terminals: readonly Terminal[];
  /** Kills the process. The terminal stays, because its output is what to read next. */
  stop(terminalId: string): StopOutcome;
  /** Shutdown. The one thing besides the cap that closes a terminal. */
  closeAll(): void;
}

interface TerminalRecord {
  readonly terminalId: string;
  readonly storeId: StoreId;
  readonly run: PtyRun;
  sessionId: SessionId | null;
  status: SessionStatus;
  watchers: number;
  unwatchedSince: number | null;
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
  cap = DEFAULT_TERMINAL_CAP,
}: TerminalManagerDependencies): TerminalManager {
  const terminals = new Map<string, TerminalEntry>();

  const liveHolderOf = (session: SessionRef): TerminalRecord | undefined => {
    for (const { record } of terminals.values()) {
      if (
        record.storeId === session.storeId &&
        record.sessionId === session.sessionId &&
        record.run.exit === null
      ) {
        return record;
      }
    }
    return undefined;
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
        .filter((record) => record.watchers === 0)
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
      close(oldest);
    }
    return null;
  };

  const close = (record: TerminalRecord): void => {
    record.run.kill();
    // The supervisor is told to forget it as well, so that "how many are
    // running" has one answer rather than two that drift.
    supervisor.forget(record.terminalId);
    terminals.delete(record.terminalId);
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
      watchers: 0,
      unwatchedSince: openedAt,
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

    observe(session: SessionRef, status: SessionStatus): void {
      const record = liveHolderOf(session);
      if (record !== undefined) record.status = status;
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
      record.run.kill();
      return { ok: true };
    },

    closeAll(): void {
      for (const { record } of [...terminals.values()]) close(record);
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

function holderOf(record: TerminalRecord): TerminalHolder {
  return {
    terminalId: record.terminalId,
    storeId: record.storeId,
    sessionId: record.sessionId,
    pid: record.run.pid,
    startedAt: record.run.startedAt,
    status: record.status,
    watchers: record.watchers,
    stoppable: stoppable(record.status),
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

    get watchers(): number {
      return record.watchers;
    },

    get unwatchedSince(): number | null {
      return record.unwatchedSince;
    },

    get stoppable(): boolean {
      return stoppable(record.status);
    },

    watch(listener: (chunk: Uint8Array) => void): () => void {
      const unsubscribe = record.run.subscribe(listener);
      record.watchers += 1;
      record.unwatchedSince = null;

      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        unsubscribe();
        record.watchers -= 1;
        // Only the last one out sets the clock: a tab closing while another is
        // open has not left the terminal unwatched, and dating it then would
        // make eviction pick a session somebody is looking at.
        if (record.watchers === 0) record.unwatchedSince = clock.now();
      };
    },
  };
}
