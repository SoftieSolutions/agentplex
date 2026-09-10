#!/usr/bin/env node
import process from 'node:process';
import {
  childEnvironment,
  childSearchPath,
  systemClock,
  randomIdGenerator,
  createLogger,
  jsonLineSink,
  systemTimers,
  randomTokenMinter,
} from '@agentplex/node-shared';
import { loadConfig, usage } from './config/config.js';
import { formatDoctorReport, inspectMachine } from './doctor.js';
import { startRuntime } from './runtime.js';
import { createNodeBeaconNetwork } from './server/node-beacon-transport.js';
import {
  createNodeProcessProbe,
  createNodeProgramResolver,
  nodeStoreFileSystem,
  createNodeProcessRunner,
  createClaudeAdapter,
  nodeProviderFiles,
  createProviderPreflight,
  createProviderRegistry,
} from '@agentplex/providers';
import { nodePtyFactory, createPtySupervisor } from '@agentplex/pty';
import { createOperationRegistry } from './server/operations/operation-registry.js';
import { createTerminalManager } from './server/terminal-manager.js';
import { createNodeSetupMachine } from './setup/node-setup-machine.js';
import { createNodeSetupTerminal } from './setup/node-setup-terminal.js';
import { runSetupCommand, setupUsage } from './setup/setup-command.js';

/**
 * The entrypoint is wiring and process concerns only: argv, env, stdout,
 * signals, exit codes. Every rule lives in a sibling module that a test can
 * reach without opening a port.
 *
 * The shebang above is the whole of what makes this file a command. `bin` in a
 * package.json is a path, not an interpreter: npm links `agentplexd` at that
 * path and marks it executable, and the kernel then hands a file with no `#!`
 * to the shell, which reads `import process from 'node:process'` as a command
 * called `import`. Nothing in this repository noticed, because the image and
 * every script here start it as `node .../main.js`. `tsc` copies a leading
 * shebang into the emitted file, so the built `dist/main.js` carries it too.
 */

/** Configuration was wrong. Restarting will not help; the operator must act. */
const EXIT_BAD_CONFIGURATION = 2;
/** Startup failed for a reason that may pass, such as a database not up yet. */
const EXIT_STARTUP_FAILED = 1;
/**
 * `doctor` found something this machine cannot do.
 *
 * The same 1, deliberately: to a script `agentplexd doctor` is a check, and a
 * check that says "not ready" has failed in the only sense a shell understands.
 * Nothing here distinguishes a missing provider from an unmounted store by
 * code, because the report already does, in words, on stdout.
 */
const EXIT_NOT_READY = 1;

async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
  const writeError = (line: string): void => void process.stderr.write(`${line}\n`);
  const argv = process.argv.slice(2);

  // `setup` is a different program that happens to share a binary: it reads a
  // plan rather than a configuration, binds no port, opens no database, and
  // exits when it is done. It writes files -- an identity, store files, the
  // settings -- and the hub reads them at its next boot. It is dispatched
  // before `loadConfig` because the daemon's flags are not its flags, and
  // because the settings a run of setup produces are the ones the daemon will
  // later be started with.
  if (argv[0] === 'setup') {
    process.exitCode = await setUp(argv.slice(1), write);
    return;
  }

  const loaded = loadConfig({ argv, env: process.env });

  if (!loaded.ok) {
    for (const problem of loaded.problems) process.stderr.write(`agentplexd: ${problem}\n`);
    process.stderr.write(`\n${usage()}\n\n${setupUsage()}\n`);
    process.exitCode = EXIT_BAD_CONFIGURATION;
    return;
  }

  const config = loaded.config;
  // The service logs on stdout, because that is what a supervisor collects.
  // `doctor` gives stdout to its report and puts its own log lines on stderr,
  // so that what an operator reads -- or pipes into an issue -- is the report
  // and not the report with a JSON line about a probe in the middle of it.
  const logger = createLogger(
    config.logLevel,
    jsonLineSink(loaded.command === 'doctor' ? writeError : write, systemClock),
  );

  // What every child of this process gets, composed once: what agentplexd
  // inherited, with the configured directories ahead of its PATH. Both spawn
  // seams below take it at construction, so nothing downstream has an
  // environment to read or a variable to add.
  const environment = childEnvironment({ inherited: process.env, binPath: config.server.binPath });

  // The one place a one-shot child is started. Every operation shares this
  // runner, so what a child inherits is decided above and cannot be added to
  // further down.
  const processRunner = createNodeProcessRunner({ environment });

  // Where a bare program name will actually resolve, read back out of the
  // environment composed above rather than out of the setting that shaped it.
  // The preflight's whole value is that its answer is the one a spawn would
  // reach, and a second list built from `binPath` here could differ from the
  // first the day the composition changes.
  const programs = createNodeProgramResolver(childSearchPath(environment));

  // What this build drives, in one line, shared by `doctor` and by the service.
  // Adding codex is another adapter file and another entry here, and nothing
  // else.
  const providers = createProviderRegistry([
    createClaudeAdapter({
      files: nodeProviderFiles,
      probe: createNodeProcessProbe({ runner: processRunner }),
    }),
  ]);

  // What those adapters turn out to be on this machine, asked once. The service
  // asks it at boot and carries the answer into every handshake; `doctor` asks
  // it and prints it. One implementation, so the two can never disagree about
  // whether a binary is there -- which is exactly the moment somebody is
  // staring at a machine wondering why a session will not start.
  const preflight = createProviderPreflight({ programs, probes: processRunner, logger });

  if (loaded.command === 'doctor') {
    // Read-only, and then it exits. Nothing below this line runs: no port is
    // bound, no database is opened, no store file is minted.
    const report = await inspectMachine(config, {
      providers,
      preflight,
      files: nodeStoreFileSystem,
    });
    for (const line of formatDoctorReport(report)) write(line);
    if (!report.usable) process.exitCode = EXIT_NOT_READY;
    return;
  }

  let runtime;
  try {
    runtime = await startRuntime(config, {
      logger,
      ids: randomIdGenerator,
      storeFileSystem: nodeStoreFileSystem,
      // The only place a secret is generated, and the CSPRNG is the whole
      // implementation: the server's pairing token, once, on its first start.
      tokens: randomTokenMinter,
      providers,
      // Asked once at boot, and the answer carried into every handshake. It
      // shares the one-shot runner above, so a provider is probed through
      // exactly the environment its sessions will run in -- and it is nowhere
      // in the operation registry, so nothing reachable over a socket can ask
      // this process to run a provider probe.
      preflight,
      // Closed: the operations are a list in that module, and there is no
      // parameter here through which a build could add one. Provisioning is not
      // among them, and `createSetupOperationRegistry` is deliberately not
      // called here: a serving agentplexd has no installer to be asked for over
      // a socket, rather than one it declines to use.
      operations: createOperationRegistry(processRunner),
      // The only place a real pty is opened. It is handed the same composed
      // environment as the one-shot runner, so a provider binary resolves the
      // same way whether it is being probed or driven. What gets scrubbed out
      // of it is each adapter's call, carried on its launch plan.
      //
      terminals: createTerminalManager({
        supervisor: createPtySupervisor({
          pty: nodePtyFactory,
          clock: systemClock,
          ids: randomIdGenerator,
          environment,
        }),
        clock: systemClock,
        cap: config.server.terminalCap,
      }),
      // The one place a UDP socket can be opened. Built whatever the setting,
      // and used only where the configuration turned announcing on, so that
      // "can this process broadcast" stays a visible line in the entrypoint
      // rather than a decision taken somewhere below it.
      beacon: createNodeBeaconNetwork(logger),
      timers: systemTimers,
      clock: systemClock,
    });
  } catch (error) {
    logger.error('agentplexd failed to start', { error: String(error) });
    process.exitCode = EXIT_STARTUP_FAILED;
    return;
  }

  // Containers stop with SIGTERM; a terminal stops with SIGINT. A second signal
  // means the operator is done waiting, so it is not intercepted.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info('shutting down', { signal });
      void runtime.stop().catch((error: unknown) => {
        logger.error('shutdown failed', { error: String(error) });
        process.exitCode = EXIT_STARTUP_FAILED;
      });
    });
  }
}

/**
 * `agentplexd setup`, wired: the wizard and the plan replay both.
 *
 * The two factories are the whole of why this is here rather than in the command
 * itself: what a child of setup inherits comes from the directories in hand, and
 * this is the only place allowed to read `process.env`. The command hands the
 * directories back — out of a plan on one path, out of what the wizard found on
 * the other — and gets a runner composed exactly the way the server's will be,
 * which is what makes a replay find what the previous run installed instead of
 * installing it again.
 *
 * The terminal and the machine are the wizard's two windows onto the world, and
 * they are opened here for the same reason: `$HOME` and `$PATH` are environment,
 * and stdin is this process's own. What the wizard adopts is decided against the
 * operator's PATH, so that list has to come from the process they started.
 *
 * The provisioning operations are reachable from this branch and from nowhere
 * else: `startRuntime` below is wired with the wire-facing registry, which holds
 * none of them, so a serving agentplexd has no installer to be asked for over a
 * socket rather than one it declines to use. That is the whole of AGX-71's split,
 * and this is the process that is on the other side of it.
 */
async function setUp(argv: readonly string[], write: (line: string) => void): Promise<number> {
  const terminal = createNodeSetupTerminal({ input: process.stdin, output: process.stdout });

  try {
    return await runSetupCommand(argv, {
      terminal,
      machine: createNodeSetupMachine({
        // `os.homedir()` is deliberately not the fallback. It reads the passwd
        // entry, so under `sudo` it answers with the invoking user's home while
        // `$HOME` answers root's — two different directories, and the provider
        // state that matters is in whichever one the operator's shell was using.
        // A missing `$HOME` is a machine to say something about, not to guess
        // at.
        home: process.env['HOME'] ?? '',
        path: process.env['PATH'],
      }),
      runnerFor: (binPath) =>
        createNodeProcessRunner({
          environment: childEnvironment({ inherited: process.env, binPath }),
        }),
      // The other place a real pty is opened, and the same composition the
      // runtime's supervisor gets a few lines up. That is the point of it being
      // here: a provider's login is driven through the seam a session is driven
      // through, on the copy of the binary the recorded directories resolve, so
      // what setup logs in is what the server will run.
      supervisorFor: (binPath) =>
        createPtySupervisor({
          pty: nodePtyFactory,
          clock: systemClock,
          ids: randomIdGenerator,
          environment: childEnvironment({ inherited: process.env, binPath }),
        }),
      // The same one line the runtime has, for the same reason: which providers
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
      ids: randomIdGenerator,
      // A plan that brought no pairing token gets one minted here, from the same
      // CSPRNG a server's first start would have used. It is also the token the
      // hub pairs the local server with at its next boot, read back off the
      // identity file: setup has one place a secret comes from, and this is it.
      tokens: randomTokenMinter,
      clock: systemClock,
      write,
      writeError: (line) => void process.stderr.write(`${line}\n`),
    });
  } finally {
    // The input, given back. `setup` is the one subcommand that reads stdin, and
    // a stdin that has been read keeps the event loop alive until it ends — which
    // a terminal never does. Without this the wizard finishes, prints its last
    // line and hangs, and the operator's shell prompt never comes back.
    //
    // In a `finally` because it is true of every way this returns, and here
    // rather than inside the command because this is where the terminal was
    // opened.
    terminal.close();
  }
}

await main();
