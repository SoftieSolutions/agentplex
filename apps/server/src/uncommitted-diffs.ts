import type { UncommittedDiff } from '@agentplex/protocol';
import type { ProcessRunner } from '@agentplex/providers';
import { runOperation } from '@agentplex/providers';
import { gitDiffOperation } from './operations/git-diff.js';

/**
 * What the store report asks when it wants a session's uncommitted work.
 *
 * A seam of its own rather than a `ProcessRunner` handed to the session
 * controller, because those are different capabilities and only one of them is
 * the controller's business. "Read a directory's diffstat" is a question a test
 * answers with a value; "start any program you like" is a licence, and a
 * controller that held one would be a second place to look when asking what
 * this server can spawn.
 *
 * `null` is the only failure shape, and it means one thing: nobody looked, or
 * whoever looked could not say. A directory that is not a repository, a
 * repository with no commit yet, a machine with no git, a git that took too
 * long, a path the provider recorded that no longer exists — a client draws
 * nothing for all of them, because the alternative is a zero, and a zero says a
 * person has nothing outstanding.
 */
export interface UncommittedDiffs {
  /** The diffstat for one directory, or `null` when it could not be read. */
  read(directory: string): Promise<UncommittedDiff | null>;
}

export interface GitUncommittedDiffsDependencies {
  /**
   * The one-shot process seam, from the one place allowed to build it. This is
   * the reason the reader is composed in `main` rather than here: the runner
   * fixes what a child inherits, and only the entrypoint has read this
   * process's environment.
   */
  readonly runner: ProcessRunner;
}

/**
 * The real reader: `git.diff`, through the same `runOperation` the registry
 * uses.
 *
 * Not `registry.execute('git.diff', ...)`, which would hand back `unknown` and
 * need a parser here to get the type back. A caller that knows which operation
 * it wants names the operation, and both paths build the same argv and start
 * the same child; the registry exists so that a caller which learned a name
 * from outside cannot reach anything else, and this caller learned nothing from
 * outside.
 */
export function createGitUncommittedDiffs({
  runner,
}: GitUncommittedDiffsDependencies): UncommittedDiffs {
  return {
    async read(directory: string): Promise<UncommittedDiff | null> {
      const outcome = await runOperation(gitDiffOperation, { directory }, runner);
      return outcome.ok ? outcome.result : null;
    },
  };
}

/**
 * How many directories one store report will start git for.
 *
 * A report is sent on every scan, and a scan can be triggered by an agent
 * writing a line, so the cost of one has to be bounded by something other than
 * how many sessions a store happens to contain. Sessions in a store nearly
 * always share a working directory, so the deduplicated set is one or two; a
 * store of worktrees is the case this cap exists for, and there the sessions
 * past the cap report `null` rather than the report taking seconds.
 */
export const DIRECTORIES_PER_REPORT = 8;

/**
 * One diffstat per distinct directory, for the sessions in one report.
 *
 * Deduplicated because several sessions in one store are usually in one
 * checkout, and `git diff-index` answers for the whole repository whichever
 * directory inside it was named — so asking twice would be two children for one
 * answer. Concurrent for the reason discovery is: the directories are
 * independent, and a report that waited on each in turn would be as slow as the
 * slowest disk times the number of checkouts.
 *
 * A directory the cap excluded is simply absent from the map, which is the same
 * thing a directory git refused is, and both reach a descriptor as `null`. That
 * is deliberate: the field means "this server did not read it", and a client
 * that had to tell "too many checkouts" from "not a repository" would be
 * drawing this server's bookkeeping instead of the user's working tree.
 */
export async function readUncommittedDiffs(
  directories: readonly string[],
  diffs: UncommittedDiffs,
): Promise<ReadonlyMap<string, UncommittedDiff>> {
  const distinct = [...new Set(directories)].slice(0, DIRECTORIES_PER_REPORT);
  const read = await Promise.all(
    distinct.map(async (directory) => [directory, await diffs.read(directory)] as const),
  );

  const found = new Map<string, UncommittedDiff>();
  for (const [directory, diff] of read) {
    if (diff !== null) found.set(directory, diff);
  }
  return found;
}
