import type { MachineState, ServerView, SessionRow, StoreView } from '@agentplex/protocol';
import type { ServerConnectionReport } from '../connections/server-connection.js';
import type {
  HubStateSnapshot,
  SessionRow as ReducedSessionRow,
  StoreView as ReducedStoreView,
} from '../state/reducer.js';

/**
 * The reducer's state, as the wire carries it.
 *
 * A projection rather than the reducer's own value sent as-is, for two reasons
 * that are both about what a client is owed.
 *
 * The first is that the internal state holds things a client has no business
 * with. `ServerConnectionReport` carries the address the hub dials -- which is
 * a routing detail of the hub's deployment, not a fact about a session -- and a
 * retry counter, which is the supervisor's bookkeeping and would only ever be
 * rendered as a number nobody can act on.
 *
 * The second is the one this ticket exists for. Internally a store holds the
 * server objects attached to it, because that is the convenient shape for the
 * code that builds it. On the wire a store names its servers by id and the
 * server is described once, in `servers`. A frame that inlined them could
 * contradict itself -- the same machine `connected` under one store and `stale`
 * under another -- which is the two-clients-disagree failure moved inside a
 * single message.
 *
 * Nothing here is cast. The enums line up by assignment, so a phase or a stale
 * reason added to the supervisor and not to the protocol fails to compile here
 * rather than reaching a client as a word it has never heard of.
 */
export function toMachineState(snapshot: HubStateSnapshot): MachineState {
  return {
    version: snapshot.version,
    stores: snapshot.stores.map(toStoreView),
    servers: snapshot.servers.map(toServerView),
  };
}

function toServerView(report: ServerConnectionReport): ServerView {
  return {
    registrationId: report.registrationId,
    label: report.label,
    serverId: report.serverId,
    phase: report.phase,
    stores: [...report.stores],
    connectedSince: report.connectedSince,
    staleSince: report.staleSince,
    lastConnectedAt: report.lastConnectedAt,
    staleReason: report.staleReason,
    problem: report.problem,
  };
}

function toStoreView(view: ReducedStoreView): StoreView {
  return {
    storeId: view.storeId,
    servers: view.servers.map((server) => server.registrationId),
    reachable: view.reachable,
    unreachableSince: view.unreachableSince,
    lastReachableAt: view.lastReachableAt,
    sessions: view.sessions.map(toSessionRow),
  };
}

/**
 * The descriptor travels whole, exactly as the chosen server sent it.
 *
 * The reducer's `ref` is not carried: it is `descriptor.storeId` and
 * `descriptor.sessionId` restated, and two fields on a wire that must agree
 * with each other are two fields that can disagree.
 */
function toSessionRow(row: ReducedSessionRow): SessionRow {
  return {
    descriptor: row.descriptor,
    source: row.source,
    reportedBy: [...row.reportedBy],
    reportedAt: row.reportedAt,
    reachable: row.reachable,
  };
}
