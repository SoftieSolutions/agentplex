import type { ZodType } from 'zod';
import { describeIssues, type Argv } from './operation.js';

/**
 * Starting a child and letting go of it.
 *
 * The one-shot runner beside this covers every spawn agentplex had until now:
 * run it, wait, read what it said. This is the other shape, and it exists for
 * exactly one caller -- the passive update notice, which finds a stale version
 * cache and wants it refreshed for next time without the command an operator
 * actually typed waiting on a network request.
 *
 * The difference is the whole point rather than an implementation detail:
 *
 * - **Nothing is read back.** There is no `read`, because there is no output to
 *   interpret. The child's stdio goes to nowhere, so anything it prints cannot
 *   land in the middle of the parent's report, and a caller cannot be tempted
 *   to wait for a line.
 * - **There is no timeout**, because there is nothing to time. The child
 *   outlives this process; killing it later would need a handle this seam
 *   deliberately does not hand out.
 * - **The only answer is whether it started.** A machine that could not start
 *   it has a fact worth one line in a `--check` report, and the notice itself
 *   says nothing either way: a refresh that failed is a cache that stays stale,
 *   which is a run without a notice rather than an error.
 *
 * Everything the registry guarantees is kept. A request goes through a parser
 * that can say no, the argv is built by a pure function from the parsed value,
 * and there is no shell, no cwd and no environment for a caller to contribute
 * to -- `Argv` is the same two fields a `ProcessRequest` carries, minus the
 * timeout that has no meaning here.
 */

/**
 * An operation that is started rather than run.
 *
 * The same three parts as an `Operation` with `read` and `timeoutMs` removed,
 * rather than an `Operation` with those two made optional: an operation whose
 * `read` is sometimes never called is a type that lies about what happens to a
 * child, and the two kinds of spawn are worth telling apart at the call site.
 */
export interface DetachedOperation<Request> {
  readonly name: string;
  /** One sentence, for an operator reading a log line. */
  readonly summary: string;
  readonly request: ZodType<Request>;
  readonly argv: (request: Request) => Argv;
}

/** Whether a child was started. Nothing is claimed about what it then did. */
export type DetachedStart =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

export interface DetachedSpawner {
  /**
   * Starts it and returns.
   *
   * Never rejects, for the reason the one-shot runner never does: a program
   * that is not installed is an outcome the caller answers for, and an
   * exception would unwind past the one place that knows what the failure is
   * worth.
   */
  start(argv: Argv): Promise<DetachedStart>;
}

/**
 * Starts one detached operation, the only way any of them is ever started.
 *
 * The mirror of `runOperation`, and deliberately the same shape: the request is
 * parsed before the argv builder is reached, so a malformed request cannot
 * contribute an argv element even in principle.
 */
export async function startDetached<Request>(
  operation: DetachedOperation<Request>,
  request: unknown,
  spawner: DetachedSpawner,
): Promise<DetachedStart> {
  const parsed = operation.request.safeParse(request);
  if (!parsed.success) {
    return {
      ok: false,
      problem: `${operation.name} was asked for something it cannot do: ${describeIssues(
        parsed.error.issues,
      )}`,
    };
  }

  return spawner.start(operation.argv(parsed.data));
}
