import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { childEnvironment, childSearchPath, wantsHelp } from '@agentplex/node-shared';
import { createNodeProcessRunner, createNodeProgramResolver } from '@agentplex/providers';
import { z } from 'zod';
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
 * manifest and `AGENTPLEX_PACKAGE` for a directory of tarballs, the platform
 * for whether a unit can be held at all, and this package's own version, so
 * the command's own package is installed only when the release names another.
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
    runningVersion: await ownVersion(),
    platform: process.platform,
    source: manifestSource(process.env, join),
    packageDirectory:
      packageDirectory === undefined || packageDirectory === '' ? null : packageDirectory,
    write: (text) => void process.stdout.write(text),
    writeError: (line) => void process.stderr.write(`${line}\n`),
  });
}

/**
 * The package root's manifest: five levels up from the `dist/commands/install`
 * this file is emitted into, which is the bin's `../../..` from its own
 * `dist/main.js` -- the one expression correct in a checkout, in the image and
 * under `<prefix>/lib/node_modules`, because each keeps the workspace layout.
 */
const MANIFEST = new URL('../../../../../package.json', import.meta.url);

const manifestSchema = z.object({ version: z.string().min(1) });

/**
 * This package's version, read as the bin's `--version` reads it, or `null`
 * for a tree that cannot say -- which installs the command's package rather
 * than guessing that it is already the one wanted.
 */
async function ownVersion(): Promise<string | null> {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(MANIFEST, 'utf8')));
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}
