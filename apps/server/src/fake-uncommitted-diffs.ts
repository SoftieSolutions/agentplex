import type { UncommittedDiff } from '@agentplex/protocol';
import type { UncommittedDiffs } from './uncommitted-diffs.js';

/**
 * A diffstat table a test writes down: a directory in, what git found back.
 *
 * A real implementation of the seam rather than a mock. What matters about the
 * report path is what it does with a directory that answered and a directory
 * that did not, and both of those are values this returns; asserting that
 * `read` was called would test the code's shape instead of its judgement.
 *
 * A directory with no entry answers `null`, which is what every real failure
 * looks like — not a repository, no git on the machine, a path that is gone.
 * The default is therefore a server that reads nothing, which is the state most
 * tests want and none of them have to say.
 */
export interface FakeUncommittedDiffs extends UncommittedDiffs {
  /** Every directory asked about, in order, including repeats. */
  readonly asked: readonly string[];
}

export function createFakeUncommittedDiffs(
  found: Readonly<Record<string, UncommittedDiff>> = {},
): FakeUncommittedDiffs {
  const asked: string[] = [];
  const table = new Map(Object.entries(found));

  return {
    asked,

    async read(directory: string): Promise<UncommittedDiff | null> {
      asked.push(directory);
      return table.get(directory) ?? null;
    },
  };
}
