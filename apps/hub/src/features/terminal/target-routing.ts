import type {
  ClientTerminalTarget,
  FrameId,
  ServerRegistrationId,
  ServerTerminalTarget,
  SessionId,
} from '@agentplex/protocol';
import { countsTowardAttention, type ServerConnectionReport } from '../servers/servers.js';
import type { HubStateSnapshot, StoreView } from '../fleet-state/fleet-state.js';
import type { ClientStart } from './terminal.js';

/**
 * Which machine holds the terminal a client is asking about.
 *
 * Pure, and given the whole state, for the reason `session-routing.ts` is: the
 * cases worth testing are a fleet -- a session held on one of two servers
 * sharing a volume, a machine that has gone stale with the session still on
 * it, a start handle that belongs to a different client -- and every one of
 * them is a value a test can build.
 *
 * The refusals are the subject here more than the successes. A pane that opens
 * and stays blank looks exactly like a pane watching an idle agent, and the
 * only thing that tells them apart is a sentence, so every no here names
 * something: the machine the hub cannot reach, or the fact that no machine
 * reports that session at all. "Refused" on its own would leave a user
 * looking at an empty rectangle deciding whether to wait.
 */

/** What a client's terminal frame resolves to, or why it resolves to nothing. */
export type TerminalRouting =
  | {
      readonly ok: true;
      readonly registrationId: ServerRegistrationId;
      /** The machine, as it is named in a sentence. */
      readonly label: string;
      /** The same terminal, addressed the way the server leg addresses one. */
      readonly target: ServerTerminalTarget;
    }
  | { readonly ok: false; readonly problem: string };

/**
 * Resolves a client's target against the fleet.
 *
 * `starts` is the asking client's own map from its `session-start` frame ids to
 * the starts this hub made for it. A start handle is local to the socket that
 * made it, so this takes one client's map rather than a registry: a handle
 * another client used is not a handle this one may name, and passing only the
 * asker's map is what makes that unrepresentable rather than checked.
 */
export function routeTerminal(
  state: HubStateSnapshot,
  starts: ReadonlyMap<FrameId, ClientStart>,
  target: ClientTerminalTarget,
): TerminalRouting {
  if (target.by === 'start') {
    const start = starts.get(target.startId);
    if (start === undefined) {
      // Not "no such start": this connection asking about a handle it never
      // received is a different thing from a start that has ended, and the only
      // one of the two the hub can tell.
      return { ok: false, problem: 'this connection did not start that session' };
    }

    const server = state.servers.find(
      (candidate) => candidate.registrationId === start.registrationId,
    );
    const unreachable = whyUnreachable(server);
    if (unreachable !== null) return { ok: false, problem: unreachable };

    return {
      ok: true,
      registrationId: start.registrationId,
      label: server?.label ?? start.registrationId,
      target: { by: 'start', startId: start.startId },
    };
  }

  const store = state.stores.find((view) => view.storeId === target.storeId);
  if (store === undefined) {
    return { ok: false, problem: 'no server the hub is paired with has that store mounted' };
  }

  const candidates = holdersOf(store, target.sessionId);
  if (candidates.length === 0) {
    return { ok: false, problem: 'no server the hub can see reports that session' };
  }

  const live = candidates.filter(countsTowardAttention);
  if (live[0] === undefined) {
    // The refusal this whole file exists for. A machine that is asleep and a
    // session that produces nothing render as the same empty pane, and naming
    // the machine is the only thing that tells a person which of the two they
    // are looking at -- and what to go and do about it.
    return {
      ok: false,
      problem: `the hub cannot reach ${candidates.map((server) => server.label).join(', ')} right now`,
    };
  }

  return {
    ok: true,
    registrationId: live[0].registrationId,
    label: live[0].label,
    target: { by: 'session', storeId: target.storeId, sessionId: target.sessionId },
  };
}

/**
 * The machines that could have this session's terminal, best first.
 *
 * The holder, when a server says it is running one, because that is the machine
 * with the process. Otherwise every server that reported the session, in the
 * order the store view holds them, which is the case that matters most often:
 * a session whose agent has just exited is frequently the one somebody wants to
 * read, and its bytes are on the machine that ran it rather than in the
 * transcript. The server answers for itself when it has no terminal either.
 */
function holdersOf(store: StoreView, sessionId: SessionId): readonly ServerConnectionReport[] {
  const row = store.sessions.find((session) => session.ref.sessionId === sessionId);
  if (row === undefined) return [];

  const holder = row.holder;
  const named =
    holder === null
      ? row.reportedBy
      : // The holder first, and then the rest, so a stale holder still names
        // itself in the refusal rather than being replaced by a machine that
        // has the volume and never ran anything.
        [holder.server, ...row.reportedBy.filter((server) => server !== holder.server)];

  return named
    .map((registrationId) =>
      store.servers.find((server) => server.registrationId === registrationId),
    )
    .filter((server): server is ServerConnectionReport => server !== undefined);
}

/** Why this server cannot be asked anything, or `null` when it can. */
function whyUnreachable(server: ServerConnectionReport | undefined): string | null {
  if (server === undefined) return 'the server that start was made on is no longer paired';
  if (!countsTowardAttention(server)) return `the hub cannot reach ${server.label} right now`;
  return null;
}
