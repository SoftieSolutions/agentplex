import process from 'node:process';
import { childEnvironment, childSearchPath, wantsHelp } from '@agentplex/node-shared';
import { createNodeProcessRunner, createNodeProgramResolver } from '@agentplex/providers';
import { nodeInstallationFiles } from '../../installation/node-installation-files.js';
import { createSystemd } from '../../installation/systemd.js';
import { runUnitsCommand, unitsUsage } from './units-command.js';

/**
 * The composition `agentplex start` and `agentplex stop` share.
 *
 * The one-shot runner and the program resolver are built exactly the way
 * `doctor` builds them, from the same two helpers, so that "where would a bare
 * `systemctl` come from" is answered here the same way "where would a bare
 * `claude` come from" is answered there. No `binPath`: agentplex's own prefix is
 * where providers are installed, and a `systemctl` found in it would not be the
 * machine's.
 *
 * This is the only file in the pair that reads `process`. `$HOME` decides which
 * per-user prefix is looked at, `process.execPath` is the interpreter the
 * foreground command falls back to, and both are process facts a test cannot
 * supply -- which is exactly why they are read here and passed down as values.
 */
export async function main(verb: 'start' | 'stop'): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
  const writeError = (line: string): void => void process.stderr.write(`${line}\n`);

  // Before the flags are read, for the reason every program here answers it
  // first: the reader below refuses an argument it does not know, and `--help`
  // is not one of the two it takes.
  if (wantsHelp(process.argv.slice(2))) {
    write(unitsUsage(verb));
    return;
  }

  const environment = childEnvironment({ inherited: process.env, binPath: [] });

  process.exitCode = await runUnitsCommand(verb, process.argv.slice(2), {
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
