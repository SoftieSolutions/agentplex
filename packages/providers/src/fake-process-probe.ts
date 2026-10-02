import type { ProcessProbe } from './process-probe.js';

/**
 * A process table a test can write down.
 *
 * A real implementation of the seam rather than a mock, for the same reason
 * `fake-provider-files` is one: what matters is what the caller does with a pid
 * that is gone, a pid that has been recycled, and a pid nothing can date, and
 * all three are values this can produce. Asserting that `isAlive` was called
 * would test the code's shape instead of its judgement.
 */
export interface FakeProcessProbeOptions {
  /** Live processes, as `pid -> epoch ms it started`. */
  readonly processes?: Readonly<Record<number, number>>;
  /**
   * Live pids this platform will not date — the answer a machine with neither
   * `/proc` nor `ps` gives, and the one that must not be read as evidence.
   */
  readonly undatable?: readonly number[];
}

/**
 * The fake, and the one thing a real process table does that a test needs on
 * cue: a process ending.
 */
export interface FakeProcessProbe extends ProcessProbe {
  /** The process holding this pid exits; the pid is no longer alive or datable. */
  exit(pid: number): void;
  /**
   * A process starts under this pid, dated as given, or one this platform
   * cannot date for `null`: how a test issues a pid again after its holder
   * has exited.
   */
  start(pid: number, startedAt: number | null): void;
}

export function createFakeProcessProbe(options: FakeProcessProbeOptions = {}): FakeProcessProbe {
  const processes = new Map(
    Object.entries(options.processes ?? {}).map(([pid, startedAt]) => [Number(pid), startedAt]),
  );
  const undatable = new Set(options.undatable ?? []);

  return {
    async isAlive(pid: number): Promise<boolean> {
      return processes.has(pid) || undatable.has(pid);
    },

    async startedAt(pid: number): Promise<number | null> {
      return processes.get(pid) ?? null;
    },

    exit(pid: number): void {
      processes.delete(pid);
      undatable.delete(pid);
    },

    start(pid: number, startedAt: number | null): void {
      if (startedAt === null) undatable.add(pid);
      else processes.set(pid, startedAt);
    },
  };
}
