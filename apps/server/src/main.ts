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
import { createPtySupervisor, nodePtyFactory } from '@agentplex/pty';
import { startRuntime } from './boot.js';
import { loadServerConfig, serverUsage } from './config.js';
import { createNodeBeaconNetwork } from './node-beacon-transport.js';
import { createOperationRegistry } from './operations/operation-registry.js';
import { createTerminalManager } from './terminal-manager.js';

/**
 * The server's entrypoint: wiring and process concerns only. argv, env,
 * stdout, signals, exit codes. Every rule lives in a sibling module a test can
 * reach without opening a port.
 *
 * The shebang above is what makes this file a command once the `agentplex`
 * bin dispatches to it. `tsc` copies a leading shebang into the emitted file,
 * so the built `dist/main.js` carries it too.
 */

/** Configuration was wrong. Restarting will not help; the operator must act. */
const EXIT_BAD_CONFIGURATION = 2;
/** Startup failed for a reason that may pass. */
const EXIT_STARTUP_FAILED = 1;

async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
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

await main();
