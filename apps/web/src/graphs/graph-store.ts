import type {
  FrameId,
  GraphDocument,
  GraphNodeId,
  GraphPublishedVersion,
  GraphRunId,
  GraphRunState,
  NodeId,
  RouteInput,
} from '@agentplex/protocol';
import type {
  CommandOutcome,
  ConnectionPhase,
  GraphDocumentView,
  GraphPublishedView,
  GraphSavedView,
  HubCommand,
  RefusalView,
  RunCancelledView,
  RunLatestView,
  RunStartedView,
} from '../store/hub-store.js';
import type { GraphEdit } from './graph-model.js';
import { isRunOpen } from './run-model.js';

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
 * person last saw a minute ago -- and it sends the publish only once the hub
 * has confirmed that save. Sent in the same breath, a refused save and an
 * accepted publish would stamp the draft the hub already held and quietly
 * drop the edits; chained, a refused save is the end of it and the refusal
 * is what the screen shows.
 *
 * What a landed publish confirms is the document that was sent, never the
 * one on screen: an edit made while the publish was out is still unsaved
 * afterwards, and the hub's re-asked answer brings the new draft's number
 * and the published list without replacing that edit.
 *
 * ## What it does when the connection goes, and when it comes back
 *
 * The hub store forgets every unanswered frame when the socket closes and
 * sends no refusal for them, so a save, a publish or the open itself would
 * otherwise stay "out" for ever. Leaving the connected phase is therefore an
 * edge here: whatever was in flight is dropped, Save and Publish come back,
 * and the graph is asked for again -- queued by the hub store until the next
 * welcome -- when there is nothing unsaved to lose: another client may have
 * saved the draft while this one was away, and a clean screen showing that
 * copy is the honest one. A dirty screen keeps its edits; the next Save is
 * what settles which copy the hub holds.
 *
 * ## The run is asked for, on open and on every reconnection
 *
 * A run's states arrive only while a socket is up, and the hub store drops
 * the ones it holds when the socket goes. The run this store holds is kept
 * -- the strip should not go blank because a socket did -- but it is where
 * the run was when the connection went, and a run that ended meanwhile, or
 * that the hub's restart swept, would otherwise read `live` for ever with
 * Run disabled and Cancel refused. So the store sends `graph-run-read` with
 * the open and again on every drop, marks the run it holds stale until the
 * answer lands, and takes the answer whole: the graph's newest run, or the
 * hub's word that it has never run, in the one frame that answers the read.
 * Run is held while the read is out, for the same reason a second Run is
 * held while a run is live: a run started from another tab, or by this one
 * just as its socket went, is a run.
 *
 * The run shown is the graph's newest, whoever started it. A state carries
 * its graph, so the store picks the highest-numbered run of this graph out
 * of what the hub store holds; a run of another graph is somebody else's.
 */

export interface GraphStoreHub {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    readonly phase: ConnectionPhase;
    readonly lastGraphDocument: GraphDocumentView | null;
    readonly lastGraphSaved: GraphSavedView | null;
    readonly lastGraphPublished: GraphPublishedView | null;
    readonly lastRunStarted: RunStartedView | null;
    readonly lastRunCancelled: RunCancelledView | null;
    readonly lastRunLatest: RunLatestView | null;
    readonly runs: ReadonlyMap<GraphRunId, GraphRunState>;
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
  /**
   * The graph's newest run as the hub last said it stood, or `null` while
   * the hub has said there is none, or has not answered yet.
   */
  readonly run: GraphRunState | null;
  /**
   * `run` is from a connection that is gone and the hub has not yet said
   * where it stands. Drawn at rest and never as live; Cancel is refused.
   */
  readonly runStale: boolean;
  /** A read of the graph's run is out and unanswered. Run waits for it. */
  readonly readingRun: boolean;
  /** A run is out and unanswered. */
  readonly starting: boolean;
  /** A cancel is out and unanswered. */
  readonly cancelling: boolean;
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
  /** Runs the newest published version with this input. Does nothing while a run is in flight or being asked about. */
  run(input: RouteInput): void;
  /** Asks the hub to stop the graph's run before its next step. Does nothing for a stale run. */
  cancelRun(): void;
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
  run: null,
  runStale: false,
  readingRun: false,
  starting: false,
  cancelling: false,
  problem: null,
};

export function createGraphStore({ hub, nodeId }: GraphStoreDependencies): GraphStore {
  const listeners = new Set<() => void>();
  let state: GraphState = EMPTY;
  /** The document the hub last confirmed; dirty is the draft differing from it. */
  let confirmed: GraphDocument | null = null;
  /** The document the save in flight carries, kept until it is answered. */
  let inFlight: GraphDocument | null = null;
  /** The hub's draft as this store knew it when the publish went out. */
  let publishedDocument: GraphDocument | null = null;
  /** A publish is waiting on the save that went out first. */
  let publishAfterSave = false;
  let openFrame: FrameId | null = null;
  /** The last answer taken, so one answer is applied once however often the snapshot moves. */
  let takenAnswer: GraphDocumentView | null = null;
  let saveFrame: FrameId | null = null;
  let publishFrame: FrameId | null = null;
  let runFrame: FrameId | null = null;
  let cancelFrame: FrameId | null = null;
  /** The read of the graph's run that is out, or `null`. */
  let readFrame: FrameId | null = null;
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
      // Stale is a held run with its read out: the two facts, not a third.
      runStale: merged.run !== null && merged.readingRun,
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

  /** Asks where the graph's run stands. Queued by the hub store while the connection is down. */
  function askForRun(): void {
    const outcome = hub.sendCommand({ type: 'graph-run-read', nodeId });
    if (outcome.accepted) {
      readFrame = outcome.id;
      moveTo({ readingRun: true });
    } else {
      moveTo({ problem: outcome.reason });
    }
  }

  /** The graph's newest run among what the hub store holds, or `null`. */
  function newestRun(runs: ReadonlyMap<GraphRunId, GraphRunState>): GraphRunState | null {
    let newest: GraphRunState | null = null;
    for (const run of runs.values()) {
      if (run.nodeId !== nodeId) continue;
      if (newest === null || run.number > newest.number) newest = run;
    }
    return newest;
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

  function sendPublish(): void {
    const outcome = hub.sendCommand({ type: 'graph-publish', nodeId });
    if (!outcome.accepted) {
      moveTo({ publishing: false, problem: outcome.reason });
      return;
    }
    publishFrame = outcome.id;
    publishedDocument = confirmed;
    moveTo({ publishing: true, problem: null });
  }

  /**
   * The connection went with frames out: the hub store has forgotten them
   * and will answer none of them, so nothing here may wait on one.
   */
  function dropInFlight(): void {
    const waited =
      saveFrame !== null
        ? 'save'
        : publishFrame !== null
          ? 'publish'
          : runFrame !== null
            ? 'run'
            : cancelFrame !== null
              ? 'cancel'
              : null;
    openFrame = null;
    saveFrame = null;
    inFlight = null;
    publishFrame = null;
    publishedDocument = null;
    publishAfterSave = false;
    // A run, a cancel or a read that was out goes the same way: the hub
    // store forgot the frame, so nothing will ever answer it. The run this
    // store holds stays, stale, until the read below is answered.
    runFrame = null;
    cancelFrame = null;
    readFrame = null;
    moveTo({
      saving: false,
      publishing: false,
      starting: false,
      cancelling: false,
      ...(waited === null
        ? {}
        : { problem: `the connection dropped before the hub answered the ${waited}` }),
    });
    if (state.document === null || !state.dirty) askForGraph();
    // Always, dirty or not: the hub's run is the hub's, and a Run that went
    // out unanswered may well have started one.
    askForRun();
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
      // A dirty screen keeps its document: the hub's copy becomes the baseline
      // the edits are measured against, and the name, the draft's number and
      // the published list are the hub's to say either way.
      const document = state.dirty && state.document !== null ? state.document : answer.document;
      moveTo({
        name: answer.name,
        draftVersion: answer.draftVersion,
        published: answer.published,
        document,
        selection:
          state.selection !== null && document.nodes.some((node) => node.id === state.selection)
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
      if (publishAfterSave) {
        publishAfterSave = false;
        sendPublish();
      }
    }

    const published = snapshot.lastGraphPublished;
    if (published !== null && publishFrame !== null && published.replyTo === publishFrame) {
      publishFrame = null;
      // The hub stamped the draft it held, which is the one this store had
      // confirmed when the publish went out; an edit made since is still
      // unsaved. The new draft's number and the published list are the hub's
      // to say, and the re-ask is what brings them.
      confirmed = publishedDocument ?? confirmed;
      publishedDocument = null;
      moveTo({ publishing: false });
      askForGraph();
    }

    const runStarted = snapshot.lastRunStarted;
    if (runStarted !== null && runFrame !== null && runStarted.replyTo === runFrame) {
      runFrame = null;
      moveTo({ starting: false });
    }
    // The hub store drops every run when the socket goes, so a run of this
    // graph it holds is from this connection: it is the answer to the read
    // as much as to anything, and the run this store held is no longer stale.
    const newest = newestRun(snapshot.runs);
    if (newest !== null && newest !== state.run) {
      readFrame = null;
      moveTo({ run: newest, readingRun: false });
    }

    const latest = snapshot.lastRunLatest;
    if (latest !== null && readFrame !== null && latest.replyTo === readFrame) {
      readFrame = null;
      // A run in the answer was filed in `runs` as well, so the newest there
      // is at least as new as it; `null` is the graph never having run.
      moveTo({
        run: latest.run === null ? null : (newestRun(snapshot.runs) ?? latest.run),
        readingRun: false,
      });
    }

    const cancelled = snapshot.lastRunCancelled;
    if (cancelled !== null && cancelFrame !== null && cancelled.replyTo === cancelFrame) {
      cancelFrame = null;
      moveTo({ cancelling: false });
    }

    const no = snapshot.lastRefusal;
    if (no !== null) {
      if (no.replyTo === runFrame) {
        runFrame = null;
        moveTo({ starting: false, problem: no.message });
      } else if (no.replyTo === cancelFrame) {
        cancelFrame = null;
        moveTo({ cancelling: false, problem: no.message });
      } else if (no.replyTo === readFrame) {
        readFrame = null;
        moveTo({ readingRun: false, problem: no.message });
      } else if (no.replyTo === openFrame) {
        openFrame = null;
        moveTo({ problem: no.message });
      } else if (no.replyTo === saveFrame) {
        saveFrame = null;
        inFlight = null;
        // A publish waiting on this save goes with it: what it would stamp is
        // the draft the hub still holds, not what is on screen.
        publishAfterSave = false;
        moveTo({ saving: false, publishing: false, problem: no.message });
      } else if (no.replyTo === publishFrame) {
        publishFrame = null;
        publishedDocument = null;
        moveTo({ publishing: false, problem: no.message });
      }
    }

    const phase = snapshot.phase;
    const dropped = phase !== 'connected' && phaseBefore === 'connected';
    const returned = phase === 'connected' && phaseBefore !== 'connected';
    phaseBefore = phase;
    if (dropped) dropInFlight();
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
        // next welcome, which is the same wait, said once. The read goes
        // with it, for the run the graph may already be in.
        askForGraph();
        askForRun();
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
      if (state.document === null || state.publishing) return;
      if (state.dirty) {
        if (!sendSave(state.document)) return;
        publishAfterSave = true;
        moveTo({ publishing: true });
        return;
      }
      sendPublish();
    },

    run(input: RouteInput): void {
      if (state.starting || state.readingRun || (state.run !== null && isRunOpen(state.run.status)))
        return;
      const outcome = hub.sendCommand({ type: 'graph-run', nodeId, input });
      if (!outcome.accepted) {
        moveTo({ problem: outcome.reason });
        return;
      }
      runFrame = outcome.id;
      // The previous run's strip stays until the hub names the new one, so
      // the screen never flashes empty between two runs.
      moveTo({ starting: true, problem: null });
    },

    cancelRun(): void {
      const run = state.run;
      if (run === null || !isRunOpen(run.status) || state.runStale || state.cancelling) return;
      const outcome = hub.sendCommand({ type: 'graph-run-cancel', runId: run.runId });
      if (!outcome.accepted) {
        moveTo({ problem: outcome.reason });
        return;
      }
      cancelFrame = outcome.id;
      moveTo({ cancelling: true, problem: null });
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
    a.run === b.run &&
    a.runStale === b.runStale &&
    a.readingRun === b.readingRun &&
    a.starting === b.starting &&
    a.cancelling === b.cancelling &&
    a.problem === b.problem
  );
}
