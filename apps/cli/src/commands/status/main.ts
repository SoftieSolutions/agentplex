import process from 'node:process';
import { childEnvironment, childSearchPath, wantsHelp } from '@agentplex/node-shared';
import { createNodeProcessRunner, createNodeProgramResolver } from '@agentplex/providers';
import { nodeInstallationFiles } from '../../installation/node-installation-files.js';
import { createSystemd } from '../../installation/systemd.js';
import { versionsCacheFile } from '../../versions/versions-cache.js';
import { runStatusCommand, statusUsage } from './status-command.js';

/**
 * `agentplex status`, wired: read the machine, print the report, exit.
 *
 * Composed the way `doctor` is, from the same two helpers, so that where a bare
 * `systemctl` comes from is decided the same way where a bare `claude` comes
 * from is. Nothing that could reach a network is composed here, which is the
 * other half of the claim `status.ts` makes: this program depends on no dialer,
 * no HTTP client and no fetch. The "what is available" column arrives instead
 * as a path to a cache file -- the one `agentplex update --check` writes -- read
 * through the same read-only filesystem the rest of the report comes from.
 */
export async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
  const writeError = (line: string): void => void process.stderr.write(`${line}\n`);

  if (wantsHelp(process.argv.slice(2))) {
    write(statusUsage());
    return;
  }

  const environment = childEnvironment({
    inherited: process.env,
    binPath: [],
    timezone: undefined,
  });

  process.exitCode = await runStatusCommand(process.argv.slice(2), {
    home: process.env['HOME'] ?? '',
    files: nodeInstallationFiles,
    systemd: createSystemd({
      runner: createNodeProcessRunner({ environment }),
      programs: createNodeProgramResolver(childSearchPath(environment)),
    }),
    cacheFile: versionsCacheFile(process.env),
    now: () => Date.now(),
    write,
    writeError,
  });
}
