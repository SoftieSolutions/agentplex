import type { FrameId, MachineState, SessionHolder, SessionRef } from '@agentplex/protocol';
import type { HubCommand, RefusalView, StoppedView } from '../store/hub-store.js';
import { findSessionRow } from '../terminal/presentation.js';
import { serverLabel } from './session-list-model.js';

/**
 * Everything stopping a session decides, as pure functions: whether the
 * affordance exists at all, what the frame carries, what to make of the hub's
 * answer, and what a list says about a stop that landed somewhere else.
 *
 * The components own nothing but the id of the stop they are waiting on.
 */

/**
 * Whether a stop is offered at all.
 *
 * The whole rule, and it is one field: the hub publishes `stoppable` as the
 * answer of the server that holds the process, and nothing here re-derives it
 * from a status. A status is read out of a transcript and describes the
 * session; `stoppable` is a live process on one machine right now. A session
 * can be `idle` and held by an agent sitting at its own prompt, and `working`
 * and held by nobody at all, so a button drawn off the status would appear
 * where there is nothing to stop and vanish where there is.
 *
 * A busy holder -- one mid-turn -- is `stoppable: false` and gets no button,
 * because interrupting a turn mid-tool is how a half-applied edit is left on
 * disk. The hub refuses one anyway; this is the half that does not offer it.
 */
export function offersStop(holder: SessionHolder | null): boolean {
  return holder !== null && holder.stoppable;
}

/**
 * The stop command, exactly the fields the frame defines.
 *
 * `{ storeId, sessionId }` and nothing else: the hub resolves which server
 * holds the session and that server resolves its own terminal, so no machine,
 * no terminal handle and no pid is named here. The worst a client can do with
 * a stop is stop a session it can already see.
 */
export function stopCommand(ref: SessionRef): HubCommand {
  return { type: 'session-stop', storeId: ref.storeId, sessionId: ref.sessionId };
}

/**
 * Where a stop the user asked for has got to.
 *
 * `stopped` and `refused` are both answers and both end the wait; `waiting` is
 * what disables the button, so an answer that never comes leaves it disabled
 * rather than inviting a second kill. The connection dropping clears the wait
 * elsewhere -- the store says in words that the command went unanswered.
 */
export type StopFollowUp =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'refused'; readonly words: string };

/**
 * What the hub has said about the stop this screen is waiting on.
 *
 * Correlated by `replyTo` and never by "the most recent answer": the snapshot
 * holds one refusal and one stop for the whole page, and a card that read the
 * newest of either would show another card's answer beside its own button.
 */
export function stopFollowUp(
  pending: FrameId | null,
  lastStopped: StoppedView | null,
  lastRefusal: RefusalView | null,
): StopFollowUp {
  if (pending === null) return { kind: 'idle' };
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    return { kind: 'refused', words: lastRefusal.message };
  }
  if (lastStopped !== null && lastStopped.replyTo === pending) return { kind: 'stopped' };
  return { kind: 'waiting' };
}

/**
 * The one line a list says about a stop that landed, or `null` when none has.
 *
 * Rendered out of the reply's own payload rather than out of the state that
 * follows it, which is why the payload is kept: a stop is answered to the
 * client that asked, and this tab may not be that client. Without this, a
 * session another tab stopped is a row that quietly stops being held, with
 * nothing anywhere saying why.
 *
 * The session is named out of the state when the state still describes it, and
 * by its id when it does not. A stop whose store has since gone unreachable is
 * still a stop that happened, and an id is a truthful name for it.
 */
export function stoppedNotice(
  state: MachineState | null,
  stopped: StoppedView | null,
): string | null {
  if (stopped === null) return null;
  const row = findSessionRow(state, { storeId: stopped.storeId, sessionId: stopped.sessionId });
  const name = row?.descriptor.title ?? stopped.sessionId;
  const machine = state === null ? stopped.server : serverLabel(state, stopped.server);
  return `stopped ${name} on ${machine}`;
}
