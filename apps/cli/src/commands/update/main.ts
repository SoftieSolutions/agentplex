import { join } from 'node:path';
import process from 'node:process';
import { childEnvironment, childSearchPath, wantsHelp } from '@agentplex/node-shared';
import { createNodeProcessRunner, createNodeProgramResolver } from '@agentplex/providers';
import { createSystemd } from '../../installation/systemd.js';
import { manifestSource } from '../../versions/version-check.js';
import { nodeNetwork } from '../../versions/node-network.js';
import { versionsCacheFile } from '../../versions/versions-cache.js';
import { nodeUpdateMachine } from './node-update-machine.js';
import { runUpdateCommand } from './update-command.js';
import { updateUsage } from './update-flags.js';
import type { RuntimeArchitecture, RuntimePlatform } from './runtime.js';

/**
 * `agentplex update`, wired.
 *
 * The only place in this command that reads `process`, and it reads more of it
 * than any other entrypoint here does: `$HOME` for the prefix, the environment
 * for the manifest source and the cache location, and the platform and
 * architecture for the runtime, because a Node tarball is named after both.
 * Every one of them is a process fact a test cannot supply, which is exactly
 * why they are read here and passed down as values.
 *
 * `nodeNetwork` is composed here and nowhere else. It is the one thing in this
 * app that can reach off the machine, and a command that must not go out cannot
 * acquire one by accident -- there is nowhere in `status`'s dependencies to put
 * it.
 */
export async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
  const writeError = (line: string): void => void process.stderr.write(`${line}\n`);

  if (wantsHelp(process.argv.slice(2))) {
    write(updateUsage());
    return;
  }

  const environment = childEnvironment({ inherited: process.env, binPath: [] });

  process.exitCode = await runUpdateCommand(process.argv.slice(2), {
    // `os.homedir()` is deliberately not the fallback, for the reason setup
    // gives: under `sudo` it reads the passwd entry and answers with the
    // invoking user's home while `$HOME` answers root's, and the prefix that
    // matters is in whichever one the shell was using.
    home: process.env['HOME'] ?? '',
    machine: nodeUpdateMachine,
    systemd: createSystemd({
      runner: createNodeProcessRunner({ environment }),
      programs: createNodeProgramResolver(childSearchPath(environment)),
    }),
    runner: createNodeProcessRunner({ environment }),
    programs: createNodeProgramResolver(childSearchPath(environment)),
    reader: nodeNetwork,
    downloader: nodeNetwork,
    source: manifestSource(process.env, join),
    cacheFile: versionsCacheFile(process.env),
    now: () => Date.now(),
    platform: platformOf(process.platform),
    architecture: architectureOf(process.arch),
    write,
    writeError,
  });
}

/**
 * The platform and architecture as nodejs.org names them.
 *
 * `detect_platform` in the installer, with the same two maps. Anything else
 * falls back to `linux` and `x64` rather than refusing, and the fallback is
 * deliberate: the only thing either value is used for is picking a line out of
 * a checksum file, and a platform with no line in it is reported as "nothing
 * there builds for this" -- which is a better answer than a command that
 * refuses to update packages because it could not name a runtime it may not
 * even have been asked to touch.
 */
function platformOf(platform: string): RuntimePlatform {
  return platform === 'darwin' ? 'darwin' : 'linux';
}

function architectureOf(architecture: string): RuntimeArchitecture {
  return architecture === 'arm64' ? 'arm64' : 'x64';
}
