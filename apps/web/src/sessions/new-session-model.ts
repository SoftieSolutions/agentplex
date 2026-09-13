import { readinessRefusal } from '@agentplex/protocol';
import type {
  FrameId,
  MachineState,
  NodeId,
  Provider,
  ServerRegistrationId,
  SessionHolder,
  ServerView,
  SessionRef,
  StoreId,
} from '@agentplex/protocol';
import type { ConnectionPhase, HubCommand, RefusalView, StartedView } from '../store/hub-store.js';
import { sessionHash } from '../terminal/session-route.js';
import { serverLabel } from './session-list-model.js';

/**
 * Everything the new-session flow decides, as pure functions: which controls
 * are drawn, what the frame carries, whether submit is allowed, and what to do
 * with the hub's answer. The form component owns nothing but what the user has
 * typed; every rule the ticket names lives here where a test can hold a
 * captured state against it.
 *
 * The controls follow the one-option rule the session list already applies: a
 * store picker with one store is not drawn (the store is named in words), the
 * server override appears only when more than one connected server could
 * actually run the chosen store, and the provider is named in words when the
 * machines on offer can start exactly one of them.
 *
 * The provider used to be neither of those: it was the literal `'claude'` on
 * the frame, so every session started from this client was a claude session
 * whatever the machine actually had. It is a choice now, and the list it is
 * chosen from is a fact about the fleet rather than a constant -- `providerOffer`
 * is the whole of that, and `serverOverrideChoices` is the same rule read the
 * other way, so the two selects constrain each other.
 *
 * The project picker follows the same rule from the other end: it is drawn when
 * there is at least one project, because "in a project" and "wherever the store
 * is" are two different starts and a form with no way to say which would only
 * ever make the second. It narrows neither of the other two controls, and that
 * is not an omission: nothing on the wire ties a project to a machine. A
 * project is a node with a directory, and whether that directory sits under a
 * root is answered by the machine that has the disk, at the moment it is asked.
 */

/** Every store a session could start in, in the order the hub sent them. */
export function startableStores(state: MachineState): readonly StoreId[] {
  return state.stores.map((store) => store.storeId);
}

/** A machine the override control offers: the stable id, worded by its label. */
export interface ServerChoice {
  readonly id: ServerRegistrationId;
  readonly label: string;
}

/**
 * The machines the hub could route this start to, in the store's own order.
 *
 * Only servers that are attached to the store *and* connected right now: a
 * start routed at a stale machine would be refused, and a form built on rows
 * the hub will not use is a form whose every answer is an apology. The stale
 * row keeps its providers -- that is what keeping it is for -- and none of them
 * is on offer here.
 */
function liveServers(state: MachineState | null, storeId: StoreId | null): readonly ServerView[] {
  if (state === null || storeId === null) return [];
  const store = state.stores.find((view) => view.storeId === storeId);
  if (store === undefined) return [];
  const servers: ServerView[] = [];
  for (const id of store.servers) {
    const server = state.servers.find((view) => view.registrationId === id);
    if (server === undefined || server.phase !== 'connected') continue;
    servers.push(server);
  }
  return servers;
}

/**
 * Whether that machine said it can start this provider.
 *
 * `readinessRefusal` and nothing of this file's own, which is the point: the
 * hub decides a start with that same function, so a client with its own notion
 * of startable would be a second rule free to drift from the one that actually
 * answers. It is also why `unknown` counts -- the binary resolved, the hub will
 * route to it, and a client that hid the machine would be stricter than the
 * thing it is trying to agree with.
 *
 * A provider a server never mentioned is one it does not run: `undefined` here
 * is a no, and the hub says the same in words.
 */
function canStart(view: ServerView, provider: Provider): boolean {
  const readiness = view.providers.find((entry) => entry.provider === provider);
  return readiness !== undefined && readinessRefusal(readiness) === null;
}

/**
 * The machines the user could override the hub's pick with, or `[]` when the
 * control is not drawn.
 *
 * Below two live candidates there is no decision to override -- the hub's pick
 * is the one machine -- so the control is not drawn, which is `[]` here.
 *
 * `provider` narrows what the drawn control offers, and it narrows it for every
 * start rather than only for one in a project: the provider is the user's own
 * choice now, and a machine that cannot honour it is a machine whose start the
 * hub refuses in that machine's own words. The count is taken before the
 * narrowing on purpose. A fleet where only one of four machines can run the
 * chosen provider is worth seeing, and dropping the control instead would
 * silently unchoose the machine the user had already picked.
 *
 * The narrowing can never drop that machine, because the provider on offer came
 * from that machine: see `providerOffer`, and the order the form resolves the
 * two choices in.
 */
export function serverOverrideChoices(
  state: MachineState | null,
  storeId: StoreId | null,
  provider: Provider | null = null,
): readonly ServerChoice[] {
  const candidates = liveServers(state, storeId);
  if (candidates.length < 2) return [];
  return candidates
    .filter((view) => provider === null || canStart(view, provider))
    .map((view) => ({ id: view.registrationId, label: view.label }));
}

/** One provider the form may start, and what is odd about it. */
export interface ProviderOption {
  readonly provider: Provider;
  /**
   * What a machine could not tell about it, or `null`.
   *
   * Beside the option rather than in place of it. A provider whose version
   * probe did not answer is still startable -- the program resolved -- and
   * dropping it would turn "could not tell" into "no", which is the over-claim
   * `readinessRefusal` exists to refuse. So it is offered, with the machine's
   * own sentence next to it, and the person decides.
   */
  readonly caveat: string | null;
}

/**
 * What the provider control may offer, and what to say about the rest.
 *
 * Both halves, because an empty list is not an answer a person can act on. A
 * machine with no adapters in its build, a machine nobody has installed the
 * program on, and a machine that is logged out are three different things to go
 * and do, and each of them arrives here as the sentence the machine that took
 * the reading wrote.
 */
export interface ProviderOffer {
  /** What can be started, first seen first, in the hub's order of machines. */
  readonly options: readonly ProviderOption[];
  /** Why each provider that is not on the list is not, in the machine's words. */
  readonly problems: readonly string[];
}

/**
 * What the chosen machine -- or the whole store, when the hub is placing --
 * says it can start.
 *
 * The union and not a static list, which is the ticket in one line: a server
 * reports its readiness in its handshake, the hub holds it per server, and this
 * is the first surface that asks it what to offer rather than assuming. With no
 * machine chosen the union is over every live machine on the store, because
 * that is exactly the set the hub will schedule onto; with one chosen it is
 * that machine's own answer, because that is the only machine the start can
 * reach.
 *
 * `problems` is reported for a provider nothing here can start, and not for one
 * that some other machine can: a codex that is missing on one of three machines
 * is not a problem to read about, it is a machine the list below has already
 * dropped. The no-adapters line is held to the same rule -- it appears only when
 * nothing at all is on offer, which is the one case where a build carrying no
 * adapters is the answer rather than a detail.
 */
export function providerOffer(
  state: MachineState | null,
  storeId: StoreId | null,
  server: ServerRegistrationId | null,
): ProviderOffer {
  const candidates = liveServers(state, storeId).filter(
    (view) => server === null || view.registrationId === server,
  );

  const startable: Provider[] = [];
  const caveats = new Map<Provider, string[]>();
  for (const view of candidates) {
    for (const readiness of view.providers) {
      if (readinessRefusal(readiness) !== null) continue;
      if (!startable.includes(readiness.provider)) startable.push(readiness.provider);
      if (readiness.state === 'unknown' && readiness.problem !== null) {
        caveats.set(readiness.provider, [
          ...(caveats.get(readiness.provider) ?? []),
          `${view.label}: ${readiness.problem}`,
        ]);
      }
    }
  }

  const problems: string[] = [];
  for (const view of candidates) {
    if (view.providers.length === 0) {
      // A build with no adapters, which is not a machine to go and fix: it is
      // an agentplex that was built without them, and saying "claude is
      // missing" about it would send somebody to install a program that would
      // change nothing.
      if (startable.length === 0) {
        problems.push(
          `${view.label} reports no providers: that build carries no provider adapters`,
        );
      }
      continue;
    }
    for (const readiness of view.providers) {
      if (startable.includes(readiness.provider)) continue;
      const refusal = readinessRefusal(readiness);
      if (refusal === null) continue;
      problems.push(`${view.label} cannot run ${readiness.provider}: ${refusal}`);
    }
  }

  return {
    options: startable.map((provider) => ({
      provider,
      caveat: caveats.get(provider)?.join('; ') ?? null,
    })),
    problems,
  };
}

/**
 * Which provider this start carries, or `null` while the answer is not settled.
 *
 * The one-option rule, applied where the store picker applies it: a list with
 * one entry is not a question, so it is the answer whatever was clicked before.
 * Anything the current offer does not list is forgotten rather than sent -- the
 * component keeps the click in case its option returns, and a choice that is
 * not on offer is a start the hub would refuse.
 */
export function resolveProvider(offer: ProviderOffer, choice: string | null): Provider | null {
  const [only] = offer.options;
  if (offer.options.length === 1 && only !== undefined) return only.provider;
  return offer.options.find((option) => option.provider === choice)?.provider ?? null;
}

/**
 * The prompt as the frame carries it: the wire wants at least one character or
 * `null`, so whitespace-only input is the absence of a prompt, not an empty
 * one. `null` leaves the provider at its own prompt.
 */
export function parsePrompt(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The session-start command, exactly the fields the frame defines.
 *
 * `sessionId` is `null` because this flow only ever starts new sessions, and a
 * new session has no id to name: the provider mints its own and writes it, and
 * the hub learns it from the next scan.
 *
 * `provider` is a parameter and sits next to the store, because those two are
 * what this frame cannot be built without. It was the literal `'claude'` here,
 * which made every session this client started a claude session however the
 * machine was provisioned; `resolveProvider` decides it now, out of what the
 * chosen machine says it can start.
 */
export function buildStart(
  storeId: StoreId,
  provider: Provider,
  server: ServerRegistrationId | null,
  promptText: string,
  project: NodeId | null = null,
): HubCommand {
  return {
    type: 'session-start',
    storeId,
    sessionId: null,
    provider,
    prompt: parsePrompt(promptText),
    server,
    // A node id and never a path. Which directory that project is, is the hub's
    // to answer out of its own rows -- a client that could send the path would
    // be a client choosing a cwd on somebody else's machine.
    project,
  };
}

/**
 * Why submit is disabled, in words, or `null` when it is not.
 *
 * The connection has to be up: the store would queue the command, but a start
 * is intent about *now*, and a form that silently records intent for later is
 * the surprise the queue's own wording exists to soften. The race -- the
 * connection dropping between render and click -- still lands in the queue,
 * and `deliveryWords` is what says so.
 */
export function submitBlockedReason(
  phase: ConnectionPhase,
  stores: readonly StoreId[],
  chosen: StoreId | null,
  offer: ProviderOffer,
  provider: Provider | null,
): string | null {
  switch (phase) {
    case 'idle':
      return 'not connected to the hub';
    case 'connecting':
      return 'still connecting to the hub';
    case 'reconnecting':
      return 'the connection to the hub is down; reconnecting';
    case 'failed':
      return 'the connection has failed and is not retrying';
    case 'connected':
      break;
  }
  if (stores.length === 0) return 'no paired server reports a store to start in';
  if (chosen === null) return 'choose a store to start in';
  // One sentence for the button, naming the controls it is about; what to go
  // and do about it is `offer.problems`, drawn where the list would have been.
  if (offer.options.length === 0) return 'no provider can be started with these choices';
  if (provider === null) return 'choose a provider to run';
  return null;
}

/** What to say about how the command left, or `null` when nothing needs saying. */
export function deliveryWords(delivery: 'sent' | 'queued'): string | null {
  return delivery === 'queued'
    ? 'the connection is down; the start is queued and will be sent when it returns'
    : null;
}

/**
 * The session pane's address, encoded by the route module that parses it.
 *
 * Delegated rather than spelled out again: an address written in one place and
 * read in another is one edit away from a link nothing matches.
 */
export function sessionPaneHash(ref: SessionRef): string {
  return sessionHash(ref);
}

/**
 * What the form does with the hub's answer to the start it sent.
 *
 * `navigate` only when the reply names a session, because only then does a
 * pane address exist: a fresh spawn is answered with `sessionId: null` -- the
 * provider has not written its id yet -- and a route invented around a missing
 * id would never match the id the provider eventually mints, a page that is
 * permanently wrong rather than merely early. That case is `started`: said in
 * words, naming the machine the hub picked, while the session's row arrives
 * with the scan that learns its id.
 */
export type StartFollowUp =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'navigate'; readonly hash: string }
  | { readonly kind: 'started'; readonly words: string }
  | {
      readonly kind: 'refused';
      readonly words: string;
      /** The machine already running it, when that is why the answer was no. */
      readonly held: HeldElsewhere | null;
    };

/**
 * A refusal that named a machine, ready to draw.
 *
 * This is what `refusal.holder` is for: "it is running over here" is a
 * different answer from "no" and leads somewhere, and the way out is stopping
 * the holder. So the machine is named -- through the lookup the list uses, not
 * by reading the hub's sentence -- and the session a stop would be aimed at
 * comes along with it.
 *
 * `session` is `null` whenever the start named none, which is every start this
 * form sends today: a new session has no id until the provider writes one, and
 * a session nobody has started is a session nobody is holding. A stop has to
 * address `{ storeId, sessionId }`, so the button exists exactly when there is
 * something to aim it at, and a resume -- a start that does name a session, and
 * the only kind a holder can refuse -- is what makes it appear.
 */
export interface HeldElsewhere {
  readonly holder: SessionHolder;
  /** The holder's label, or its registration id when the frame describes none. */
  readonly machine: string;
  /** The session to aim a stop at, or `null` when the start named none. */
  readonly session: SessionRef | null;
}

export function startFollowUp(
  pending: FrameId,
  lastStarted: StartedView | null,
  lastRefusal: RefusalView | null,
  state: MachineState | null,
  /** The session the start named, or `null` for a fresh spawn. */
  asked: SessionRef | null,
): StartFollowUp {
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    const { holder } = lastRefusal;
    return {
      kind: 'refused',
      words: lastRefusal.message,
      held:
        holder === null
          ? null
          : {
              holder,
              machine: state === null ? holder.server : serverLabel(state, holder.server),
              session: asked,
            },
    };
  }
  if (lastStarted !== null && lastStarted.replyTo === pending) {
    if (lastStarted.sessionId !== null) {
      return {
        kind: 'navigate',
        hash: sessionPaneHash({ storeId: lastStarted.storeId, sessionId: lastStarted.sessionId }),
      };
    }
    const label = state === null ? lastStarted.server : serverLabel(state, lastStarted.server);
    return {
      kind: 'started',
      words: `started on ${label}; the session appears in the list once the provider writes its first turn`,
    };
  }
  return { kind: 'waiting' };
}
