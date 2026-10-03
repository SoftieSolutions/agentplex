/**
 * The one way this server sends a signal to a process it did not start.
 *
 * A seam rather than `process.kill` at the call site, for two reasons. A unit
 * test cannot supply a process that ignores SIGHUP, one owned by another
 * account, or one that exits on cue, and every one of those is a case a retake
 * has to get right. And a signal to a pid is the most dangerous single call in
 * this server: keeping its only real implementation in `main` means a reader
 * can find every place one is sent by looking at one object.
 *
 * Two signals and no others. SIGHUP is what a terminal closing sends, and the
 * thing an agent's TUI is written to clean up on -- Claude Code 2.1.287 exits
 * on it within a second, removing its own registry entry and leaving its
 * transcript whole. SIGKILL is for a process that caught SIGHUP and carried on.
 * Anything else would be a signal nobody has checked a provider's answer to.
 *
 * It answers rather than throws, because a refusal is an ordinary outcome:
 * the process ended between the check and the signal, or it belongs to an
 * account this server cannot touch. Each is a sentence for whoever asked.
 */
export type RetakeSignal = 'SIGHUP' | 'SIGKILL';

export type SignalOutcome =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

/**
 * The words for the two refusals a kernel gives a signal, shared by the real
 * signaller and the fake so a test asserts the sentence a hub will read.
 */
export const SIGNAL_REFUSALS = {
  ESRCH: 'no such process',
  EPERM: 'that process belongs to another account',
} as const;

export interface ProcessSignaller {
  signal(pid: number, signal: RetakeSignal): SignalOutcome;
}
