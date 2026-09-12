import {
  PROTOCOL_VERSION,
  sameReadiness,
  type ProviderReadiness,
  type ServerId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  type Clock,
  HTTP_TIMEOUTS,
  sendJson,
  startHttpServer,
  type HttpListener,
  type IdGenerator,
  type Logger,
  type Timers,
  type TokenMinter,
  createWebSocketListener,
} from '@agentplex/node-shared';
import { createDrain, drainingSessions } from './drain.js';
import { serveHubConnection, type HubConnection } from './hub-connection.js';
import type { OperationRegistry } from './operations/operation-registry.js';
import {
  type ConfiguredToken,
  type GrantFileSystem,
  type ProviderPreflight,
  type ProviderRegistry,
  ensureStores,
  openServerGrants,
  serverGrantsPath,
  type StoreFileSystem,
} from '@agentplex/providers';
import { announceServer, type BeaconNetwork } from './server-beacon.js';
import { ensureServerIdentity } from '@agentplex/providers';
import { createHubAudience } from './hub-audience.js';
import { sweepGrants } from './grant-sweep.js';
import { createSessionController } from './session-control.js';
import type { MachineLoadReader } from './machine-load.js';
import type { WorkingTree } from './working-tree.js';
import type { TerminalManager } from './terminal-manager.js';

/**
 * The server role.
 *
 * A session runner and nothing else: it holds no database, and it dials out to
 * nothing. The hub dials it. Milestone 2 gives it the one durable fact it
 * owns — the identity of each store it has mounted — which is what every
 * session id it later reports is scoped by. It also holds the one thing here
 * that starts processes, the PTY supervisor, because a shutdown that does not
 * reach the agents it started has not shut anything down.
 */

export interface SessionServerDependencies {
  readonly logger: Logger;
  readonly ids: IdGenerator;
  readonly host: string;
  readonly port: number;
  /** Store roots from configuration, already absolute and deduplicated. */
  readonly storePaths: readonly string[];
  readonly storeFileSystem: StoreFileSystem;
  /**
   * Where this server's own identity and pairing token live, absolute.
   *
   * Not in a store: a store is a volume two servers may mount at once, and an
   * identity written there would hand both of them the same name and secret.
   */
  readonly identityPath: string;
  /**
   * The disk under the grants file, which sits beside the identity file.
   *
   * A third filesystem seam, and not an oversight. The store seam reaches a
   * provider's volume and may never grow a write; the data root seam creates a
   * directory; this one replaces one file, atomically, because a reader that
   * meets half a grants file is a server that refuses every handshake.
   */
  readonly grantFileSystem: GrantFileSystem;
  /** Where the pairing token comes from the first time this server starts. */
  readonly tokens: TokenMinter;
  /**
   * The pairing token the deployment set, when it set one.
   *
   * When it is here it is the token and `tokens` above is never reached, and
   * when it is not, nothing about this server's first start has changed. It is
   * a separate dependency from the minter rather than a minter that returns a
   * constant, because the two are not the same fact: a minter is where entropy
   * comes from, and this is a decision somebody already took. Folding it in
   * would also lose the disagreement -- `ensureServerIdentity` has to be able
   * to tell a token it was handed from one it produced, or a file holding a
   * credential the operator thinks they replaced would be read straight past.
   */
  readonly serverToken: ConfiguredToken | undefined;
  /** The adapters this build can drive. An empty registry finds nothing and says nothing. */
  readonly providers: ProviderRegistry;
  /**
   * How this server finds out, at boot, what it can actually start.
   *
   * A dependency rather than something built here for the reason the operation
   * registry is one: it resolves programs against the environment children get,
   * and only `main` may read this process's environment.
   *
   * Run once, and its answer carried into every handshake. Not on a timer and
   * not per start: two child processes per provider on the path of every
   * session start would cost every user a probe to catch a machine somebody
   * reconfigured underneath a running service, which is not the failure this is
   * for. The failure it is for is a machine that was never provisioned, and
   * that one is true at boot and stays true.
   *
   * That is still the rule, and `refreshReadiness` does not reopen it. What it
   * adds is the case the rule left with no answer at all: the operator who has
   * just installed the provider, or just logged it in, and now wants the fleet
   * to know. A probe nobody asked for is the cost this paragraph refuses; a
   * probe an operator asked for is a probe somebody is waiting on. So the
   * trigger is a person and never a clock, a session, or a hub.
   */
  readonly preflight: ProviderPreflight;
  readonly clock: Clock;
  /**
   * The one thing on this server that starts processes.
   *
   * It is held here rather than made here so that shutdown can reach it. A
   * server that closes its port and leaves agents running has not stopped: the
   * processes keep the store's transcripts moving, the next server to start
   * finds sessions it did not launch and cannot drive, and on a laptop they
   * outlive the terminal that started them.
   *
   * Shutdown is also the only thing besides the cap that closes a terminal:
   * nothing here runs an idle timer, and a session whose last tab closed goes
   * on working.
   */
  readonly terminals: TerminalManager;
  /**
   * How long shutdown waits for the turns this server holds to end before it
   * kills them, in milliseconds.
   *
   * A value rather than a constant because the number it has to agree with is
   * in the systemd unit beside it. See `drain.ts` for what the wait is actually
   * against, and `config.ts` for why the two numbers are rendered from one.
   */
  readonly drainMs: number;
  /**
   * The one thing on this server that starts anything else.
   *
   * Every non-PTY child comes from here: a name, a parsed request, an argv this
   * process built, `shell: false`. The division with the terminals above is by
   * shape of process rather than by trust — an interactive session is a pty
   * that lives for hours and is written to, a one-shot operation is a program
   * that answers a question and exits — and neither of them takes an argv
   * element off the wire. What a launch plan is to the PTY path, an operation
   * is to this one.
   *
   * It is a dependency rather than something the server builds, because the
   * runner underneath it decides what environment children inherit, and only
   * `main` may read this process's environment.
   */
  readonly operations: OperationRegistry;
  /**
   * How a store scan learns what git says about the directories it read.
   *
   * Beside `operations` and not inside it, because they are different things:
   * the registry is the closed list of what a name may reach, and this is a
   * typed caller that already knows which operations it wants. Both are built
   * in `main` over the same runner, so what a child inherits is still decided
   * in exactly one place.
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
  readonly timers: Timers;
  /**
   * How this server announces itself on the local network, or `null` for one
   * that does not.
   *
   * Opt-in expressed as a type rather than a flag beside a socket: a server
   * that was not asked to announce is handed nothing to announce with, so
   * "announcing is off" and "a UDP socket is open" cannot both be true. The
   * hub's half of discovery is not symmetrical with this and is not meant to
   * be — it listens unconditionally, because hearing a beacon costs nothing
   * and grants nothing.
   */
  readonly announce: BeaconNetwork | null;
}

export interface SessionServer {
  readonly port: number;
  /** What this server calls itself to every hub that dials it. */
  readonly serverId: ServerId;
  /** The stores this server can speak for. A store it could not read is not in here. */
  readonly stores: readonly StoreDescriptor[];
  /**
   * What each provider turned out to be when this server last looked, as every
   * hub is told.
   *
   * At boot, unless somebody has asked for a re-read since. There is no age on
   * it, for the reason `store-report` carries no timestamp: what a reading is
   * worth is a question about this machine's clock, and the one answer that
   * would not need a clock -- "this is current" -- is the one thing it must
   * never claim.
   */
  readonly providers: readonly ProviderReadiness[];
  /**
   * Asks this machine again what its providers are, and tells every hub that
   * holds an answer if it changed.
   *
   * The one thing here that spends child processes without a hub or a user
   * having asked for a session, which is why nothing calls it but a signal an
   * operator sent. It never rejects: it is reached from a signal handler, and a
   * rejection there is an unhandled one.
   *
   * Returns the reading this server now holds -- the fresh one when the probe
   * answered, and the one it already had when the probe did not. A failed
   * refresh writes nothing, because the alternative is reporting that every
   * provider went `unknown` on a machine where nothing changed but this
   * server's ability to run a probe.
   */
  refreshReadiness(): Promise<readonly ProviderReadiness[]>;
  /**
   * Drains and then stops: no new sessions, every turn given until the budget
   * runs out to reach a boundary, and then whatever is left is killed anyway.
   */
  stop(): Promise<void>;
  /**
   * Abandons the wait a `stop` is in the middle of. Safe before one and after.
   *
   * A second signal is the operator saying they are done waiting, and this is
   * what that means: the drain answers at once, the terminals still mid-turn
   * are killed, and the shutdown finishes the way it always did.
   */
  stopWaiting(): void;
}

export async function startSessionServer(
  dependencies: SessionServerDependencies,
): Promise<SessionServer> {
  const {
    host,
    port,
    ids,
    storePaths,
    storeFileSystem,
    identityPath,
    grantFileSystem,
    tokens,
    serverToken,
    providers,
    preflight,
    clock,
    terminals,
    drainMs,
    operations,
    workingTree,
    machineLoad,
    timers,
    announce,
  } = dependencies;
  const logger = dependencies.logger.child({ role: 'server' });

  // Before anything is served, and fatally. A store that cannot be read costs
  // itself; an identity that cannot be read costs the whole server, because
  // every alternative is worse: minting a fresh one would present this machine
  // to the hub as a server nobody has paired, with a token the user has never
  // seen, and the only symptom would be a paired server that quietly stopped
  // answering.
  const identity = await ensureServerIdentity(identityPath, {
    files: storeFileSystem,
    ids,
    tokens,
    configuredToken: serverToken,
  });
  if (!identity.ok) {
    throw new Error(`agentplex cannot establish its server identity: ${identity.problem}`);
  }

  // The path, never the token. The file is where the operator reads the token
  // to paste into the hub, and a secret in a log line is one that has to be
  // rotated. `logger.ts` would redact a `token` field anyway; not gathering it
  // is the version that does not depend on remembering.
  //
  // Three messages rather than two, because "minted" now over-claims on one of
  // the three paths. A deployment that supplied the token has no new secret to
  // go and read, and a line telling it one was just minted would send somebody
  // to a file for a value they put there themselves.
  logger.info(identityMessage(identity.minted, serverToken !== undefined), {
    serverId: identity.identity.serverId,
    identityPath,
  });

  // The grants this server will answer to, and grant zero the first time.
  //
  // Fatal for the reason the identity is. Coming up with an empty grants file
  // would unpair every hub silently; coming up ignoring one it could not read
  // would leave a server answering to credentials the operator believes they
  // withdrew. Both are the failure nobody sees, and this is the moment it can
  // be said out loud.
  const grantsPath = serverGrantsPath(identityPath);
  const grants = await openServerGrants(grantsPath, identity.identity.token, {
    files: grantFileSystem,
    ids,
    tokens,
    clock,
    // The one sentence about a disagreeing hub id, written where the log lines
    // about connections already are. The store records it and decides nothing
    // with it; a hub whose database was rebuilt is still the same operator.
    onWitness: ({ grantId, hubId, disagrees, unrecorded }) => {
      if (disagrees) {
        logger.warn('a grant is being used by a different hub id than the one it first saw', {
          grantId,
          hubId,
        });
      }
      if (unrecorded !== null) {
        logger.warn('could not record a handshake against its grant', { grantId, unrecorded });
      }
    },
  });
  if (!grants.ok) {
    throw new Error(`agentplex cannot read this server's grants: ${grants.problem}`);
  }
  // The path and the count, never a verifier. What an operator needs from this
  // line is where the file is and whether the upgrade wrote grant zero.
  logger.info(grants.migrated ? 'grants file written with grant zero' : 'grants loaded', {
    grantsPath,
  });

  // What this build can run, said out loud at boot. The registry is closed, so
  // this line is the complete answer to "what can this server start", and an
  // operator reading it against a machine that has no `git` learns why an
  // operation refuses before anybody asks.
  logger.info('operations registered', {
    operations: operations.operations.map(({ name }) => name),
  });

  // A store that cannot be read costs itself and nothing else: the server
  // comes up, reports the stores it does have, and says out loud which one it
  // dropped and why. Refusing to start would take every healthy store offline
  // over one bad mount, and minting a fresh id over the bad one would quietly
  // orphan every session already filed under the old identity.
  const resolved = await ensureStores(storePaths, { files: storeFileSystem, ids });
  const stores: StoreDescriptor[] = [];
  for (const result of resolved) {
    if (result.ok) {
      stores.push(result.store);
      logger.info('store mounted', { ...result.store, minted: result.minted });
    } else {
      logger.error('store unavailable', { path: result.path, problem: result.problem });
    }
  }

  // What this machine can actually start, resolved once, before a hub can ask.
  // A provider that is not here is not a reason to refuse to start: this server
  // may have three others that work and stores full of sessions to report, and
  // an unusable provider costs itself. What it must not do is stay quiet about
  // it, because on a pty the same fact arrives later as a session that appears
  // and vanishes.
  //
  // `let`, because an operator can ask for it again. Every use of it below
  // reads it at the moment it is needed rather than capturing it, so a
  // connection accepted after a re-read hands the hub the reading this server
  // holds now.
  const reportUnusable = (reading: readonly ProviderReadiness[]): void => {
    for (const provider of reading) {
      if (provider.state === 'ready') continue;
      logger.warn('provider unusable', { ...provider });
    }
  };

  let readiness = await preflight.run(providers);
  reportUnusable(readiness);

  // The one thing here that turns a store id and a provider name into a running
  // agent. It is built once and outlives every hub connection: a socket comes
  // and goes, and the sessions this server started go on running across both.
  const sessions = createSessionController({
    stores,
    providers,
    terminals,
    workingTree,
    clock,
    logger,
  });

  // One pass over every mounted store, so that a misconfigured store path is
  // discovered at boot rather than the first time somebody opens the client.
  // It is a log line and not a field on the returned server on purpose: a
  // snapshot taken at startup goes stale the moment a session writes, and a
  // stale list presented as current is the failure the watcher exists to
  // avoid. It goes through the same scan a hub is answered with, so there is
  // one code path that reads a store rather than two that can disagree.
  for (const store of stores) {
    const scanned = await sessions.report(store.storeId);
    logger.info('store scanned', {
      storeId: store.storeId,
      sessions: scanned?.sessions.length ?? 0,
      providers: providers.providers,
    });
  }

  /**
   * The hubs dialled in right now, as connections rather than as an audience.
   *
   * Two sets, deliberately, because they answer two different questions. The
   * audience below is what a *fact about a store* is told to, and it is keyed
   * by grant because that is what a revocation names. This is what a fact about
   * *this process* -- it is draining, it has re-read its providers -- is told
   * to, and neither of those is a frame the audience carries: one is a
   * `server-draining` and the other is a close.
   *
   * It is pruned as connections are accepted rather than as they close, because
   * a `HubConnection` says what state it is in and does not offer a hook for the
   * end of one. Every dial drops whatever ended since the last dial, so what
   * this holds is the live connections and the churn since the most recent one.
   */
  const connections = new Set<HubConnection>();

  // Every hub connected at once, which is what makes a stop by one of them
  // something the others are told about. It outlives each connection: a socket
  // comes and goes and the set is the server's.
  const audience = createHubAudience({
    sessions,
    logger,
    // A socket that closed is a watcher that is gone, and it is not there to
    // call the detach it was handed. Without this a terminal nobody can see
    // stays pinned against eviction for the life of the process.
    onLeave: (member) => terminals.release(member.connectionId),
  });

  // The one thing a hub can do with this server before it has proved itself:
  // open a socket. Everything past that is the handshake's to allow.
  const hubs = createWebSocketListener({
    onConnection: (socket) => {
      for (const ended of connections) if (ended.state === 'closed') connections.delete(ended);
      connections.add(
        serveHubConnection(socket, {
          connectionId: ids.newId(),
          identity: identity.identity,
          grants: grants.store,
          audience,
          sessions,
          // The same terminals the controller starts sessions into. A
          // connection only ever holds subscriptions to them, and hands those
          // back when the socket goes; the processes themselves outlive every
          // hub that dials.
          terminals,
          // Read at connection time rather than captured, so a hub that dials
          // after a store came back reachable is told what is mounted now.
          stores,
          providers: readiness,
          // Sampled when this connection is pinged and at no other time, so a
          // server nobody has dialled reads nothing. The reader is the
          // server's and not the connection's: the counters are one machine's,
          // and two hubs asking are two questions about the same cpus.
          machineLoad,
          logger,
        }),
      );
    },
  });

  // Revocation reaching a connection that is already up. The handshake covers
  // the hub that reconnects; this covers the one that does not have to.
  const sweep = sweepGrants({ grants: grants.store, audience, timers, logger });

  const listener: HttpListener = await startHttpServer(
    port,
    host,
    (request, response) => {
      if (request.url === '/health') {
        sendJson(response, 200, {
          status: 'ok',
          role: 'server',
          protocolVersion: PROTOCOL_VERSION,
        });
        return;
      }
      sendJson(response, 404, { error: 'not found' });
    },
    HTTP_TIMEOUTS,
    // Same port as the health check: a server needs exactly one inbound port
    // reachable by the hub, and that is a promise to whoever opens the firewall.
    hubs.onUpgrade,
  );

  logger.info('server listening', {
    port: listener.port,
    serverId: identity.identity.serverId,
    stores: stores.length,
  });

  // Only once there is something to announce. The port comes from the listener
  // rather than from the setting, so a server started on port 0 announces the
  // port it actually got; announcing before the bind could name a port nothing
  // is on, and a beacon that is wrong is worse than one that is late by a
  // millisecond.
  const beacon = announceServer(announce, {
    host,
    port: listener.port,
    serverId: identity.identity.serverId,
    timers,
    logger,
  });

  /**
   * A re-read in flight, or `null`. Two asks in the same moment are one probe.
   *
   * Coalesced rather than queued, because what a second caller wants is a
   * current reading and that is exactly what the run already in flight is about
   * to produce. Queueing would turn a signal sent twice into two probes, which
   * is the cost this whole design is built to keep off any path somebody can
   * repeat.
   */
  let rereading: Promise<readonly ProviderReadiness[]> | null = null;

  /**
   * Whether `stop` has begun. A re-read after that point probes a machine this
   * process is about to stop speaking for.
   */
  let stopping = false;

  /**
   * The wait between "stop" and "everything is dead".
   *
   * Built here rather than in `stop` so that `stopWaiting` has something to
   * call before a shutdown has begun -- two signals arriving in the same
   * millisecond is exactly the case where an operator is in a hurry -- and so
   * that the thing it waits on is the same terminal manager everything else on
   * this server holds.
   */
  const drain = createDrain({
    terminals,
    // One scan of one store, which is the only part of a report the drain
    // wants: a status is derived by an adapter and handed to the terminal
    // holding the session, and nothing derives one unless somebody asks.
    observe: async (storeId) => void (await sessions.report(storeId)),
    timers,
    clock,
    logger,
    budgetMs: drainMs,
  });

  return {
    port: listener.port,
    serverId: identity.identity.serverId,
    stores,

    // A getter, because the reading can be taken again. A value captured here
    // would hand every later caller the answer from boot while the handshakes
    // carried a different one.
    get providers(): readonly ProviderReadiness[] {
      return readiness;
    },

    stopWaiting() {
      drain.stopWaiting();
    },

    refreshReadiness(): Promise<readonly ProviderReadiness[]> {
      if (stopping) {
        logger.info('not re-reading providers: this server is shutting down');
        return Promise.resolve(readiness);
      }
      if (rereading !== null) return rereading;

      const run = (async (): Promise<readonly ProviderReadiness[]> => {
        try {
          const reading = await preflight.run(providers);

          if (sameReadiness(readiness, reading)) {
            // The ordinary outcome, and the one that must cost nothing. A hub
            // holds this fact on its handshake, so redelivering it means ending
            // a connection -- and ending one to say what the other end already
            // knows would spend every watcher's subscription on no news.
            logger.info('providers re-read; nothing changed', {
              providers: reading.map(({ provider, state }) => `${provider}:${state}`),
            });
            return readiness;
          }

          if (stopping) {
            // A shutdown began while this was probing. The hubs have been told
            // this server is draining and their sockets stay up on purpose, so
            // that a client keeps seeing the last of its agent's output --
            // ending them now to deliver a fact about a machine that is going
            // away would take that away for nothing.
            logger.info('discarding a re-read: this server began shutting down during it');
            return readiness;
          }

          readiness = reading;
          reportUnusable(reading);
          logger.info('providers re-read; this machine has changed', {
            providers: reading.map(({ provider, state }) => `${provider}:${state}`),
          });

          // Every hub holding the old answer, told the only way there is to
          // tell it: the handshake is where a server states what it is, and a
          // handshake that is no longer true is a connection to end rather than
          // a frame to invent. See `hub-connection.ts` for what that costs and
          // why the sessions do not notice.
          for (const connection of connections) {
            if (connection.state === 'closed') {
              connections.delete(connection);
              continue;
            }
            connection.rehandshake('this server has re-read what its providers are');
          }

          return readiness;
        } catch (error) {
          // The preflight's contract says it never rejects, and this is here
          // anyway: the caller is a signal handler, where a broken promise is
          // an unhandled rejection rather than a failed refresh. The reading
          // this server had stands, which is the direction that does not
          // over-claim -- nothing was learned, so nothing is reported.
          logger.error('could not re-read what this machine can run', {
            problem: String(error),
          });
          return readiness;
        } finally {
          // Unconditionally, and it cannot clear somebody else's run: a new one
          // is only ever made while this is `null`, so the run clearing it here
          // is the only one there has been since it was set.
          rereading = null;
        }
      })();

      rereading = run;
      return run;
    },

    async stop() {
      // Before anything slow, so that a re-read racing a shutdown is refused
      // rather than left probing a machine this process is done speaking for.
      stopping = true;
      // The beacon first, and before anything slow: every announcement from
      // here on would be inviting a hub to dial a server that is going away.
      beacon?.stop();
      // The sweep next, because a pending timer is a process that will not
      // exit, and there is nothing left for it to revoke access to.
      sweep.stop();
      // Then nothing new. This is what makes the wait below terminate at all:
      // a drain that is still accepting starts is not draining. It closes
      // nothing, which is the point -- the agents already running go on
      // working for as long as the budget allows.
      terminals.seal();

      const held = drainingSessions(terminals);
      // Said before the waiting rather than after it, because the whole value
      // of saying it is that somebody watching a session learns it is closing
      // while it is still closing. The sockets stay up through the drain for
      // the same reason: a client keeps seeing the last of its agent's output.
      for (const connection of connections) connection.announceDraining(drainMs, held);
      logger.info('draining', { sessions: held.length, graceMs: drainMs });

      const drained = await drain.run();

      // Whatever the drain did not release, killed. Closing the listener only
      // stops new work arriving; anything still running would go on writing
      // into the store with nothing left to watch it, and on a laptop it would
      // outlive the terminal that started it.
      terminals.closeAll();
      // Then the hub sockets: an upgraded connection is not an HTTP request,
      // so closing the listener does not reach it, and a live websocket would
      // hold the process open after everything it could ask about had stopped.
      hubs.close();
      await listener.close();
      // `killed` is the count this line used to carry, and it now means what it
      // says: sessions that were still mid-turn when the waiting stopped,
      // rather than every session that was running.
      logger.info('server stopped', { ...drained });
    },
  };
}

/**
 * Which of the three things this boot did about the identity file.
 *
 * A function rather than a nested ternary at the call site, and outside
 * `startSessionServer` because it needs nothing from it. What it is careful
 * about is the second argument: it says whether a token was configured, never
 * what it was, so no caller can accidentally pass the secret into a log
 * message by passing the wrong thing here.
 */
function identityMessage(minted: boolean, configured: boolean): string {
  if (!minted) return 'server identity loaded';
  return configured
    ? 'server identity written with the configured pairing token'
    : 'server identity minted';
}
