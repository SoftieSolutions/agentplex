#!/usr/bin/env node
import process from 'node:process';
import {
  childEnvironment,
  childSearchPath,
  createLogger,
  jsonLineSink,
  randomIdGenerator,
  randomTokenMinter,
  systemClock,
  systemTimers,
  wantsHelp,
} from '@agentplex/node-shared';
import {
  createClaudeAdapter,
  createNodeProcessProbe,
  createNodeProcessRunner,
  createNodeProgramResolver,
  createProviderPreflight,
  createProviderRegistry,
  nodeProviderFiles,
  nodeStoreFileSystem,
} from '@agentplex/providers';
import { checkNodePty, createPtySupervisor, nodePtyFactory } from '@agentplex/pty';
import { startRuntime } from './boot.js';
import { loadServerConfig, serverUsage } from './config.js';
import { createNodeBeaconNetwork } from './node-beacon-transport.js';
import { createOperationRegistry } from './operations/operation-registry.js';
import { createMachineLoadReader, createNodeMachineProbe } from './machine-load.js';
import { createGitWorkingTree } from './working-tree.js';
import { refuseWithoutTerminals } from './terminal-support.js';
import { createTerminalManager } from './terminal-manager.js';

/**
 * The server's entrypoint: wiring and process concerns only. argv, env,
 * stdout, signals, exit codes. Every rule lives in a sibling module a test can
 * reach without opening a port.
 *
 * The shebang above buys nothing any longer and stays anyway. Nothing dispatches
 * to this file: the `agentplex` bin has no daemon in its table, the systemd unit
 * names an interpreter and this path, and the image's entrypoint is `node`. The
 * one caller that would have needed the `#!` line is the one that no longer
 * exists. It costs a line, it keeps `./dist/main.js` from a shell working the
 * way somebody debugging will expect, and removing it would be the kind of edit
 * that is noticed only by whatever turns out to have relied on it. `tsc` copies
 * a leading shebang into the emitted file, so the built `dist/main.js` carries
 * it too.
 */

/** Configuration was wrong. Restarting will not help; the operator must act. */
const EXIT_BAD_CONFIGURATION = 2;
/** Startup failed for a reason that may pass. */
const EXIT_STARTUP_FAILED = 1;

async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);

  // First of all, ahead even of the question below about what this machine can
  // do. What this program's flags are is a fact about the program: an operator
  // whose server will not start is exactly the one who needs to read them, and
  // a `--help` that answered with the pty refusal on an installation whose
  // addon did not build would be answering a question nobody asked. It is also
  // before the settings, whose reader refuses any argument that is not one of
  // them -- which is what made the flag the bin advertises a refusal. An answer
  // goes to stdout and exits 0; the two refusals below keep stderr and the code
  // `RestartPreventExitStatus=2` tells the unit not to retry.
  if (wantsHelp(process.argv.slice(2))) {
    write(serverUsage());
    return;
  }

  // Then, and before the configuration, because this is a fact about the
  // installation rather than about the deployment: no setting fixes it, and a
  // server that got as far as opening a port and announcing itself before
  // discovering it cannot run a session has already over-claimed. node-pty is
  // loaded lazily precisely so that this line is reachable -- a static import
  // would have failed while this module was being linked, with a resolver stack
  // instead of a sentence.
  const terminals = refuseWithoutTerminals(checkNodePty());
  if (terminals !== null) {
    for (const line of terminals.lines) process.stderr.write(`${line}\n`);
    process.exitCode = terminals.exitCode;
    return;
  }

  const loaded = loadServerConfig({ argv: process.argv.slice(2), env: process.env });

  if (!loaded.ok) {
    for (const problem of loaded.problems) process.stderr.write(`agentplex server: ${problem}\n`);
    process.stderr.write(`\n${serverUsage()}\n`);
    process.exitCode = EXIT_BAD_CONFIGURATION;
    return;
  }

  const config = loaded.config;
  // The server logs on stdout, because that is what a supervisor collects.
  const logger = createLogger(config.logLevel, jsonLineSink(write, systemClock));

  // What every child of this process gets, composed once: what the server
  // inherited, with the configured directories ahead of its PATH. Both spawn
  // seams below take it at construction, so nothing downstream has an
  // environment to read or a variable to add.
  const environment = childEnvironment({ inherited: process.env, binPath: config.binPath });

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

  // What this build drives, in one line. Adding codex is another adapter file
  // and another entry here, and nothing else.
  const providers = createProviderRegistry([
    createClaudeAdapter({
      files: nodeProviderFiles,
      probe: createNodeProcessProbe({ runner: processRunner }),
    }),
  ]);

  // What those adapters turn out to be on this machine, asked once at boot and
  // carried into every handshake. The same implementation `doctor` prints, so
  // the two can never disagree about whether a binary is there.
  const preflight = createProviderPreflight({ programs, probes: processRunner, logger });

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
      preflight,
      // Closed: the operations are a list in that module, and there is no
      // parameter here through which a build could add one. Provisioning is
      // not among them, and `createSetupOperationRegistry` is deliberately
      // not called here: a serving process has no installer to be asked for
      // over a socket, rather than one it declines to use.
      operations: createOperationRegistry(processRunner),
      // The typed callers of operations, over the same runner: what git says
      // about a session's working directory -- the branch, and what is
      // uncommitted -- attached to every store report. They name `git.status`
      // and `git.diff` at compile time rather than by string, so they can
      // reach no operation the registry does not have and no name it does not
      // know.
      workingTree: createGitWorkingTree({ runner: processRunner }),
      // What this machine says about its own cpus, read when a hub asks and
      // never on a timer. Composed here for the reason everything else is: the
      // probe is the one thing in it that touches the outside world.
      machineLoad: createMachineLoadReader({ probe: createNodeMachineProbe(), clock: systemClock }),
      // The only place a real pty is opened. It is handed the same composed
      // environment as the one-shot runner, so a provider binary resolves the
      // same way whether it is being probed or driven.
      terminals: createTerminalManager({
        supervisor: createPtySupervisor({
          pty: nodePtyFactory,
          clock: systemClock,
          ids: randomIdGenerator,
          environment,
        }),
        clock: systemClock,
        cap: config.terminalCap,
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
    logger.error('agentplex server failed to start', { error: String(error) });
    process.exitCode = EXIT_STARTUP_FAILED;
    return;
  }

  // Containers stop with SIGTERM; a terminal stops with SIGINT.
  //
  // The first one starts a draining shutdown: no new sessions, and the agents
  // already running are given until the drain budget to reach a turn boundary
  // before they are killed. See `drain.ts` for why that is worth waiting for.
  //
  // The second one means the operator is done waiting, and it now has somewhere
  // to say so. It used to be left uncaught, which had the process die on the
  // spot -- fine when shutdown was instantaneous, and wrong the moment it is
  // not: dying mid-drain would leave every agent this server forked running
  // with nothing left to stop them, which is the orphan the shutdown exists to
  // prevent. So it cancels the wait and lets the same shutdown finish, which is
  // both faster and the only version that kills the children.
  //
  // The third is uncaught, deliberately. By then this process has been asked
  // twice and has already stopped waiting for anything, so a third signal can
  // only mean the shutdown itself is stuck -- and the one thing worse than a
  // slow exit is a program that cannot be killed.
  let asked = 0;
  const listeners: (() => void)[] = [];
  const onSignal = (signal: NodeJS.Signals): void => {
    asked += 1;
    if (asked === 1) {
      logger.info('shutting down', { signal });
      void runtime.stop().catch((error: unknown) => {
        logger.error('shutdown failed', { error: String(error) });
        process.exitCode = EXIT_STARTUP_FAILED;
      });
      return;
    }
    logger.info('no longer waiting for sessions to finish', { signal });
    runtime.stopWaiting();
    for (const remove of listeners) remove();
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const listener = (): void => onSignal(signal);
    process.on(signal, listener);
    listeners.push(() => void process.off(signal, listener));
  }
}

await main();
