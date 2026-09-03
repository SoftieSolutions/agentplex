import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadConfig, usage } from './config/config.js';
import { createPostgresDatabase } from './hub/db/postgres.js';
import { nodeMigrationFileSystem } from './hub/db/node-migration-files.js';
import { startRuntime } from './runtime.js';
import { nodeProcessProbe } from './server/node-process-probe.js';
import { nodePtyFactory } from './server/node-pty-factory.js';
import { nodeStoreFileSystem } from './server/node-store-files.js';
import { createClaudeAdapter } from './server/providers/claude-adapter.js';
import { nodeProviderFiles } from './server/providers/node-provider-files.js';
import { createProviderRegistry } from './server/providers/provider-registry.js';
import { createPtySupervisor } from './server/pty-supervisor.js';
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

  let runtime;
  try {
    runtime = await startRuntime(config, {
      logger,
      ids: randomIdGenerator,
      openDatabase: (url) => createPostgresDatabase(url),
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      migrationFileSystem: nodeMigrationFileSystem,
      storeFileSystem: nodeStoreFileSystem,
      // The providers this build drives, in one line. Adding codex is another
      // adapter file and another entry here, and nothing else.
      providers: createProviderRegistry([
        createClaudeAdapter({ files: nodeProviderFiles, probe: nodeProcessProbe }),
      ]),
      // The only place a real pty is opened, and the only place `process.env`
      // is read as the environment a child inherits. What gets scrubbed out of
      // it is each adapter's call, carried on its launch plan.
      sessions: createPtySupervisor({
        pty: nodePtyFactory,
        clock: systemClock,
        ids: randomIdGenerator,
        environment: process.env,
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
