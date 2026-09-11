import { readInstallation } from '../../installation/installation.js';
import type { InstallationFiles } from '../../installation/installation-files.js';
import type { Systemd } from '../../installation/systemd.js';
import { startUnits } from '../../installation/units.js';

/**
 * The last thing `agentplex setup` does, when there is anything to do: start the
 * units the installer wrote and did not.
 *
 * ## Why here and not in `install.sh`
 *
 * The installer writes the units deliberately unstarted. At the moment it runs
 * there is no database file, no client token and no store path -- it has no way
 * to know any of them and says so in the file it writes -- so a unit it started
 * would be a service that fails on its first line and keeps failing, and an
 * operator's first sight of agentplex would be a restart loop over configuration
 * nobody had been asked for yet.
 *
 * Setup is the step that just filled that file in. It is the only thing on the
 * machine that knows the settings are complete, which is what makes it the place
 * starting belongs. Nothing about the installer's decision changes.
 *
 * ## The three machines this declines on, and why each is a decline
 *
 * **A failed run.** If the plan came back with problems, nothing is started. A
 * setup that half worked and then started the daemons is the same restart loop
 * under a different name -- and worse, because the operator was told the run
 * finished. Half-provisioned and stopped is a machine somebody can finish by
 * hand; half-provisioned and running is one they have to catch first.
 *
 * **A `--system` machine.** The fleet install puts its units in
 * `/etc/systemd/system` and its settings under `/etc`, and `install.sh` replays
 * the plan as the service account -- which cannot enable a system unit. So this
 * declines by scope rather than by attempting it and reading polkit's refusal:
 * the refusal is not a failure worth printing at the end of a successful setup,
 * and on that tier starting the daemons is root's act and belongs in whatever
 * ran the install. It says which command to run, which is the same one either
 * way.
 *
 * **No systemd.** The same fallback everything else here gives: the foreground
 * command, because `install.sh` wrote no unit on that machine either.
 *
 * ## Why it never fails the run
 *
 * It reports and returns lines. A provisioned machine whose units would not
 * start is a machine somebody has to look at, and exiting non-zero over it would
 * throw away the providers, the stores and the identity the run just wrote --
 * the same argument the settings file already makes for costing itself rather
 * than the run.
 */

export interface UnitsAfterSetup {
  /**
   * Starts what this machine has, or says why nothing was.
   *
   * Lines to print, never an exception: setup has finished by the time this is
   * called, and there is nothing left for a throw to abandon that would not be
   * worse abandoned.
   */
  start(): Promise<readonly string[]>;
}

export interface UnitsAfterSetupDependencies {
  /** `$HOME`, read at the entrypoint, as everywhere else. */
  readonly home: string;
  readonly files: InstallationFiles;
  readonly systemd: Systemd;
  /** `process.execPath`, for the foreground command's interpreter. */
  readonly interpreter: string;
}

export function createUnitsAfterSetup(dependencies: UnitsAfterSetupDependencies): UnitsAfterSetup {
  return {
    async start(): Promise<readonly string[]> {
      const found = await readInstallation(
        { home: dependencies.home, prefix: null, system: false },
        dependencies.files,
      );
      if (!found.ok) {
        // The ordinary case, and not a problem: a wizard run by hand on a
        // machine nothing installed -- a checkout, a developer's laptop -- has
        // no units and no settings file to find. There is nothing to start and
        // nothing to apologise for.
        return [];
      }

      const installation = found.installation;
      if (installation.layout.scope === 'system') {
        return [
          "The units on this machine are the system manager's, and this run is not root:",
          '  agentplex start',
          'as root enables and starts them.',
        ];
      }

      const done = await startUnits(installation, dependencies);
      return done.ok
        ? ['The units are running:', ...done.lines]
        : ['The units were not started:', ...done.lines, 'agentplex start tries again.'];
    },
  };
}
