import { graphNameSchema, type FrameId, type NodeId } from '@agentplex/protocol';
import type {
  CommandOutcome,
  ConnectionPhase,
  GraphCreatedView,
  HubCommand,
  RefusalView,
} from '../store/hub-store.js';

/**
 * Every rule the New graph form follows, as functions of values, and the one
 * piece that is not: the store that sends the create and acts on the answer.
 *
 * ## Why the name is parsed here as well as on the wire
 *
 * `graphNameSchema` is the protocol's, and the hub refuses what it refuses.
 * Running it here is the same answer one round trip earlier, in the schema's
 * own words, which is why this returns the schema's sentence and not one
 * written here.
 *
 * ## Why the answer is acted on in a store and not an effect
 *
 * Opening the new graph is an imperative navigation answering an
 * asynchronous hub reply. The document form does that in a `useEffect`, with
 * the justification written beside it; this form does it in the listener of
 * an external store instead, because a listener is already outside render
 * and already the place a hub answer arrives. The callback that opens the
 * graph is handed in with the submit rather than at construction, so it is
 * the one from the render that pressed the button and no stale closure has
 * to be worked around.
 */

export type GraphNameVerdict =
  { readonly ok: true; readonly name: string } | { readonly ok: false; readonly problem: string };

/** The name as the protocol reads it, trimmed first, or the schema's sentence. */
export function parseGraphName(text: string): GraphNameVerdict {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, problem: 'give the graph a name' };
  const parsed = graphNameSchema.safeParse(trimmed);
  if (parsed.success) return { ok: true, name: parsed.data };
  const first = parsed.error.issues[0];
  return { ok: false, problem: first?.message ?? 'that is not a graph name' };
}

/** The graph-create command, exactly the fields the frame defines. */
export function buildGraphCreate(projectId: NodeId, name: string): HubCommand {
  return { type: 'graph-create', projectId, name };
}

/**
 * Why the create is disabled, in words, or `null` when it is not.
 *
 * The connection has to be up for the reason a project create needs one: the
 * store would queue the command, and a form that silently records intent for
 * later is the surprise the queue's own wording exists to soften.
 */
export function graphCreateBlockedReason(
  phase: ConnectionPhase,
  name: string,
  projectId: NodeId | null,
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
  const verdict = parseGraphName(name);
  if (!verdict.ok) return verdict.problem;
  if (projectId === null) return 'pick the project this graph belongs to';
  return null;
}

export interface GraphCreationHub {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    readonly phase: ConnectionPhase;
    readonly lastGraphCreated: GraphCreatedView | null;
    readonly lastRefusal: RefusalView | null;
  };
  sendCommand(command: HubCommand): CommandOutcome;
}

export interface GraphCreationState {
  /** A create is out and unanswered. */
  readonly waiting: boolean;
  /** The hub's, or the store's own, no to the last submit, or `null`. */
  readonly refused: string | null;
}

export interface GraphCreation {
  subscribe(listener: () => void): () => void;
  getSnapshot(): GraphCreationState;
  /** Sends the create; `onMade` is called once with the node the hub named. */
  submit(projectId: NodeId, name: string, onMade: (nodeId: NodeId) => void): void;
  /** Forgets the last refusal, for a form that is closed or typed into again. */
  reset(): void;
}

export interface GraphCreationDependencies {
  readonly hub: GraphCreationHub;
}

const IDLE: GraphCreationState = { waiting: false, refused: null };

export function createGraphCreation({ hub }: GraphCreationDependencies): GraphCreation {
  const listeners = new Set<() => void>();
  let state: GraphCreationState = IDLE;
  let pending: { readonly id: FrameId; readonly onMade: (nodeId: NodeId) => void } | null = null;
  let detachHub: (() => void) | null = null;

  function moveTo(next: GraphCreationState): void {
    if (next.waiting === state.waiting && next.refused === state.refused) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function onHubChange(): void {
    if (pending === null) return;
    const snapshot = hub.getSnapshot();
    const made = snapshot.lastGraphCreated;
    if (made !== null && made.replyTo === pending.id) {
      const { onMade } = pending;
      pending = null;
      moveTo(IDLE);
      onMade(made.nodeId);
      return;
    }
    const no = snapshot.lastRefusal;
    if (no !== null && no.replyTo === pending.id) {
      pending = null;
      moveTo({ waiting: false, refused: no.message });
    }
  }

  function listen(): void {
    if (detachHub === null) detachHub = hub.subscribe(onHubChange);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listen();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && pending === null) {
          detachHub?.();
          detachHub = null;
        }
      };
    },

    getSnapshot() {
      return state;
    },

    submit(projectId, name, onMade) {
      if (hub.getSnapshot().phase !== 'connected') {
        // Refused rather than queued: a create that went out on the next
        // welcome would make a graph in a tree nobody is looking at any more.
        moveTo({ waiting: false, refused: 'not connected to the hub; nothing was sent' });
        return;
      }
      const outcome = hub.sendCommand(buildGraphCreate(projectId, name));
      if (!outcome.accepted) {
        moveTo({ waiting: false, refused: outcome.reason });
        return;
      }
      // The answer has to be heard even if the form's subscriber is gone by
      // the time it lands, so the hub is listened to for as long as a create
      // is out.
      listen();
      pending = { id: outcome.id, onMade };
      moveTo({ waiting: true, refused: null });
    },

    reset() {
      moveTo({ waiting: state.waiting, refused: null });
    },
  };
}
