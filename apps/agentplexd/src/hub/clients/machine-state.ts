import type {
  MachineState,
  ServerCandidate,
  ServerView,
  SessionRow,
  StoreView,
} from '@agentplex/protocol';
import type { ServerConnectionReport } from '../connections/server-connection.js';
import type { DiscoveredServer } from '../discovery/beacon-listener.js';
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
    // Its own field, from its own collection, through its own projection. There
    // is no line in this file along which a candidate could arrive in `servers`.
    candidates: snapshot.candidates.map(toServerCandidate),
  };
}

/**
 * A machine the hub has heard from, as a client reads it.
 *
 * Two internal fields do not make the trip, for the reason the dialled address
 * and the retry counter do not. `heardAt` is what the aging is measured
 * against, and it moves every five seconds for a machine that has done nothing
 * but still be there -- publishing it would put a ticking field into a frame
 * that goes whole to every client, and invite a client to re-derive an answer
 * the hub has already given by keeping the candidate in the list at all.
 * `heardFrom` is the cross-check on the announced address, which an operator
 * reads in a log; a client handed both addresses has been handed a decision the
 * hub could not make either.
 *
 * The protocol version is carried rather than judged. `checkProtocolVersion` is
 * the verdict, and the client reading this frame is running the same protocol
 * number as this hub -- its `hello` was compared with `===` before it was sent
 * any of this -- so the verdict it reaches is the one the hub would reach, and
 * a second field saying so could only ever disagree with the first.
 */
function toServerCandidate(candidate: DiscoveredServer): ServerCandidate {
  return {
    serverId: candidate.serverId,
    address: candidate.address,
    port: candidate.port,
    protocolVersion: candidate.protocolVersion,
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
    // Carried, not re-derived. Whether a session may be stopped is the holding
    // server's answer about its own process, and a projection that recomputed
    // it from the status would be a second copy of the rule, free to disagree
    // with the machine that actually holds the terminal.
    holder: row.holder,
  };
}
