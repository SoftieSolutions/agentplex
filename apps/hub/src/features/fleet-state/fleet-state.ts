import type {
  MachineState,
  NodeId,
  PendingApproval,
  ServerRegistrationId,
  SessionDescriptor,
  SessionHold,
  SessionHolder,
  SessionRef,
  StoreId,
} from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import { NOTHING_PENDING } from '../approvals/approvals.js';
import { UNATTENDED, type SessionAttention } from '../attention/attention.js';
import { countsTowardAttention, type ServerConnectionReport } from '../servers/servers.js';
import type { DiscoveredServer } from '../discovery/discovery.js';
import {
  sameApprovals,
  sameCandidates,
  sameConnection,
  sameHolds,
  sameSessions,
} from './equality.js';
import { toMachineState } from './machine-state.js';
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
 * One thing here is not a reading of a machine, and it is the exception that
 * states the rule: `attention` on a session row -- an acknowledgement moment
 * and a mute moment -- is the user talking, and no server knows it exists.
 * Its rows live in the attention feature, which owns the table; what is held
 * here is the current reading of them, applied through `applyAttention` the
 * same way a connection report is. It is here at all because the version below
 * means "a client holding this has the whole state", and a fact published on a
 * session row that could change without moving that number would be a
 * broadcast cache handing out the row as it was.
 *
 * None of the rest of this is persisted, and that is the decision rather than
 * an omission.
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

/**
 * The project a session sits in, as the hub currently reads its tree.
 *
 * Declared here rather than imported from the feature that owns projects, and
 * that is the decision: the catalogue imports this feature, so an import the
 * other way would be a cycle. What a session row needs of a project is a key to
 * navigate by and a word to draw, and both are copied onto the row at the
 * moment the reading is applied. A row is then readable without asking a second
 * feature anything, which is what keeps a screen from joining two answers taken
 * at two different instants.
 *
 * The name is a copy and not a reference for the same reason every other field
 * here is: this state is a claim about *now*, republished whole whenever it
 * changes, and a rename arrives as a new reading rather than as a mutation
 * nothing would have bumped the version for.
 */
export interface SessionProject {
  readonly nodeId: NodeId;
  readonly name: string;
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
  /**
   * What the user has said about this session: when its prompt was last
   * acknowledged, and whether it is muted.
   *
   * The one thing on this row that no server reported and no scan can rebuild.
   * It is merged in here rather than added by the projection because a row is
   * what the hub believes about a session, and a client reading attention off
   * a different object from the status it is about would be two answers a
   * screen has to join.
   */
  readonly attention: SessionAttention;
  /**
   * The project this session is in, or `null` when it is in none.
   *
   * The second thing on this row no server reported: a server watches a store
   * on disk and has never heard of a project, so asking it would be asking it
   * to invent an answer. The association is the hub's, derived from the same
   * tree the catalogue reads, and merged on here through `applyProjects` for
   * the reason attention is -- a fact published on a session row that could
   * change without moving the version would leave the broadcast's encode cache
   * handing out the row as it was.
   *
   * `null` is a session in no project and not a reading that has not happened
   * yet. Nothing downstream may treat it as a gap to fill in: the screens that
   * name a project fall back to what they said before it existed.
   */
  readonly project: SessionProject | null;
  /**
   * What an agent in this session is presently blocked on, oldest first, and
   * usually nothing.
   *
   * The third thing on this row that no scan rebuilds, and it is not persisted
   * for a stronger reason than attention is: on the other side of each of these
   * there is a process parked with a timeout running, so a list read back off
   * disk would offer a person questions nobody is waiting on any more. The
   * approvals feature holds them; what is here is the current reading, applied
   * through `applyApprovals` the way a connection report is.
   *
   * It is not a second source of status. `awaiting-permission` is what the
   * provider's own record of the session says, and a row with an empty list
   * beside that status is a provider that asks at its own terminal rather than
   * a contradiction.
   */
  readonly approvals: readonly PendingApproval[];
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
  /**
   * Every machine heard announcing itself on the network, sorted by server id.
   *
   * A second collection rather than a flag on a server, and that is the whole
   * of it: a paired server is something the user did, backed by a token in the
   * database and a supervisor dialling it, and a candidate is a datagram
   * anybody on the network can send. One list with a discriminator would put
   * the two one boolean apart, and every reader of the list would have to
   * remember to check it.
   *
   * It is held here rather than beside the reducer because there is exactly one
   * `version`, and it means "a client holding this has the whole state".
   * Anything published has to move that number, or the broadcast's encode cache
   * -- keyed on the version -- would keep handing out a frame that is missing
   * what changed. What discovery does not get from being here is any
   * entanglement with the merge: no store is built out of it, no session row
   * cites it, and neither `applyConnection` nor `applySessions` can reach it.
   */
  readonly candidates: readonly DiscoveredServer[];
}

export interface FleetStateDependencies {
  readonly logger: Logger;
}

export interface FleetState {
  /**
   * Takes a connectivity change from the supervisor. This is the seam
   * `DialLoopDependencies.onChange` is left for.
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
  /**
   * Takes the whole set of machines the beacon listener can currently hear.
   *
   * A whole list rather than an arrival or a departure, for the reason nothing
   * here is a delta: the listener knows what it can hear, and a reducer
   * applying "one left" would be keeping a second copy of that answer.
   *
   * A list that says what the last one said changes nothing, deliberately. A
   * candidate is refreshed every five seconds by a machine that is simply
   * still there, and waking every attached client for that would make the
   * version mean "a datagram arrived" rather than "something changed". Only
   * the published fields are compared -- when a claim was last heard is the
   * hub's bookkeeping and no client is shown it.
   */
  applyCandidates(candidates: readonly DiscoveredServer[]): void;
  /**
   * Takes what the user has said about one session.
   *
   * The seam the attention feature's `onChanged` is wired to, and the one path
   * by which an acknowledgement or a mute reaches the published state --
   * whether it was just made or read back off disk at boot.
   *
   * It is filed under `{ storeId, sessionId }` and not under a store the hub
   * has heard of: a row may arrive at boot for a session no server has scanned
   * yet, and dropping it would lose a mute until somebody made it again. It
   * surfaces when the session does.
   */
  applyAttention(ref: SessionRef, attention: SessionAttention): void;
  /**
   * Takes the whole of what the hub's tree says about where sessions sit,
   * keyed by `sessionKey`.
   *
   * A whole reading rather than one placement at a time, for the reason a
   * session report is a whole list: a session leaves a project by being absent
   * from the next reading, and a reducer applying "this one moved out" would
   * be keeping a second copy of an answer the tree already holds. One node
   * renamed high in the tree also moves every session under it at once, and
   * that is one reading, not a fan-out of edits.
   *
   * Filed under `{ storeId, sessionId }` and not under a store the hub has
   * heard of, like attention: a placement may be read before any server has
   * scanned the store, and it surfaces when the session does.
   *
   * A reading that says what the last one said changes nothing. The tree is
   * re-read on every catalogue change, and most of those move nothing a
   * session row draws.
   */
  applyProjects(placements: ReadonlyMap<string, SessionProject>): void;
  /**
   * Takes everything one session presently has open, as a whole list.
   *
   * The seam the approvals feature's `onChanged` is wired to, and a whole list
   * rather than an arrival or an ending for the reason nothing here is a delta:
   * that feature knows what is open, and a reducer applying "one ended" would
   * be keeping a second copy of the answer, free to drift from the one the
   * decision is actually made against.
   *
   * Filed under `{ storeId, sessionId }` and not under a store the hub has
   * heard of, exactly as an acknowledgement is: a machine can report a blocked
   * agent before its first store report lands, and dropping it would leave a
   * person unable to answer a question the hub had already been told about.
   */
  applyApprovals(ref: SessionRef, approvals: readonly PendingApproval[]): void;
  /** The whole state. The same object until something changes. */
  snapshot(): HubStateSnapshot;
  /**
   * What the hub believes one store holds, merged across every server attached
   * to it, or `null` when it knows of no such store.
   *
   * Here rather than assembled by whoever needs it, because it is the answer
   * this feature exists to be the only one of. The catalogue is the caller: a
   * store report arrives from one server, and the tree has to follow what the
   * hub believes is in the store rather than what the one server that spoke
   * last could see. Reading it off `snapshot().stores` at each call site would
   * be a second merge of the same reports, and two merges are two answers
   * waiting to differ.
   *
   * `null` means no server has this store mounted. An empty list means the
   * servers that do have reported nothing in it -- which covers a store that
   * was read and found empty *and* one mounted a moment ago and not yet
   * scanned, and this cannot tell those apart. Its caller must not need it to:
   * the catalogue asks only for a store a report has just arrived for, and
   * that is what makes the list it gets back a reading rather than a silence.
   * A caller that asked for an arbitrary store and swept against the answer
   * would be spending the sweep's whole safeguard.
   */
  storeSessions(storeId: StoreId): readonly SessionDescriptor[] | null;
  /**
   * The server running one session right now, or `null` when nobody is.
   *
   * `null` also answers a session this hub has never heard of, and the two are
   * deliberately one answer: both mean there is no live process here to name,
   * and the one caller -- a removal deciding whether the tree may drop a node
   * -- would do the same thing with either. A session in a store nobody has
   * mounted is precisely a session nobody is running.
   *
   * Here rather than read off `snapshot().stores` by whoever needs it, for the
   * reason `storeSessions` is here: a hold is merged across every server
   * attached to a volume, and a second reader doing that merge is a second
   * answer waiting to differ from the one the client is looking at.
   */
  sessionHolder(ref: SessionRef): SessionHolder | null;
  /**
   * When the provider last wrote to this session, as the hub currently
   * believes it, or `null` when the hub knows of no such session.
   *
   * Two answers in one, because its one caller asks both at one instant: an
   * acknowledgement is refused for a session the hub cannot see, and what it
   * records for one it can see is exactly this number. Two calls could be
   * answered out of two snapshots, and the pair would then describe a session
   * as it was at two different moments.
   *
   * `null` is existence and not reachability: a session on a machine that went
   * away keeps its row, labelled, and is still a session a person can see and
   * act on -- and is exactly the session somebody reaches for the mute on.
   * What the `null` bounds is the attention table: a hub that recorded an
   * acknowledgement for any pair of strings a client sent would have a table a
   * client could grow without limit.
   *
   * Here rather than worked out by the caller for the reason `sessionHolder`
   * is here: it is an answer about the merged view, and a second reader doing
   * the merge is a second answer waiting to differ from the one on screen.
   */
  sessionActivity(ref: SessionRef): number | null;
  /**
   * The same state, projected onto the shape the wire carries.
   *
   * A method here rather than a function the broadcast imports, because the
   * projection is this feature's: it decides which of the reducer's fields a
   * client is shown and which are the hub's own bookkeeping, and a caller that
   * reached past it would be publishing on its own authority. What it is and
   * why each field is in it is `machine-state.ts`.
   */
  published(): MachineState;
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

export function createFleetState(dependencies: FleetStateDependencies): FleetState {
  const logger = dependencies.logger.child({ part: 'reducer' });

  const connections = new Map<ServerRegistrationId, ServerConnectionReport>();
  const reports = new Map<ServerRegistrationId, Map<StoreId, StoredReport>>();
  /**
   * What the user has said, by session.
   *
   * Keyed as JSON rather than by a joined string, because a store id and a
   * session id are opaque and either may contain whatever separator was
   * chosen -- two sessions colliding on one key would put one person's mute on
   * another session.
   */
  const attention = new Map<string, SessionAttention>();
  /**
   * What each session has open, by session, and only while it has any.
   *
   * Keyed as JSON for the reason the attention map is. A session whose last
   * request ended leaves the map rather than keeping an empty list: nothing
   * open is the same fact as never having had anything open, and two
   * representations of it would be two ways for a row to say the same thing.
   */
  const approvals = new Map<string, readonly PendingApproval[]>();
  const listeners = new Set<(snapshot: HubStateSnapshot) => void>();

  /**
   * Where the tree says each session sits, as of the last whole reading.
   *
   * Replaced whole rather than edited, which is what makes a session absent
   * from a reading a session in no project: the previous map is gone, so there
   * is no path by which a placement outlives the tree that produced it.
   */
  let projects: ReadonlyMap<string, SessionProject> = new Map();
  let version = 0;
  let built: HubStateSnapshot | null = null;
  /**
   * What the network has been heard to say, kept whole and separate.
   *
   * Its own binding rather than a field folded into `connections`, so that
   * there is no code path in this file along which a candidate could reach the
   * server list: the two are never in the same map to be confused.
   */
  let candidates: readonly DiscoveredServer[] = [];

  const build = (): HubStateSnapshot => {
    const stores = buildStoreViews(connections, reports, attention, projects, approvals);
    return {
      version,
      stores,
      servers: [...connections.values()].sort(byLabel),
      candidates,
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

    applyCandidates(heard: readonly DiscoveredServer[]): void {
      if (sameCandidates(candidates, heard)) return;
      candidates = heard;
      changed();
    },

    applyAttention(ref: SessionRef, next: SessionAttention): void {
      const key = sessionKey(ref);
      const previous = attention.get(key) ?? UNATTENDED;
      // A repeat says nothing new, and waking every client for it would make
      // the version mean "somebody clicked" rather than "something changed".
      // It happens for real: two tabs acknowledging the same prompt, and a
      // mute re-asserted by a client catching up after a reconnection.
      if (
        previous.acknowledgedThrough === next.acknowledgedThrough &&
        previous.mutedAt === next.mutedAt
      ) {
        return;
      }
      attention.set(key, next);
      changed();
    },

    applyProjects(placements: ReadonlyMap<string, SessionProject>): void {
      if (sameProjects(projects, placements)) return;
      // Copied rather than held, because the caller built this map out of a
      // tree it goes on reading: a reference kept here would let the next read
      // change what the hub has already published without moving the version.
      projects = new Map(placements);
      changed();
    },

    applyApprovals(ref: SessionRef, next: readonly PendingApproval[]): void {
      const key = sessionKey(ref);
      const previous = approvals.get(key) ?? NOTHING_PENDING;
      // The same rule the reports follow: a list that says what the last one
      // said is a version bump that would mean "a machine spoke" rather than
      // "something changed", and every bump is a whole state frame to every
      // attached client.
      if (sameApprovals(previous, next)) return;
      if (next.length === 0) approvals.delete(key);
      else approvals.set(key, next);
      changed();
    },

    snapshot,

    storeSessions(storeId: StoreId): readonly SessionDescriptor[] | null {
      const view = snapshot().stores.find((candidate) => candidate.storeId === storeId);
      if (view === undefined) return null;
      return view.sessions.map((row) => row.descriptor);
    },

    sessionHolder(ref: SessionRef): SessionHolder | null {
      return findRow(snapshot(), ref)?.holder ?? null;
    },

    sessionActivity(ref: SessionRef): number | null {
      return findRow(snapshot(), ref)?.descriptor.updatedAt ?? null;
    },

    published(): MachineState {
      return toMachineState(snapshot());
    },

    subscribe(listener: (snapshot: HubStateSnapshot) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** One merged session row, or `undefined` when the hub has no such session. */
function findRow(state: HubStateSnapshot, ref: SessionRef): SessionRow | undefined {
  const view = state.stores.find((candidate) => candidate.storeId === ref.storeId);
  return view?.sessions.find((session) => session.ref.sessionId === ref.sessionId);
}

/**
 * One session's key in the maps keyed by session rather than by store.
 *
 * JSON rather than a joined string, because a store id and a session id are
 * opaque and either may contain whatever separator was chosen -- two sessions
 * colliding on one key would put one person's mute, or one project's name, on
 * another session.
 *
 * Exported because `applyProjects` takes a whole map: its caller reads the
 * tree and has to build the same keys this file reads, and a caller spelling
 * the key itself would be a second definition of it waiting to drift.
 */
export function sessionKey(ref: SessionRef): string {
  return JSON.stringify([ref.storeId, ref.sessionId]);
}

/**
 * Whether the tree is saying exactly what it was saying last time.
 *
 * Here rather than in `equality.ts` because `SessionProject` is declared in
 * this file, and that module importing this one would close a cycle: this file
 * imports it.
 *
 * Both fields are compared. The id moves when a session is moved between
 * projects, and the name moves on a rename -- a client draws the name, so a
 * rename that did not bump the version would leave every screen saying the old
 * word about a project that had just been renamed.
 */
function sameProjects(
  left: ReadonlyMap<string, SessionProject>,
  right: ReadonlyMap<string, SessionProject>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, project] of left) {
    const other = right.get(key);
    if (other === undefined) return false;
    if (project.nodeId !== other.nodeId || project.name !== other.name) return false;
  }
  return true;
}

function byLabel(left: ServerConnectionReport, right: ServerConnectionReport): number {
  if (left.label !== right.label) return left.label < right.label ? -1 : 1;
  return left.registrationId < right.registrationId ? -1 : 1;
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
  attention: ReadonlyMap<string, SessionAttention>,
  projects: ReadonlyMap<string, SessionProject>,
  approvals: ReadonlyMap<string, readonly PendingApproval[]>,
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
      sessions: buildSessionRows(storeId, servers, reports, attention, projects, approvals),
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
  attention: ReadonlyMap<string, SessionAttention>,
  projects: ReadonlyMap<string, SessionProject>,
  approvals: ReadonlyMap<string, readonly PendingApproval[]>,
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
    const ref = { storeId, sessionId: chosen.descriptor.sessionId };
    rows.push({
      ref,
      descriptor: chosen.descriptor,
      source: chosen.registrationId,
      reportedBy: gathered.map((reading) => reading.registrationId).sort(),
      reportedAt: chosen.reportedAt,
      reachable: gathered.some((reading) => reading.reachable),
      holder: holders.get(chosen.descriptor.sessionId) ?? null,
      // A session nobody has said anything about reads as unattended rather
      // than as a gap: there is no third state between "not acknowledged" and
      // "no row", and offering one would make every reader handle it.
      attention: attention.get(sessionKey(ref)) ?? UNATTENDED,
      // A session the tree does not place is a session in no project, which is
      // an answer rather than a reading that has not happened yet.
      project: projects.get(sessionKey(ref)) ?? null,
      // Empty rather than absent, for the reason the wire's own field is:
      // "nothing is waiting" and "this hub cannot tell you" must not be one
      // value, and every codex row will say the first of them forever.
      approvals: approvals.get(sessionKey(ref)) ?? NOTHING_PENDING,
    });
  }

  return rows.sort((left, right) =>
    left.descriptor.sessionId < right.descriptor.sessionId ? -1 : 1,
  );
}
