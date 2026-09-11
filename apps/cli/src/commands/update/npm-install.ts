import { join } from 'node:path';
import {
  runOperation,
  type Operation,
  type ProcessRunner,
  type ProgramResolver,
} from '@agentplex/providers';
import { z } from 'zod';
import { NODE_DIRECTORY, type Layout } from '../../installation/layout.js';
import type { UpdateMachine } from './update-machine.js';

/**
 * npm, as the only thing that replaces a package in the prefix.
 *
 * `install.sh` installs with `npm install --global --prefix <prefix>
 * --ignore-scripts=false <tarball urls>`, and an update is the same command
 * with different URLs -- which is the point: a package installed by an update
 * has to be indistinguishable from one installed by the installer, or the next
 * install is the one that discovers the difference.
 *
 * The two flags that are not defaults are both load-bearing.
 *
 * `--ignore-scripts=false` overrides whatever an operator's npmrc says.
 * node-pty's install scripts are what compile the addon, and the pty package's
 * postinstall restores the executable bit the npm tarball drops from node-pty's
 * `spawn-helper`. An npmrc carrying `ignore-scripts=true` produces an install
 * that reports success and a service that cannot start -- and that postinstall
 * cannot warn about it, because it is disabled by the same setting.
 *
 * `--prefix` is the prefix this install actually used, read out of the settings
 * file rather than assumed, which is what makes an install into `/srv/agentplex`
 * updatable at all.
 */

/**
 * Long, and it is the one operation here that deserves to be. A server's
 * install compiles a native addon from source on a machine that may be a small
 * cloud instance; ten minutes is not a budget, it is the point past which
 * something is wrong rather than slow.
 */
const INSTALL_TIMEOUT_MS = 600_000;

const installRequestSchema = z.strictObject({
  npm: z.string().min(1),
  prefix: z.string().min(1),
  /**
   * The tarball URLs. Parsed rather than trusted: every one was built by
   * `releaseUrl` out of a component and a version that came from a manifest
   * that was parsed or a pin that was matched against the release grammar, and
   * this is the last place that can say no before a string becomes an argv
   * element handed to npm.
   */
  specs: z.array(z.string().url()).min(1),
});

export type InstallRequest = z.infer<typeof installRequestSchema>;

export const installOperation: Operation<InstallRequest, null> = {
  name: 'npm.install-release',
  summary: 'install released agentplex packages into the prefix this machine uses',
  request: installRequestSchema,
  timeoutMs: INSTALL_TIMEOUT_MS,
  argv: (request) => ({
    file: request.npm,
    args: [
      'install',
      '--global',
      '--prefix',
      request.prefix,
      '--ignore-scripts=false',
      ...request.specs,
    ],
  }),
  read: (completed) =>
    completed.exitCode === 0
      ? { ok: true, result: null }
      : {
          ok: false,
          refusal: 'failed',
          // npm's own last line, which on a failed compile is node-gyp's and is
          // worth more than any rewording of it here.
          problem: lastLine(completed.stderr) ?? lastLine(completed.stdout) ?? 'npm said nothing',
        },
};

export type InstallOutcome =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

export async function installPackages(
  npm: string,
  layout: Layout,
  specs: readonly string[],
  runner: ProcessRunner,
): Promise<InstallOutcome> {
  const outcome = await runOperation(
    installOperation,
    { npm, prefix: layout.prefix, specs },
    runner,
  );
  return outcome.ok ? { ok: true } : { ok: false, problem: outcome.problem };
}

/**
 * Which npm to run, which is `npm_command` in the installer restated.
 *
 * The prefix's own first, and that ordering is the whole point rather than a
 * preference: a runtime this install owns is on nobody's PATH, so an npm
 * resolved off PATH would be the machine's, running under the machine's Node --
 * which is the failure `ensure_node` has a captured note about, where a v20
 * shim compiled a native addon against the wrong runtime and the install
 * reported success. After a runtime swap it matters even more, since the npm
 * beside the new interpreter is the one that came with it.
 *
 * It is a path when it is the prefix's and a program name when it is the
 * machine's, and that is the one place this app hands a path where a program
 * name usually goes. It is deliberate: `<prefix>/node/bin/npm` is not on any
 * search path, so naming it is the only way to reach it, and the alternative --
 * prepending the directory to the child's PATH -- would change the environment
 * of every spawn this process makes to influence one of them.
 */
export async function resolveNpm(
  layout: Layout,
  machine: UpdateMachine,
  programs: ProgramResolver,
): Promise<string | null> {
  const owned = join(layout.prefix, NODE_DIRECTORY, 'bin', 'npm');
  if (await machine.isFile(owned)) return owned;
  return (await programs.resolve('npm')) === null ? null : 'npm';
}

function lastLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? null;
}
