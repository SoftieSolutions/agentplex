import type {
  GraphRunApproval,
  MachineState,
  ServerCandidate,
  ServerView,
  SessionRow,
  StoreView,
} from '@agentplex/protocol';
import type { ServerConnectionReport } from '../servers/servers.js';
import type { DiscoveredServer } from '../discovery/discovery.js';
import type {
  HubStateSnapshot,
  SessionRow as ReducedSessionRow,
  StoreView as ReducedStoreView,
} from './fleet-state.js';

/**
 * The reducer's state, as the wire carries it.
 *
 * A projection rather than the reducer's own value sent as-is, for two reasons
 * that are both about what a client is owed.
 *
 * The first is that the internal state holds things a client has no business
 * with -- the retry counter, which is the supervisor's bookkeeping and would
 * only ever be rendered as a number nobody can act on, and the timestamp a
 * candidate's aging is measured against.
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
    // Copied, not passed through, for the reason a row's approvals are: the
    // protocol's `graphRunApprovalSchema` is the same shape the reducer holds,
    // so there is nothing to project, and nothing a client is sent may share
    // an array with the reducer's own.
    graphRunApprovals: snapshot.graphRunApprovals.map(toGraphRunApproval),
  };
}

function toGraphRunApproval(entry: GraphRunApproval): GraphRunApproval {
  return {
    graph: entry.graph,
    number: entry.number,
    nodeLabel: entry.nodeLabel,
    approval: entry.approval,
  };
}

/**
 * A machine the hub has heard from, as a client reads it.
 *
 * Two internal fields do not make the trip, for the reason the retry counter
 * does not. `heardAt` is what the aging is measured
 * against, and it moves every five seconds for a machine that has done nothing
 * but still be there -- publishing it would put a ticking field into a frame
 * that goes whole to every client, and invite a client to re-derive an answer
 * the hub has already given by keeping the candidate in the list at all.
 * `heardFrom` is the cross-check on the announced address, which an operator
 * reads in a log; a client handed both addresses has been handed a decision the
 * hub could not make either.
 *
 * The protocol version is carried rather than judged. `checkServerProtocolVersion`
 * is the verdict, and the client reading this frame holds the same server-leg
 * number as this hub -- not because its `hello` matched, which proves only the
 * client leg, but because the web package records the server leg too and every
 * install and update refuses a web that disagrees with the hub on it -- so the
 * verdict it reaches is the one the hub would reach, and a second field saying
 * so could only ever disagree with the first.
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
    // Published, after a release in which it was held back as a routing detail
    // of the hub's deployment. What changed is that a client can pair and
    // unpair now, so the screen these rows are drawn on is the pairing screen:
    // the address is what tells two boxes with the same label apart, and
    // `Unpair` destroys a token rather than hiding a row. It carries no secret
    // to leak -- the parser that admitted it refuses a URL with a credential,
    // a query or a fragment in it -- and the token, which is the credential,
    // is on no frame the hub sends.
    address: report.address,
    serverId: report.serverId,
    phase: report.phase,
    stores: [...report.stores],
    // Published rather than reduced to a boolean. The version and the directory
    // are the two things an operator asks for when the wrong agent runs, and a
    // hub that summarised them into "ready" would be the only thing that had
    // ever known the answer.
    providers: [...report.providers],
    connectedSince: report.connectedSince,
    staleSince: report.staleSince,
    lastConnectedAt: report.lastConnectedAt,
    staleReason: report.staleReason,
    // Published beside the phase rather than folded into it, because they are
    // two facts and a client draws both: the socket is up, and everything on it
    // is about to stop. The sessions are copied rather than passed through, so
    // that nothing a client is sent shares an array with the supervisor's own.
    draining:
      report.draining === null
        ? null
        : {
            since: report.draining.since,
            graceMs: report.draining.graceMs,
            sessions: [...report.draining.sessions],
          },
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
    // Flattened onto the row rather than carried as the little object the
    // reducer holds, because on the wire they are read beside `updatedAt` and
    // never apart from it: the verdict a client wants is one comparison across
    // two fields of one row, and a nested object would put a `null` in the way
    // of it for the common case of a session nobody has said anything about.
    acknowledgedThrough: row.attention.acknowledgedThrough,
    mutedAt: row.attention.mutedAt,
    // Passed through, not flattened and not re-derived. Unlike attention, whose
    // two fields are read beside `updatedAt` on this same row, a project is one
    // thing a screen either names or does not, so the object survives the trip
    // and `null` keeps saying "in no project" in one place rather than two.
    //
    // The reducer holds exactly the pair the wire carries, so there is nothing
    // to copy defensively here: both fields are values, and a row is rebuilt
    // rather than mutated whenever the tree says something new.
    project: row.project,
    // Copied rather than passed through, so that nothing a client is sent
    // shares an array with the reducer's own. Empty is the true value and not
    // a placeholder: a provider with no hook to ask through publishes this on
    // every row, which is what keeps "nothing is waiting" and "this build
    // cannot tell you" two different answers.
    approvals: [...row.approvals],
    // Carried as the reducer holds it, `null` and all. This is the one field
    // on the row that came from a person rather than from a machine, and the
    // projection's job is to pass it on: filling a `null` in from the
    // descriptor would invent the fact the field exists to state honestly.
    task: row.task,
  };
}
