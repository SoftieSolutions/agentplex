import {
  readinessRefusal,
  type Provider,
  type RefusalCode,
  type ServerRegistrationId,
  type SessionHolder,
  type SessionId,
  type StoreId,
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

/** A start, as the hub reads it: a store, a provider, maybe a session, maybe a machine. */
export interface StartRequest {
  readonly storeId: StoreId;
  /** The session to resume, or `null` for a new one the provider will name. */
  readonly sessionId: SessionId | null;
  /**
   * Which agent to run. Part of the routing decision and not merely payload:
   * a machine that cannot run this provider is not a machine this start can be
   * scheduled onto, however idle it is.
   */
  readonly provider: Provider;
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
    if (chosen !== undefined) {
      // The machine the user picked, checked before it is instructed. This is
      // the refusal the preflight exists to make possible: on a pty a provider
      // that is not there is not an error, it is a session that appears and
      // vanishes, and here is the last place it can still be a sentence.
      const unusable = cannotRun(chosen, request.provider);
      if (unusable !== null) {
        return { ok: false, code: 'refused', problem: unusable, holder: null };
      }
      return { ok: true, server: chosen };
    }

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

  // Filtered before the scheduling rather than after it, so a fleet where one
  // machine has the provider and another does not schedules onto the one that
  // does. An unusable provider costs its own machine a start and never the
  // store: every other server on the volume is a candidate exactly as before.
  const capable = live.filter((server) => cannotRun(server, request.provider) === null);

  const scheduled = leastLoaded(state, capable);
  if (scheduled === undefined) {
    return {
      ok: false,
      code: 'refused',
      problem: whyNothingCanRun(live, request.provider),
      holder: null,
    };
  }

  return { ok: true, server: scheduled };
}

/**
 * Why this machine must not be asked to run this provider, or `null`.
 *
 * A provider a server never mentioned is refused as firmly as one it reported
 * missing, and the sentence says which of the two it is: a build with no
 * adapter and a machine with no binary are different things to go and fix.
 *
 * The words come from the machine that took the reading. The hub is repeating a
 * fact, not diagnosing one, and a sentence composed here would be the hub's
 * guess at what some other box meant.
 */
function cannotRun(server: ServerConnectionReport, provider: Provider): string | null {
  const readiness = server.providers.find((entry) => entry.provider === provider);
  if (readiness === undefined) return `${server.label} does not run ${provider}`;

  const refusal = readinessRefusal(readiness);
  return refusal === null ? null : `${server.label} cannot run ${provider}: ${refusal}`;
}

/**
 * What to say when every reachable machine on the store refuses.
 *
 * Their own reasons, joined, rather than one flat "nothing can run this".
 * "gpu-box-01 cannot run claude: no directory this server searches holds
 * claude" is a thing to go and fix; the flat version is a thing to guess at.
 */
function whyNothingCanRun(live: readonly ServerConnectionReport[], provider: Provider): string {
  const reasons = live
    .map((server) => cannotRun(server, provider))
    .filter((reason): reason is string => reason !== null);

  return reasons.length === 0
    ? 'no server with that store mounted is connected right now'
    : reasons.join('; ');
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
