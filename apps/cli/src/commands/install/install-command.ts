import { dirname, join } from 'node:path';
import { parseVersionsManifest } from '@agentplex/release';
import { runOperation, type ProcessRunner, type ProgramResolver } from '@agentplex/providers';
import { z } from 'zod';
import { CLI_COMMAND } from '../../installation/components.js';
import {
  SYSTEM_ACCOUNT,
  binDirectory,
  packageDirectory,
  systemLayout,
  unitFile,
  userLayout,
  type Layout,
} from '../../installation/layout.js';
import { resolveNodeDirectory } from '../../installation/node-directory.js';
import {
  grantServiceAccountOwnership,
  serviceAccountOperation,
  settingsOwnershipOperation,
} from '../../installation/ownership.js';
import {
  installPackages,
  resolveGlobalConfig,
  resolveNpm,
  type Installer,
  type PackageInstall,
} from '../../installation/package-install.js';
import { renderSettings } from '../../installation/settings-template.js';
import { renderUnit, unitFileName } from '../../installation/unit-file.js';
import { writeUnit } from '../../installation/unit-writer.js';
import type { Downloader } from '../../installation/write-machine.js';
import type { ManifestReader, ManifestSource } from '../../versions/version-check.js';
import { installUsage, readInstallFlags, type InstallRequest } from './install-flags.js';
import type { InstallMachine } from './install-machine.js';
import {
  formatPlanLine,
  planInstall,
  unitSkipReason,
  type PlanLine,
  type PlannedPackage,
  type ReleaseInput,
} from './install-plan.js';

/**
 * `agentplex install`: what `install.sh` does after its runtime, done by the
 * program that is taking the install over.
 *
 * `--print-unit` prints each daemon's unit, the bytes `install.sh --print-unit`
 * prints for the same role, scope and prefix. `--dry-run` prints the plan for
 * everything after the runtime. A bare run is the install itself, in the
 * script's order:
 *
 * ```
 * resolve the release (the manifest, or AGENTPLEX_PACKAGE's tarballs)
 *   -> the service account is there, under --system
 *   -> the role's packages, staged together and moved in together
 *   -> the command's own package, last, unless the prefix already holds it
 *   -> what the service account owns, under --system
 *   -> the settings file, if there is none
 *   -> each daemon's unit, if there is none; never enabled
 * ```
 *
 * The package step is the one `agentplex update` runs, not a second copy of
 * it. The runtime, the toolchain, creating the service account and handing
 * over to setup stay `install.sh`'s: they are the bootstrap, and they run
 * before this command exists on the machine.
 *
 * ## It may be replacing its own code
 *
 * Run by hand on an installed machine, this command runs out of the package it
 * would overwrite -- the reason `update` gives for installing that package
 * last and importing everything statically. The same holds here. Whether it
 * is installed at all is the target prefix's answer, not this process's: it is
 * left alone only when the tree in the prefix says it is the resolved version
 * and the prefix's link to run it is there. Under the handover `install.sh` has
 * just put exactly that there, so the step is a no-op then. From
 * `AGENTPLEX_PACKAGE` it is always installed, as the script installs it,
 * because every local build is `0.0.0` and a version cannot tell two apart.
 *
 * Exit codes are the bin's rather than the script's: a wrong invocation -- a
 * flag the grammar refuses, a scope the account cannot take -- is 2, as every
 * command here answers one, and an install that stops on what the release
 * says or on what the machine will not do is 1. The sentences are the
 * script's.
 */

const EXIT_OK = 0;
/** The plan or the install stopped: a release, a machine, or a step that failed. */
const EXIT_STOPPED = 1;
/** The invocation was wrong. */
const EXIT_BAD_INVOCATION = 2;

/** The command's own package: installed in a set of its own, last. */
const SELF = 'cli';

export interface InstallCommandDependencies {
  /** `$HOME`, read at the entrypoint, and empty when it was not set. */
  readonly home: string;
  /** Whether this process runs as root, which decides which scope it may take. */
  readonly isRoot: boolean;
  readonly machine: InstallMachine;
  /** Where `node`, `npm` and `systemctl` resolve from, on this process's PATH. */
  readonly programs: ProgramResolver;
  /** What every program this runs -- node, npm, tar, id, chown -- is started through. */
  readonly runner: ProcessRunner;
  /** What reads the network manifest, for a real run with no local one. */
  readonly reader: ManifestReader;
  /** What downloads a release's tarballs. */
  readonly downloader: Downloader;
  /** `process.platform`: a machine that is not Linux holds no systemd unit. */
  readonly platform: string;
  /** Where the manifest is. A dry run reads only a file; a real run reads either. */
  readonly source: ManifestSource;
  /** `AGENTPLEX_PACKAGE`, or `null` when it is unset or empty. */
  readonly packageDirectory: string | null;
  /** Writes text to stdout exactly as given. */
  readonly write: (text: string) => void;
  /** Writes one line to stderr. */
  readonly writeError: (line: string) => void;
}

class Refusal extends Error {}

export async function runInstallCommand(
  argv: readonly string[],
  dependencies: InstallCommandDependencies,
): Promise<number> {
  const { write, writeError } = dependencies;
  const say = (problem: string): void => writeError(`agentplex install: ${problem}`);

  const flags = readInstallFlags(argv);
  if (!flags.ok) {
    say(flags.problem);
    writeError(`\n${installUsage()}`);
    return EXIT_BAD_INVOCATION;
  }
  const request = flags.value;

  let layout: Layout;
  try {
    layout = resolveLayout(request, dependencies);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    say(error.message);
    return EXIT_BAD_INVOCATION;
  }

  // Before the dry run, as in `main`: printing a unit asks about the
  // interpreter and nothing else, so it reads no manifest and lists nothing.
  if (request.printUnit) {
    const nodeDirectory = await resolveNodeDirectory(layout, {
      files: dependencies.machine,
      programs: dependencies.programs,
      runner: dependencies.runner,
    });
    for (const daemon of request.daemons) write(renderUnit(daemon, layout, nodeDirectory));
    return EXIT_OK;
  }

  const release = await readRelease(request.dryRun, dependencies);
  if (!release.ok) {
    say(release.problem);
    return EXIT_STOPPED;
  }

  const { machine } = dependencies;
  const unitsPresent: string[] = [];
  for (const daemon of request.daemons) {
    const file = unitFile(layout, unitFileName(daemon));
    // `[ -e ]`, as `write_units` asks: anything at that path is somebody's.
    if (await machine.exists(file)) unitsPresent.push(file);
  }
  const settingsPresent = await machine.exists(layout.settingsFile);
  const skipUnits = unitSkipReason(
    dependencies.platform,
    (await dependencies.programs.resolve('systemctl')) !== null,
  );

  const plan = planInstall({
    request,
    layout,
    release: release.value,
    settingsPresent,
    unitsPresent,
    unitSkipReason: skipUnits,
  });
  if (!plan.ok) {
    say(plan.problem);
    return EXIT_STOPPED;
  }

  const report = (lines: readonly PlanLine[]): void => {
    for (const line of lines) write(`${formatPlanLine(line)}\n`);
  };
  if (request.dryRun) {
    report(plan.lines);
    return EXIT_OK;
  }

  // A real run has read a release, so every version is resolved: `unread` is
  // the dry run's answer to a network manifest, and a real run reads that one.
  if (plan.packages === null) {
    say('no version was resolved, so there is nothing to install');
    return EXIT_STOPPED;
  }

  const stop = (problem: string): number => {
    say(problem);
    return EXIT_STOPPED;
  };
  const byLabel = (...labels: readonly string[]): readonly PlanLine[] =>
    plan.lines.filter((line) => labels.includes(line.label));

  // Before anything is written, because the settings file below is given to
  // this account, and a chown to a user that does not exist would stop the run
  // after the packages had landed -- half an install, and the confusing half.
  if (layout.scope === 'system') {
    const account = await runOperation(
      serviceAccountOperation,
      { account: SYSTEM_ACCOUNT },
      dependencies.runner,
    );
    if (!account.ok) {
      return stop(
        `could not ask whether the ${SYSTEM_ACCOUNT} service account exists: ${account.problem}`,
      );
    }
    if (!account.result) {
      return stop(
        `there is no ${SYSTEM_ACCOUNT} service account, and --system runs both daemons as it and ` +
          'gives it the directories it writes into. install.sh creates it before it hands over; ' +
          `create it with useradd --system, or run install.sh --system. Nothing was installed`,
      );
    }
  }

  report(byLabel('release', 'client protocol', 'server protocol', 'package'));

  const installed = await installRoleComponents(
    plan.packages,
    release.value.kind,
    layout,
    dependencies,
  );
  if (!installed.ok) return stop(installed.problem);

  if (layout.scope === 'system') {
    report(byLabel('ownership'));
    const granted = await grantServiceAccountOwnership(layout, SYSTEM_ACCOUNT, dependencies);
    if (!granted.ok) return stop(granted.problem);
  }

  report(byLabel('settings'));
  if (!settingsPresent) {
    const written = await writeSettingsFile(request, layout, dependencies);
    if (!written.ok) return stop(written.problem);
  }

  report(byLabel('unit'));
  if (skipUnits === null) {
    const nodeDirectory = await resolveNodeDirectory(layout, {
      files: machine,
      programs: dependencies.programs,
      runner: dependencies.runner,
    });
    for (const daemon of request.daemons) {
      if (unitsPresent.includes(unitFile(layout, unitFileName(daemon)))) continue;
      const written = await writeUnit(daemon, layout, nodeDirectory, machine);
      if (!written.ok) return stop(`could not write the ${daemon} unit: ${written.problem}`);
    }
  }

  return EXIT_OK;
}

/**
 * The role's packages, and then the command's own when it has to move.
 *
 * Two sets, as `update` plans them: every package but the command's staged
 * together so the machine gets the set or none of it, and the command's own
 * last, in a set of its own, because this process may be running out of it.
 */
async function installRoleComponents(
  packages: readonly PlannedPackage[],
  from: ReleaseInput['kind'],
  layout: Layout,
  dependencies: InstallCommandDependencies,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly problem: string }> {
  const { machine, write } = dependencies;
  const line = (text: string): void => write(`${text}\n`);

  const others = packages.filter((one) => one.component !== SELF);
  const self = packages.find((one) => one.component === SELF);
  const command = join(binDirectory(layout), CLI_COMMAND);
  const installs: PackageInstall[] = [];
  if (others.length > 0) {
    installs.push({
      packages: others,
      reason: 'staged together, so this machine gets the set or none of it',
    });
  }
  if (self !== undefined) {
    const tree = packageDirectory(layout, self.package);
    if (
      from !== 'tarballs' &&
      self.version !== null &&
      (await installedVersion(tree, machine)) === self.version &&
      (await machine.exists(command))
    ) {
      line(
        `${CLI_COMMAND} ${self.version} is already in ${tree}, and ${command} is there: left as it is`,
      );
    } else {
      installs.push({
        packages: [self],
        reason: 'last, because this command may be running out of the package it replaces',
      });
    }
  }

  if (installs.length > 0) {
    // Resolved before anything is staged, for the reason `update` gives: after
    // the command's own package has moved, a lookup that needed a module this
    // process has not loaded would be a lookup into a tree that moved.
    const npm = await resolveNpm(layout, machine, dependencies.programs);
    if (npm === null) {
      return {
        ok: false,
        problem:
          'there is a node here and no npm beside it, so there is nothing to install the package with',
      };
    }
    const config = await resolveGlobalConfig(npm, dependencies.runner);
    if (!config.ok) {
      return {
        ok: false,
        problem:
          'npm could not say where its global config is, so the installs below could not be ' +
          `pointed at it: ${config.problem}`,
      };
    }
    const installer: Installer = { npm, globalconfig: config.path };
    const done = await installPackages(installs, layout, installer, {
      machine,
      downloader: dependencies.downloader,
      runner: dependencies.runner,
      write: line,
    });
    if (!done) {
      return {
        ok: false,
        problem:
          'the packages did not install, as the lines above say, so no settings file and no unit ' +
          'were written',
      };
    }
  }

  if (!(await machine.exists(command))) {
    return { ok: false, problem: `installed the packages and there is no ${command} to run` };
  }
  return { ok: true };
}

const installedManifestSchema = z.object({ version: z.string().min(1) });

/**
 * The version a package tree in the prefix says it is, or `null` when it
 * cannot say: no manifest, one that will not read, or one that does not parse.
 * Each of those is a tree that is not known to be the release, so it is
 * installed over rather than trusted.
 */
async function installedVersion(tree: string, machine: InstallMachine): Promise<string | null> {
  const read = await machine.readFile(`${tree}/package.json`);
  if (read.kind !== 'read') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.contents);
  } catch {
    return null;
  }
  const manifest = installedManifestSchema.safeParse(parsed);
  return manifest.success ? manifest.data.version : null;
}

/**
 * `write_environment_file`, for a file that is not there: created `0600`
 * before a byte is in it, because the client token lives here, and under
 * `--system` then given to `root:<account>` and widened to `0640` -- after the
 * write and never before it, so the file is never wider than the mode it ends
 * with. The owner and the mode are one decision and are set together.
 */
async function writeSettingsFile(
  request: InstallRequest,
  layout: Layout,
  { machine, runner }: InstallCommandDependencies,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly problem: string }> {
  const file = layout.settingsFile;
  const made = await machine.makeDirectory(dirname(file));
  if (!made.ok)
    return { ok: false, problem: `could not make the directory for ${file}: ${made.problem}` };
  const written = await machine.writeFile(file, renderSettings(request.role, layout), {
    mode: 0o600,
  });
  if (!written.ok) return { ok: false, problem: `could not write ${file}: ${written.problem}` };
  if (layout.scope !== 'system') return { ok: true };

  const owned = await runOperation(
    settingsOwnershipOperation(layout),
    { account: SYSTEM_ACCOUNT, path: file },
    runner,
  );
  if (!owned.ok)
    return {
      ok: false,
      problem: `could not give ${file} to root:${SYSTEM_ACCOUNT}: ${owned.problem}`,
    };
  const narrowed = await machine.chmod(file, 0o640);
  return narrowed.ok ? { ok: true } : { ok: false, problem: narrowed.problem };
}

/**
 * `resolve_layout`: who this installs for, and where.
 *
 * The server must not run as root, so a plain run installs for the invoking
 * user and refuses root, and root has exactly one supported path -- `--system`,
 * which makes a service account and runs nothing as root either.
 */
function resolveLayout(
  request: InstallRequest,
  { isRoot, home }: InstallCommandDependencies,
): Layout {
  if (request.system) {
    if (!isRoot) {
      throw new Refusal(
        '--system installs a service account and a system unit, so it must run as root',
      );
    }
    return request.prefix === null ? systemLayout() : systemLayout(request.prefix);
  }
  if (isRoot) {
    throw new Refusal(
      'refusing to install as root: agentplex runs coding agents as you, and root-owned stores ' +
        'are tedious to undo. Run this as your own user, or pass --system to install under a ' +
        'service account',
    );
  }
  if (home === '') throw new Refusal('HOME is not set, so there is no user prefix to install into');
  return userLayout(home, request.prefix ?? undefined);
}

/**
 * Where the packages come from, read as `resolve_release` and `load_versions`
 * read it.
 *
 * `AGENTPLEX_PACKAGE` first, because a directory of tarballs is not a release
 * and nothing about versions is asked of it. Then the manifest: from a file
 * whenever `AGENTPLEX_VERSIONS` names one, and from the network only on a real
 * run -- a dry run downloads nothing, and the network manifest is a download.
 */
async function readRelease(
  dryRun: boolean,
  { machine, reader, source, packageDirectory: tarballs }: InstallCommandDependencies,
): Promise<
  | { readonly ok: true; readonly value: ReleaseInput }
  | { readonly ok: false; readonly problem: string }
> {
  if (tarballs !== null) {
    return {
      ok: true,
      value: {
        kind: 'tarballs',
        directory: tarballs,
        entries: await machine.listDirectory(tarballs),
      },
    };
  }

  let text: string;
  let from: string;
  if (source.kind === 'url') {
    if (dryRun) return { ok: true, value: { kind: 'unread' } };
    const read = await reader.read(source);
    if (read.kind === 'failed') {
      return {
        ok: false,
        problem:
          `could not reach ${source.url}, which is what says which releases of each component ` +
          'exist and what each one speaks. Every install reads it, pinned or not, because a pin ' +
          'is a claim about a release and this is the record of which releases there are. Point ' +
          'AGENTPLEX_VERSIONS at a directory holding a copy of it to install without reaching ' +
          'this host',
      };
    }
    text = read.text;
    from = source.url;
  } else {
    const read = await machine.readFile(source.path);
    if (read.kind === 'missing') {
      return {
        ok: false,
        problem:
          `AGENTPLEX_VERSIONS names "${dirname(source.path)}", which holds no versions.json: it ` +
          'is the directory holding a copy of the manifest the release publishes',
      };
    }
    if (read.kind === 'failed') {
      return { ok: false, problem: `${source.path} could not be read: ${read.reason}` };
    }
    text = read.contents;
    from = source.path;
  }

  try {
    return {
      ok: true,
      value: { kind: 'manifest', source: from, manifest: parseVersionsManifest(from, text) },
    };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}
