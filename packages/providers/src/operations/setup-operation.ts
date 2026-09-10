import type { ZodType } from 'zod';
import type { OneShotPlan } from '../provider-adapter.js';
import type { ProviderRegistry } from '../provider-registry.js';
import { describeIssues, type OperationOutcome, type OperationRefusal } from './operation.js';
import type { ProcessRequest, ProcessRunner } from './process-runner.js';

/**
 * A setup operation: the only shape in which the setup path knows how to run a
 * program.
 *
 * Read it beside `Operation` in `operation.ts`, because everything they have in
 * common is deliberate and the one difference is the whole reason this type
 * exists. Both parse a request that can be said no to, both build an argv and
 * nothing else, both hand a `CompletedProcess` to a reader that knows what a
 * nonzero exit means for that program, and both reach the same `ProcessRunner`,
 * which has nowhere to put a cwd, an env var or a shell.
 *
 * The difference is where the argv comes from. A wire-facing operation's argv is
 * a module constant of a function: `git.status` runs `git`, always, and the
 * builder is pure and total. A provisioning argv is the *adapter's* answer —
 * `npm` for a provider that ships to npm, something else for one that ships a
 * tarball — and it can be a refusal, because "there is no way to install that
 * there" is an answer setup has to show an operator. So the middle step is
 * `plan` rather than `argv`: a parsed request and the provider registry in, one
 * program to run or a named refusal out. Nothing else moves.
 *
 * What is deliberately *not* shared is the operation list. That is `AGENTS.md`'s
 * "every spawn goes through the operation registry" kept while `provider.install`
 * stays off the wire entirely, and it is asserted in `operation-registry.test.ts`
 * rather than left as a paragraph.
 */
export interface SetupOperation<Request, Result> {
  /**
   * What this operation is called. The setup registry is keyed on it, and a
   * name that is not in that registry is a refusal — the same closed lookup the
   * wire-facing registry gives, over a different and disjoint list.
   */
  readonly name: string;
  /** One sentence, for an operator reading a log line or a wizard's transcript. */
  readonly summary: string;
  readonly request: ZodType<Request>;
  /**
   * The one program this request means, or the reason there is not one.
   *
   * It takes the provider registry rather than an adapter because the request
   * names a provider, and turning a provider name into an adapter happens in
   * exactly one place. It does not take a filesystem, a clock or an
   * environment: like `argv`, what a given request runs stays a value a test
   * writes down.
   */
  readonly plan: (request: Request, providers: ProviderRegistry) => SetupPlanned<Result>;
}

/**
 * One program to run, or a refusal that already knows what kind it is.
 *
 * The refusal is tagged here rather than flattened at the registry because the
 * planner is the only thing that can tell the two apart: a provider nobody has
 * heard of is a bad request, and a provider this build simply has no adapter for
 * is the build's own limit. A caller that had to match on the message to know
 * which is a caller that will get it wrong.
 */
export type SetupPlanned<Result> =
  | { readonly ok: true; readonly plan: OneShotPlan<Result> }
  | { readonly ok: false; readonly refusal: OperationRefusal; readonly problem: string };

/**
 * Runs one setup operation, the only way any setup operation is ever run.
 *
 * The order is the order in `runOperation` and for the same reasons: an
 * unparseable request never reaches a planner, a refused plan never reaches the
 * runner, and a runner that could not start the program is `unavailable` rather
 * than an answer. The reader's own refusal is `failed` — it ran, and its output
 * does not answer the question that was asked.
 */
export async function runSetupOperation<Request, Result>(
  operation: SetupOperation<Request, Result>,
  request: unknown,
  runner: ProcessRunner,
  providers: ProviderRegistry,
): Promise<OperationOutcome<Result>> {
  const parsed = operation.request.safeParse(request);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: 'invalid-request',
      problem: `${operation.name} was asked for something it cannot do: ${describeIssues(parsed.error.issues)}`,
    };
  }

  const planned = operation.plan(parsed.data, providers);
  if (!planned.ok) {
    return { ok: false, refusal: planned.refusal, problem: planned.problem };
  }

  const process: ProcessRequest = {
    file: planned.plan.argv.file,
    args: planned.plan.argv.args,
    timeoutMs: planned.plan.timeoutMs,
  };

  const outcome = await runner.run(process);
  if (outcome.kind === 'failed') {
    return { ok: false, refusal: 'unavailable', problem: outcome.problem };
  }

  const read = planned.plan.read(outcome);
  return read.ok
    ? { ok: true, result: read.result }
    : { ok: false, refusal: 'failed', problem: read.problem };
}
