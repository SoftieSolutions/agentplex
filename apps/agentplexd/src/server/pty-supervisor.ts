import type { Clock } from '../shared/clock.js';
import type { IdGenerator } from '../shared/ids.js';
import type { Launch } from './providers/provider-adapter.js';
import type { Pty, PtyExit, PtyFactory } from './pty.js';
import { createScrollback, type Scrollback } from './scrollback.js';

/**
 * The PTY supervisor: it turns a launch plan into a running session.
 *
 * It is the only thing in agentplexd that starts a process, and it is
 * deliberately ignorant of providers. An adapter decides *what* to run — argv,
 * working directory, which inherited variables would poison the child — and
 * this decides *how*: on a pty, with a scrubbed environment, with the output
 * buffered by whole chunks. That split is what keeps a second provider a new
 * file rather than an edit here, and it is why `launch` takes the adapter's
 * `Launch` rather than a plan: a refusal is already an answer and passes
 * straight through, so no caller has to remember to check twice.
 *
 * Everything it cannot supply itself is injected. The pty factory, because a
 * unit test cannot fork one; the clock, because "when did this start" is a
 * value a test sets; the id source, because a test asserting on a run id
 * should not be matching a pattern; and the environment, because the whole
 * point of the scrub is what it does to variables this process happens to have
 * inherited, and reading `process.env` in here would make that untestable.
 */

/** Enough that a client attaching mid-session sees a screenful of real history. */
const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;

/**
 * The size a session starts at, before a client says what it actually has.
 *
 * A pty has to be born with a size, and 80x24 is the one every TUI is written
 * to survive. A client resizes on attach; until then the agent lays out for a
 * terminal that certainly exists rather than one that might.
 */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * What the child is told it is talking to.
 *
 * `xterm-256color` rather than `xterm`: the emulator in the client is xterm.js,
 * which does 256 colours, and a TUI that believes it has 8 renders its status
 * lines in colours nobody chose.
 */
const DEFAULT_TERM = 'xterm-256color';

export interface PtySupervisorDependencies {
  readonly pty: PtyFactory;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The environment a child would inherit. `process.env` in production, a
   * literal in a test. Values may be `undefined` because `process.env` says
   * they may be; the scrub drops those rather than defining them empty.
   */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly scrollbackBytes?: number;
}

export interface LaunchOptions {
  readonly cols?: number;
  readonly rows?: number;
}

export type LaunchOutcome =
  | { readonly ok: true; readonly run: PtyRun }
  /** The adapter's refusal, or the machine's, in the words the user should read. */
  | { readonly ok: false; readonly problem: string };

/**
 * One running session, from this server's point of view.
 *
 * There is no `{ storeId, sessionId }` on it, and that is not an oversight. A
 * provider mints its own session id and writes it to disk; discovery is what
 * finds it, moments later. A supervisor that had to name the session up front
 * would need `--session-id`, which is the flag that splits a history in two.
 * So a run has its own id and the hub joins the two by store and time.
 */
export interface PtyRun {
  readonly runId: string;
  readonly pid: number;
  /** Epoch ms, from the injected clock: the floor a `ProcessProbe` dates against. */
  readonly startedAt: number;
  /** `null` while it is still running. */
  readonly exit: PtyExit | null;
  /** Recent output, oldest first, trimmed by whole chunks. */
  scrollback(): readonly Uint8Array[];
  /** Whether the beginning has been dropped, so a viewer can say so. */
  readonly truncated: boolean;
  /** Live output. Returns the unsubscribe; the buffer keeps filling either way. */
  subscribe(listener: (chunk: Uint8Array) => void): () => void;
  write(input: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySupervisor {
  launch(launch: Launch, options?: LaunchOptions): LaunchOutcome;
  run(runId: string): PtyRun | undefined;
  readonly runs: readonly PtyRun[];
  /** Drops a run this server no longer has to answer for. Does not kill it. */
  forget(runId: string): void;
  /** Kills everything still running. For shutdown, where orphans outlive us. */
  stopAll(): void;
}

export function createPtySupervisor({
  pty: factory,
  clock,
  ids,
  environment,
  scrollbackBytes = DEFAULT_SCROLLBACK_BYTES,
}: PtySupervisorDependencies): PtySupervisor {
  const runs = new Map<string, PtyRun>();

  return {
    launch(launch: Launch, options: LaunchOptions = {}): LaunchOutcome {
      // A refusal is an answer the adapter already gave. Restating it here
      // would only make it worse.
      if (!launch.ok) return launch;

      const { plan } = launch;
      const request = {
        command: plan.command,
        args: [...plan.args],
        cwd: plan.cwd,
        env: scrubEnvironment(environment, plan.scrubEnvPrefixes, plan.env),
        cols: options.cols ?? DEFAULT_COLS,
        rows: options.rows ?? DEFAULT_ROWS,
        term: DEFAULT_TERM,
      };

      let opened: Pty;
      try {
        opened = factory.open(request);
      } catch (error) {
        // The machine said no: a command that is not on PATH, a working
        // directory that is gone, a spawn helper without its executable bit.
        // The command is named because the raw message frequently does not
        // name anything at all — `posix_spawnp failed.` is the whole of it.
        return { ok: false, problem: `cannot start ${plan.command}: ${describe(error)}` };
      }

      const run = trackRun(opened, ids.newId(), clock.now(), scrollbackBytes);
      runs.set(run.runId, run);
      return { ok: true, run };
    },

    run(runId: string): PtyRun | undefined {
      return runs.get(runId);
    },

    get runs(): readonly PtyRun[] {
      return [...runs.values()];
    },

    forget(runId: string): void {
      runs.delete(runId);
    },

    stopAll(): void {
      for (const run of runs.values()) run.kill();
    },
  };
}

/**
 * The child's environment: what it inherits, minus what the provider says
 * poisons it, plus what the provider states outright.
 *
 * Pure, and exported, because it is the rule most worth reading on its own.
 * The failure it prevents is silent in both directions: a Claude Code that
 * inherits `CLAUDECODE` and `CLAUDE_CODE_SSE_PORT` from the agent that started
 * agentplexd concludes it is a nested run and stops writing a transcript — the
 * session works, and agentplex never sees it again, because a transcript is
 * the only thing discovery reads.
 *
 * The prefixes come from the plan and are never hardcoded here: `CLAUDE_` means
 * nothing to codex, and a supervisor with its own list would need editing for
 * every adapter that lands. The plan's own variables are applied *after* the
 * scrub, so an adapter that must set something inside a scrubbed prefix can.
 */
export function scrubEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  scrubPrefixes: readonly string[],
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const [name, value] of Object.entries(inherited)) {
    // Absent is not empty. Defining a variable as "" would answer "is it set?"
    // with yes for every tool that asks that way.
    if (value === undefined) continue;
    if (scrubPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    environment[name] = value;
  }

  return { ...environment, ...overrides };
}

function trackRun(pty: Pty, runId: string, startedAt: number, scrollbackBytes: number): PtyRun {
  const buffer: Scrollback = createScrollback({ maxBytes: scrollbackBytes });
  const listeners = new Set<(chunk: Uint8Array) => void>();
  let exit: PtyExit | null = null;

  pty.onData((chunk) => {
    buffer.append(chunk);
    for (const listener of listeners) listener(chunk);
  });

  pty.onExit((ended) => {
    exit = ended;
  });

  return {
    runId,
    pid: pty.pid,
    startedAt,

    get exit(): PtyExit | null {
      return exit;
    },

    scrollback(): readonly Uint8Array[] {
      return buffer.chunks();
    },

    get truncated(): boolean {
      return buffer.truncated;
    },

    subscribe(listener: (chunk: Uint8Array) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    write(input: string): void {
      // Writing to a closed pty is an EIO on some platforms and silence on
      // others. Neither is a useful thing to do to a caller who is a keystroke
      // behind an exit, so the run answers for it.
      if (exit !== null) return;
      pty.write(input);
    },

    resize(cols: number, rows: number): void {
      if (exit !== null) return;
      pty.resize(cols, rows);
    },

    kill(): void {
      // Signalling a dead pid is how a recycled pid gets killed instead.
      if (exit !== null) return;
      pty.kill();
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
