import type {
  FrameId,
  MachineState,
  ServerRegistrationId,
  SessionRef,
  StoreId,
} from '@agentplex/protocol';
import type { ConnectionPhase, HubCommand, RefusalView, StartedView } from '../store/hub-store.js';

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
 */
export function serverOverrideChoices(
  state: MachineState,
  storeId: StoreId | null,
): readonly ServerChoice[] {
  if (storeId === null) return [];
  const store = state.stores.find((view) => view.storeId === storeId);
  if (store === undefined) return [];
  const choices: ServerChoice[] = [];
  for (const id of store.servers) {
    const server = state.servers.find((view) => view.registrationId === id);
    if (server !== undefined && server.phase === 'connected') {
      choices.push({ id, label: server.label });
    }
  }
  return choices.length < 2 ? [] : choices;
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
): HubCommand {
  return {
    type: 'session-start',
    storeId,
    sessionId: null,
    provider: 'claude',
    prompt: parsePrompt(promptText),
    server,
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

/** The session pane's address, the shape the terminal-pane route parses. */
export function sessionPaneHash(ref: SessionRef): string {
  return `#/session/${encodeURIComponent(ref.storeId)}/${encodeURIComponent(ref.sessionId)}`;
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
  | { readonly kind: 'refused'; readonly words: string };

export function startFollowUp(
  pending: FrameId,
  lastStarted: StartedView | null,
  lastRefusal: RefusalView | null,
  state: MachineState | null,
): StartFollowUp {
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    return { kind: 'refused', words: lastRefusal.message };
  }
  if (lastStarted !== null && lastStarted.replyTo === pending) {
    if (lastStarted.sessionId !== null) {
      return {
        kind: 'navigate',
        hash: sessionPaneHash({ storeId: lastStarted.storeId, sessionId: lastStarted.sessionId }),
      };
    }
    const label =
      state?.servers.find((server) => server.registrationId === lastStarted.server)?.label ??
      lastStarted.server;
    return {
      kind: 'started',
      words: `started on ${label}; the session appears in the list once the provider writes its first turn`,
    };
  }
  return { kind: 'waiting' };
}
