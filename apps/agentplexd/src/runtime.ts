import type { Config } from './config/config.js';
import type { OperationRegistry } from './server/operations/operation-registry.js';
import type { ProviderPreflight, ProviderRegistry, StoreFileSystem } from '@agentplex/providers';
import type { BeaconNetwork } from './server/server-beacon.js';
import { startSessionServer, type SessionServer } from './server/server.js';
import type { TerminalManager } from './server/terminal-manager.js';
import type { Clock, IdGenerator, Logger, Timers, TokenMinter } from '@agentplex/node-shared';

/**
 * Composition of the server from a configuration.
 *
 * Everything the process supplies -- the disk, the logger, the id source --
 * arrives as a dependency, so the whole thing can be started in a test against
 * fakes and shut back down.
 */
export interface RuntimeDependencies {
  readonly logger: Logger;
  readonly ids: IdGenerator;
  /** The store volumes, injected so that a test runs on a volume it wrote down. */
  readonly storeFileSystem: StoreFileSystem;
  /**
   * Where a secret comes from: the pairing token on a first start.
   *
   * Injected rather than imported for the reason the id source is, and one
   * more: a test that asserts on a handshake needs to know the value, and a
   * seam is how it does that without the entropy being weaker in the build
   * anyone actually runs.
   */
  readonly tokens: TokenMinter;
  /**
   * The provider adapters this process runs with.
   *
   * Built in `main` rather than imported here, so that a test can start the
   * whole runtime against a store of fixtures without a real Claude Code
   * transcript existing anywhere, and so that "which providers does this build
   * drive" is one visible line in the entrypoint.
   */
  readonly providers: ProviderRegistry;
  /**
   * How the server finds out at boot what those adapters can actually start on
   * this machine.
   *
   * Injected for the same reason the operations are, and it is the same
   * constraint underneath: it resolves programs against the search path a child
   * of this process gets, and `main` is the only place allowed to know what
   * that is. A test drives the whole runtime against a search path and a
   * process table it wrote down, with nothing on the machine consulted.
   */
  readonly preflight: ProviderPreflight;
  /**
   * The terminal manager the server starts sessions on, and the supervisor
   * underneath it. Injected for the same reason the providers are: a test
   * starts the whole runtime without forking anything, and the one place a real
   * pty is opened stays visible in `main`. It is built there rather than here
   * because its cap is configuration, and only `main` has read the config.
   */
  readonly terminals: TerminalManager;
  /**
   * The operation registry: every child that is not a pty.
   *
   * Injected for the same reason the terminals are. The runner underneath it
   * fixes the environment children inherit, and `main` is the only place
   * allowed to read this process's environment; a registry built here would
   * have to reach for `process.env` two layers below the entrypoint.
   */
  readonly operations: OperationRegistry;
  /**
   * What the server would announce itself on, if it is configured to.
   *
   * Supplied whatever the configuration says, and consulted only when it says
   * `announce`: the process owns the one place a UDP socket can be opened, and
   * whether that capability is used is a setting rather than a fact about the
   * build. A test drives the whole runtime without a network on the machine.
   */
  readonly beacon: BeaconNetwork;
  readonly timers: Timers;
  readonly clock: Clock;
}

export interface Runtime {
  readonly server: SessionServer;
  stop(): Promise<void>;
}

export async function startRuntime(
  config: Config,
  dependencies: RuntimeDependencies,
): Promise<Runtime> {
  const {
    logger,
    ids,
    storeFileSystem,
    tokens,
    providers,
    preflight,
    terminals,
    operations,
    beacon,
    timers,
    clock,
  } = dependencies;

  const server = await startSessionServer({
    logger,
    ids,
    host: config.host,
    port: config.server.port,
    storePaths: config.server.storePaths,
    storeFileSystem,
    identityPath: config.server.identityPath,
    tokens,
    providers,
    preflight,
    terminals,
    operations,
    clock,
    timers,
    // The setting decides, in the one place that has read it. A server that
    // was not asked to announce is handed no socket to do it with.
    announce: config.server.announce ? beacon : null,
  });

  logger.info('agentplexd started', { role: config.role });

  let stopped = false;
  return {
    server,
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop();
      logger.info('agentplexd stopped');
    },
  };
}
