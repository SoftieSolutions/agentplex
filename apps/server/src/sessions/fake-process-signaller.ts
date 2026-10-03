import {
  SIGNAL_REFUSALS,
  type ProcessSignaller,
  type RetakeSignal,
  type SignalOutcome,
} from './process-signaller.js';

/**
 * A signaller that sends nothing and remembers everything.
 *
 * What a process does with a signal is the half a test has to write down: one
 * that exits on SIGHUP, one that ignores it until SIGKILL, one that survives
 * both. `onSignal` is where a test says which, usually by ending the pid in the
 * fake process probe the adapter reads, so the caller sees the exit the way it
 * would see a real one -- by asking again.
 */
export interface FakeProcessSignallerOptions {
  /** Refuse every signal as the kernel refuses one to another account's process. */
  readonly refuse?: 'EPERM';
  /** Called for every signal sent, after it is recorded and before it is answered. */
  readonly onSignal?: (pid: number, signal: RetakeSignal) => void;
}

export interface SentSignal {
  readonly pid: number;
  readonly signal: RetakeSignal;
}

export interface FakeProcessSignaller extends ProcessSignaller {
  /** Every signal asked for, in order, including the refused ones. */
  readonly sent: readonly SentSignal[];
}

export function createFakeProcessSignaller(
  options: FakeProcessSignallerOptions = {},
): FakeProcessSignaller {
  const sent: SentSignal[] = [];

  return {
    signal(pid: number, signal: RetakeSignal): SignalOutcome {
      sent.push({ pid, signal });
      if (options.refuse === 'EPERM') {
        return { ok: false, problem: SIGNAL_REFUSALS.EPERM };
      }
      options.onSignal?.(pid, signal);
      return { ok: true };
    },

    get sent(): readonly SentSignal[] {
      return sent;
    },
  };
}
