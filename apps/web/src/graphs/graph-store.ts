import type {
  FrameId,
  GraphDocument,
  GraphNodeId,
  GraphPublishedVersion,
  NodeId,
} from '@agentplex/protocol';
import type {
  CommandOutcome,
  ConnectionPhase,
  GraphDocumentView,
  GraphPublishedView,
  GraphSavedView,
  HubCommand,
  RefusalView,
} from '../store/hub-store.js';
import type { GraphEdit } from './graph-model.js';

/**
 * One open graph, as an external store the screen owns.
 *
 * ## Why the draft lives here and not in React, and not in the hub store
 *
 * The edits somebody has made and not yet saved are the one thing on this
 * screen that cannot be fetched again, for the reason a document's typing
 * cannot (`docs/doc-editor-store.ts`): React state would tie them to a mount,
 * and the hub store deliberately drops the graph it holds when the connection
 * goes. A store the screen holds for as long as it is on screen outlives every
 * reconnection underneath it, which is the lifetime unsaved work has.
 *
 * ## Dirty is a comparison, not a flag
 *
 * `dirty` is whether the document differs from the one the hub last
 * confirmed -- the answer to the open, or the document a landed save carried.
 * A save that lands after a further edit therefore leaves the draft dirty,
 * because the baseline becomes what was *sent* and not what is on screen.
 *
 * ## Save is a button
 *
 * There is no idle save here, and nothing is written when the screen closes.
 * A document's editor writes on the way out because a text file on a disk
 * has no version but the last one; a graph draft is the hub's, Publish reads
 * it whole, and a save nobody pressed would publish an edit somebody may have
 * been walking away from. Publish therefore saves first when the draft is
 * dirty, so what is published is what is on screen and never a draft the
 * person last saw a minute ago.
 *
 * ## What it does when the connection comes back
 *
 * It asks for the graph again, and only when there is nothing unsaved to
 * lose: another client may have saved the draft while this one was away, and
 * a clean screen showing that copy is the honest one. A dirty screen keeps
 * its edits; the next Save is what settles which copy the hub holds.
 */

export interface GraphStoreHub {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    readonly phase: ConnectionPhase;
    readonly lastGraphDocument: GraphDocumentView | null;
    readonly lastGraphSaved: GraphSavedView | null;
    readonly lastGraphPublished: GraphPublishedView | null;
    readonly lastRefusal: RefusalView | null;
  };
  sendCommand(command: HubCommand): CommandOutcome;
}

export interface GraphState {
  /** What the tree calls the graph, once the hub has answered. */
  readonly name: string | null;
  /** The draft's number, once the hub has answered. */
  readonly draftVersion: number | null;
  readonly published: readonly GraphPublishedVersion[];
  /** The draft as edited, or `null` until the hub has answered the open. */
  readonly document: GraphDocument | null;
  /** The node the inspector is about, or `null`. */
  readonly selection: GraphNodeId | null;
  /** Whether the document differs from the one the hub last confirmed. */
  readonly dirty: boolean;
  /** The draft the last landed save was of, and the hub's clock for it. */
  readonly savedVersion: number | null;
  readonly savedAt: number | null;
  /** A save is out and unanswered. */
  readonly saving: boolean;
  /** A publish is out and unanswered. */
  readonly publishing: boolean;
  /** The last thing the hub or the model said no to, in its words, or `null`. */
  readonly problem: string | null;
}

export interface GraphStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): GraphState;
  /** Applies one edit from `graph-model.ts`; a refusal becomes `problem`. */
  edit(change: (document: GraphDocument) => GraphEdit): void;
  select(id: GraphNodeId | null): void;
  /** Sends the draft when it is dirty; does nothing otherwise. */
  save(): void;
  /** Saves first when dirty, then asks the hub to stamp the draft. */
  publish(): void;
}

export interface GraphStoreDependencies {
  readonly hub: GraphStoreHub;
  readonly nodeId: NodeId;
}

const EMPTY: GraphState = {
  name: null,
  draftVersion: null,
  published: [],
  document: null,
  selection: null,
  dirty: false,
  savedVersion: null,
  savedAt: null,
  saving: false,
  publishing: false,
  problem: null,
};

export function createGraphStore({ hub, nodeId }: GraphStoreDependencies): GraphStore {
  const listeners = new Set<() => void>();
  let state: GraphState = EMPTY;
  /** The document the hub last confirmed; dirty is the draft differing from it. */
  let confirmed: GraphDocument | null = null;
  /** The document the save in flight carries, kept until it is answered. */
  let inFlight: GraphDocument | null = null;
  let openFrame: FrameId | null = null;
  /** The last answer taken, so one answer is applied once however often the snapshot moves. */
  let takenAnswer: GraphDocumentView | null = null;
  let saveFrame: FrameId | null = null;
  let publishFrame: FrameId | null = null;
  let detachHub: (() => void) | null = null;
  /** The phase at the last notification, so a reconnection is an edge. */
  let phaseBefore: ConnectionPhase = 'idle';

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function moveTo(patch: Partial<GraphState>): void {
    const merged = { ...state, ...patch };
    const next: GraphState = {
      ...merged,
      dirty: merged.document !== null && merged.document !== confirmed,
    };
    if (sameState(next, state)) return;
    state = next;
    notify();
  }

  function askForGraph(): void {
    const outcome = hub.sendCommand({ type: 'graph-open', nodeId });
    if (outcome.accepted) {
      openFrame = outcome.id;
      moveTo({ problem: null });
    } else {
      moveTo({ problem: outcome.reason });
    }
  }

  function sendSave(document: GraphDocument): boolean {
    const outcome = hub.sendCommand({ type: 'graph-save', nodeId, document });
    if (!outcome.accepted) {
      moveTo({ problem: outcome.reason });
      return false;
    }
    saveFrame = outcome.id;
    inFlight = document;
    moveTo({ saving: true, problem: null });
    return true;
  }

  /**
   * The hub's snapshot changed. Every answer is matched on the frame this
   * store is waiting for, or on the node for the open, which is what keeps
   * one screen's refusal out of another's draft.
   */
  function onHubChange(): void {
    const snapshot = hub.getSnapshot();

    // Filed by node and not by frame, the way the hub store files it: a graph
    // is a screen with one of it per node, and any open of this node -- this
    // store's or a remount's -- is an answer this store wants.
    const answer = snapshot.lastGraphDocument;
    if (answer !== null && answer !== takenAnswer && answer.nodeId === nodeId) {
      takenAnswer = answer;
      openFrame = null;
      confirmed = answer.document;
      moveTo({
        name: answer.name,
        draftVersion: answer.draftVersion,
        published: answer.published,
        document: answer.document,
        selection:
          state.selection !== null &&
          answer.document.nodes.some((node) => node.id === state.selection)
            ? state.selection
            : null,
        problem: null,
      });
    }

    const saved = snapshot.lastGraphSaved;
    if (saved !== null && saveFrame !== null && saved.replyTo === saveFrame) {
      saveFrame = null;
      confirmed = inFlight;
      inFlight = null;
      moveTo({ saving: false, savedVersion: saved.version, savedAt: saved.updatedAt });
    }

    const published = snapshot.lastGraphPublished;
    if (published !== null && publishFrame !== null && published.replyTo === publishFrame) {
      publishFrame = null;
      // The hub opened a new draft copying what it stamped, so the document on
      // screen is that draft; its number and the published list are the hub's
      // to say, and the re-ask is what brings them.
      confirmed = state.document;
      moveTo({ publishing: false });
      askForGraph();
    }

    const no = snapshot.lastRefusal;
    if (no !== null) {
      if (no.replyTo === openFrame) {
        openFrame = null;
        moveTo({ problem: no.message });
      } else if (no.replyTo === saveFrame) {
        saveFrame = null;
        inFlight = null;
        moveTo({ saving: false, problem: no.message });
      } else if (no.replyTo === publishFrame) {
        publishFrame = null;
        moveTo({ publishing: false, problem: no.message });
      }
    }

    const phase = snapshot.phase;
    const returned = phase === 'connected' && phaseBefore !== 'connected';
    phaseBefore = phase;
    if (returned && state.document !== null && !state.dirty && openFrame === null) {
      askForGraph();
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        phaseBefore = hub.getSnapshot().phase;
        detachHub = hub.subscribe(onHubChange);
        // The open goes out now whatever the connection is doing: the hub
        // store queues a command made while it is down and flushes it on the
        // next welcome, which is the same wait, said once.
        askForGraph();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          detachHub?.();
          detachHub = null;
        }
      };
    },

    getSnapshot(): GraphState {
      return state;
    },

    edit(change): void {
      if (state.document === null) return;
      const edit = change(state.document);
      if (!edit.ok) {
        moveTo({ problem: edit.problem });
        return;
      }
      const selection =
        state.selection !== null && edit.document.nodes.some((node) => node.id === state.selection)
          ? state.selection
          : null;
      moveTo({ document: edit.document, selection, problem: null });
    },

    select(id): void {
      moveTo({ selection: id });
    },

    save(): void {
      if (state.document === null || !state.dirty) return;
      sendSave(state.document);
    },

    publish(): void {
      if (state.document === null) return;
      if (state.dirty && !sendSave(state.document)) return;
      const outcome = hub.sendCommand({ type: 'graph-publish', nodeId });
      if (!outcome.accepted) {
        moveTo({ problem: outcome.reason });
        return;
      }
      publishFrame = outcome.id;
      moveTo({ publishing: true, problem: null });
    },
  };
}

function sameState(a: GraphState, b: GraphState): boolean {
  return (
    a.name === b.name &&
    a.draftVersion === b.draftVersion &&
    a.published === b.published &&
    a.document === b.document &&
    a.selection === b.selection &&
    a.dirty === b.dirty &&
    a.savedVersion === b.savedVersion &&
    a.savedAt === b.savedAt &&
    a.saving === b.saving &&
    a.publishing === b.publishing &&
    a.problem === b.problem
  );
}
