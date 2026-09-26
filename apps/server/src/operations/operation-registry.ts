import { createGitDiffOperation } from './git-diff.js';
import { runGuardedGitProbe, type GitProbe } from './git-probe.js';
import { createGitStatusOperation } from './git-status.js';
import {
  runOperation,
  type Operation,
  type OperationOutcome,
  type OperationSummary,
  processStartTimeOperation,
  type ProcessRunner,
} from '@agentplex/providers';

/**
 * The operation registry: every program agentplex can run, by name, and no
 * way to run one that is not here.
 *
 * "Closed" is the whole design. The list below is a module constant, and
 * `createOperationRegistry` takes no operations — there is no parameter through
 * which a caller could add one, no plugin hook, and no path that falls back to
 * running a name it does not know. A name that is not in this file is a
 * refusal, always, and the set of programs a build can start is a diff a
 * reviewer reads rather than a runtime property nobody can enumerate. That set
 * holds one argv the list of names does not: each git probe starts a `git
 * config` read of the repository's filter drivers before itself. The read is
 * reached from this file, through `registerGuarded`, and never by a name a
 * caller can send.
 *
 * The spec names the failure mode this is built against: "a generic
 * `{ command }` frame is the failure mode the registry exists to prevent — more
 * so once open source". The registry closes it from both ends. There is no
 * command string to send, because `execute` takes a name and an object and the
 * argv is built here from a parsed value; and there is no name worth guessing,
 * because the map is finite and typed.
 *
 * Milestone 3 hands this the payload of a frame; milestone 6 hands it an MCP
 * tool call. Neither gains a capability the other lacks, because both arrive at
 * this same method — which is why the executor is here and not in the frame
 * router.
 */

/**
 * Every operation this build can run.
 *
 * Three today, and each earns its place by being needed rather than by
 * demonstrating the shape:
 *
 * - `process.start-time` dates a pid where `/proc` does not exist. It is on the
 *   discovery path already — it is what stops a provider's stale registry entry
 *   being reported as a live session — and it replaces the one direct
 *   `execFile` call that used to sit in `node-process-probe`.
 * - `git.status` answers the first question anyone asks about a session's
 *   working directory, which is the branch. The hub cannot: the directory is on
 *   the server's disk.
 * - `git.diff` answers the next one, which is how much is uncommitted and in
 *   which files.
 *
 * Both of the last two are on the store report path: every scan attaches what
 * it read to the descriptors it is about to send, so the branch and the numbers
 * a client draws are what this machine read off its own disk. Each of them is
 * two children rather than one: the filter read above, then the probe with
 * those filters switched off.
 *
 * Nothing speculative is here. An operation with no caller is an argv nobody
 * has run, and the registry's value is that its contents are exactly what this
 * build can do.
 */
const OPERATIONS: readonly RegisteredOperation[] = [
  registerGuarded(createGitDiffOperation),
  registerGuarded(createGitStatusOperation),
  register(processStartTimeOperation),
];

/**
 * One operation with its two type parameters closed over rather than cast away.
 *
 * The list has to be heterogeneous — every operation parses a different request
 * type — and the obvious way to write that down is a cast to some widest type,
 * which is precisely the move this codebase does not make. Capturing the
 * generics in a closure keeps `runOperation` fully typed at the only place the
 * types are still known, and leaves `unknown` where it is honest: at the
 * boundary, where a name and a payload arrived together from outside.
 */
interface RegisteredOperation {
  readonly name: string;
  readonly summary: string;
  run(request: unknown, runner: ProcessRunner): Promise<OperationOutcome<unknown>>;
}

function register<Request, Result>(operation: Operation<Request, Result>): RegisteredOperation {
  return {
    name: operation.name,
    summary: operation.summary,
    run: (request, runner) => runOperation(operation, request, runner),
  };
}

/**
 * A git probe, which only runs after the repository's filter names were read.
 *
 * Registered through its factory rather than as an operation, so the name-keyed
 * path has no probe built for no names to reach: the only thing `run` can do
 * with it is `runGuardedGitProbe`. The name and the summary do not depend on the
 * names, so they are read off a probe built for none.
 */
function registerGuarded<Request extends { readonly directory: string }, Result>(
  create: GitProbe<Request, Result>,
): RegisteredOperation {
  const { name, summary } = create([]);
  return {
    name,
    summary,
    run: (request, runner) => runGuardedGitProbe(create, request, runner),
  };
}

export interface OperationRegistry {
  /** The operations this build has, for a boot log line and, later, an MCP listing. */
  readonly operations: readonly OperationSummary[];
  /**
   * Runs an operation by name.
   *
   * The result is `unknown` on purpose. A caller that reached the registry by
   * name learned the name from outside the type system, so it cannot be handed
   * a typed result honestly; a caller that knows which operation it wants calls
   * `runOperation` with the operation itself -- `runGuardedGitProbe` with the
   * factory, for a git probe -- and keeps its types. Both paths run the same
   * parser, build the same argv and start the same children.
   */
  execute(name: string, request: unknown): Promise<OperationOutcome<unknown>>;
}

export function createOperationRegistry(runner: ProcessRunner): OperationRegistry {
  const byName = new Map(OPERATIONS.map((operation) => [operation.name, operation]));

  return {
    operations: OPERATIONS.map(({ name, summary }) => ({ name, summary })),

    async execute(name: string, request: unknown): Promise<OperationOutcome<unknown>> {
      const operation = byName.get(name);
      if (operation === undefined) {
        // The name is not echoed back into anything that runs, and it is not
        // treated as a program. It is a word that failed a lookup.
        return {
          ok: false,
          refusal: 'unknown-operation',
          problem: `there is no operation called ${JSON.stringify(name)}`,
        };
      }

      return operation.run(request, runner);
    },
  };
}
