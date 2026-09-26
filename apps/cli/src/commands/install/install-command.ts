import { dirname } from 'node:path';
import { parseVersionsManifest } from '@agentplex/release';
import type { ProcessRunner, ProgramResolver } from '@agentplex/providers';
import { systemLayout, unitFile, userLayout, type Layout } from '../../installation/layout.js';
import { resolveNodeDirectory } from '../../installation/node-directory.js';
import { renderUnit, unitFileName } from '../../installation/unit-file.js';
import type { ManifestSource } from '../../versions/version-check.js';
import { installUsage, readInstallFlags, type InstallRequest } from './install-flags.js';
import type { InstallMachine } from './install-machine.js';
import { formatPlanLine, planInstall, unitSkipReason, type ReleaseInput } from './install-plan.js';

/**
 * `agentplex install`: the two questions `install.sh` answers without changing
 * the machine, asked of the program that will take the install over.
 *
 * `--print-unit` prints each daemon's unit, the bytes `install.sh --print-unit`
 * prints for the same role, scope and prefix. `--dry-run` prints the plan for
 * everything after the runtime. A bare run is the install itself, which is not
 * in this command yet: it is refused, naming `install.sh` as the way to
 * install, and the next change replaces the refusal with the install.
 *
 * Exit codes are the bin's rather than the script's: a wrong invocation -- a
 * flag the grammar refuses, a scope the account cannot take, the bare run -- is
 * 2, as every command here answers one, and a plan that stops on what the
 * release says is 1. The sentences are the script's.
 */

const EXIT_OK = 0;
/** The plan stopped: a pin nothing lists, a broken release, a manifest that is not one. */
const EXIT_STOPPED = 1;
/** The invocation was wrong, or asked for what this command does not do yet. */
const EXIT_BAD_INVOCATION = 2;

export interface InstallCommandDependencies {
  /** `$HOME`, read at the entrypoint, and empty when it was not set. */
  readonly home: string;
  /** Whether this process runs as root, which decides which scope it may take. */
  readonly isRoot: boolean;
  readonly machine: InstallMachine;
  /** Where `node` and `systemctl` resolve from, on this process's PATH. */
  readonly programs: ProgramResolver;
  /** What asks an interpreter its version. */
  readonly runner: ProcessRunner;
  /** `process.platform`: a machine that is not Linux holds no systemd unit. */
  readonly platform: string;
  /** Where the manifest is. Only a file is read; a dry run downloads nothing. */
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

  if (!request.printUnit && !request.dryRun) {
    say(
      'the install itself is not in this command yet: install.sh is how to install agentplex, ' +
        'and this command answers --dry-run and --print-unit',
    );
    return EXIT_BAD_INVOCATION;
  }

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

  const release = await readRelease(dependencies);
  if (!release.ok) {
    say(release.problem);
    return EXIT_STOPPED;
  }

  const unitsPresent: string[] = [];
  for (const daemon of request.daemons) {
    const file = unitFile(layout, unitFileName(daemon));
    if (await dependencies.machine.isFile(file)) unitsPresent.push(file);
  }

  const plan = planInstall({
    request,
    layout,
    release: release.value,
    settingsPresent: await dependencies.machine.isFile(layout.settingsFile),
    unitsPresent,
    unitSkipReason: unitSkipReason(
      dependencies.platform,
      (await dependencies.programs.resolve('systemctl')) !== null,
    ),
  });
  if (!plan.ok) {
    say(plan.problem);
    return EXIT_STOPPED;
  }
  for (const line of plan.lines) write(`${formatPlanLine(line)}\n`);
  return EXIT_OK;
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
 * and nothing about versions is asked of it. Then the manifest, only when it is
 * a file: a dry run downloads nothing, and the network manifest is a download.
 */
async function readRelease({
  machine,
  source,
  packageDirectory,
}: InstallCommandDependencies): Promise<
  | { readonly ok: true; readonly value: ReleaseInput }
  | { readonly ok: false; readonly problem: string }
> {
  if (packageDirectory !== null) {
    return {
      ok: true,
      value: {
        kind: 'tarballs',
        directory: packageDirectory,
        entries: await machine.listDirectory(packageDirectory),
      },
    };
  }

  if (source.kind === 'url') return { ok: true, value: { kind: 'unread' } };

  const read = await machine.readFile(source.path);
  if (read.kind === 'missing') {
    return {
      ok: false,
      problem:
        `AGENTPLEX_VERSIONS names "${dirname(source.path)}", which holds no versions.json: it is ` +
        'the directory holding a copy of the manifest the release publishes',
    };
  }
  if (read.kind === 'failed') {
    return { ok: false, problem: `${source.path} could not be read: ${read.reason}` };
  }
  try {
    return {
      ok: true,
      value: {
        kind: 'manifest',
        source: source.path,
        manifest: parseVersionsManifest(source.path, read.contents),
      },
    };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}
