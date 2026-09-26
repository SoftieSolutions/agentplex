import type { ClientFrame, FrameId, HubFrame } from '@agentplex/protocol';

/**
 * A command is a client frame body without its id: ids belong to the store's
 * counter, minted at the moment of acceptance so a queued command keeps one
 * identity from enqueue to reply. `hello` and `ping` are not commands — the
 * connection machinery owns them — and `layout-request` and
 * `pane-layout-request` are subscriptions (standing interest), not requests
 * the user makes once. `pane-layout-save` is a command: a save is something
 * that happened once, and if the connection is down when it does, the queue
 * carries it — later saves replay after it, so the hub still ends on the
 * newest arrangement. `directory-list` is a command too, and the queue is the
 * right place for it rather than the wrong one: a person browsing while the
 * connection blinks asked a question once, and the answer is as good a moment
 * later. It is not standing interest — nothing re-lists a directory on every
 * reconnection — so it is not a subscription. `project-create`, the five tree
 * edits and the three document frames are commands for the plainest reason of
 * all: each is something the user did once, and a queue is where a once-only
 * intent waits. `session-acknowledge` and `session-mute` are commands for that
 * same reason, and the queue is righter for them than it is for a stop:
 * dismissing a prompt while the connection blinks is still dismissing that
 * prompt, and the hub stamps the moment when it reads the frame rather than
 * when the user clicked — so what a queued acknowledgement ends up worth is
 * decided by whether the session spoke in the meantime, which is the rule an
 * acknowledgement already lives by. `push-subscribe` and `push-unsubscribe`
 * are commands for the same reason, and the queue is right for them in a way
 * it is not for a pairing: neither carries a credential -- a push endpoint is
 * a capability for reaching that browser, minted by its own push service, and
 * it is what the hub stores rather than a secret the user typed -- and turning
 * notifications on while the connection blinks is still turning them on.
 *
 * The three policy frames are commands for the plainest reason too: reading a
 * project's rules is a question asked once by somebody who opened a panel, and
 * writing or removing one is something a person did once. None of them is
 * standing interest -- nothing re-reads a policy on every reconnection, the way
 * the layout is re-asked -- so none of them is a subscription. Queueing a write
 * over a blink is right for the same reason it is right for an acknowledgement:
 * "stop asking me about this" is still what the person meant a second later,
 * and the hub refuses the rule if it has since become one it will not take.
 *
 * `approval-decide` is a command for that reason too, and it is the one where
 * queueing looks riskiest and is not: a decision held over a blink can reach a
 * hub that has nothing left to apply it to. What makes it safe is that the hub
 * says so -- `withdrawn` for a question the agent took back, `expired` for a
 * hook that stopped waiting -- so a late answer is reported as what it was
 * rather than swallowed or mistaken for a denial. Dropping it instead would
 * lose the one case that matters most: a person answering the moment they saw
 * the request, over a connection that blinked while they read it.
 */
type CommandFrame = Extract<
  ClientFrame,
  {
    type:
      | 'session-start'
      | 'session-stop'
      | 'session-pause'
      | 'session-resume'
      | 'session-acknowledge'
      | 'session-mute'
      | 'approval-decide'
      | 'approval-policy-list'
      | 'approval-policy-add'
      | 'approval-policy-remove'
      | 'pane-layout-save'
      | 'directory-list'
      | 'project-create'
      | 'node-create-folder'
      | 'node-rename'
      | 'node-move'
      | 'node-remove'
      | 'node-forget-removal'
      | 'doc-create'
      | 'doc-save'
      | 'doc-open'
      | 'graph-create'
      | 'graph-open'
      | 'graph-save'
      | 'graph-publish'
      | 'graph-run'
      | 'graph-run-cancel'
      | 'graph-run-read'
      | 'graph-run-history-request'
      | 'graph-run-open'
      | 'graph-simulate'
      | 'push-subscribe'
      | 'push-unsubscribe'
      | 'session-transcript';
  }
>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type HubCommand = DistributiveOmit<CommandFrame, 'id'>;

export type CommandOutcome =
  | { readonly accepted: true; readonly id: FrameId; readonly delivery: 'sent' | 'queued' }
  | { readonly accepted: false; readonly reason: string };

/**
 * A request the store sends now or not at all, and then waits for.
 *
 * The pairing frames and nothing else so far: they carry a credential, which
 * is why they may not queue, and they change what the hub may dial, which is
 * why the screen that sent one waits for the answer rather than inferring it
 * from the next state.
 */
type RequestFrame = Extract<ClientFrame, { type: 'server-pair' | 'server-unpair' }>;
export type HubRequest = DistributiveOmit<RequestFrame, 'id'>;

/**
 * What the hub answered, as a value.
 *
 * A refusal is not a failure to send: the hub read the frame and said no, and
 * its words are what the screen shows. `reason` therefore covers both -- the
 * hub's refusal and the store's own "there is no connection to send this on" --
 * because to whoever submitted the form they are the same kind of sentence.
 */
export type RequestOutcome =
  | {
      readonly ok: true;
      readonly reply: Extract<HubFrame, { type: 'server-paired' | 'server-unpaired' }>;
    }
  | { readonly ok: false; readonly reason: string };

export type TerminalInputOutcome =
  { readonly delivered: true } | { readonly delivered: false; readonly reason: string };

/** The one place a client frame becomes characters. */
export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}
