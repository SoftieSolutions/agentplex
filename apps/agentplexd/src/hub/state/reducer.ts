import type {
  ServerRegistrationId,
  SessionDescriptor,
  SessionHold,
  SessionHolder,
  SessionRef,
  StoreId,
} from '@agentplex/protocol';
import type { Logger } from '../../shared/logger.js';
import { countsTowardAttention } from '../connections/attention.js';
import type { ServerConnectionReport } from '../connections/server-connection.js';
import { chooseReportedSession, type ReportedSession } from './session-selection.js';

/**
 * What every connected server reports, merged into one state.
 *
 * v1 did this merge in the browser, once per open tab, which meant two tabs
 * could disagree and neither could be asked why. Here it happens once, in the
 * one process that can see every server at once, and what comes out is a
 * snapshot -- the whole of what the hub believes, not a stream of edits to it.
 *
 * Three rules, and they are the ticket:
 *
 *   * A session is `{ storeId, sessionId }` and never the machine. Rows are
 *     filed under the store the reporting server was speaking for.
 *   * Two servers with the same volume mounted are one store: one session
 *     list, with the set of attached servers as a live fact beside it. Not two
 *     stores that happen to share a name, and not one store listed twice.
 *   * A row is replaced whole. Never field by field, because a row built out
 *     of two reports describes a session that exists on no disk anywhere, and
 *     nothing downstream could tell that it did.
 *
 * None of this is persisted, and that is the decision rather than an omission.
 * What is durable already is: the pairing, the store anchor row, and the last
 * time each server was actually connected (migrations 0002 and 0003). What is
 * here is a claim about *now* -- these sessions, on these machines, reachable
 * this second -- and every column in a database outlives the process that
 * wrote it. A sessions table read back after a crash would present the
 * sessions of a machine nobody is connected to as current, which is exactly
 * the over-claim the stale label exists to prevent. Disk owns session content;
 * the next scan rebuilds this in full.
 */

/** One server's whole view of one store's sessions, as of one scan. */
export interface ServerSessionReport {
  readonly registrationId: ServerRegistrationId;
  /**
   * The store this report is about, which is what its rows get filed under.
   *
   * On the report rather than taken from each descriptor: a server speaks for
   * one store at a time, and a descriptor naming a different one is that row
   * disagreeing with its own envelope. Trusting the descriptor there would let
   * one server put sessions into a store it has nothing to do with.
   */
  readonly storeId: StoreId;
  /**
   * Every session that server can currently see in that store. A whole list,
   * never a delta: what is absent from it is absent from that server's view.
   */
  readonly sessions: readonly SessionDescriptor[];
  /**
   * The sessions that server has a live process for, in this store.
   *
   * A separate list rather than a flag on a descriptor, because it is a
   * different kind of claim. A descriptor is a reading of a transcript, and two
   * servers on one volume read the same one; a hold is a fact about one
   * machine's own processes, and only that machine can state it. Merging them
   * would let the reducer pick a reading from one server and silently carry the
   * other's liveness with it.
   *
   * It is also what makes one live process per session enforceable at the hub:
   * the hub is the only thing that sees every server attached to a store, and
   * it can only refuse a second start if the servers say what they are running.
   */
  readonly holding: readonly SessionHold[];
  readonly reportedAt: number;
}

/** One session, as the hub shows it: some server's row, whole, plus who saw it. */
export interface SessionRow {
  readonly ref: SessionRef;
  /** Exactly the descriptor the chosen server sent. Never assembled. */
  readonly descriptor: SessionDescriptor;
  /** Which server's reading this is. */
  readonly source: ServerRegistrationId;
  /** Every server that reported this session, sorted. Usually one; two is a shared volume. */
  readonly reportedBy: readonly ServerRegistrationId[];
  /** When the chosen reading arrived. */
  readonly reportedAt: number;
  /**
   * Whether any server that reported this session is connected right now.
   *
   * False is the labelled state, not a deletion: the row is still shown, and
   * this is what says it cannot presently be acted on.
   */
  readonly reachable: boolean;
  /**
   * The server running this session right now, and whether it may be stopped,
   * or `null` when nobody reports holding it.
   *
   * Not derived from the chosen descriptor's status: `working` is a reading of
   * a transcript that any server with the volume mounted can make, and it says
   * nothing about which machine has the process. This comes from the holding
   * server's own account of what it is running, which is the only source that
   * can answer it.
   */
  readonly holder: SessionHolder | null;
}

/** One store, however many servers have it mounted. */
export interface StoreView {
  readonly storeId: StoreId;
  /**
   * The servers with this store mounted, right now. A live fact and the reason
   * a store is not duplicated per machine: N servers attached, one store.
   */
  readonly servers: readonly ServerConnectionReport[];
  /** Whether at least one attached server is connected. */
  readonly reachable: boolean;
  /**
   * When the hub lost its last live route to this store, or `null` when it has
   * one or has never had one. The age on the stale label.
   */
  readonly unreachableSince: number | null;
  /**
   * The last moment the hub actually held a connection to a server with this
   * store mounted, `null` if it never has. Survives a restart, because it is
   * read back off the pairing row rather than kept here.
   */
  readonly lastReachableAt: number | null;
  /** One list for the store, deduplicated across its servers, sorted by session id. */
  readonly sessions: readonly SessionRow[];
}

/** The whole of what the hub believes, at one version. */
export interface HubStateSnapshot {
  /**
   * Bumped once per change that actually changed something.
   *
   * The change signal's payload and a broadcast's idempotence key: a client
   * that already has this version has the whole state, because there are no
   * deltas to have missed.
   */
  readonly version: number;
  readonly stores: readonly StoreView[];
  /** Every paired server the hub is supervising, sorted by label. */
  readonly servers: readonly ServerConnectionReport[];
}

export interface ReducerDependencies {
  readonly logger: Logger;
}

export interface Reducer {
  /**
   * Takes a connectivity change from the supervisor. This is the seam
   * `ServerConnectionDependencies.onChange` was left for.
   *
   * A `stopped` server is forgotten along with everything it reported: the
   * pairing has been revoked or removed, and a revoked machine's rows are not
   * stale data waiting for it to come back, they are claims nothing stands
   * behind any more. An unreachable one keeps every row it ever reported.
   */
  applyConnection(report: ServerConnectionReport): void;
  /**
   * Takes one server's whole view of one store.
   *
   * Answers whether it was accepted. A report is refused when the hub holds no
   * connection for that server, or when that server has not said it has the
   * store mounted -- in both cases the hub would be publishing sessions on the
   * word of something it cannot place.
   */
  applySessions(report: ServerSessionReport): boolean;
  /** The whole state. The same object until something changes. */
  snapshot(): HubStateSnapshot;
  /**
   * Called after every change, with the state that resulted. Returns the
   * unsubscribe.
   *
   * A listener that throws costs itself: one client's socket dying mid-send
   * must not stop the others being told, nor leave the state half-updated.
   */
  subscribe(listener: (snapshot: HubStateSnapshot) => void): () => void;
}

/** One server's last report for one store. */
interface StoredReport {
  readonly sessions: readonly SessionDescriptor[];
  /**
   * The sessions that server has a live process for, in this store.
   *
   * A separate list rather than a flag on a descriptor, because it is a
   * different kind of claim. A descriptor is a reading of a transcript, and two
   * servers on one volume read the same one; a hold is a fact about one
   * machine's own processes, and only that machine can state it. Merging them
   * would let the reducer pick a reading from one server and silently carry the
   * other's liveness with it.
   *
   * It is also what makes one live process per session enforceable at the hub:
   * the hub is the only thing that sees every server attached to a store, and
   * it can only refuse a second start if the servers say what they are running.
   */
  readonly holding: readonly SessionHold[];
  readonly reportedAt: number;
}

export function createReducer(dependencies: ReducerDependencies): Reducer {
  const logger = dependencies.logger.child({ part: 'reducer' });

  const connections = new Map<ServerRegistrationId, ServerConnectionReport>();
  const reports = new Map<ServerRegistrationId, Map<StoreId, StoredReport>>();
  const listeners = new Set<(snapshot: HubStateSnapshot) => void>();

  let version = 0;
  let built: HubStateSnapshot | null = null;

  const build = (): HubStateSnapshot => {
    const stores = buildStoreViews(connections, reports);
    return {
      version,
      stores,
      servers: [...connections.values()].sort(byLabel),
    };
  };

  const snapshot = (): HubStateSnapshot => {
    if (built === null || built.version !== version) built = build();
    return built;
  };

  const changed = (): void => {
    version += 1;
    const state = snapshot();
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        logger.warn('a state listener threw', { problem: String(error) });
      }
    }
  };

  return {
    applyConnection(report: ServerConnectionReport): void {
      const previous = connections.get(report.registrationId);

      if (report.phase === 'stopped') {
        if (previous === undefined) return;
        connections.delete(report.registrationId);
        reports.delete(report.registrationId);
        logger.info('server gone; its rows with it', { registrationId: report.registrationId });
        changed();
        return;
      }

      if (previous !== undefined && sameConnection(previous, report)) return;
      connections.set(report.registrationId, report);

      // A server that came back with a volume unmounted is not reporting stale
      // sessions for it, it has stopped speaking for that store entirely. The
      // rows go rather than lingering as a store nothing is attached to.
      const held = reports.get(report.registrationId);
      if (held !== undefined) {
        const mounted = new Set(report.stores);
        for (const storeId of [...held.keys()]) {
          if (!mounted.has(storeId)) held.delete(storeId);
        }
      }

      changed();
    },

    applySessions(report: ServerSessionReport): boolean {
      const connection = connections.get(report.registrationId);
      if (connection === undefined) {
        logger.warn('sessions reported by a server the hub is not connected to', {
          registrationId: report.registrationId,
          storeId: report.storeId,
        });
        return false;
      }

      if (!connection.stores.includes(report.storeId)) {
        logger.warn('sessions reported for a store this server has not mounted', {
          registrationId: report.registrationId,
          storeId: report.storeId,
        });
        return false;
      }

      // Filed under the report's store, and a descriptor that names another
      // one costs itself rather than the list: an unreadable item in a listing
      // is not the listing being wrong.
      const belonging = report.sessions.filter((descriptor) => {
        if (descriptor.storeId === report.storeId) return true;
        logger.warn('session claims a store its report was not about', {
          registrationId: report.registrationId,
          storeId: report.storeId,
          claimed: descriptor.storeId,
          sessionId: descriptor.sessionId,
        });
        return false;
      });

      const held = reports.get(report.registrationId) ?? new Map<StoreId, StoredReport>();
      reports.set(report.registrationId, held);

      const previous = held.get(report.storeId);
      // Servers report on a schedule. A store nobody touched between two scans
      // is a report that says the same thing, and waking every client for it
      // would make the version number mean "a server spoke" rather than
      // "something changed". The held report is left exactly as it was, so
      // that `reportedAt` keeps saying when these rows last actually changed
      // rather than when a scan last confirmed they had not.
      if (
        previous !== undefined &&
        sameSessions(previous.sessions, belonging) &&
        sameHolds(previous.holding, report.holding)
      ) {
        return true;
      }

      held.set(report.storeId, {
        sessions: belonging,
        holding: report.holding,
        reportedAt: report.reportedAt,
      });
      changed();
      return true;
    },

    snapshot,

    subscribe(listener: (snapshot: HubStateSnapshot) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

function byLabel(left: ServerConnectionReport, right: ServerConnectionReport): number {
  if (left.label !== right.label) return left.label < right.label ? -1 : 1;
  return left.registrationId < right.registrationId ? -1 : 1;
}

/**
 * Whether two connectivity reports say the same thing.
 *
 * Field by field rather than by identity, because the supervisor builds a
 * fresh value on every read. The mounted list is compared in order, which is
 * the database's order and stable for the same set of stores.
 */
function sameConnection(left: ServerConnectionReport, right: ServerConnectionReport): boolean {
  return (
    left.serverId === right.serverId &&
    left.label === right.label &&
    left.address === right.address &&
    left.phase === right.phase &&
    left.connectedSince === right.connectedSince &&
    left.staleSince === right.staleSince &&
    left.lastConnectedAt === right.lastConnectedAt &&
    left.failedAttempts === right.failedAttempts &&
    left.problem === right.problem &&
    left.staleReason === right.staleReason &&
    left.stores.length === right.stores.length &&
    left.stores.every((storeId, index) => storeId === right.stores[index])
  );
}

/**
 * Whether a server is running exactly what it was running last time.
 *
 * Compared alongside the sessions rather than folded into them, because a hold
 * changing is a change a client must see even when every transcript reads the
 * same: a session that has just been stopped looks identical on disk for as
 * long as it takes the provider to write again, and the stop button has to go
 * away the moment the process does.
 */
function sameHolds(left: readonly SessionHold[], right: readonly SessionHold[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((hold, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      hold.sessionId === other.sessionId &&
      hold.stoppable === other.stoppable
    );
  });
}

/** Whether a scan found exactly what the previous one did, row for row. */
function sameSessions(
  left: readonly SessionDescriptor[],
  right: readonly SessionDescriptor[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((descriptor, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      descriptor.sessionId === other.sessionId &&
      descriptor.storeId === other.storeId &&
      descriptor.provider === other.provider &&
      descriptor.status === other.status &&
      descriptor.updatedAt === other.updatedAt &&
      descriptor.cwd === other.cwd &&
      descriptor.title === other.title
    );
  });
}

/**
 * Every store the hub can see, once each.
 *
 * The store set comes from what the servers say they have mounted, not from
 * what has reported sessions: a store with no sessions in it is still a store,
 * and a machine that is stale still has its volumes.
 */
function buildStoreViews(
  connections: ReadonlyMap<ServerRegistrationId, ServerConnectionReport>,
  reports: ReadonlyMap<ServerRegistrationId, ReadonlyMap<StoreId, StoredReport>>,
): readonly StoreView[] {
  const attached = new Map<StoreId, ServerConnectionReport[]>();
  for (const connection of connections.values()) {
    for (const storeId of connection.stores) {
      const servers = attached.get(storeId) ?? [];
      servers.push(connection);
      attached.set(storeId, servers);
    }
  }

  const views: StoreView[] = [];
  for (const [storeId, servers] of attached) {
    servers.sort(byLabel);
    const reachable = servers.some(countsTowardAttention);
    views.push({
      storeId,
      servers,
      reachable,
      unreachableSince: reachable ? null : lastOf(servers.map((server) => server.staleSince)),
      lastReachableAt: lastOf(
        servers.map((server) => server.connectedSince ?? server.lastConnectedAt),
      ),
      sessions: buildSessionRows(storeId, servers, reports),
    });
  }

  return views.sort((left, right) => (left.storeId < right.storeId ? -1 : 1));
}

/** The latest of the moments there are, or `null` when there are none. */
function lastOf(moments: readonly (number | null)[]): number | null {
  const known = moments.filter((moment): moment is number => moment !== null);
  return known.length === 0 ? null : Math.max(...known);
}

/**
 * One store's session list, unified across the servers that reported it.
 *
 * Every server's reading of a session is gathered, one is chosen whole, and
 * the rest are remembered only as "who else saw this" -- which is what makes
 * two servers on one volume read as one list rather than as duplicates.
 */
function buildSessionRows(
  storeId: StoreId,
  servers: readonly ServerConnectionReport[],
  reports: ReadonlyMap<ServerRegistrationId, ReadonlyMap<StoreId, StoredReport>>,
): readonly SessionRow[] {
  const readings = new Map<string, ReportedSession[]>();
  const holders = new Map<string, SessionHolder>();

  for (const server of servers) {
    const report = reports.get(server.registrationId)?.get(storeId);
    if (report === undefined) continue;

    const reachable = countsTowardAttention(server);
    // Only a server the hub is holding a connection to can be said to be
    // running anything. A stale machine's holds are claims about a process
    // nobody can presently reach, and offering a stop button aimed at one would
    // be offering a button that cannot work.
    if (reachable) {
      for (const hold of report.holding) {
        // First writer wins, and the servers are in label order, so two
        // machines both claiming one session resolve the same way on every
        // snapshot. It is the state the hub's own refusal exists to prevent;
        // the reducer's job when it happens anyway is to be stable about it.
        if (holders.has(hold.sessionId)) continue;
        holders.set(hold.sessionId, {
          server: server.registrationId,
          stoppable: hold.stoppable,
        });
      }
    }

    for (const descriptor of report.sessions) {
      const gathered = readings.get(descriptor.sessionId) ?? [];
      gathered.push({
        registrationId: server.registrationId,
        descriptor,
        reportedAt: report.reportedAt,
        reachable,
      });
      readings.set(descriptor.sessionId, gathered);
    }
  }

  const rows: SessionRow[] = [];
  for (const gathered of readings.values()) {
    const chosen = chooseReportedSession(gathered);
    rows.push({
      ref: { storeId, sessionId: chosen.descriptor.sessionId },
      descriptor: chosen.descriptor,
      source: chosen.registrationId,
      reportedBy: gathered.map((reading) => reading.registrationId).sort(),
      reportedAt: chosen.reportedAt,
      reachable: gathered.some((reading) => reading.reachable),
      holder: holders.get(chosen.descriptor.sessionId) ?? null,
    });
  }

  return rows.sort((left, right) =>
    left.descriptor.sessionId < right.descriptor.sessionId ? -1 : 1,
  );
}
