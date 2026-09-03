import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from './config/child-environment.js';
import { loadConfig, usage } from './config/config.js';
import { nodeMigrationFileSystem } from './hub/db/node-migration-files.js';
import { createSqliteDatabase } from './hub/db/sqlite.js';
import { startRuntime } from './runtime.js';
import { createNodeProcessProbe } from './server/node-process-probe.js';
import { nodePtyFactory } from './server/node-pty-factory.js';
import { nodeStoreFileSystem } from './server/node-store-files.js';
import { createNodeProcessRunner } from './server/operations/node-process-runner.js';
import { createOperationRegistry } from './server/operations/operation-registry.js';
import { createClaudeAdapter } from './server/providers/claude-adapter.js';
import { nodeProviderFiles } from './server/providers/node-provider-files.js';
import { createProviderRegistry } from './server/providers/provider-registry.js';
import { randomTokenMinter } from './server/server-identity.js';
import { createPtySupervisor } from './server/pty-supervisor.js';
import { createTerminalManager } from './server/terminal-manager.js';
import { systemClock } from './shared/clock.js';
import { randomIdGenerator } from './shared/ids.js';
import { createLogger, jsonLineSink } from './shared/logger.js';

/**
 * The entrypoint is wiring and process concerns only: argv, env, stdout,
 * signals, exit codes. Every rule lives in a sibling module that a test can
 * reach without opening a port.
 */

/** Configuration was wrong. Restarting will not help; the operator must act. */
const EXIT_BAD_CONFIGURATION = 2;
/** Startup failed for a reason that may pass, such as a database not up yet. */
const EXIT_STARTUP_FAILED = 1;

/**
 * `migrations/` sits beside `src/` and `dist/`, so this resolves the same way
 * whether the process was started from source or from a build.
 */
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));

async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);
  const loaded = loadConfig({ argv: process.argv.slice(2), env: process.env });

  if (!loaded.ok) {
    for (const problem of loaded.problems) process.stderr.write(`agentplexd: ${problem}\n`);
    process.stderr.write(`\n${usage()}\n`);
    process.exitCode = EXIT_BAD_CONFIGURATION;
    return;
  }

  const config = loaded.config;
  const logger = createLogger(config.logLevel, jsonLineSink(write, systemClock));

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

  let runtime;
  try {
    runtime = await startRuntime(config, {
      logger,
      ids: randomIdGenerator,
      openDatabase: (path) => createSqliteDatabase(path),
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      migrationFileSystem: nodeMigrationFileSystem,
      storeFileSystem: nodeStoreFileSystem,
      // The only place a pairing token is generated, and the CSPRNG is the
      // whole implementation. What the operator pastes into the hub is what
      // this produced, once, on the server's first start.
      tokens: randomTokenMinter,
      // The providers this build drives, in one line. Adding codex is another
      // adapter file and another entry here, and nothing else.
      providers: createProviderRegistry([
        createClaudeAdapter({
          files: nodeProviderFiles,
          probe: createNodeProcessProbe({ runner: processRunner }),
        }),
      ]),
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
