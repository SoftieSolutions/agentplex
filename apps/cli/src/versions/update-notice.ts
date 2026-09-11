import { isNewerVersion } from '@agentplex/release';
import { startDetached, type DetachedOperation, type DetachedSpawner } from '@agentplex/providers';
import { z } from 'zod';
import type { InstallationFiles } from '../installation/installation-files.js';
import { NO_UPDATE_CHECK_FLAG } from './notice-flags.js';
import { describeAge, isStale, readCachedVersions } from './versions-cache.js';

/**
 * "1.5.0 is available": one line on stderr, after a command has finished, when
 * a newer command exists than the one that just ran.
 *
 * Every constraint below is load-bearing, and together they are the whole
 * design.
 *
 * **It never makes a network call.** Not a short one, not a backgrounded one it
 * waits on -- none. `agentplex status` on a laptop with no route out must be
 * exactly as fast as it is on one with a route, because the alternative is a
 * command that hangs for a timeout somebody will eventually work around by
 * turning the notice off. So this reads a cache and nothing else, and a cache
 * that is too old asks a *detached* child to refresh it for next time and says
 * nothing this run. The notice is then at most one run late, which is the price
 * and it is small: what it is announcing has been true since the release.
 *
 * The alternative -- print the stale answer with its age and refresh at the
 * same time -- was the other candidate, and it loses on one case: a machine
 * whose refresh keeps failing would repeat a month-old claim every run, and an
 * operator who read it would be right to believe it less each time. Silence
 * until there is a fresh answer is the version of this that never wears out.
 *
 * **stderr, always.** `agentplex --version` inside `$(...)` is a real thing
 * somebody writes, and a notice on stdout would end up in a variable that was
 * supposed to hold a version. Beyond that, a notice is not an answer to what
 * anybody asked -- which is the same line every command here draws between its
 * report and its diagnostics.
 *
 * **Silent when nobody is reading.** Not a terminal, an environment variable
 * set, `--no-update-check`, or the question was `--version`: any of them and
 * there is no line. The TTY test is the one that matters most, because it is
 * what keeps this out of pipes, logs, CI output and the detached refresh's own
 * run -- a child started with its stdio going nowhere has no terminal, so it
 * cannot print a notice and cannot ask for a refresh of its own.
 *
 * **A cached answer is labelled with its age.** The cache is up to a day old
 * even when it is fresh, so "1.5.0 is available" without a date is a claim this
 * program cannot make. What it can say is when it last looked.
 */

/** The word `versions.json` keys the command's own release on. */
const CLI_COMPONENT = 'cli';

/**
 * The version every manifest in this workspace carries, and no released package
 * does.
 *
 * Nothing here is versioned -- the tag is the single statement of what was
 * released -- so a checkout and the development image both report `0.0.0`. A
 * comparison against it says every release is newer, which would put a notice
 * under every command a contributor runs and teach them to ignore it. It is not
 * a version, so it gets no opinion.
 */
const UNRELEASED = '0.0.0';

/**
 * Asking this machine's own agentplex to refresh the cache, in the background.
 *
 * `update --check` is what refreshes it, which is the whole reason there is one
 * version-check mechanism here rather than two: the notice does not know how to
 * fetch anything, it knows how to ask the command that does. The child writes
 * the cache and exits; its output goes nowhere, so nothing it prints can land
 * in the middle of the report the parent has just written.
 *
 * The interpreter and the entrypoint are process facts read at the entrypoint
 * and passed down, exactly as the foreground command's interpreter is. Both are
 * parsed here rather than trusted: they end up as argv elements, which is the
 * one place this app is strict about by rule.
 */
const refreshOperation: DetachedOperation<{
  readonly interpreter: string;
  readonly entrypoint: string;
}> = {
  name: 'agentplex.refresh-versions',
  summary: "ask this machine's own agentplex to refresh its version cache",
  request: z.strictObject({
    interpreter: z.string().min(1),
    entrypoint: z.string().min(1),
  }),
  argv: (request) => ({
    file: request.interpreter,
    // `--no-update-check` as well, so that the child cannot even in principle
    // decide to ask for a refresh of its own. Its stdio already makes that
    // impossible; two reasons for something that must never recurse is cheap.
    args: [request.entrypoint, 'update', '--check', NO_UPDATE_CHECK_FLAG],
  }),
};

export interface UpdateNoticeDependencies {
  /** Read-only, because this only ever reads: the refresh is a child's job. */
  readonly files: InstallationFiles;
  readonly now: () => number;
  readonly spawner: DetachedSpawner;
  /** Where this identity's cache is, or `null` when it has nowhere for one. */
  readonly cacheFile: string | null;
  /** The version of the package this bin is running out of, or `null`. */
  readonly runningVersion: string | null;
  /** `process.execPath` and `process.argv[1]`: what the refresh re-runs. */
  readonly interpreter: string;
  readonly entrypoint: string;
}

/**
 * The notice, as the lines to write. Empty is the ordinary answer.
 *
 * Lines rather than a write, so that what an operator reads is a value a test
 * can assert on -- the same split every report in this app makes.
 */
export async function updateNotice(
  dependencies: UpdateNoticeDependencies,
): Promise<readonly string[]> {
  const { cacheFile, runningVersion, now } = dependencies;
  if (cacheFile === null) return [];

  const cached = await readCachedVersions(cacheFile, dependencies.files);
  if (cached === null) {
    // No cache, or one this cannot read. Both are the same machine as far as
    // this run is concerned -- there is nothing to say -- and both are worth a
    // refresh, because the second one is how a truncated file heals.
    await requestRefresh(dependencies);
    return [];
  }

  if (isStale(cached, now())) {
    await requestRefresh(dependencies);
    return [];
  }

  if (runningVersion === null || runningVersion === UNRELEASED) return [];

  const available = cached.manifest[CLI_COMPONENT]?.version;
  if (available === undefined || !isNewerVersion(available, runningVersion)) return [];

  return [
    `agentplex ${available} is available; you are running ${runningVersion} ` +
      `(checked ${describeAge(now() - cached.checkedAt)})`,
    'agentplex update installs it, and agentplex update --check says what would change.',
  ];
}

/**
 * Ask for a refresh, and do not care whether it happened.
 *
 * A machine that cannot start a child is a machine whose cache stays stale,
 * which is a run without a notice -- which is what this run was going to be
 * anyway. Nothing is printed and nothing is waited for.
 */
async function requestRefresh({
  spawner,
  interpreter,
  entrypoint,
}: UpdateNoticeDependencies): Promise<void> {
  await startDetached(refreshOperation, { interpreter, entrypoint }, spawner);
}
