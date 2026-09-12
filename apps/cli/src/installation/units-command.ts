import process from 'node:process';
import { childEnvironment, childSearchPath, wantsHelp } from '@agentplex/node-shared';
import { createNodeProcessRunner, createNodeProgramResolver } from '@agentplex/providers';
import type { Installation } from './installation.js';
import { readInstallation } from './installation.js';
import type { InstallationFiles } from './installation-files.js';
import { nodeInstallationFiles } from './node-installation-files.js';
import { readLookupFlags, lookupFor } from './lookup-flags.js';
import { createSystemd, type Systemd } from './systemd.js';
import type { UnitsAct, UnitsDependencies } from './units.js';

/**
 * The shell `agentplex start` and `agentplex stop` are each a filling of.
 *
 * They are wrappers and never a supervisor. Nothing here runs a daemon as a
 * child of this process, and the type of the seam they go through says so: the
 * only thing either can do to a machine is ask systemd to do it. That is the
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
 * ## Why this is one module and the two commands are not
 *
 * What differs between `start` and `stop` is a word, a paragraph of usage and
 * which function in `units.js` gets called. What is the same is everything
 * between the argv and the exit code: the flags, the lookup that turns them
 * into an installation, the report, and the three codes below. Splitting that
 * as well would be two copies of the flow, and the copies would not disagree
 * about anything visible until the day one of them exited differently from the
 * other for the same bad `--prefix`.
 *
 * So the pair is a `UnitsCommand` each, declared beside its own entrypoint
 * under `commands/`, and this file is the only thing that knows how either of
 * them reaches a machine. `name` is a label rather than a verb union on
 * purpose: nothing here branches on which command it is running, and a type
 * that cannot spell a third one would be claiming otherwise.
 *
 * It lives here rather than under `commands/` because what it wraps is
 * `units.js` next door -- `startUnits` and `stopUnits`, which `setup` calls
 * too -- and because `commands/` holds subcommands, one folder each.
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

/**
 * One of the two commands: the word an operator typed, the usage that word
 * prints, and the one thing it does to a machine.
 *
 * `act` is `startUnits` or `stopUnits` and nothing else ever, which is why it
 * is typed as what those are rather than as a free function: the pair has to
 * stay a pair -- what `start` enables, `stop` disables, out of one list of this
 * machine's units -- and that is a property of `units.js`, kept there.
 */
export interface UnitsCommand {
  /** The word, as `agentplex <name>` and in every line either stream carries. */
  readonly name: string;
  readonly usage: string;
  readonly act: (installation: Installation, dependencies: UnitsDependencies) => Promise<UnitsAct>;
}

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

export async function runUnitsCommand(
  command: UnitsCommand,
  argv: readonly string[],
  dependencies: UnitsCommandDependencies,
): Promise<number> {
  const { write, writeError } = dependencies;
  const refuse = (problems: readonly string[]): number => {
    for (const problem of problems) writeError(`agentplex ${command.name}: ${problem}`);
    writeError(`\n${command.usage}`);
    return EXIT_BAD_INVOCATION;
  };

  const flags = readLookupFlags(argv);
  if (!flags.ok) return refuse(flags.problems);

  const found = await readInstallation(lookupFor(dependencies.home, flags), dependencies.files);
  if (!found.ok) return refuse(found.problems);

  const installation = found.installation;
  const done = await command.act(installation, dependencies);

  // The report goes to stdout whatever happened, and the verdict is the exit
  // code -- the same split `doctor` makes. What is printed is an answer to what
  // was asked, including the machine that has no systemd to ask: the foreground
  // command is the most useful thing anybody gets out of this run, and putting
  // it on stderr would hide it from the pipe an operator reached for.
  write(
    `agentplex ${command.name}   prefix=${installation.layout.prefix}   scope=${installation.layout.scope}`,
  );
  write('');
  for (const line of done.lines) write(line);

  return done.ok ? EXIT_OK : EXIT_NOT_DONE;
}

/**
 * The composition both entrypoints share.
 *
 * The one-shot runner and the program resolver are built exactly the way
 * `doctor` builds them, from the same two helpers, so that "where would a bare
 * `systemctl` come from" is answered here the same way "where would a bare
 * `claude` come from" is answered there. No `binPath`: agentplex's own prefix is
 * where providers are installed, and a `systemctl` found in it would not be the
 * machine's.
 *
 * This is the only place in the pair that reads `process`. `$HOME` decides which
 * per-user prefix is looked at, `process.execPath` is the interpreter the
 * foreground command falls back to, and both are process facts a test cannot
 * supply -- which is exactly why they are read here and passed down as values.
 */
export async function runUnitsMain(command: UnitsCommand): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
  const writeError = (line: string): void => void process.stderr.write(`${line}\n`);

  // Before the flags are read, for the reason every program here answers it
  // first: the reader below refuses an argument it does not know, and `--help`
  // is not one of the two it takes.
  if (wantsHelp(process.argv.slice(2))) {
    write(command.usage);
    return;
  }

  const environment = childEnvironment({ inherited: process.env, binPath: [] });

  process.exitCode = await runUnitsCommand(command, process.argv.slice(2), {
    // `os.homedir()` is deliberately not the fallback, for the reason setup
    // gives: under `sudo` it reads the passwd entry and answers with the
    // invoking user's home while `$HOME` answers root's, and the prefix that
    // matters is in whichever one the shell was using.
    home: process.env['HOME'] ?? '',
    files: nodeInstallationFiles,
    systemd: createSystemd({
      runner: createNodeProcessRunner({ environment }),
      programs: createNodeProgramResolver(childSearchPath(environment)),
    }),
    interpreter: process.execPath,
    write,
    writeError,
  });
}
