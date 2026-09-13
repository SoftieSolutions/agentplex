import type {
  FrameId,
  MachineState,
  NodeId,
  Provider,
  ServerRegistrationId,
  SessionHolder,
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
 * store picker with one store is not drawn (the store is named in words), and
 * the server override appears only when more than one connected server could
 * actually run the chosen store. The provider is on the frame -- it is a field
 * of every session -- but v2 ships one adapter, so it is named in words and
 * never drawn as a choice.
 *
 * The project picker follows the same rule from the other end: it is drawn when
 * there is at least one project, because "in a project" and "wherever the store
 * is" are two different starts and a form with no way to say which would only
 * ever make the second. Choosing one narrows the machine list, and the
 * narrowing is the hub's rule reflected rather than a second one: a start in a
 * project is refused by a machine that cannot run the provider, so a menu
 * offering such a machine would be offering a refusal.
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
 * The machines the user could override the hub's pick with, or `[]` when the
 * control is not drawn.
 *
 * Only servers that are attached to the store *and* connected right now: an
 * override naming a stale machine would be refused, and offering a choice that
 * can only be refused is worse than no control. Below two live candidates
 * there is no decision to override -- the hub's pick is the one machine -- so
 * the control is not drawn, which is `[]` here.
 *
 * `provider` narrows it further and is passed only when a project was chosen.
 * The narrowing is not extra caution: a machine that reported the provider
 * missing is a machine the hub refuses the start on, with that machine's own
 * sentence, and a menu that listed it would be a menu of one live option and
 * one apology. It is applied for a project start and not for every start
 * because a project start is the one the user is steering -- when the hub is
 * choosing, it already filters the candidates itself and an unusable machine
 * costs its own machine a start and never the store.
 */
export function serverOverrideChoices(
  state: MachineState,
  storeId: StoreId | null,
  provider: Provider | null = null,
): readonly ServerChoice[] {
  if (storeId === null) return [];
  const store = state.stores.find((view) => view.storeId === storeId);
  if (store === undefined) return [];
  const choices: ServerChoice[] = [];
  for (const id of store.servers) {
    const server = state.servers.find((view) => view.registrationId === id);
    if (server === undefined || server.phase !== 'connected') continue;
    if (provider !== null && !runs(server.providers, provider)) continue;
    choices.push({ id, label: server.label });
  }
  return choices.length < 2 ? [] : choices;
}

/**
 * Whether that machine said it can run this provider.
 *
 * `ready` and nothing else. A provider a server never mentioned is one it does
 * not run, and one it reported as missing or broken is one the start is refused
 * on -- the hub says so in the machine's own words, and this is the client
 * declining to offer the question.
 */
function runs(
  providers: readonly { readonly provider: Provider; readonly state: string }[],
  provider: Provider,
): boolean {
  return providers.some((entry) => entry.provider === provider && entry.state === 'ready');
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
 * the hub learns it from the next scan. `provider` is fixed to claude -- on
 * the frame because every session names its provider, not drawn because a
 * control with one option is not drawn.
 */
export function buildStart(
  storeId: StoreId,
  server: ServerRegistrationId | null,
  promptText: string,
  project: NodeId | null = null,
): HubCommand {
  return {
    type: 'session-start',
    storeId,
    sessionId: null,
    provider: 'claude',
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
