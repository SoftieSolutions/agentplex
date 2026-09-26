import {
  describeIssues,
  runOperation,
  type Operation,
  type OperationOutcome,
  type ProcessRunner,
} from '@agentplex/providers';
import { gitFilterNamesOperation } from './git-filter-names.js';

/**
 * A git probe, built for the filter drivers one repository configures.
 *
 * A factory rather than an operation because the argv depends on a fact about
 * the directory that only git can read, and an `Operation`'s argv is pure: it
 * sees the parsed request and nothing else. Closing over the names keeps it
 * pure -- the names are not a request field, so nothing from outside can put
 * one in -- and leaves the only way to get a probe with the right names the
 * function below, which read them.
 */
export type GitProbe<Request extends { readonly directory: string }, Result> = (
  filterNames: readonly string[],
) => Operation<Request, Result>;

/**
 * Runs a git probe the only way one is run: read the repository's filter
 * names, then run the probe with each of them switched off.
 *
 * Two children, one after the other, for every reading. The request is parsed
 * before either starts, so a request the probe would refuse starts nothing,
 * exactly as `runOperation` promises for any other operation. A read that
 * fails -- no git, a directory that is not there, a filter name `-c` cannot
 * carry -- is the reading's answer and the probe never runs: a probe run with
 * a filter nobody could switch off is the program this exists to keep from
 * running.
 *
 * The names are read fresh for every probe rather than once per directory,
 * so no probe runs with names somebody read for another question. There is
 * still a gap between the read and the probe; `git-filter-names.ts` says what
 * it is.
 */
export async function runGuardedGitProbe<Request extends { readonly directory: string }, Result>(
  create: GitProbe<Request, Result>,
  request: unknown,
  runner: ProcessRunner,
): Promise<OperationOutcome<Result>> {
  // Built with no names only for its name and its parser: nothing runs it.
  const unbuilt = create([]);
  const parsed = unbuilt.request.safeParse(request);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: 'invalid-request',
      problem: `${unbuilt.name} was asked for something it cannot do: ${describeIssues(parsed.error.issues)}`,
    };
  }

  const names = await runOperation(
    gitFilterNamesOperation,
    { directory: parsed.data.directory },
    runner,
  );
  if (!names.ok) return { ok: false, refusal: names.refusal, problem: names.problem };

  return runOperation(create(names.result), parsed.data, runner);
}

/**
 * The environment a git probe's runner gives its children: the server's own,
 * with lazy fetching off.
 *
 * In a partial clone, a probe that needs a blob the clone never fetched starts
 * a child `git fetch`, and that fetch runs whatever the repository's config
 * names for reaching its remote. `GIT_NO_LAZY_FETCH=1` stops it; git has
 * honoured it since 2.39.4, so bookworm's 2.39.5 included. The flag
 * `--no-lazy-fetch` would say the same in the argv, where the rest of the
 * probe's decisions are, but it arrived in 2.45 and 2.39.5 refuses it as an
 * unknown option. So it is a variable, and a variable is decided where a
 * runner is built rather than per request -- which is why `main` builds a
 * second runner for the probes with this environment and hands the sessions
 * and the pty the first one.
 *
 * A reading that needed the missing blob then fails rather than fetching it,
 * and fails as a whole: git dies instead of reporting what it could. That
 * reaches a client as "nobody read this", which under-claims; a fetch would
 * have been a program the repository chose.
 */
export function withoutLazyFetch(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return { ...environment, GIT_NO_LAZY_FETCH: '1' };
}
