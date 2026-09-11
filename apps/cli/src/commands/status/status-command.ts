import { readInstallation } from '../../installation/installation.js';
import type { InstallationFiles } from '../../installation/installation-files.js';
import { lookupFor, lookupUsageLines, readLookupFlags } from '../../installation/lookup-flags.js';
import type { Systemd } from '../../installation/systemd.js';
import { readUnitStates } from '../../installation/units.js';
import { formatStatus } from './status.js';

/**
 * `agentplex status`: what is installed, at what version, and whether it is
 * running.
 *
 * Not `doctor`, and the line is worth stating where both commands can be read
 * beside each other. `doctor` asks whether this machine can do the work -- a
 * pseudoterminal, a provider that is installed and logged in, a store that is
 * mounted -- and exits 1 when something it looked at is unusable. `status` asks
 * about installation state: packages, units, runtime. A machine passes one and
 * fails the other in both directions, which is what makes them two commands
 * rather than two sections of one.
 *
 * It changes nothing, and structurally so: the filesystem seam it is given can
 * read and cannot write, and the systemd seam is asked only `show`. It also
 * reaches no network, which is the boundary `status.ts` argues -- the version
 * oracle and the "a newer one exists" column belong to the update command.
 */

/** Nothing on this machine is in a failed state. */
const EXIT_OK = 0;
/** A unit systemd calls `failed`. The one thing that sets it; see `StatusReport`. */
const EXIT_FAILED = 1;
/** The invocation was wrong, or there is no install here to report on. */
const EXIT_BAD_INVOCATION = 2;

export interface StatusCommandDependencies {
  /** `$HOME`, read at the entrypoint. */
  readonly home: string;
  readonly files: InstallationFiles;
  readonly systemd: Systemd;
  readonly write: (line: string) => void;
  readonly writeError: (line: string) => void;
}

export function statusUsage(): string {
  return [
    'Usage: agentplex status [options]',
    '',
    '  What is installed on this machine, at what version, and whether it is running.',
    '  Packages, units, runtime. It reads this machine and reaches no network, so it',
    '  reports the versions that are here and never whether a newer one exists.',
    '',
    '  agentplex doctor is the other question: whether this machine can do the work',
    '  -- a terminal, a provider, a store. Capability rather than installation.',
    '',
    ...lookupUsageLines(),
  ].join('\n');
}

export async function runStatusCommand(
  argv: readonly string[],
  dependencies: StatusCommandDependencies,
): Promise<number> {
  const { write, writeError } = dependencies;
  const refuse = (problems: readonly string[]): number => {
    for (const problem of problems) writeError(`agentplex status: ${problem}`);
    writeError(`\n${statusUsage()}`);
    return EXIT_BAD_INVOCATION;
  };

  const flags = readLookupFlags(argv);
  if (!flags.ok) return refuse(flags.problems);

  const found = await readInstallation(lookupFor(dependencies.home, flags), dependencies.files);
  if (!found.ok) return refuse(found.problems);

  const installation = found.installation;
  // A machine with no systemctl is asked nothing rather than asked and refused
  // once per unit: the answer would be the same "could not be reached" every
  // time, and the report would carry it twice instead of once. `null` is that
  // machine, and the report says so in one line above the units it still lists.
  const units = (await dependencies.systemd.present())
    ? await readUnitStates(installation, dependencies.systemd)
    : null;

  const report = formatStatus(installation, units);
  for (const line of report.lines) write(line);
  return report.failed ? EXIT_FAILED : EXIT_OK;
}
