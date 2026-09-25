import type { UncommittedDiff } from '@agentplex/protocol';
import type { WorkingTree } from './working-tree.js';

/**
 * A checkout table a test writes down: a directory in, what git found back.
 *
 * A real implementation of the seam rather than a mock. What matters about the
 * report path is what it does with a directory that answered and a directory
 * that did not, and both of those are values this returns; asserting that
 * `uncommitted` was called would test the code's shape instead of its
 * judgement.
 *
 * A directory with no entry answers `null`, which is what every real failure
 * looks like -- not a repository, no git on the machine, a path that is gone.
 * The default is therefore a server that reads nothing, which is the state most
 * tests want and none of them have to say. The two tables are separate because
 * the two readings fail separately: a repository with no commits yet has a
 * branch and no diffstat, and a test has to be able to write that down.
 */
export interface FakeWorkingTree extends WorkingTree {
  /** Every directory a branch was asked about, in order, including repeats. */
  readonly askedBranch: readonly string[];
  /** Every directory a diffstat was asked about, in order, including repeats. */
  readonly askedUncommitted: readonly string[];
}

export function createFakeWorkingTree(
  diffs: Readonly<Record<string, UncommittedDiff>> = {},
  branches: Readonly<Record<string, string>> = {},
): FakeWorkingTree {
  const askedBranch: string[] = [];
  const askedUncommitted: string[] = [];
  const diffTable = new Map(Object.entries(diffs));
  const branchTable = new Map(Object.entries(branches));

  return {
    askedBranch,
    askedUncommitted,

    async branch(directory: string): Promise<string | null> {
      askedBranch.push(directory);
      return branchTable.get(directory) ?? null;
    },

    async uncommitted(directory: string): Promise<UncommittedDiff | null> {
      askedUncommitted.push(directory);
      return diffTable.get(directory) ?? null;
    },
  };
}
