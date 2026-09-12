import process from 'node:process';
import {
  childEnvironment,
  childSearchPath,
  randomIdGenerator,
  randomTokenMinter,
  systemClock,
  wantsHelp,
} from '@agentplex/node-shared';
import {
  createClaudeAdapter,
  createNodeProcessProbe,
  createNodeProcessRunner,
  createNodeProgramResolver,
  createProviderRegistry,
  nodeProviderFiles,
  nodeStoreFileSystem,
} from '@agentplex/providers';
import { createPtySupervisor, nodePtyFactory } from '@agentplex/pty';
import { nodeInstallationFiles } from '../../installation/node-installation-files.js';
import { createSystemd } from '../../installation/systemd.js';
import { createNodeSetupMachine } from './node-setup-machine.js';
import { createUnitsAfterSetup } from './start-after-setup.js';
import { createNodeSetupTerminal } from './node-setup-terminal.js';
import { runSetupCommand, setupUsage } from './setup-command.js';

/**
 * `agentplex setup`, wired: the wizard and the plan replay both.
 *
 * Exported and called by the bin's dispatcher rather than run by the act of
 * importing this file. There is no shebang above and no `await main()` below
 * because neither is true any more: this was its own bin, with its own
 * `package.json` and its own `dist/main.js`, and it is now a command inside the
 * one bin there is. The argument for a call over a module that runs itself is
 * in `programs.ts`.
 *
 * Setup reads a plan rather than a configuration, binds no port, opens no
 * database, and exits when it is done. It writes files -- an identity, store
 * files, the settings -- and the daemons read them when they start.
 *
 * The two factories are the whole of why this is here rather than in the
 * command itself: what a child of setup inherits comes from the directories in
 * hand, and this is the only place allowed to read `process.env`. The command
 * hands the directories back -- out of a plan on one path, out of what the
 * wizard found on the other -- and gets a runner composed exactly the way the
 * server's is, which is what makes a replay find what the previous run
 * installed instead of installing it again.
 *
 * The terminal and the machine are the wizard's two windows onto the world,
 * and they are opened here for the same reason: `$HOME` and `$PATH` are
 * environment, and stdin is this process's own. What the wizard adopts is
 * decided against the operator's PATH, so that list has to come from the
 * process they started.
 *
 * The provisioning operations are reachable from this program and from no
 * daemon: the server is wired with the wire-facing registry, which holds none
 * of them, so a serving process has no installer to be asked for over a socket
 * rather than one it declines to use.
 */
export async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);

  // Before the terminal exists, and before the command reads a flag. Setup's
  // flag reader refuses an argument it does not know for the reason every other
  // program's does, so `--help` was a refusal here too; and this is the one
  // program whose no-flags path is to start asking, so an operator who asked
  // what the flags are and got the wizard instead would be answering questions
  // on a terminal that never ends. Nothing is opened and nothing is read: the
  // usage is printed on stdout and the process is done.
  if (wantsHelp(process.argv.slice(2))) {
    write(setupUsage());
    return;
  }

  const terminal = createNodeSetupTerminal({ input: process.stdin, output: process.stdout });

  // What a child that is not a provider inherits: this process's environment
  // with no `binPath` in front of it. `systemctl` is the machine's own program
  // and must resolve as the machine resolves it, where a provider is looked for
  // in the directories the plan named first.
  const machineEnvironment = childEnvironment({
    inherited: process.env,
    binPath: [],
    timezone: undefined,
  });

  try {
    process.exitCode = await runSetupCommand(process.argv.slice(2), {
      terminal,
      machine: createNodeSetupMachine({
        // `os.homedir()` is deliberately not the fallback. It reads the passwd
        // entry, so under `sudo` it answers with the invoking user's home while
        // `$HOME` answers root's -- two different directories, and the provider
        // state that matters is in whichever one the operator's shell was
        // using. A missing `$HOME` is a machine to say something about, not to
        // guess at.
        home: process.env['HOME'] ?? '',
        path: process.env['PATH'],
      }),
      runnerFor: (binPath) =>
        createNodeProcessRunner({
          environment: childEnvironment({ inherited: process.env, binPath, timezone: undefined }),
        }),
      // The other place a real pty is opened, and the same composition the
      // server's supervisor gets. That is the point of it being here: a
      // provider's login is driven through the seam a session is driven
      // through, on the copy of the binary the recorded directories resolve,
      // so what setup logs in is what the server will run.
      supervisorFor: (binPath) =>
        createPtySupervisor({
          pty: nodePtyFactory,
          clock: systemClock,
          ids: randomIdGenerator,
          environment: childEnvironment({ inherited: process.env, binPath, timezone: undefined }),
        }),
      // The same one line the server has, for the same reason: which providers
      // this build drives is a fact about the build and belongs in the
      // entrypoint.
      providersFor: (runner) =>
        createProviderRegistry([
          createClaudeAdapter({
            files: nodeProviderFiles,
            probe: createNodeProcessProbe({ runner }),
          }),
        ]),
      files: nodeStoreFileSystem,
      // The one step that runs after everything else, and the reason it is
      // setup's rather than the installer's is in `start-after-setup.ts`. It is
      // composed here with the same runner and resolver `doctor` and `status`
      // get, because "where would a bare `systemctl` come from" has one answer
      // per machine and should not have two per program.
      units: createUnitsAfterSetup({
        home: process.env['HOME'] ?? '',
        files: nodeInstallationFiles,
        systemd: createSystemd({
          runner: createNodeProcessRunner({ environment: machineEnvironment }),
          programs: createNodeProgramResolver(childSearchPath(machineEnvironment)),
        }),
        interpreter: process.execPath,
      }),
      ids: randomIdGenerator,
      // A plan that brought no pairing token gets one minted here, from the
      // same CSPRNG a server's first start would have used. It is also the
      // token the hub pairs the local server with at its next boot, read back
      // off the identity file: setup has one place a secret comes from, and
      // this is it.
      tokens: randomTokenMinter,
      clock: systemClock,
      write,
      writeError: (line) => void process.stderr.write(`${line}\n`),
    });
  } finally {
    // The input, given back. Setup is the one program that reads stdin, and a
    // stdin that has been read keeps the event loop alive until it ends --
    // which a terminal never does. Without this the wizard finishes, prints
    // its last line and hangs, and the operator's shell prompt never comes
    // back.
    terminal.close();
  }
}
