import type { SessionRef, StoreId } from '@agentplex/protocol';
import type { Clock, Logger, Timers } from '@agentplex/node-shared';
import type { TerminalManager } from './terminal-manager.js';

/**
 * The drain: the stretch between "this server is going down" and "everything it
 * started is dead".
 *
 * What it exists to stop is a half-applied edit. `terminal-manager.ts` already
 * refuses to stop a terminal that is working, because interrupting a turn
 * mid-tool is how one gets left on disk, and shutdown used to walk straight
 * around that refusal and kill the same session with no warning. Since
 * `agentplex update` restarts the units, that was a routine upgrade's ordinary
 * cost rather than a rare one.
 *
 * So the drain is not a new rule. It is the existing one, applied to every
 * terminal, on a clock: nothing is closed here that a person could not have
 * stopped by hand at the same moment, and nothing is waited for beyond the
 * budget. The only thing this adds to `stop` is patience and a bound on it.
 *
 * ## What a boundary actually is, and what it is not
 *
 * The adapter is the only thing that knows, and the answer is already on the
 * wire: a terminal is `stoppable` when its last derived status is anything but
 * `working`. For Claude Code that is a real signal rather than an inference --
 * its own per-process registry declares `busy`, and `claude-registry.ts`
 * promotes a blocked session to `awaiting-permission`, which is stoppable
 * because a tool waiting to be approved has not run. For codex the rollout
 * carries `task_started` and `task_complete`, so a turn that ends is visible
 * the same way.
 *
 * Two gaps are worth naming rather than hiding, because both end in the same
 * place -- the budget runs out and the session is killed after all:
 *
 * - **codex at an approval prompt.** AGX-218 captured this: codex writes no
 *   approval event, so a session stopped at "Would you like to run the
 *   following command?" and a session running a slow tool are the same bytes.
 *   Both read `progressing`, so both read `working`, so a codex session sitting
 *   at a prompt nobody is answering costs the whole grace period and is then
 *   killed. That is the honest behaviour and not a bug to be papered over: the
 *   alternative is guessing that a running tool has finished.
 * - **a turn genuinely longer than the budget.** A drain is bounded because
 *   systemd's is: `TimeoutStopSec` sends SIGKILL whatever this process is
 *   doing, so an unbounded wait is a hang followed by the same kill with extra
 *   steps. What the budget buys is that the common turn finishes; what it
 *   cannot buy is that every turn does.
 *
 * The latency is in the safe direction. A status is derived from a file the
 * provider appends to, so the reading can lag the truth -- but a lagging
 * reading says `working` for a session that has just finished, which costs a
 * poll, and never says finished for a session that is mid-tool.
 */

/**
 * How long a drain waits, absent configuration, in milliseconds.
 *
 * Chosen against the unit, not against a feeling. `install.sh` writes
 * `TimeoutStopSec=20s` and renders this number from the same pair, so a machine
 * has one number and a five-second margin: what is left when the drain gives up
 * is what this process has to kill the stragglers, close its sockets and exit
 * before systemd stops caring. This default is what a checkout, a container and
 * anything else without that unit gets, and it matches what the installer
 * writes so that the two cannot say different things about the same server.
 */
export const DEFAULT_DRAIN_MS = 15_000;

/**
 * How often the drain asks again, in milliseconds.
 *
 * Asking means scanning every store that still has a terminal in it, which is
 * real work, and the scan itself is the floor on how fast this can go. Half a
 * second is fast enough that a turn ending is noticed as a rounding error
 * against the budget, and slow enough that a store full of transcripts is not
 * re-read thirty times a second while the machine is trying to shut down.
 */
export const DRAIN_POLL_MS = 500;

export interface DrainDependencies {
  readonly terminals: TerminalManager;
  /**
   * Re-derives what every session in one store is doing, and hands the answer
   * back to the terminal holding it.
   *
   * A seam rather than the controller itself, because what the drain needs is
   * exactly one of the things a report does: a status is derived by an adapter
   * from the provider's own files, and nothing derives one unless somebody
   * asks. Without this the drain would read whatever the last hub report left
   * behind, which on a quiet connection is minutes old -- and a drain deciding
   * against a stale `working` waits the whole budget for a session that ended
   * long ago.
   */
  readonly observe: (storeId: StoreId) => Promise<void>;
  readonly timers: Timers;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The bound, in milliseconds. Zero is legal and means one pass, no waiting. */
  readonly budgetMs: number;
  readonly pollMs?: number;
}

/**
 * How the drain ended, which is the part worth logging.
 *
 * `expired` is not a failure and is not silent either: it is the case the
 * budget exists for, and a server that killed a working agent has to say so
 * rather than leave it to be inferred from a session that stops moving.
 */
export type DrainEnd =
  /** Every terminal reached a boundary and was closed there. */
  | 'drained'
  /** The budget ran out with turns still in flight. */
  | 'expired'
  /** A second signal: the operator stopped waiting. */
  | 'abandoned';

export interface DrainReport {
  readonly end: DrainEnd;
  /** Terminals stopped at a boundary. */
  readonly drained: number;
  /** Terminals still mid-turn when the waiting stopped. The caller kills these. */
  readonly killed: number;
  readonly elapsedMs: number;
}

export interface Drain {
  /**
   * Waits, closing each terminal as it reaches a boundary, and answers with
   * what it managed.
   *
   * It does not kill what is left. That is the caller's, and deliberately so:
   * this decides when to stop waiting, and `closeAll` is the one thing besides
   * the cap that closes a terminal regardless.
   */
  run(): Promise<DrainReport>;
  /** A second signal. Stop waiting; the answer comes back `abandoned`. */
  stopWaiting(): void;
}

export function createDrain({
  terminals,
  observe,
  timers,
  clock,
  logger,
  budgetMs,
  pollMs = DRAIN_POLL_MS,
}: DrainDependencies): Drain {
  let abandoned = false;
  /** Cuts the current wait short, or nothing when the drain is not waiting. */
  let wake: (() => void) | null = null;

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const cancel = timers.schedule(ms, () => {
        wake = null;
        resolve();
      });
      wake = () => {
        cancel();
        wake = null;
        resolve();
      };
    });

  return {
    stopWaiting(): void {
      abandoned = true;
      wake?.();
    },

    async run(): Promise<DrainReport> {
      const startedAt = clock.now();
      const elapsed = (): number => clock.now() - startedAt;

      /** Terminals this drain has already dealt with, by id. */
      const settled = new Set<string>();
      const outstanding = (): readonly string[] =>
        terminals.terminals
          .filter((terminal) => !settled.has(terminal.terminalId))
          .map((terminal) => terminal.terminalId);

      let end: DrainEnd = 'drained';

      for (;;) {
        // Only the stores that still have something in them. A server with ten
        // mounted volumes and one live agent re-reads one of them.
        for (const storeId of storesStillHolding(terminals, settled)) {
          try {
            await observe(storeId);
          } catch (error) {
            // A store that cannot be scanned costs its own sessions the chance
            // to be released early, and nothing else: they stay `working` as
            // far as this is concerned, and the budget decides. Refusing to
            // drain the rest over one bad mount would be the worse direction.
            logger.warn('could not read a store while draining', {
              storeId,
              problem: String(error),
            });
          }
        }

        for (const terminal of terminals.terminals) {
          if (settled.has(terminal.terminalId)) continue;
          // Already gone: a session that ended on its own needs nothing.
          if (terminal.run.exit !== null) {
            settled.add(terminal.terminalId);
            continue;
          }
          // The manual stop rule, unchanged. A refusal here means "still
          // working", which is the whole thing this is waiting for.
          if (!terminals.stop(terminal.terminalId).ok) continue;
          settled.add(terminal.terminalId);
          logger.info('session closed at a turn boundary', {
            terminalId: terminal.terminalId,
            sessionId: terminal.session?.sessionId ?? null,
          });
        }

        if (outstanding().length === 0) break;
        if (abandoned) {
          end = 'abandoned';
          break;
        }
        const left = budgetMs - elapsed();
        if (left <= 0) {
          end = 'expired';
          break;
        }

        await sleep(Math.min(pollMs, left));
        if (abandoned) {
          end = 'abandoned';
          break;
        }
      }

      const killed = outstanding().length;
      return { end, drained: settled.size, killed, elapsedMs: elapsed() };
    },
  };
}

/**
 * The sessions a server is holding as it starts to drain, as the hub is told
 * them.
 *
 * A terminal the provider has not named yet is absent rather than invented:
 * there is no honest way to say which session it is, and a frame that guessed
 * would have the hub mark the wrong row as closing.
 */
export function drainingSessions(terminals: TerminalManager): readonly SessionRef[] {
  const sessions: SessionRef[] = [];
  for (const terminal of terminals.terminals) {
    if (terminal.run.exit !== null) continue;
    const session = terminal.session;
    if (session !== null) sessions.push(session);
  }
  return sessions;
}

/** The distinct stores still holding a terminal this drain has not settled. */
function storesStillHolding(
  terminals: TerminalManager,
  settled: ReadonlySet<string>,
): readonly StoreId[] {
  const stores = new Set<StoreId>();
  for (const terminal of terminals.terminals) {
    if (settled.has(terminal.terminalId) || terminal.run.exit !== null) continue;
    stores.add(terminal.storeId);
  }
  return [...stores];
}
