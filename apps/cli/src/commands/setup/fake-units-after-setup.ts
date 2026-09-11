import type { UnitsAfterSetup } from './start-after-setup.js';

/**
 * The unit step as a test can watch it: how many times setup reached for it,
 * and what it said when it did.
 *
 * A real implementation of the seam rather than a mock, like every other fake
 * here -- but the count is the point of this one, and that is worth saying out
 * loud because it is the exception. What the setup command's tests are about is
 * *whether* a run starts the units, and the whole of the decision is a run that
 * provisioned versus one that did not: an operator who declined the plan, a
 * plan file that would not parse, a run that finished with problems. None of
 * those can be told apart by what was printed, and all of them can be told
 * apart by whether this was called.
 *
 * What the step itself decides -- which scope, which units, the foreground
 * command instead -- is the subject of `start-after-setup.test.ts`, which drives
 * the real one.
 */
export interface FakeUnitsAfterSetup extends UnitsAfterSetup {
  /** How many times setup asked for the units to be started. */
  readonly calls: () => number;
}

export function createFakeUnitsAfterSetup(
  lines: readonly string[] = ['The units are running:'],
): FakeUnitsAfterSetup {
  let calls = 0;
  return {
    calls: () => calls,
    async start(): Promise<readonly string[]> {
      calls += 1;
      return lines;
    },
  };
}
