import type { ZodType } from 'zod';
import type { CompletedProcess, ProcessRequest, ProcessRunner } from './process-runner.js';

/**
 * An operation: the only shape in which agentplexd knows how to run a program.
 *
 * The spec states the rule and the reason together — "every spawn goes through
 * the operation registry: name to typed parser to argv builder, `shell: false`
 * always. No frame carries an operation name, an argv element, an env var, or a
 * cwd. A generic `{ command }` frame is the failure mode the registry exists to
 * prevent — more so once open source." This type is that sentence made
 * structural.
 *
 * The three parts are separate on purpose, because each is a different kind of
 * thing and mixing them is how the guarantee gets lost:
 *
 * - `request` is a parser that can say no. Whatever arrives — a frame payload
 *   in milestone 3, an MCP tool call in milestone 6 — is a claim, and it
 *   becomes a typed value here or it becomes a refusal here.
 * - `argv` is pure and total: a parsed request in, a `file` and `args` out. It
 *   cannot read the clock, the disk or the environment, so what a given request
 *   runs is a value a test writes down. It is also the only thing that ever
 *   chooses an argv element; nothing upstream contributes one.
 * - `read` interprets the program's own output, given the request that produced
 *   it. It is where a nonzero exit code gets its meaning, which differs per
 *   program and per question. It gets the request back because a refusal has to
 *   name what was asked about — "git could not read /srv/work" is actionable
 *   where "git exited 128" is not — and because the alternative is each
 *   operation smuggling the answer back out of the argv it built.
 *
 * What is *not* here matters as much. An operation has no way to name a working
 * directory for the spawn, add an environment variable, or reach a shell,
 * because `ProcessRequest` has nowhere to put any of them.
 */
export interface Operation<Request, Result> {
  /**
   * What this operation is called. The registry is keyed on it; a name that is
   * not in the registry is a refusal and never a lookup that falls through to
   * running something.
   */
  readonly name: string;
  /** One sentence, for an operator reading a log line or an MCP tool listing. */
  readonly summary: string;
  readonly request: ZodType<Request>;
  readonly argv: (request: Request) => Argv;
  /** This operation's own answer to "how long may this block the server". */
  readonly timeoutMs: number;
  readonly read: (completed: CompletedProcess, request: Request) => OperationOutcome<Result>;
}

/**
 * What to run, and nothing else.
 *
 * Two fields, deliberately the same two the process seam takes: an argv builder
 * that wanted to set a cwd or an env var would have to change this type, and
 * changing it is the reviewable act. A directory belongs in `args`, as the flag
 * the child understands.
 */
export interface Argv {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * The answer, or the reason there isn't one.
 *
 * A refusal is a value rather than a thrown error because every one of these is
 * something a person has to be told: an operation nobody has, a request that
 * does not typecheck, a program that is not installed, output that does not
 * answer the question. Milestone 3 turns the tag into a refusal frame; nothing
 * here has to know that.
 */
export type OperationOutcome<Result> =
  | { readonly ok: true; readonly result: Result }
  | { readonly ok: false; readonly refusal: OperationRefusal; readonly problem: string };

export type OperationRefusal =
  /** No operation by that name. The registry is closed; this is where that shows. */
  | 'unknown-operation'
  /** The request did not parse. The caller asked for something ill-formed. */
  | 'invalid-request'
  /** The machine could not run it: not installed, killed, took too long. */
  | 'unavailable'
  /** It ran, and its output does not answer the question that was asked. */
  | 'failed';

/**
 * Runs one operation, the only way any operation is ever run.
 *
 * The name-keyed registry and the typed callers inside the server both come
 * through here, so there is exactly one place where a request is parsed, an
 * argv is built and a child is started, and no second path that skips a step.
 *
 * Note what happens to an unparseable request: the argv builder is never
 * reached, so a malformed request cannot contribute an argv element even in
 * principle.
 */
export async function runOperation<Request, Result>(
  operation: Operation<Request, Result>,
  request: unknown,
  runner: ProcessRunner,
): Promise<OperationOutcome<Result>> {
  const parsed = operation.request.safeParse(request);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: 'invalid-request',
      problem: `${operation.name} was asked for something it cannot do: ${describeIssues(parsed.error.issues)}`,
    };
  }

  const argv = operation.argv(parsed.data);
  const process: ProcessRequest = {
    file: argv.file,
    args: argv.args,
    timeoutMs: operation.timeoutMs,
  };

  const outcome = await runner.run(process);
  if (outcome.kind === 'failed') {
    return { ok: false, refusal: 'unavailable', problem: outcome.problem };
  }

  return operation.read(outcome, parsed.data);
}

/** Zod's issues, flattened into the one line a refusal carries. */
function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}
