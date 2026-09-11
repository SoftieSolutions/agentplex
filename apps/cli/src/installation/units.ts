import { join } from 'node:path';
import { daemonEntrypoint, daemonPackage } from './components.js';
import type { Installation } from './installation.js';
import { nodeBinary, packageDirectory } from './layout.js';
import type { InstallationFiles } from './installation-files.js';
import type { Systemd, UnitState } from './systemd.js';

/**
 * Enabling and starting what an install left behind, and taking it back off.
 *
 * Shared by `agentplex start`, `agentplex stop` and the end of `agentplex
 * setup`, which is the whole reason it is here rather than inside a command: a
 * wizard that finished and a command an operator typed have to leave the
 * machine in the same state, and two implementations of "start whatever this
 * machine has" is how they stop doing that.
 *
 * ## Why the installer still does not do this
 *
 * `install.sh` writes the units and deliberately does not start them, and that
 * stays true. There is no database file, no client token and no store path until
 * the settings file has been filled in, so a unit started at install time is a
 * service that fails on its first line, restarts, and fails again -- and the
 * operator's first experience of agentplex is a log full of a configuration
 * error for configuration nobody has been asked for yet.
 *
 * Setup is the step that just wrote those settings and is the only thing on the
 * machine that knows they are complete, which is what makes it, and not the
 * installer, the place starting belongs.
 */

/** What one act left behind: lines for a person, and whether it worked. */
export interface UnitsAct {
  readonly lines: readonly string[];
  /**
   * Whether the machine is now in the state that was asked for.
   *
   * False is also what a machine with no systemd gets. It was told what to run
   * instead, which is a useful answer and not a successful one: the daemons are
   * not running, and a `start` that exited 0 would have said they were.
   */
  readonly ok: boolean;
}

export interface UnitsDependencies {
  readonly systemd: Systemd;
  readonly files: InstallationFiles;
  /**
   * The interpreter to name in the foreground command, which is the runtime
   * this very process is running under.
   *
   * Injected because it is `process.execPath`, and the entrypoint is the only
   * thing allowed to read one. It is the fallback rather than the answer: a
   * prefix with a runtime in it names that one, because it is the runtime the
   * unit's own `ExecStart` would have named. What is never done is printing a
   * bare `node` -- the units stopped saying that on purpose, since a service
   * that resolves its own interpreter off a PATH is a service that dies before
   * `main` on the machine where that lookup lands somewhere else.
   */
  readonly interpreter: string;
}

/**
 * `agentplex start`: on at boot, and running now.
 *
 * `daemon-reload` first, because the units on this disk may be newer than the
 * ones the manager has read -- an install that ran since the last reload is the
 * ordinary case, and it is exactly the case this command exists for. Then one
 * `enable --now` for every unit that is there. One call and not one per unit:
 * systemd starts them in one transaction, and two calls would be two
 * transactions with a window between them in which the machine is half up.
 */
export async function startUnits(
  installation: Installation,
  dependencies: UnitsDependencies,
): Promise<UnitsAct> {
  const { systemd } = dependencies;
  const absent = await nothingToActOn(installation, dependencies, 'start');
  if (absent !== null) return absent;

  const reloaded = await systemd.reload(installation.layout.scope);
  if (!reloaded.ok) {
    return {
      ok: false,
      // Stopping here rather than enabling anyway. A manager that will not
      // reload is a manager that would enable the unit it read last time, which
      // on a machine that has just been upgraded is a different program from
      // the one on the disk.
      lines: [`systemd would not reload: ${reloaded.problem}`],
    };
  }

  const units = installation.units.map((one) => one.unit);
  const enabled = await systemd.enable(installation.layout.scope, units);
  if (!enabled.ok) {
    return {
      ok: false,
      lines: [`systemd would not start ${units.join(', ')}: ${enabled.problem}`],
    };
  }

  // What the manager says afterwards, and not only what it said about the job.
  //
  // `enable --now` usually exits non-zero when a start job fails, and usually
  // is the word: a `Type=simple` unit's job completes as soon as the fork does,
  // so a daemon that reads its settings, refuses them and exits two seconds
  // later is a successful job and a failed service. This command asked for
  // something to be running, and whether it is running is a question with an
  // answer -- so the answer decides the exit code, rather than the exit code of
  // the request.
  const states = await readUnitStates(installation, systemd);
  const failed = states.filter((state) => state.active === 'failed');

  return {
    ok: failed.length === 0,
    lines: [
      failed.length === 0
        ? `enabled and started ${units.join(', ')}`
        : `enabled ${units.join(', ')}; ${failed
            .map((state) => state.unit)
            .join(', ')} is not running, and journalctl says why`,
      '',
      ...formatUnits(states),
    ],
  };
}

/**
 * `agentplex stop`: the exact reverse, which is why it disables as well.
 *
 * `stop` alone would leave a machine that comes back up running the daemons
 * after the next reboot, which is not what anybody typing `agentplex stop`
 * means -- and the pair would then be asymmetric in the one way that bites
 * silently, since `start` enables. Somebody who wants one restart and no more
 * has `systemctl stop`, and this command does not take that vocabulary away.
 */
export async function stopUnits(
  installation: Installation,
  dependencies: UnitsDependencies,
): Promise<UnitsAct> {
  const { systemd } = dependencies;
  const absent = await nothingToActOn(installation, dependencies, 'stop');
  if (absent !== null) return absent;

  const units = installation.units.map((one) => one.unit);
  const disabled = await systemd.disable(installation.layout.scope, units);
  if (!disabled.ok) {
    return {
      ok: false,
      lines: [`systemd would not stop ${units.join(', ')}: ${disabled.problem}`],
    };
  }

  return {
    ok: true,
    lines: [
      `stopped and disabled ${units.join(', ')}`,
      '',
      ...(await unitLines(installation, systemd)),
    ],
  };
}

/**
 * The two machines there is nothing to do on, answered before anything is run.
 *
 * They are separate answers because they send an operator to different places.
 * A machine with no systemd needs the foreground command, which is the same
 * fallback `install.sh`'s own summary prints on the machine it could write no
 * unit for. A machine that has systemd and no units is a machine where the
 * units were never written or have been removed, and what it needs is to know
 * that -- naming a unit that is not there would be worse than saying nothing.
 */
async function nothingToActOn(
  installation: Installation,
  dependencies: UnitsDependencies,
  verb: 'start' | 'stop',
): Promise<UnitsAct | null> {
  if (!(await dependencies.systemd.present())) {
    return {
      ok: false,
      lines: [
        'There is no systemctl on this machine, so there is no unit to ' +
          `${verb} and nothing here supervises agentplex.`,
        ...(verb === 'stop'
          ? ['Whatever is running was started by hand or by something else on this machine.']
          : [
              'Run a daemon yourself once the settings file is complete:',
              ...(await foregroundCommands(installation, dependencies)).map(
                (command) => `  ${command}`,
              ),
              'What to hand it to instead -- launchd on macOS -- is in the documentation.',
            ]),
      ],
    };
  }

  if (installation.units.length === 0) {
    return {
      ok: false,
      lines: [
        `There is no agentplex unit in ${installation.layout.unitDirectory}, so there is ` +
          `nothing to ${verb}. install.sh writes one per daemon this machine's role runs.`,
      ],
    };
  }

  return null;
}

/**
 * How to run each daemon this machine has the package for, as one command line.
 *
 * The same two halves the unit's `ExecStart` is built from, and long for the
 * same reason `install.sh`'s summary gives: a daemon is not a command, so there
 * is nothing shorter to print that would start one, and an operator handing this
 * to launchd needs the literal argv anyway.
 *
 * The packages decide which daemons are named, because on this machine there is
 * no unit to ask. A hub-only install has no server entry to point at, and naming
 * one would be a command line ending in a file that is not there.
 */
async function foregroundCommands(
  installation: Installation,
  { files, interpreter }: UnitsDependencies,
): Promise<readonly string[]> {
  const runtime = nodeBinary(installation.layout);
  // The prefix's own runtime when it has one, because that is the Node the
  // install settled on and the one a unit would have named. Otherwise the one
  // running this, which is a Node that certainly exists -- unlike anything this
  // could infer about a runtime the installer adopted from the machine.
  const node = (await files.isFile(runtime)) ? runtime : interpreter;

  return installation.packages
    .filter((one) => one.state === 'installed')
    .flatMap((one) => {
      const held = daemonPackage(one.component);
      if (held === null) return [];
      return [
        `${node} ${join(packageDirectory(installation.layout, held), daemonEntrypoint(one.component))}`,
      ];
    });
}

/**
 * Every unit this machine has, as the manager describes it now.
 *
 * Asked one at a time and in order, so that the report reads the same way twice
 * and a unit the manager will not answer about costs itself rather than the
 * listing.
 */
export async function readUnitStates(
  installation: Installation,
  systemd: Systemd,
): Promise<readonly UnitState[]> {
  const states: UnitState[] = [];
  for (const unit of installation.units) {
    states.push(await systemd.show(installation.layout.scope, unit.unit));
  }
  return states;
}

/** The unit block, as `status` prints it and as `start` and `stop` sign off with. */
export async function unitLines(
  installation: Installation,
  systemd: Systemd,
): Promise<readonly string[]> {
  return formatUnits(await readUnitStates(installation, systemd));
}

/**
 * One line per unit: what it is doing, whether it comes back after a reboot,
 * and since when.
 *
 * Columns are padded rather than tabulated, for the reason `doctor`'s report
 * gives: a fixed width survives being pasted into an issue.
 */
export function formatUnits(states: readonly UnitState[]): readonly string[] {
  return states.flatMap((state) => {
    const line = [
      state.unit.padEnd(26),
      (state.active ?? '?').padEnd(10),
      (state.enabled ?? '?').padEnd(10),
      state.since ?? '',
    ]
      .join(' ')
      .trimEnd();
    const notes: string[] = [];
    if (state.problem !== null) notes.push(`    ${state.problem}`);
    // A unit file on the disk that the manager has never loaded. It is the one
    // state that looks like "stopped" and is not: nothing will ever start it,
    // including a reboot, until something reloads.
    if (state.load !== null && state.load !== 'loaded') {
      notes.push(`    the manager has not loaded this unit: LoadState=${state.load}`);
    }
    return [`  ${line}`, ...notes];
  });
}
