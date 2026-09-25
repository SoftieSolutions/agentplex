import {
  createMachineLoadReader,
  type CpuTimes,
  type MachineLoadReader,
  type MachineProbe,
} from './machine-load.js';
import { before, loadAverage } from './machine-load-linux.fixture.js';

/**
 * A machine a test writes down: counters in, and whatever they were set to
 * back.
 *
 * A real implementation of the seam rather than a mock, because what matters
 * about the reader is what it computes from two readings and what it refuses to
 * compute from one -- both of which are values this returns. Asserting that
 * `cpuTimes` was called would test the reader's shape instead of its judgement.
 *
 * The counters a test sets come from `machine-load-*.fixture.ts`, which is real
 * `os.cpus()` output captured on a real machine. Hand-written tick counts would
 * test somebody's idea of what a kernel counts.
 */
export interface FakeMachineProbe extends MachineProbe {
  /** What the next reading of the counters will find. */
  set(times: readonly CpuTimes[]): void;
  /** What the next reading of the load average will find. */
  setLoadAverage(load: [number, number, number] | null): void;
}

export function createFakeMachineProbe(
  times: readonly CpuTimes[] = [],
  load: [number, number, number] | null = null,
): FakeMachineProbe {
  let current = times;
  let average = load;

  return {
    cpuTimes: () => current,
    loadAverage: () => average,
    set: (next) => void (current = next),
    setLoadAverage: (next) => void (average = next),
  };
}

/**
 * A reader over a fake machine, for the many tests that need a server to be
 * able to answer a ping and do not care what it answers.
 *
 * The counters are a real machine's, from the captured fixture, so a test that
 * accidentally depends on their shape depends on a true one. The clock stands
 * still, which means every reading is taken at the same instant and none of
 * them has an interval to report a share over -- the honest answer for a
 * machine nobody has left any time between questions to. Tests about the share
 * itself wind a clock of their own.
 */
export function createFakeMachineLoadReader(): MachineLoadReader {
  return createMachineLoadReader({
    probe: createFakeMachineProbe(before, loadAverage),
    clock: { now: () => 0 },
  });
}
