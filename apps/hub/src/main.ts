#!/usr/bin/env node
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createLogger,
  createWebSocketDialer,
  jsonLineSink,
  randomIdGenerator,
  randomTokenMinter,
  systemClock,
  systemTimers,
  wantsHelp,
} from '@agentplex/node-shared';
import { nodeStoreFileSystem } from '@agentplex/providers';
import { startHubRuntime } from './boot.js';
import { hubUsage, loadHubConfig } from './config.js';
import { nodeMigrationFileSystem } from './db/node-migration-files.js';
import { createSqliteDatabase } from './db/sqlite.js';
import { createNodeBeaconSource } from './discovery/node-beacon-listener.js';
import { createNodeWebAssets } from './web/node-web-assets.js';
import { missingWebPackage, resolveWebRoot } from './web/web-package.js';

/**
 * The hub's entrypoint: wiring and process concerns only. argv, env, stdout,
 * signals, exit codes. Every rule lives in a sibling module a test can reach
 * without opening a port.
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
/** Startup failed for a reason that may pass, such as a database not up yet. */
const EXIT_STARTUP_FAILED = 1;

/**
 * `migrations/` sits beside `src/` and `dist/`, so this resolves the same way
 * whether the process was started from source or from a build.
 */
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * The built PWA the hub serves, found by asking Node where its package is.
 *
 * It was `../../web/dist` while the client was cargo inside the hub's own tree.
 * It is a package of its own now -- a hub machine installs it beside the hub
 * and a server machine installs neither -- so the client is somewhere the hub
 * resolves rather than somewhere it counts directories to. `web-package.ts`
 * carries the argument and the three homes that one specifier has to work in.
 *
 * `import.meta.resolve` is passed in rather than reached for, because it is
 * meaningful only in the module it is evaluated in: it resolves against *this*
 * file's URL, and a copy of it called from somewhere else would answer for
 * somewhere else. That makes it exactly the kind of thing a test cannot supply,
 * so it is injected at the one place that has the right URL to ask from.
 */
const WEB_ROOT = resolveWebRoot((specifier) => import.meta.resolve(specifier));

async function main(): Promise<void> {
  const write = (line: string): void => void process.stdout.write(`${line}\n`);

  // Before the settings are read, because the reader under them accepts the
  // flags in this program's table and refuses everything else -- so `--help`,
  // the one flag the bin's usage tells an operator to type, would be an unknown
  // argument. Answering it is not the same event as refusing a typo: an answer
  // goes to stdout, where a pipe or a pager can take it, and exits 0, while the
  // refusal below keeps stderr and the code the unit will not restart on.
  if (wantsHelp(process.argv.slice(2))) {
    write(hubUsage());
    return;
  }

  const loaded = loadHubConfig({ argv: process.argv.slice(2), env: process.env });

  if (!loaded.ok) {
    for (const problem of loaded.problems) process.stderr.write(`agentplex hub: ${problem}\n`);
    process.stderr.write(`\n${hubUsage()}\n`);
    process.exitCode = EXIT_BAD_CONFIGURATION;
    return;
  }

  const config = loaded.config;
  // The hub logs on stdout, because that is what a supervisor collects.
  const logger = createLogger(config.logLevel, jsonLineSink(write, systemClock));

  let runtime;
  try {
    runtime = await startHubRuntime(config, {
      logger,
      ids: randomIdGenerator,
      openDatabase: (path) => createSqliteDatabase(path),
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      migrationFileSystem: nodeMigrationFileSystem,
      // The one place the client's files are read off a disk -- and, when the
      // client package is not installed here, the one place that is said out
      // loud instead of guessed at. A hub with no client still owns the
      // database, still pairs servers and still answers its health check; what
      // it does not do is claim to serve a page it does not have.
      webAssets: WEB_ROOT.ok
        ? createNodeWebAssets(WEB_ROOT.root)
        : missingWebPackage(WEB_ROOT.reason),
      // The one place the local server's identity file is read off a disk,
      // through the same seam the server reads it with.
      files: nodeStoreFileSystem,
      // The only place a secret is generated: every websocket ticket the hub
      // hands a client. The hub's own client token is not among them -- that
      // one is typed by a person, so it arrives as configuration.
      tokens: randomTokenMinter,
      // The one place a real websocket is opened from this side. The hub
      // dials; nothing dials it. TLS verification is Node's own against the
      // system trust store, which is why there is no certificate decision
      // being made anywhere in this process.
      dialer: createWebSocketDialer(),
      // The one place a UDP socket can be opened: a hub binds the discovery
      // port whenever it runs, because hearing a machine announce itself costs
      // nothing and grants nothing.
      discovery: createNodeBeaconSource(logger),
      timers: systemTimers,
      clock: systemClock,
    });
  } catch (error) {
    logger.error('agentplex hub failed to start', { error: String(error) });
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
