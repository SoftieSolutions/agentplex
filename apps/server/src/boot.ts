import type { ServerConfig } from './config.js';
import { ensureDataRoot, type DataRootFileSystem } from './data-root.js';
import type { OperationRegistry } from './operations/operation-registry.js';
import type { ProjectFileSystem } from './project-files.js';
import type {
  GrantFileSystem,
  ProviderPreflight,
  ProviderRegistry,
  StoreFileSystem,
} from '@agentplex/providers';
import type { BeaconNetwork } from './server-beacon.js';
import { startSessionServer, type SessionServer } from './server.js';
import type { MachineLoadReader } from './machine-load.js';
import type { WorkingTree } from './working-tree.js';
import type { TerminalManager } from './terminal-manager.js';
import type { Clock, IdGenerator, Logger, Timers, TokenMinter } from '@agentplex/node-shared';
import type { ProviderReadiness } from '@agentplex/protocol';

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
   * The disk under this server's own data root, which is a different seam from
   * the store volumes above and not an oversight.
   *
   * A store is read and never created; the data root is created by this
   * process and has to be proved writable before anything relies on it.
   * Folding the two into one interface would put a `mkdir` on the seam that
   * reaches a provider's directory, which is the one thing `data-root.ts` says
   * must never happen.
   */
  readonly dataRootFileSystem: DataRootFileSystem;
  /**
   * The disk under the grants file, beside the identity file.
   *
   * A third seam rather than a method on either of the two above, and for the
   * reason the data root got its own: this one replaces a file atomically, and
   * putting a replace on the seam that reaches a provider's volume is the one
   * thing `data-root.ts` says must never happen.
   */
  readonly grantFileSystem: GrantFileSystem;
  /**
   * The disk under the project file store, below the data root.
   *
   * A fourth seam, and for the reason each of the others is its own: this
   * one replaces files whole and lists folders, and neither belongs on the
   * seam that makes the data root, whose one job is a `mkdir` it has to be
   * able to refuse. It is handed the root the data root seam ensured, so a
   * test that says "this folder cannot be made" is describing this disk and
   * not the one above it.
   */
  readonly projectFiles: ProjectFileSystem;
  /**
   * Where a secret comes from when nothing supplied one: the pairing token on
   * a first start.
   *
   * Injected rather than imported for the reason the id source is, and one
   * more: a test that asserts on a handshake needs to know the value, and a
   * seam is how it does that without the entropy being weaker in the build
   * anyone actually runs.
   *
   * It is a dependency and not a setting, and the token a deployment sets is a
   * setting and not a dependency, which is the right way round: one is a
   * capability the process supplies and the other is a decision the operator
   * took. `config.serverToken` reaches the identity file through the same call
   * as this, and when it is there this is never asked.
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
   * The typed callers of operations on the report path: what git says about a
   * session's directory, which branch is checked out and what is uncommitted.
   *
   * Injected for the same reason the registry is, and over the same runner.
   */
  readonly workingTree: WorkingTree;
  /**
   * How this machine reads its own cpus, for the answer to a hub's ping.
   *
   * Injected rather than reached for, because a test that could not write the
   * counters down would have to assert on whatever the machine running it
   * happened to be doing. It is here beside the operations for the same reason
   * they are here: `main` is where this process's view of the outside world is
   * assembled, and nothing below it goes looking on its own.
   */
  readonly machineLoad: MachineLoadReader;
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
  /** Drains, then stops. Calling it twice is safe; the second call answers at once. */
  stop(): Promise<void>;
  /**
   * A second signal: stop waiting for turns to end and kill what is left.
   *
   * Separate from `stop` rather than an argument to it, because it arrives
   * while the first call is still running and there is nothing to hand it to.
   */
  stopWaiting(): void;
  /**
   * A third signal, and the only one that is not about stopping: re-read what
   * this machine's providers are, and tell the hubs if the answer moved.
   *
   * Here beside the other two because it arrives the same way -- something
   * outside this process asking for something while it runs -- and because
   * `main` is where a signal is turned into a call. It never rejects.
   */
  refreshReadiness(): Promise<readonly ProviderReadiness[]>;
}

export async function startRuntime(
  config: ServerConfig,
  dependencies: RuntimeDependencies,
): Promise<Runtime> {
  const {
    logger,
    ids,
    storeFileSystem,
    dataRootFileSystem,
    grantFileSystem,
    projectFiles,
    tokens,
    providers,
    preflight,
    terminals,
    operations,
    workingTree,
    machineLoad,
    beacon,
    timers,
    clock,
  } = dependencies;

  // First, and before a port is bound or an identity is minted. A server that
  // cannot write its own state is one that will forget something at its next
  // restart, and the only moment that can be said out loud is this one -- see
  // `data-root.ts` for why this refuses where an absent store path does not.
  // It throws rather than returning: `main` maps a startup failure to the exit
  // code a unit retries, and a disk can become writable without anybody
  // editing a settings file.
  const dataRoot = await ensureDataRoot(config.dataPath, dataRootFileSystem);
  if (!dataRoot.ok) throw new Error(dataRoot.problem);
  logger.info('data root ready', { path: dataRoot.path, created: dataRoot.created });

  const server = await startSessionServer({
    logger,
    ids,
    host: config.host,
    port: config.port,
    storePaths: config.storePaths,
    storeFileSystem,
    identityPath: config.identityPath,
    grantFileSystem,
    tokens,
    // The setting decides, in the one place that has read it. A deployment
    // that set none leaves the minter above as the only source, which is what
    // every machine with a disk of its own does.
    serverToken: config.serverToken,
    providers,
    preflight,
    terminals,
    drainMs: config.drainMs,
    operations,
    workingTree,
    machineLoad,
    // The root as ensured above and not as configured: the two are the same
    // string today, and the day they differ the server should be writing
    // where it proved it could.
    dataRoot: dataRoot.path,
    projectFiles,
    clock,
    timers,
    // The setting decides, in the one place that has read it. A server that
    // was not asked to announce is handed no socket to do it with.
    announce: config.announce ? beacon : null,
  });

  logger.info('agentplex server started');

  let stopped: Promise<void> | null = null;
  return {
    server,

    stopWaiting() {
      server.stopWaiting();
    },

    refreshReadiness() {
      return server.refreshReadiness();
    },

    stop() {
      // The promise and not a boolean, so that a second caller waits for the
      // first shutdown rather than being told it is already over. It is not
      // over: a drain takes time, and a caller that returned immediately would
      // let the process exit in the middle of one.
      stopped ??= (async () => {
        await server.stop();
        logger.info('agentplex server stopped');
      })();
      return stopped;
    },
  };
}
