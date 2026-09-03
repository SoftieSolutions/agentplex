import type {
  RefusalCode,
  ServerRegistrationId,
  SessionHolder,
  SessionId,
  StoreId,
} from '@agentplex/protocol';
import { countsTowardAttention } from '../connections/attention.js';
import type { ServerConnectionReport } from '../connections/server-connection.js';
import type { HubStateSnapshot, StoreView } from '../state/reducer.js';

/**
 * Which machine runs a session, and whether it may be started at all.
 *
 * The scheduling rule from the design, in one pure function of the state: a
 * start names a store, the hub picks the least-loaded live server attached to
 * that store unless the user chose one, and a session that already has a live
 * holder is refused and the holder is named. No server-to-server coordination
 * appears anywhere, because the hub is the only thing that can see every server
 * on a store and therefore the only thing that has to decide.
 *
 * It is pure, and given the whole state, for the reason the status derivation
 * is: the interesting cases are a fleet -- two servers on one volume, one of
 * them stale, a session held on the other -- and every one of them is a value a
 * test can build. Nothing here dials, sends or awaits; `session-control.ts`
 * does that with what this decides.
 *
 * The one-writer refusal is enforced here *and* again on the server that
 * receives the instruction. This side sees every machine and can therefore
 * refuse the case the server cannot see -- a session held by a different server
 * on the same volume -- and the server can refuse the case this side cannot,
 * which is anything that started in the moment between the hub reading its
 * state and the instruction arriving.
 */

/** A start, as the hub reads it: a store, maybe a session, maybe a machine. */
export interface StartRequest {
  readonly storeId: StoreId;
  /** The session to resume, or `null` for a new one the provider will name. */
  readonly sessionId: SessionId | null;
  /** The user's override, or `null` to let the hub schedule it. */
  readonly server: ServerRegistrationId | null;
}

/**
 * Where an instruction goes, or why it goes nowhere.
 *
 * A refusal carries the holder when a live process is the reason, and `null`
 * for every other reason, so that one shape covers both and no caller has to
 * remember which kinds name a machine.
 */
export type Routing =
  | { readonly ok: true; readonly server: ServerConnectionReport }
  | {
      readonly ok: false;
      readonly code: RefusalCode;
      readonly problem: string;
      readonly holder: SessionHolder | null;
    };

/** Which server should run this start. */
export function routeStart(state: HubStateSnapshot, request: StartRequest): Routing {
  const store = state.stores.find((view) => view.storeId === request.storeId);
  if (store === undefined) {
    return {
      ok: false,
      code: 'refused',
      problem: 'no server the hub is paired with has that store mounted',
      holder: null,
    };
  }

  // Before the scheduling, and before the override is even looked at. A session
  // that is already running is not a placement problem: two agents on one
  // transcript is the corruption there is no recovery from, and the way out is
  // stopping the holder rather than choosing a different machine for a second.
  const held = request.sessionId === null ? null : holderOf(store, request.sessionId);
  if (held !== null) {
    return {
      ok: false,
      code: 'refused',
      problem: `that session is already running on ${labelOf(state, held.server)}`,
      holder: held,
    };
  }

  const live = store.servers.filter(countsTowardAttention);

  if (request.server !== null) {
    const chosen = live.find((server) => server.registrationId === request.server);
    if (chosen !== undefined) return { ok: true, server: chosen };

    // The two ways an override fails are different things for a person to do,
    // so they are different sentences. A machine that has the store but is
    // asleep is worth waiting for; one that never had it is a choice to change.
    const attached = store.servers.find((server) => server.registrationId === request.server);
    return {
      ok: false,
      code: 'refused',
      problem:
        attached === undefined
          ? 'the server you chose does not have that store mounted'
          : `the hub cannot reach ${attached.label} right now`,
      holder: null,
    };
  }

  const scheduled = leastLoaded(state, live);
  if (scheduled === undefined) {
    return {
      ok: false,
      code: 'refused',
      problem: 'no server with that store mounted is connected right now',
      holder: null,
    };
  }

  return { ok: true, server: scheduled };
}

/**
 * Which server to tell to stop a session.
 *
 * Resolved here rather than named by the client, which is the whole of "the
 * stop button resolves the owner hub-side": a client addresses
 * `{ storeId, sessionId }` and never a machine or a process, so the worst a
 * client can do with a stop is stop a session it can already see.
 */
export function routeStop(
  state: HubStateSnapshot,
  session: { readonly storeId: StoreId; readonly sessionId: SessionId },
): Routing {
  const store = state.stores.find((view) => view.storeId === session.storeId);
  const holder = store === undefined ? null : holderOf(store, session.sessionId);
  if (store === undefined || holder === null) {
    return {
      ok: false,
      code: 'refused',
      problem: 'nothing the hub can see is running that session',
      holder: null,
    };
  }

  if (!holder.stoppable) {
    // The busy holder that gets no button. Refused here as well as being
    // unbuttoned in the client, because a state a screen renders is not a rule:
    // an older client, a script, or a race past the moment the button was drawn
    // all reach this, and interrupting a turn mid-tool is how a half-applied
    // edit is left on disk.
    return {
      ok: false,
      code: 'refused',
      problem: 'that session is mid-turn; stopping it now could leave an edit half applied',
      holder,
    };
  }

  const server = store.servers.find((candidate) => candidate.registrationId === holder.server);
  if (server === undefined || !countsTowardAttention(server)) {
    return {
      ok: false,
      code: 'refused',
      problem: 'the server running that session is not reachable right now',
      holder,
    };
  }

  return { ok: true, server };
}

function holderOf(store: StoreView, sessionId: SessionId): SessionHolder | null {
  return store.sessions.find((row) => row.ref.sessionId === sessionId)?.holder ?? null;
}

/** What to call a machine in a sentence, falling back to the id nobody named. */
function labelOf(state: HubStateSnapshot, registrationId: ServerRegistrationId): string {
  return (
    state.servers.find((server) => server.registrationId === registrationId)?.label ??
    registrationId
  );
}

/**
 * The least-loaded live server, counting live agents rather than sessions.
 *
 * Load is the number of sessions a machine says it is holding, across every
 * store it has mounted -- not the number of sessions visible in this store. A
 * session on disk costs a machine nothing; a live agent costs it a pty, a
 * subscription and a model's worth of work, and two servers sharing a volume
 * see the same transcripts while running entirely different amounts of it.
 *
 * That number is on the wire because the one-writer rule already needs it: a
 * server has to say what it is holding for the hub to enforce one live process
 * per session, and the count falls out of the same fact. Scheduling on it costs
 * no extra reporting and nothing periodic.
 *
 * Ties break on label, which is the order `store.servers` is already in, so two
 * idle machines resolve the same way on every start rather than alternating
 * with the iteration order of a map.
 */
function leastLoaded(
  state: HubStateSnapshot,
  candidates: readonly ServerConnectionReport[],
): ServerConnectionReport | undefined {
  const load = liveAgentsPerServer(state);
  let best: ServerConnectionReport | undefined;
  let bestLoad = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const running = load.get(candidate.registrationId) ?? 0;
    if (running < bestLoad) {
      best = candidate;
      bestLoad = running;
    }
  }

  return best;
}

/** How many live agents each server is holding, across every store. */
function liveAgentsPerServer(state: HubStateSnapshot): ReadonlyMap<ServerRegistrationId, number> {
  const running = new Map<ServerRegistrationId, number>();
  for (const store of state.stores) {
    for (const row of store.sessions) {
      if (row.holder === null) continue;
      running.set(row.holder.server, (running.get(row.holder.server) ?? 0) + 1);
    }
  }
  return running;
}
