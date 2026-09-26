import { join } from 'node:path';
import process from 'node:process';
import { childEnvironment, childSearchPath, wantsHelp } from '@agentplex/node-shared';
import { createNodeProcessRunner, createNodeProgramResolver } from '@agentplex/providers';
import { manifestSource } from '../../versions/version-check.js';
import { nodeNetwork } from '../../versions/node-network.js';
import { runInstallCommand } from './install-command.js';
import { installUsage } from './install-flags.js';
import { nodeInstallMachine } from './node-install-machine.js';

/**
 * `agentplex install`, wired.
 *
 * The only place in this command that reads `process`: `$HOME` for the user
 * prefix, the uid for which scope may be taken, `AGENTPLEX_VERSIONS` for the
 * manifest and `AGENTPLEX_PACKAGE` for a directory of tarballs, and the
 * platform for whether a unit can be held at all.
 *
 * `nodeNetwork` is composed here because a real run needs it: the manifest,
 * when no local one is named, and the release tarballs. A dry run and
 * `--print-unit` are handed the same one and never reach it -- the dry run
 * reads only a local manifest, and `--print-unit` nothing but the interpreter
 * it names -- which the command's suite asserts against a fake network.
 */
export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    process.stdout.write(`${installUsage()}\n`);
    return;
  }

  const environment = childEnvironment({
    inherited: process.env,
    binPath: [],
    timezone: undefined,
  });
  const packageDirectory = process.env['AGENTPLEX_PACKAGE'];

  process.exitCode = await runInstallCommand(argv, {
    // `os.homedir()` is deliberately not the fallback, for the reason setup
    // gives: under `sudo` it answers with the invoking user's home while `$HOME`
    // answers root's, and the prefix that matters is the one the shell used.
    home: process.env['HOME'] ?? '',
    isRoot: process.getuid?.() === 0,
    machine: nodeInstallMachine,
    programs: createNodeProgramResolver(childSearchPath(environment)),
    runner: createNodeProcessRunner({ environment }),
    reader: nodeNetwork,
    downloader: nodeNetwork,
    platform: process.platform,
    source: manifestSource(process.env, join),
    packageDirectory:
      packageDirectory === undefined || packageDirectory === '' ? null : packageDirectory,
    write: (text) => void process.stdout.write(text),
    writeError: (line) => void process.stderr.write(`${line}\n`),
  });
}
