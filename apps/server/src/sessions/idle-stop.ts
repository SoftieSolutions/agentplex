import type { SessionRef, StoreDescriptor, StoreId } from '@agentplex/protocol';
import type { Clock, Logger, Timers } from '@agentplex/node-shared';
import type { LiveProcess, ProviderRegistry } from '@agentplex/providers';
import type { Terminal, TerminalManager } from '../terminal/terminal-manager.js';
import type { SessionOutcome } from './session-control.js';

/**
 * Stops a session this server holds once its provider has sat at its prompt,
 * turn over, for the configured time.
 *
 * A forgotten session holds a terminal, its scrollback and a slot under the
 * cap until the next restart, and the cap's eviction only reaches it when
 * something else needs the room. This ends it sooner, and only in the one
 * state where ending it loses nothing: Claude Code's own registry saying
 * `idle`. A turn in progress, a `!` command, and a question waiting on its
 * answer are all somebody in the middle of something, and none of them counts.
 *
 * **Only what the provider itself says.** The phase is the adapter's
 * `liveProcess`, read fresh on every sweep: the bar a signal has to clear, and
 * the stop is one. A provider that keeps no registry -- codex -- answers `null`
 * and is never stopped; the transcript-derived status the scan keeps is a
 * guess from the last line written, and an idle stop on a guess would end a
 * session that was only quiet. `unknown` and `null` clear the clock, because
 * "could not tell" is not "idle".
 *
 * **Keys reset the clock.** Claude Code says `idle` while a prompt is being
 * typed and not yet sent, so the registry alone cannot tell a forgotten
 * session from one somebody is writing into. Input through agentplex is
 * stamped on the terminal, and the idle time is counted from whichever is
 * later: the first idle sighting or the last keystroke. Measured on Claude
 * Code 2.1.289: a prompt typed and not sent left the entry at `idle` with its
 * `statusUpdatedAt` unmoved, a `!` command read `busy` while it ran, and the
 * entry went back to `idle` once it had finished.
 *
 * **Through the stop a person would press.** `stop` is the session
 * controller's, so the same refusals hold -- a terminal whose last scanned
 * status is `working` is not stopped, even though the registry has since said
 * `idle`. That refusal is a stale scan rather than a busy agent, so the idle
 * time is kept and the stop is tried again at the next sweep.
 *
 * **Only what this server holds.** It walks the terminal table, never the
 * registry: a claude somebody runs in their own terminal is in the same
 * registry and is not this server's to end. One somebody resumed on a held
 * session is in it under that session's id, and can be the entry the registry
 * answers with; a phase counts only when its pid is the held terminal's own,
 * and any other is "could not tell".
 *
 * It runs whether or not a hub is connected. A session nobody is watching is
 * the one most likely to have been forgotten.
 */

/**
 * How often the terminals are looked at, at worst one minute late.
 *
 * A setting counted in minutes needs nothing finer, and each sweep re-reads the
 * registry directory once per held terminal.
 */
export const IDLE_STOP_SWEEP_MS = 60_000;

export interface IdleStopDependencies {
  readonly terminals: TerminalManager;
  /** Every adapter is asked in turn: a terminal does not record its provider. */
  readonly providers: ProviderRegistry;
  readonly stores: readonly StoreDescriptor[];
  /** The session controller's stop: the same refusals a person's stop meets. */
  readonly stop: (session: SessionRef) => SessionOutcome;
  /** Tells every connected hub what the store now holds, as a hub's own stop does. */
  readonly report: (storeId: StoreId) => Promise<void>;
  readonly clock: Clock;
  readonly timers: Timers;
  readonly logger: Logger;
  readonly idleStopMs: number;
  readonly sweepMs?: number;
}

export interface IdleStop {
  start(): void;
  /** Cancels the next sweep, and makes one in flight do nothing further. */
  stop(): void;
}

/** What one terminal has been seen doing, across sweeps. */
interface Watch {
  /** Epoch ms the provider was first seen idle in this stretch, or `null`. */
  idleSince: number | null;
  /** Set once the stop took, so a later sweep does not stop it again. */
  stopped: boolean;
}

/** One verified process, or `null`, or a throw that costs this terminal's pass. */
type Asked = { readonly ok: true; readonly process: LiveProcess | null } | { readonly ok: false };

export function createIdleStop({
  terminals,
  providers,
  stores,
  stop,
  report,
  clock,
  timers,
  logger: parent,
  idleStopMs,
  sweepMs = IDLE_STOP_SWEEP_MS,
}: IdleStopDependencies): IdleStop {
  const logger = parent.child({ part: 'idle-stop' });
  const watches = new Map<string, Watch>();
  let cancel: (() => void) | null = null;
  let started = false;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    cancel = timers.schedule(sweepMs, () => void pass());
  };

  /** The first adapter that verifies a process for this session. */
  const ask = async (store: StoreDescriptor, session: SessionRef): Promise<Asked> => {
    for (const adapter of providers.adapters) {
      try {
        const process = await adapter.liveProcess(store, session);
        if (process !== null) return { ok: true, process };
      } catch (error) {
        logger.warn('could not tell whether a session is idle', {
          ...session,
          provider: adapter.provider,
          problem: String(error),
        });
        return { ok: false };
      }
    }
    return { ok: true, process: null };
  };

  const look = async (terminal: Terminal, session: SessionRef, watch: Watch): Promise<void> => {
    const store = stores.find((candidate) => candidate.storeId === session.storeId);
    if (store === undefined) {
      watch.idleSince = null;
      return;
    }

    const asked = await ask(store, session);
    if (stopped || !asked.ok) return;

    const now = clock.now();
    // The registry answers for the session, not for this terminal: its newest
    // entry may be a claude somebody resumed on it in their own terminal.
    // Only the phase of the process this pty runs counts.
    const ours = asked.process?.pid === terminal.run.pid ? asked.process : null;
    if (ours?.phase !== 'idle') {
      watch.idleSince = null;
      return;
    }
    let idleSince = watch.idleSince ?? now;
    const { lastInputAt } = terminal;
    if (lastInputAt !== null && lastInputAt > idleSince) idleSince = lastInputAt;
    watch.idleSince = idleSince;

    const idleMs = now - idleSince;
    if (idleMs < idleStopMs) return;

    const outcome = stop(session);
    if (!outcome.ok) {
      // Most likely a scan that still says working after the registry said
      // idle. The session has been idle all the same: keep the time and try
      // again at the next sweep.
      logger.debug('idle stop refused', { ...session, problem: outcome.problem });
      return;
    }
    watch.stopped = true;
    logger.info('idle session stopped', { ...session, idleMs });
    try {
      await report(session.storeId);
    } catch (error) {
      logger.warn('could not report a store after an idle stop', {
        storeId: session.storeId,
        problem: String(error),
      });
    }
  };

  const pass = async (): Promise<void> => {
    try {
      const live = terminals.terminals.filter(
        (terminal) => terminal.run.exit === null && terminal.session !== null,
      );
      const present = new Set(live.map((terminal) => terminal.terminalId));
      for (const terminalId of [...watches.keys()]) {
        if (!present.has(terminalId)) watches.delete(terminalId);
      }

      for (const terminal of live) {
        if (stopped) return;
        const session = terminal.session;
        if (session === null) continue;
        const watch = watches.get(terminal.terminalId) ?? { idleSince: null, stopped: false };
        watches.set(terminal.terminalId, watch);
        if (watch.stopped) continue;
        await look(terminal, session, watch);
      }
    } catch (error) {
      // A sweep that failed costs this pass; the next one is a minute away.
      logger.warn('could not sweep for idle sessions', { problem: String(error) });
    }
    schedule();
  };

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      schedule();
    },
    stop(): void {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
}
