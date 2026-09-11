import { readInstallation } from '../../installation/installation.js';
import type { InstallationFiles } from '../../installation/installation-files.js';
import { lookupUsageLines, readLookupFlags, lookupFor } from '../../installation/lookup-flags.js';
import type { Systemd } from '../../installation/systemd.js';
import { startUnits, stopUnits } from '../../installation/units.js';

/**
 * `agentplex start` and `agentplex stop`: the two commands that replace typing
 * `systemctl`.
 *
 * They are wrappers and never a supervisor. Nothing here runs a daemon as a
 * child of this process, and the type of the seam they go through says so: the
 * only thing they can do to a machine is ask systemd to do it. That is the
 * decision, not an implementation detail -- a CLI that started the hub itself
 * would be a supervisor that dies with the operator's shell, restarts nothing,
 * survives no reboot, and logs nowhere, sitting beside the one every Linux box
 * already has.
 *
 * What they buy, given that, is one thing and it is worth a command: nobody has
 * to know whether their units are the user manager's or the system one's, or
 * which of the two `systemctl` spellings reaches them. That is the answer
 * `install.sh` printed as two lines of instructions and an operator had to keep,
 * and it is derived here from the file the installer actually wrote.
 *
 * One module for two commands, because they are one decision seen twice: what
 * `start` enables, `stop` disables, and the two lists have to be the same list
 * or a machine can be left half up. The two entrypoints beside this file are
 * the whole of the difference.
 */

/** Everything asked for happened. */
const EXIT_OK = 0;
/**
 * The machine is not in the state that was asked for.
 *
 * Also what a machine with no systemd gets, and deliberately. It was told what
 * to run instead, which is a useful thing to have been told and not a start:
 * the daemons are not running, and an exit 0 would be this command claiming
 * they were to whatever script asked.
 */
const EXIT_NOT_DONE = 1;
/** The invocation was wrong, or there is no install here to act on. */
const EXIT_BAD_INVOCATION = 2;

export interface UnitsCommandDependencies {
  /** `$HOME`, read at the entrypoint. */
  readonly home: string;
  readonly files: InstallationFiles;
  readonly systemd: Systemd;
  /** `process.execPath`: the fallback interpreter for the foreground command. */
  readonly interpreter: string;
  readonly write: (line: string) => void;
  readonly writeError: (line: string) => void;
}

export function unitsUsage(verb: 'start' | 'stop'): string {
  const what =
    verb === 'start'
      ? 'Enables and starts every agentplex unit this machine has, in the scope it was'
      : 'Stops every agentplex unit this machine has and takes it off boot, in the scope';
  const rest =
    verb === 'start'
      ? 'installed in. It supervises nothing itself: systemd runs the daemons, and this'
      : 'it was installed in. It is the exact reverse of agentplex start, which is why';
  const third =
    verb === 'start'
      ? 'is the command that saves you knowing which systemctl reaches them.'
      : 'it disables as well as stops. `systemctl stop` is still there for one restart.';

  return [
    `Usage: agentplex ${verb} [options]`,
    '',
    `  ${what}`,
    `  ${rest}`,
    `  ${third}`,
    '',
    '  Which prefix and which scope come from the settings file install.sh wrote:',
    '  a machine with no such file is not one this can act on, and says so.',
    '',
    ...lookupUsageLines(),
  ].join('\n');
}

export async function runUnitsCommand(
  verb: 'start' | 'stop',
  argv: readonly string[],
  dependencies: UnitsCommandDependencies,
): Promise<number> {
  const { write, writeError } = dependencies;
  const refuse = (problems: readonly string[]): number => {
    for (const problem of problems) writeError(`agentplex ${verb}: ${problem}`);
    writeError(`\n${unitsUsage(verb)}`);
    return EXIT_BAD_INVOCATION;
  };

  const flags = readLookupFlags(argv);
  if (!flags.ok) return refuse(flags.problems);

  const found = await readInstallation(lookupFor(dependencies.home, flags), dependencies.files);
  if (!found.ok) return refuse(found.problems);

  const installation = found.installation;
  const act = verb === 'start' ? startUnits : stopUnits;
  const done = await act(installation, dependencies);

  // The report goes to stdout whatever happened, and the verdict is the exit
  // code -- the same split `doctor` makes. What is printed is an answer to what
  // was asked, including the machine that has no systemd to ask: the foreground
  // command is the most useful thing anybody gets out of this run, and putting
  // it on stderr would hide it from the pipe an operator reached for.
  write(
    `agentplex ${verb}   prefix=${installation.layout.prefix}   scope=${installation.layout.scope}`,
  );
  write('');
  for (const line of done.lines) write(line);

  return done.ok ? EXIT_OK : EXIT_NOT_DONE;
}
