import type { UncommittedDiff } from '@agentplex/protocol';
import type { ProcessRunner } from '@agentplex/providers';
import { runOperation } from '@agentplex/providers';
import { gitDiffOperation } from './operations/git-diff.js';
import { gitStatusOperation } from './operations/git-status.js';

/**
 * What the store report asks when it wants to know about a session's checkout.
 *
 * A seam of its own rather than a `ProcessRunner` handed to the session
 * controller, because those are different capabilities and only one of them is
 * the controller's business. "Read a directory's branch and diffstat" is a
 * question a test answers with a value; "start any program you like" is a
 * licence, and a controller that held one would be a second place to look when
 * asking what this server can spawn.
 *
 * Two methods rather than one, because they are two readings from two git
 * invocations and they fail independently: a repository with no commits yet has
 * a branch and no diffstat. One method returning both would have to invent a
 * shape in which half an answer is expressible anyway, and the caller would
 * still have to handle it.
 *
 * `null` is the only failure shape on either, and it means one thing: nobody
 * looked, or whoever looked could not say. A directory that is not a
 * repository, a repository with no commit yet, a machine with no git, a git
 * that took too long, a path the provider recorded that no longer exists -- a
 * client draws nothing for all of them.
 */
export interface WorkingTree {
  /**
   * The branch checked out in a directory, or `null` when there is no name.
   *
   * A detached HEAD and a directory that could not be read are the same `null`
   * here, deliberately: both mean there is no branch name to show, and neither
   * claims anything about the checkout. The diffstat below distinguishes them
   * because a zero there would claim somebody has nothing outstanding.
   */
  branch(directory: string): Promise<string | null>;
  /** The diffstat for one directory, or `null` when it could not be read. */
  uncommitted(directory: string): Promise<UncommittedDiff | null>;
}

export interface GitWorkingTreeDependencies {
  /**
   * The one-shot process seam, from the one place allowed to build it. This is
   * the reason the reader is composed in `main` rather than here: the runner
   * fixes what a child inherits, and only the entrypoint has read this
   * process's environment.
   */
  readonly runner: ProcessRunner;
}

/**
 * The real reader: `git.status` and `git.diff`, through the same `runOperation`
 * the registry uses.
 *
 * Not `registry.execute('git.diff', ...)`, which would hand back `unknown` and
 * need a parser here to get the type back. A caller that knows which operation
 * it wants names the operation, and both paths build the same argv and start
 * the same child; the registry exists so that a caller which learned a name
 * from outside cannot reach anything else, and this caller learned nothing from
 * outside.
 *
 * `git.status` reports more than the branch -- the upstream, the distance from
 * it, its own count of changed entries -- and only the branch is taken. The
 * rest has nowhere to go that a client reads, and a field on the wire that
 * nothing draws is a claim nobody checks.
 */
export function createGitWorkingTree({ runner }: GitWorkingTreeDependencies): WorkingTree {
  return {
    async branch(directory: string): Promise<string | null> {
      const outcome = await runOperation(gitStatusOperation, { directory }, runner);
      return outcome.ok ? outcome.result.branch : null;
    },

    async uncommitted(directory: string): Promise<UncommittedDiff | null> {
      const outcome = await runOperation(gitDiffOperation, { directory }, runner);
      return outcome.ok ? outcome.result : null;
    },
  };
}

/**
 * How many directories one store report will read a working tree for.
 *
 * A report is sent on every scan, and a scan can be triggered by an agent
 * writing a line, so the cost of one has to be bounded by something other than
 * how many sessions a store happens to contain. Sessions in a store nearly
 * always share a working directory, so the deduplicated set is one or two; a
 * store of worktrees is the case this cap exists for, and there the sessions
 * past the cap report `null` rather than the report taking seconds.
 *
 * The cap counts directories and not children, and a directory now costs two
 * children rather than one. That is the right unit to bound: both are short
 * questions to git about the same checkout, both pass `--no-optional-locks` so
 * neither can take a lock from the agent working there, and they are started
 * together -- so what a report costs in the time a person waits is unchanged,
 * and what it costs the machine is bounded by the same number it always was.
 */
export const DIRECTORIES_PER_REPORT = 8;

/** Everything one scan read about one checkout. */
export interface WorkingTreeReading {
  readonly branch: string | null;
  readonly uncommitted: UncommittedDiff | null;
}

/**
 * One reading per distinct directory, for the sessions in one report.
 *
 * Deduplicated because several sessions in one store are usually in one
 * checkout, and both git questions answer for the whole repository whichever
 * directory inside it was named -- so asking twice would be two children for
 * one answer. Concurrent for the reason discovery is: the directories are
 * independent, and a report that waited on each in turn would be as slow as the
 * slowest disk times the number of checkouts. The two questions about one
 * directory are concurrent with each other for the same reason, and it is what
 * makes them one reading of one checkout at one moment rather than two readings
 * a client would have to reconcile.
 *
 * A directory the cap excluded is simply absent from the map, which is the same
 * thing a directory git refused is, and both reach a descriptor as `null`. That
 * is deliberate: the fields mean "this server did not read it", and a client
 * that had to tell "too many checkouts" from "not a repository" would be
 * drawing this server's bookkeeping instead of the user's working tree.
 */
export async function readWorkingTrees(
  directories: readonly string[],
  trees: WorkingTree,
): Promise<ReadonlyMap<string, WorkingTreeReading>> {
  const distinct = [...new Set(directories)].slice(0, DIRECTORIES_PER_REPORT);
  const read = await Promise.all(
    distinct.map(async (directory) => {
      const [branch, uncommitted] = await Promise.all([
        trees.branch(directory),
        trees.uncommitted(directory),
      ]);
      return [directory, { branch, uncommitted }] as const;
    }),
  );

  return new Map(read);
}
