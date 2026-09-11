import { readInstallation, type Installation } from '../../installation/installation.js';
import { lookupFor } from '../../installation/lookup-flags.js';
import type { Systemd, UnitState } from '../../installation/systemd.js';
import { readUnitStates } from '../../installation/units.js';
import type { ProcessRunner, ProgramResolver } from '@agentplex/providers';
import {
  checkVersions,
  describeSource,
  type ManifestReader,
  type ManifestSource,
  type VersionCheck,
} from '../../versions/version-check.js';
import {
  describeAge,
  serializeCachedVersions,
  versionsCacheDirectory,
} from '../../versions/versions-cache.js';
import { installPackages, resolveNpm } from './npm-install.js';
import {
  checkRuntime,
  swapRuntime,
  type Downloader,
  type RuntimeArchitecture,
  type RuntimeDecision,
  type RuntimePlatform,
} from './runtime.js';
import { preflightToolchain } from './toolchain.js';
import {
  absentlyNamed,
  formatComponents,
  formatDisagreement,
  planUpdate,
  type UpdatePlan,
} from './update-plan.js';
import { readUpdateFlags, updateUsage, type RuntimeConsent } from './update-flags.js';
import type { UpdateMachine } from './update-machine.js';

/**
 * `agentplex update`: the command that brings a machine to the versions the
 * release manifest calls current.
 *
 * ## The order, which is the whole design
 *
 * ```
 * resolve prefix -> read installed -> resolve target from versions.json
 *   -> already current? exit 0
 *   -> preflight (toolchain, if a server is installed)
 *   -> plan, and stop here if --dry-run
 *   -> stop only the units that are running, remembering which
 *   -> swap the runtime, if consented
 *   -> npm install each package
 *   -> start exactly the units from before
 * ```
 *
 * Four of those are decisions rather than steps, and each is argued where it
 * happens: the runtime moves before the packages (`runtime.ts`), the CLI's own
 * package moves last (`update-plan.ts`), the toolchain is checked before
 * anything is stopped (`toolchain.ts`), and only the units that were running
 * are started again (below).
 *
 * ## It is replacing its own code
 *
 * This command runs out of the package it overwrites. Modules already loaded
 * are safe, and anything imported *after* npm has replaced the tree is not --
 * so everything this path needs is imported statically at the top of this file
 * and resolved before the first npm invocation. The laziness in `programs.ts`
 * stops at this module's boundary on purpose.
 *
 * ## What it will not do
 *
 * Install what is absent -- that is `setup`'s -- and fix a fleet. It makes this
 * machine's components agree with each other and with the manifest; nothing
 * here updates a hub on another box, and a `doctor` line reporting a peer's
 * version is the follow-up.
 */

/** Everything asked for happened, or there was nothing to do. */
const EXIT_OK = 0;
/** Something did not happen, including a check that could not be made. */
const EXIT_NOT_DONE = 1;
/** The invocation was wrong, or there is no install here to update. */
const EXIT_BAD_INVOCATION = 2;

export interface UpdateCommandDependencies {
  /** `$HOME`, read at the entrypoint. */
  readonly home: string;
  readonly machine: UpdateMachine;
  readonly systemd: Systemd;
  readonly runner: ProcessRunner;
  readonly programs: ProgramResolver;
  /** The one seam that can be somewhere else. See `version-check.ts`. */
  readonly reader: ManifestReader;
  readonly downloader: Downloader;
  readonly source: ManifestSource;
  /** Where this identity's version cache is, or `null` when it has nowhere. */
  readonly cacheFile: string | null;
  readonly now: () => number;
  readonly platform: RuntimePlatform;
  readonly architecture: RuntimeArchitecture;
  readonly write: (line: string) => void;
  readonly writeError: (line: string) => void;
}

export async function runUpdateCommand(
  argv: readonly string[],
  dependencies: UpdateCommandDependencies,
): Promise<number> {
  const { write, writeError } = dependencies;
  const refuse = (problems: readonly string[]): number => {
    for (const problem of problems) writeError(`agentplex update: ${problem}`);
    writeError(`\n${updateUsage()}`);
    return EXIT_BAD_INVOCATION;
  };

  const flags = readUpdateFlags(argv);
  if (!flags.ok) return refuse(flags.problems);

  // Before the installation is read, and deliberately first of everything.
  // `--check` is what refreshes the cache the passive notice and `agentplex
  // status` both read, and the detached refresh the notice starts is exactly
  // this run -- so a machine whose install cannot be read still comes away with
  // a fresh answer rather than nothing.
  const checked = await checkVersions(dependencies.source, dependencies);
  const cacheLines = await writeCache(checked, dependencies);

  const found = await readInstallation(lookupFor(dependencies.home, flags), dependencies.machine);
  if (!found.ok) return refuse(found.problems);
  const installation = found.installation;

  const missing = absentlyNamed(installation, flags.asked);
  if (missing.length > 0) {
    // `setup` installs what is missing and `update` updates what is there. A
    // silent no-op would leave somebody believing this machine runs a server.
    return refuse([
      `${missing.join(', ')} is not installed here, so there is nothing to update. ` +
        'agentplex setup is what adds a component; agentplex status says what is here',
    ]);
  }

  const plan = planUpdate({
    installation,
    manifest: checked.ok ? checked.manifest : null,
    problem: checked.ok ? null : checked.problem,
    asked: flags.asked,
  });

  write(
    `agentplex update   prefix=${installation.layout.prefix}   scope=${installation.layout.scope}`,
  );
  write('');
  for (const line of formatComponents(plan)) write(line);
  write('');
  write(`  from ${describeSource(dependencies.source)}${sourceNote(checked, dependencies)}`);
  for (const line of cacheLines) write(`  ${line}`);

  if (flags.check) {
    // Asked what is available, told what is available. Nothing about units,
    // nothing about the runtime: `--check` is the version question, and it is
    // the one a background refresh runs, so it stays one small fetch.
    return checked.ok ? EXIT_OK : EXIT_NOT_DONE;
  }

  if (plan.disagreement !== null) {
    write('');
    for (const line of formatDisagreement(plan.disagreement)) write(line);
    return EXIT_NOT_DONE;
  }

  // The runtime question, asked once and used by both the dry run and the real
  // one. A dry run that skipped it would print a plan missing its first step.
  //
  // `install.sh`'s dry run reads nothing at all, on the grounds that "would
  // install 1.4.0" is a claim a run that performed no download cannot make.
  // This one differs deliberately and the line is worth drawing: a dry run here
  // reads the two small files that *say* what is current and downloads no
  // artifact. The installer's rule exists because it runs on a machine with
  // nothing on it, where a fetch may be the first thing that has ever gone out;
  // this runs on a machine that is already installed, and a plan with no
  // versions in it is not a plan.
  const runtime = await checkRuntime(installation, dependencies);
  const consent = await runtimeConsent(runtime, flags.runtime, dependencies);

  write('');
  write(`  runtime     ${describeRuntime(runtime, consent)}`);

  const preflight = await preflightToolchain(
    installation,
    dependencies.platform,
    dependencies.programs,
  );
  write(`  ${preflight.lines[0] ?? ''}`);

  const nothingToDo = plan.installs.length === 0 && consent.act === false;
  if (nothingToDo) {
    write('');
    write(
      checked.ok
        ? 'Already current: nothing to install.'
        : 'Nothing to install, and what is current could not be checked.',
    );
    // The runtime line above has already said what happened to it, including
    // the case where something newer exists and was left alone.
    return checked.ok ? EXIT_OK : EXIT_NOT_DONE;
  }

  if (flags.dryRun) {
    write('');
    for (const line of dryRunLines(plan, runtime, consent, installation)) write(line);
    return EXIT_OK;
  }

  if (!preflight.ok) {
    write('');
    for (const line of preflight.lines.slice(1)) write(line);
    return EXIT_NOT_DONE;
  }

  return await apply(installation, plan, runtime, consent, dependencies);
}

/**
 * The part that changes the machine, in the one order it is allowed to happen
 * in.
 *
 * Every step reports what it did as it does it, rather than at the end. An
 * update that fails in the middle is the run whose transcript matters most, and
 * a report assembled at the end is a report a failure throws away.
 */
async function apply(
  installation: Installation,
  plan: UpdatePlan,
  runtime: RuntimeDecision,
  consent: Consent,
  dependencies: UpdateCommandDependencies,
): Promise<number> {
  const { write, systemd, machine, runner, programs } = dependencies;
  write('');

  // Resolved before anything is stopped and before anything is replaced: after
  // npm has overwritten this package, a lookup that needed a module this
  // process has not loaded would be a lookup into a tree that moved.
  const npm =
    plan.installs.length === 0 ? null : await resolveNpm(installation.layout, machine, programs);
  if (plan.installs.length > 0 && npm === null) {
    write('there is no npm here and nothing else installs a package: nothing has been changed.');
    return EXIT_NOT_DONE;
  }

  const running = await runningUnits(installation, systemd);
  if (running.units.length > 0) {
    const stopped = await systemd.stop(installation.layout.scope, running.units);
    if (!stopped.ok) {
      // Stopping is the first thing that touches the machine, so a refusal here
      // is the cheapest failure this command has: nothing has been replaced.
      write(`systemd would not stop ${running.units.join(', ')}: ${stopped.problem}`);
      return EXIT_NOT_DONE;
    }
    write(`stopped ${running.units.join(', ')}`);
  } else {
    write(running.note);
  }

  // The runtime first. A native addon has to be built against the runtime that
  // will load it, and npm is about to build one -- see `runtime.ts`.
  if (consent.act && runtime.kind === 'stale') {
    const swapped = await swapRuntime(installation.layout, runtime, {
      machine,
      downloader: dependencies.downloader,
      runner,
    });
    for (const line of swapped.lines) write(line);
    if (!swapped.ok) {
      // The packages are not installed against a runtime that is half replaced.
      // The units are started again, because what is on this disk is what was
      // running five seconds ago.
      await restart(installation, running.units, dependencies);
      return EXIT_NOT_DONE;
    }
  }

  for (const install of plan.installs) {
    const installed = await installPackages(npm ?? '', installation.layout, install.specs, runner);
    if (!installed.ok) {
      write(`npm could not install ${install.components.join(', ')}: ${installed.problem}`);
      await restart(installation, running.units, dependencies);
      return EXIT_NOT_DONE;
    }
    write(`installed ${install.components.join(', ')} (${install.reason})`);
  }

  return (await restart(installation, running.units, dependencies)) ? EXIT_OK : EXIT_NOT_DONE;
}

/**
 * Exactly the units that were running, started again.
 *
 * Not `enable --now`, and not every unit this machine has. An update replaces
 * bytes; what an operator decided about which daemons run and which come back
 * at boot is not its business. A machine where somebody had stopped the server
 * this morning must still have it stopped afterwards, and a unit taken off boot
 * must stay off it.
 */
async function restart(
  installation: Installation,
  units: readonly string[],
  { systemd, write }: UpdateCommandDependencies,
): Promise<boolean> {
  if (units.length === 0) return true;

  const started = await systemd.start(installation.layout.scope, units);
  if (!started.ok) {
    write(`systemd would not start ${units.join(', ')}: ${started.problem}`);
    return false;
  }

  // What the manager says afterwards, and not only what it said about the job:
  // a `Type=simple` unit's start job completes as soon as the fork does, so a
  // daemon that reads its settings, refuses them and exits two seconds later is
  // a successful job and a failed service. The same reasoning `startUnits`
  // makes, and it matters more here -- this is the moment a bad upgrade shows.
  const states = await readUnitStates(installation, systemd);
  const failed = states.filter((state) => units.includes(state.unit) && state.active === 'failed');
  if (failed.length > 0) {
    write(
      `started ${units.join(', ')}; ${failed
        .map((state) => state.unit)
        .join(', ')} is not running, and journalctl says why`,
    );
    return false;
  }

  write(`started ${units.join(', ')}`);
  return true;
}

/**
 * Which units are running now, remembered before anything is stopped.
 *
 * Asked of the manager rather than assumed from the unit files, because "is
 * installed" and "is running" are different facts and this command has to put
 * back the second one exactly as it found it.
 */
async function runningUnits(
  installation: Installation,
  systemd: Systemd,
): Promise<{ readonly units: readonly string[]; readonly note: string }> {
  if (!(await systemd.present())) {
    return {
      units: [],
      note: 'there is no systemctl here, so nothing was stopped and nothing supervises these',
    };
  }
  const states: readonly UnitState[] = await readUnitStates(installation, systemd);
  const running = states.filter((state) => state.active === 'active').map((state) => state.unit);
  return {
    units: running,
    note:
      states.length === 0
        ? 'there is no agentplex unit here, so nothing was stopped'
        : 'no unit here is running, so nothing was stopped and nothing will be started',
  };
}

/** Whether the runtime is to be replaced, and how that was decided. */
interface Consent {
  readonly act: boolean;
  readonly why: string;
}

/**
 * The runtime decision, made before anything is stopped.
 *
 * Silence is never consent. A run with nobody at it skips the runtime and says
 * so in a line naming the flag that would have answered in advance -- which is
 * what makes `--node` worth having on a fleet: the answer is given by whoever
 * wrote the automation, at the time they wrote it.
 */
async function runtimeConsent(
  runtime: RuntimeDecision,
  asked: RuntimeConsent,
  { machine }: UpdateCommandDependencies,
): Promise<Consent> {
  if (runtime.kind !== 'stale') return { act: false, why: '' };
  if (asked === 'yes') return { act: true, why: '--node' };
  if (asked === 'no') return { act: false, why: '--no-node' };

  const answer = await machine.askYesNo(
    `Replace the runtime in this prefix, ${runtime.installed} with ${runtime.available}?`,
  );
  if (answer === 'nobody') {
    return { act: false, why: 'nobody to ask, and silence is not consent: --node says yes' };
  }
  return answer === 'yes' ? { act: true, why: 'you said so' } : { act: false, why: 'you said no' };
}

function describeRuntime(runtime: RuntimeDecision, consent: Consent): string {
  switch (runtime.kind) {
    case 'adopted':
      // Not "no runtime". The units name an interpreter outright and install.sh
      // stamps one only when it unpacked it, so the honest statement is that
      // this prefix does not own a Node -- and a Node somebody else put there
      // is not this command's to replace.
      return "adopted from this machine, so it is not this install's to replace";
    case 'current':
      return `${runtime.version}, which is the release nodejs.org names`;
    case 'unknown':
      return `${runtime.installed} kept: whether a newer one exists is unknown (${runtime.problem})`;
    case 'stale':
      return consent.act
        ? `${runtime.installed} -> ${runtime.available} (${consent.why})`
        : `${runtime.installed} -> ${runtime.available}, left alone (${consent.why})`;
  }
}

function dryRunLines(
  plan: UpdatePlan,
  runtime: RuntimeDecision,
  consent: Consent,
  installation: Installation,
): readonly string[] {
  const lines = ['This run would, in this order:'];
  lines.push(`  stop whichever of ${unitNames(installation)} is running`);
  if (consent.act && runtime.kind === 'stale') {
    lines.push(`  replace ${runtime.installed} with ${runtime.available} in the prefix`);
  }
  for (const install of plan.installs) {
    lines.push(`  npm install ${install.specs.join(' ')}`);
    lines.push(`    ${install.reason}`);
  }
  lines.push('  start exactly the units it stopped');
  lines.push('Nothing has been changed.');
  return lines;
}

function unitNames(installation: Installation): string {
  return installation.units.length === 0
    ? 'no unit, because this machine has none'
    : installation.units.map((one) => one.unit).join(', ');
}

/** What the manifest read was, for the line under the table. */
function sourceNote(checked: VersionCheck, { now }: UpdateCommandDependencies): string {
  return checked.ok
    ? ` (checked ${describeAge(now() - checked.checkedAt)})`
    : `: could not be read, so nothing here is a claim that this machine is current`;
}

/**
 * The cache, written for the next command to read.
 *
 * Best effort, and reported rather than fatal. A cache one identity cannot
 * write is a notice that identity does not get, which is a smaller thing than a
 * failed update -- but the run that was *asked* to refresh it owes an
 * explanation, so this returns a line rather than swallowing the failure.
 */
async function writeCache(
  checked: VersionCheck,
  { cacheFile, machine }: UpdateCommandDependencies,
): Promise<readonly string[]> {
  if (!checked.ok) return [];
  if (cacheFile === null) {
    return ['not cached: there is no home directory to keep a cache in'];
  }

  const made = await machine.makeDirectory(versionsCacheDirectory(cacheFile));
  if (!made.ok) return [`not cached: ${made.problem}`];
  const written = await machine.writeFile(
    cacheFile,
    serializeCachedVersions({
      checkedAt: checked.checkedAt,
      source: checked.source,
      manifest: checked.manifest,
    }),
  );
  return written.ok ? [] : [`not cached: ${written.problem}`];
}
