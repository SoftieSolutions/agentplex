import { isAbsolute, join } from 'node:path';
import { firstLine } from '@agentplex/node-shared';
import {
  runOperation,
  type Operation,
  type ProcessRunner,
  type ProgramResolver,
} from '@agentplex/providers';
import { z } from 'zod';
import {
  CLI_COMMAND,
  CLI_ENTRYPOINT,
  COMPONENTS,
  COMPONENT_PACKAGES,
} from '../../installation/components.js';
import {
  NODE_DIRECTORY,
  PACKAGE_DIRECTORY,
  packageDirectory,
  type Layout,
} from '../../installation/layout.js';
import type { Downloader } from './runtime.js';
import type { UpdateMachine } from './update-machine.js';
import type { PackageInstall, PackageTarball } from './update-plan.js';

/**
 * How a released package is put into the prefix, which is `install.sh`'s
 * `install_package` restated -- and the point of restating it rather than doing
 * something simpler is that a package installed by an update has to be
 * indistinguishable from one installed by the installer, or the next install is
 * the one that discovers the difference.
 *
 * ## Unpacked, then installed against its own shrinkwrap
 *
 * Every tarball carries an `npm-shrinkwrap.json`: the third-party versions this
 * build was tested against, transitive ones included. `npm install --global
 * <tarball>`, which is what this used to run, ignores it (AGX-322, Q8) and
 * resolves every range fresh against whatever the registry calls newest that
 * day, so two machines updated a week apart ran different code under one
 * version number. npm reads a shrinkwrap only when the package is the project
 * it installs into, so each tarball is downloaded, unpacked into `<tree>.new`,
 * and npm is pointed at that directory with `--prefix`. No working directory is
 * needed, which suits an operation that cannot set one: `--prefix` and running
 * inside the directory produce the same tree (AGX-322, Q2).
 *
 * `npm install` and not `npm ci`, although `ci` is the command that sounds like
 * this. `ci` deletes `node_modules` before it starts, which takes the bundled
 * `@agentplex/*` packages with it, and then asks the registry for them under
 * names nothing is published as -- E404 (AGX-322, Q1). `install` keeps what the
 * tarball brought and fetches the rest at the shrinkwrap's versions.
 *
 * ## All or nothing, per set
 *
 * Every package of one `PackageInstall` is staged before any tree is moved, and
 * a failure while staging removes every `.new` so far: the trees the machine was
 * running on are not touched. Only then is each moved in, as two renames on one
 * filesystem with the old tree set aside first, so a move that fails is undone
 * by a third. The command's own package is a set of its own, last, for the
 * reason `update-plan.ts` gives.
 *
 * ## The flags that are not defaults, each added by a probe (AGX-322)
 *
 * `--ignore-scripts=false` overrides whatever an operator's npmrc says.
 * node-pty's install scripts are what compile the addon, and the pty package's
 * postinstall restores the executable bit the npm tarball drops from node-pty's
 * `spawn-helper`. An npmrc carrying `ignore-scripts=true` produces an install
 * that reports success and a service that cannot start -- and that postinstall
 * cannot warn about it, because it is disabled by the same setting.
 *
 * `--globalconfig` because `--prefix` moves npm's global config to
 * `<staging>/etc/npmrc`, a file that does not exist, and the operator's own --
 * a registry mirror, a proxy, a CA bundle -- would silently stop applying
 * (Q14). The path is asked once, without `--prefix`, and handed back.
 * `--package-lock=true` because an npmrc `package-lock=false` makes npm ignore
 * the shrinkwrap altogether, `--no-save` because npm otherwise rewrites the
 * shrinkwrap it read, and `--install-strategy=hoisted` because that is the
 * layout the shrinkwrap was written in, whatever an npmrc prefers.
 */

/**
 * Long, and it is the one operation here that deserves to be. A server's
 * install compiles a native addon from source on a machine that may be a small
 * cloud instance; ten minutes is not a budget, it is the point past which
 * something is wrong rather than slow.
 */
const INSTALL_TIMEOUT_MS = 600_000;

/** A package is a few megabytes, and unpacking one is not what takes the time. */
const UNPACK_TIMEOUT_MS = 120_000;

/** A question npm answers out of its config, without the network. */
const CONFIG_TIMEOUT_MS = 30_000;

/**
 * A path handed to a program as an argv element. Absolute, because every one
 * of these was composed out of the prefix, the temporary directory or npm's own
 * answer, and a relative one would be resolved against whichever directory this
 * command happened to be started in.
 */
const absolutePath = z
  .string()
  .min(1)
  .refine((path) => isAbsolute(path), 'an absolute path');

const globalConfigRequestSchema = z.strictObject({ npm: z.string().min(1) });

/**
 * Where npm reads its global config from, asked without `--prefix`.
 *
 * Run by the same npm that installs, so the answer is the file that npm would
 * have read on its own. Leaving `--prefix` off is the whole point of asking.
 */
export const globalConfigOperation: Operation<z.infer<typeof globalConfigRequestSchema>, string> = {
  name: 'npm.global-config',
  summary: 'ask npm where its global config is, before --prefix can move it',
  request: globalConfigRequestSchema,
  timeoutMs: CONFIG_TIMEOUT_MS,
  argv: (request) => ({ file: request.npm, args: ['config', 'get', 'globalconfig'] }),
  read: (completed) => {
    if (completed.exitCode !== 0) {
      return {
        ok: false,
        refusal: 'failed',
        problem: lastLine(completed.stderr) ?? lastLine(completed.stdout) ?? 'npm said nothing',
      };
    }
    const said = firstLine(completed.stdout);
    const answer = absolutePath.safeParse(said);
    return answer.success
      ? { ok: true, result: answer.data }
      : {
          ok: false,
          refusal: 'failed',
          problem: `npm answered ${JSON.stringify(said)}, which is not a path to a config file`,
        };
  },
};

const unpackRequestSchema = z.strictObject({ archive: absolutePath, directory: absolutePath });

/** One package's tarball, unpacked into the directory it is staged in. */
export const unpackOperation: Operation<z.infer<typeof unpackRequestSchema>, null> = {
  name: 'package.unpack',
  summary: 'unpack a released agentplex package beside the tree it replaces',
  request: unpackRequestSchema,
  timeoutMs: UNPACK_TIMEOUT_MS,
  argv: (request) => ({
    file: 'tar',
    args: [
      '-xzf',
      request.archive,
      '-C',
      request.directory,
      // `npm pack` puts everything under `package/`, the one level that is not
      // the package's own.
      '--strip-components=1',
      // An archive's owner is the machine it was packed on, and tar run as root
      // would restore it -- the reason the runtime's unpack gives.
      '--no-same-owner',
    ],
  }),
  read: (completed) =>
    completed.exitCode === 0
      ? { ok: true, result: null }
      : {
          ok: false,
          refusal: 'failed',
          problem: `tar could not unpack it: ${firstLine(completed.stderr) || 'it said nothing'}`,
        },
};

const installDependenciesRequestSchema = z.strictObject({
  npm: z.string().min(1),
  /** The unpacked package: the project npm installs into, shrinkwrap and all. */
  directory: absolutePath,
  /** npm's own answer to `config get globalconfig`, asked without `--prefix`. */
  globalconfig: absolutePath,
});

/** A staged package's dependencies, at the versions its shrinkwrap names. */
export const installDependenciesOperation: Operation<
  z.infer<typeof installDependenciesRequestSchema>,
  null
> = {
  name: 'npm.install-dependencies',
  summary: 'install a staged agentplex package against the npm-shrinkwrap.json it carries',
  request: installDependenciesRequestSchema,
  timeoutMs: INSTALL_TIMEOUT_MS,
  argv: (request) => ({
    file: request.npm,
    args: [
      'install',
      '--prefix',
      request.directory,
      `--globalconfig=${request.globalconfig}`,
      '--omit=dev',
      '--ignore-scripts=false',
      '--package-lock=true',
      '--no-save',
      '--install-strategy=hoisted',
      '--no-audit',
      '--no-fund',
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

export type GlobalConfig =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly problem: string };

/** `npm config get globalconfig`, from the npm that is about to install. */
export async function resolveGlobalConfig(
  npm: string,
  runner: ProcessRunner,
): Promise<GlobalConfig> {
  const outcome = await runOperation(globalConfigOperation, { npm }, runner);
  return outcome.ok ? { ok: true, path: outcome.result } : { ok: false, problem: outcome.problem };
}

/** What the packages are installed with, resolved before anything is stopped. */
export interface Installer {
  readonly npm: string;
  readonly globalconfig: string;
}

/** Everything the package installs need that is not a decision. */
export interface PackageInstallDependencies {
  readonly machine: UpdateMachine;
  readonly downloader: Downloader;
  readonly runner: ProcessRunner;
  readonly write: (line: string) => void;
}

type Step = { readonly ok: true } | { readonly ok: false; readonly lines: readonly string[] };

/**
 * Every planned install, in order, each written up as it finishes.
 *
 * One temporary directory for the run's downloads, removed whatever happened:
 * a tarball left behind is a file nothing will ever read.
 */
export async function installPackages(
  installs: readonly PackageInstall[],
  layout: Layout,
  installer: Installer,
  dependencies: PackageInstallDependencies,
): Promise<boolean> {
  const { machine, write } = dependencies;
  const work = await machine.temporaryDirectory();
  if (work === null) {
    write('no temporary directory to download the packages into, so none was installed');
    return false;
  }

  try {
    const recovered = await recoverInterruptedSwaps(layout, machine, write);
    if (!recovered.ok) {
      for (const line of recovered.lines) write(line);
      return false;
    }

    for (const install of installs) {
      const installed = await installComponents(install, layout, installer, work, dependencies);
      if (!installed.ok) {
        for (const line of installed.lines) write(line);
        return false;
      }
      write(`installed ${componentsOf(install)} (${install.reason})`);
    }
    return true;
  } finally {
    await machine.removeDirectory(work);
  }
}

/**
 * What a run killed partway left, put right before anything is staged.
 *
 * A `.old` beside its tree is a swap that got past its second rename, and is
 * removed. A `.old` with no tree beside it is the one that matters: the run was
 * killed between the two renames, and the machine's package is intact under a
 * name nothing starts. It goes back -- and it has to go back *before* anything
 * is staged, because the first thing a swap does is clear the `.old`, which in
 * that state is the only copy there is. All four components, whatever this run
 * installs: these names are written by nothing but an install.
 *
 * `install.sh`'s `recover_interrupted_swap`. A leftover `.new` is not handled
 * here: staging clears its own before it unpacks, and one for a component this
 * run does not stage is inert -- nothing starts it, and the next install of
 * that component clears it.
 */
async function recoverInterruptedSwaps(
  layout: Layout,
  machine: UpdateMachine,
  write: (line: string) => void,
): Promise<Step> {
  for (const component of COMPONENTS) {
    const tree = packageDirectory(layout, COMPONENT_PACKAGES[component]);
    const old = `${tree}.old`;
    if (!(await machine.exists(old))) continue;

    if (await machine.exists(tree)) {
      // Worth a line and not the run: the swap clears it again before it sets
      // the tree aside, and fails there with the reason if it still cannot.
      const removed = await machine.removeDirectory(old);
      if (!removed.ok) write(`${old} is left over from an earlier run: ${removed.problem}`);
      continue;
    }

    const restored = await machine.rename(old, tree);
    if (!restored.ok) {
      return {
        ok: false,
        lines: [
          `${tree} is missing, and ${old}, which an interrupted run set aside, would not move back: ${restored.problem}`,
          `Nothing was installed. Put it back with: mv ${old} ${tree}`,
        ],
      };
    }
    write(`restored ${tree}, which an interrupted run had set aside as ${old}`);
  }
  return { ok: true };
}

/**
 * One set of packages: every one staged, and only then every one moved in.
 *
 * A failure while staging costs the staging and nothing else. A failure while
 * moving leaves the packages already moved where they are -- they staged and
 * installed cleanly, and no rename undoes a set -- and names them, so the lines
 * say exactly what this machine is now running.
 */
async function installComponents(
  install: PackageInstall,
  layout: Layout,
  installer: Installer,
  work: string,
  dependencies: PackageInstallDependencies,
): Promise<Step> {
  const { machine } = dependencies;
  const staged: string[] = [];

  for (const tarball of install.packages) {
    const stagedOne = await stageComponent(tarball, layout, installer, work, staged, dependencies);
    if (!stagedOne.ok) {
      return {
        ok: false,
        lines: [
          ...stagedOne.lines,
          ...(await discard(staged, machine)),
          `Nothing of ${componentsOf(install)} was installed; what was installed before is as it was.`,
        ],
      };
    }
  }

  const moved: string[] = [];
  for (const [index, tarball] of install.packages.entries()) {
    const swapped = await swapComponent(tarball, layout, machine);
    if (!swapped.ok) {
      const lines = [...swapped.lines, ...(await discard(staged.slice(index), machine))];
      if (moved.length > 0)
        lines.push(`${moved.join(', ')} had already moved into place, and stay.`);
      return { ok: false, lines };
    }
    for (const line of swapped.lines) dependencies.write(line);
    moved.push(tarball.component);
  }

  const self = install.packages.find((tarball) => tarball.component === 'cli');
  return self === undefined ? { ok: true } : await linkCommand(self, layout, machine);
}

/**
 * Downloaded to the run's temporary directory, unpacked into `<tree>.new`, and
 * installed there. The staging directory is recorded as soon as it is about to
 * be made, so a failure at any step after the download takes it back.
 */
async function stageComponent(
  tarball: PackageTarball,
  layout: Layout,
  installer: Installer,
  work: string,
  staged: string[],
  { machine, downloader, runner }: PackageInstallDependencies,
): Promise<Step> {
  const staging = `${packageDirectory(layout, tarball.package)}.new`;
  const archive = join(work, `${tarball.component}.tgz`);
  const failed = (problem: string): Step => ({ ok: false, lines: [problem] });

  const downloaded = await downloader.download(tarball.url, archive);
  if (!downloaded.ok) {
    return failed(
      `could not download the ${tarball.component} package from ${tarball.url}: ${downloaded.problem}`,
    );
  }

  staged.push(staging);
  // One an earlier run left is what would otherwise be unpacked over.
  const cleared = await machine.removeDirectory(staging);
  if (!cleared.ok) return failed(cleared.problem);
  const made = await machine.makeDirectory(staging);
  if (!made.ok) return failed(made.problem);

  const unpacked = await runOperation(unpackOperation, { archive, directory: staging }, runner);
  if (!unpacked.ok) {
    return failed(`the ${tarball.component} package from ${tarball.url}: ${unpacked.problem}`);
  }

  const installed = await runOperation(
    installDependenciesOperation,
    { npm: installer.npm, directory: staging, globalconfig: installer.globalconfig },
    runner,
  );
  if (!installed.ok) {
    return failed(
      `npm could not install the ${tarball.component} package into ${staging}: ${installed.problem}`,
    );
  }
  return { ok: true };
}

/**
 * The tree set aside, the staged one moved in, and the old one removed -- the
 * runtime swap's order, for the runtime swap's reason: a move that fails is
 * undone by moving the old one back. The lines a success carries are the ones
 * worth reading anyway: an old tree that would not go.
 */
async function swapComponent(
  tarball: PackageTarball,
  layout: Layout,
  machine: UpdateMachine,
): Promise<{ readonly ok: boolean; readonly lines: readonly string[] }> {
  const tree = packageDirectory(layout, tarball.package);
  const staging = `${tree}.new`;
  const old = `${tree}.old`;

  // Cleared first, because the tree cannot be renamed onto a directory with
  // something in it. One from before this run was restored or removed already,
  // so this is only ever a leftover.
  const leftOver = await machine.removeDirectory(old);
  if (!leftOver.ok) return { ok: false, lines: [`${tree} was left in place: ${leftOver.problem}`] };

  const present = await machine.exists(tree);
  if (present) {
    const setAside = await machine.rename(tree, old);
    if (!setAside.ok) {
      return { ok: false, lines: [`${tree} was left in place: ${setAside.problem}`] };
    }
  }

  const moved = await machine.rename(staging, tree);
  if (!moved.ok) {
    if (!present) {
      return { ok: false, lines: [`${tree} would not move into place: ${moved.problem}`] };
    }
    const restored = await machine.rename(old, tree);
    if (restored.ok) {
      return {
        ok: false,
        lines: [
          `${tree} put back as it was: the new one would not move into place: ${moved.problem}`,
        ],
      };
    }
    // The one way this leaves the machine worse than it was found, said with
    // the command that fixes it.
    return {
      ok: false,
      lines: [
        `this machine has no ${tarball.package} in ${tree}.`,
        `  the new one would not move in from ${staging}: ${moved.problem}`,
        `  the old one would not move back from ${old}: ${restored.problem}`,
        `Put the old one back with: mv ${old} ${tree}`,
      ],
    };
  }

  // The new tree is in place, so an old one that will not go costs a line
  // rather than the run, and the next run clears it before it sets one aside.
  const discarded = await machine.removeDirectory(old);
  return {
    ok: true,
    lines: discarded.ok
      ? []
      : [`${old} is still there: ${discarded.problem}; the next run removes it.`],
  };
}

/**
 * The link npm used to make, made the way npm makes it: relative, so the prefix
 * can be read from any path it is reached by. npm also sets the target's
 * executable bit as it links it, and this has to as well -- the tarball packs
 * the entry `-rw-r--r--`, and a link to it is `Permission denied` (AGX-322,
 * Q6).
 */
async function linkCommand(
  self: PackageTarball,
  layout: Layout,
  machine: UpdateMachine,
): Promise<Step> {
  const bin = join(layout.prefix, 'bin');
  const entrypoint = join(packageDirectory(layout, self.package), CLI_ENTRYPOINT);
  const target = join('..', PACKAGE_DIRECTORY, self.package, CLI_ENTRYPOINT);
  const command = join(bin, CLI_COMMAND);

  const unlinked = (problem: string): Step => ({
    ok: false,
    lines: [
      `the ${self.package} package is in place, and ${command} may not run it: ${problem}`,
      `Make it runnable with: chmod 0755 ${entrypoint} && ln -sfn ${target} ${command}`,
    ],
  });

  const made = await machine.makeDirectory(bin);
  if (!made.ok) return unlinked(made.problem);
  const executable = await machine.chmod(entrypoint, 0o755);
  if (!executable.ok) return unlinked(executable.problem);
  const linked = await machine.link(target, command);
  if (!linked.ok) return unlinked(linked.problem);
  return { ok: true };
}

/**
 * Every staged directory given, removed. One this cannot remove costs a line:
 * nothing starts a `.new`, and the next run clears it before it unpacks.
 */
async function discard(staged: readonly string[], machine: UpdateMachine): Promise<string[]> {
  const lines: string[] = [];
  for (const staging of staged) {
    const removed = await machine.removeDirectory(staging);
    if (!removed.ok) lines.push(`${staging} is still there: ${removed.problem}`);
  }
  return lines;
}

function componentsOf(install: PackageInstall): string {
  return install.packages.map((tarball) => tarball.component).join(', ');
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
