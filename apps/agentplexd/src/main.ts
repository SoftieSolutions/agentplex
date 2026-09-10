#!/usr/bin/env node
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { childEnvironment, childSearchPath } from './config/child-environment.js';
import { loadConfig, usage } from './config/config.js';
import { formatDoctorReport, inspectMachine } from './doctor.js';
import { nodeMigrationFileSystem } from './hub/db/node-migration-files.js';
import { createNodeBeaconSource } from './hub/discovery/node-beacon-listener.js';
import { createSqliteDatabase } from './hub/db/sqlite.js';
import { createNodeWebAssets } from './hub/web/node-web-assets.js';
import { startRuntime } from './runtime.js';
import { createNodeBeaconNetwork } from './server/node-beacon-transport.js';
import { createNodeProcessProbe } from './server/node-process-probe.js';
import { createNodeProgramResolver } from './server/node-program-resolver.js';
import { nodePtyFactory } from './server/node-pty-factory.js';
import { nodeStoreFileSystem } from './server/node-store-files.js';
import { createNodeProcessRunner } from './server/operations/node-process-runner.js';
import { createOperationRegistry } from './server/operations/operation-registry.js';
import { createClaudeAdapter } from './server/providers/claude-adapter.js';
import { nodeProviderFiles } from './server/providers/node-provider-files.js';
import { createProviderPreflight } from './server/providers/preflight.js';
import { createProviderRegistry } from './server/providers/provider-registry.js';
import { createPtySupervisor } from './server/pty-supervisor.js';
import { createTerminalManager } from './server/terminal-manager.js';
import { systemClock } from './shared/clock.js';
import { randomIdGenerator } from './shared/ids.js';
import { createLogger, jsonLineSink } from './shared/logger.js';
import { systemTimers } from './shared/timers.js';
import { randomTokenMinter } from './shared/tokens.js';
import { createWebSocketDialer } from './shared/ws-message-socket.js';

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

/**
 * `migrations/` sits beside `src/` and `dist/`, so this resolves the same way
 * whether the process was started from source or from a build.
 */
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * The built PWA the hub serves.
 *
 * One expression, correct in all four places this process runs, because all
 * four keep the workspace layout: `apps/agentplexd/src/main.ts` and
 * `apps/agentplexd/dist/main.js` are the same distance from `apps/web/dist`,
 * and the runtime image copies the build to that path for exactly this reason.
 *
 * The fourth is the published package, and it was expected to be the exception
 * — the one line packaging would have to change. It is not, because packaging
 * chose to keep the invariant instead of adding a case to it: `agentplexd` is
 * published as the workspace laid out the way the image lays it out, so this
 * expression is as true after `npm install --global` as it is here. See
 * `packaging/assemble-package.ts`, which is where that decision is argued and
 * where a test holds it: a flat package would have needed a second set of
 * relative paths that nothing exercises until a stranger installs it.
 */
const WEB_ROOT = fileURLToPath(new URL('../../web/dist', import.meta.url));

async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
  const writeError = (line: string): void => void process.stderr.write(`${line}\n`);
  const loaded = loadConfig({ argv: process.argv.slice(2), env: process.env });

  if (!loaded.ok) {
    for (const problem of loaded.problems) process.stderr.write(`agentplexd: ${problem}\n`);
    process.stderr.write(`\n${usage()}\n`);
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
  // environment to read or a variable to add — and a hub-only process, which
  // has no server half to configure, keeps inheriting exactly as before.
  const environment = childEnvironment({
    inherited: process.env,
    binPath: 'server' in config ? config.server.binPath : [],
  });

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
      openDatabase: (path) => createSqliteDatabase(path),
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      migrationFileSystem: nodeMigrationFileSystem,
      // The one place the client's files are read off a disk. A hub-only
      // process and a `--role=both` one serve the same bytes from the same
      // directory, and a `--role=server` one never asks.
      webAssets: createNodeWebAssets(WEB_ROOT),
      storeFileSystem: nodeStoreFileSystem,
      // The only place a secret is generated, and the CSPRNG is the whole
      // implementation. It mints two things: the server's pairing token, once,
      // on its first start, and every websocket ticket the hub hands a client.
      // The hub's own client token is not among them -- that one is typed by a
      // person, so it arrives as configuration.
      tokens: randomTokenMinter,
      providers,
      // Asked once at boot, and the answer carried into every handshake. It
      // shares the one-shot runner above, so a provider is probed through
      // exactly the environment its sessions will run in -- and it is nowhere
      // in the operation registry, so nothing reachable over a socket can ask
      // this process to run a provider probe.
      preflight,
      // Closed: the operations are a list in that module, and there is no
      // parameter here through which a build could add one.
      operations: createOperationRegistry(processRunner),
      // The only place a real pty is opened. It is handed the same composed
      // environment as the one-shot runner, so a provider binary resolves the
      // same way whether it is being probed or driven. What gets scrubbed out
      // of it is each adapter's call, carried on its launch plan.
      //
      // The cap is spread rather than passed as possibly-undefined: the
      // workspace is on `exactOptionalPropertyTypes`, so an absent property is
      // what takes the manager's own default, and a hub-only process has no
      // server half to read one from.
      terminals: createTerminalManager({
        supervisor: createPtySupervisor({
          pty: nodePtyFactory,
          clock: systemClock,
          ids: randomIdGenerator,
          environment,
        }),
        clock: systemClock,
        ...('server' in config ? { cap: config.server.terminalCap } : {}),
      }),
      // The one place a real websocket is opened from this side. The hub
      // dials; nothing dials it. TLS verification is Node's own against the
      // system trust store, which is why there is no certificate decision
      // being made anywhere in this process.
      dialer: createWebSocketDialer(),
      // The one place a UDP socket can be opened. Built whatever the role, and
      // used only where the configuration turned announcing on, so that
      // "can this process broadcast" stays a visible line in the entrypoint
      // rather than a decision taken somewhere below it.
      beacon: createNodeBeaconNetwork(logger),
      // The other end of the same facility, and the one with no switch: a hub
      // binds the discovery port whenever it runs, because hearing a machine
      // announce itself costs nothing and grants nothing.
      discovery: createNodeBeaconSource(logger),
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

await main();
