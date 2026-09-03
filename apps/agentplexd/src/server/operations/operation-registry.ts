import { gitStatusOperation } from './git-status.js';
import { runOperation, type Operation, type OperationOutcome } from './operation.js';
import { processStartTimeOperation } from './process-start-time.js';
import type { ProcessRunner } from './process-runner.js';

/**
 * The operation registry: every program agentplexd can run, by name, and no
 * way to run one that is not here.
 *
 * "Closed" is the whole design. The list below is a module constant, and
 * `createOperationRegistry` takes no operations — there is no parameter through
 * which a caller could add one, no plugin hook, and no path that falls back to
 * running a name it does not know. A name that is not in this file is a
 * refusal, always, and the set of programs a build can start is a diff a
 * reviewer reads rather than a runtime property nobody can enumerate.
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
 * Two today, and both earn their place by being needed rather than by
 * demonstrating the shape:
 *
 * - `process.start-time` dates a pid where `/proc` does not exist. It is on the
 *   discovery path already — it is what stops a provider's stale registry entry
 *   being reported as a live session — and it replaces the one direct
 *   `execFile` call that used to sit in `node-process-probe`.
 * - `git.status` answers the first question anyone asks about a session's
 *   working directory. The hub cannot: the directory is on the server's disk.
 *
 * Nothing speculative is here. An operation with no caller is an argv nobody
 * has run, and the registry's value is that its contents are exactly what this
 * build can do.
 */
const OPERATIONS: readonly RegisteredOperation[] = [
  register(gitStatusOperation),
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

export interface OperationRegistry {
  /** The operations this build has, for a boot log line and, later, an MCP listing. */
  readonly operations: readonly OperationSummary[];
  /**
   * Runs an operation by name.
   *
   * The result is `unknown` on purpose. A caller that reached the registry by
   * name learned the name from outside the type system, so it cannot be handed
   * a typed result honestly; a caller that knows which operation it wants calls
   * `runOperation` with the operation itself and keeps its types. Both paths
   * run the same parser, build the same argv and start the same child.
   */
  execute(name: string, request: unknown): Promise<OperationOutcome<unknown>>;
}

export interface OperationSummary {
  readonly name: string;
  readonly summary: string;
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
