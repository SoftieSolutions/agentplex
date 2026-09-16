import { DOC_CONTENT_MAX_CHARS, type NodeId } from '@agentplex/protocol';
import type {
  CommandOutcome,
  ConnectionPhase,
  DocContentView,
  DocSavedView,
  HubCommand,
  RefusalView,
} from '../store/hub-store.js';
import type { Timers } from '../store/timers.js';
import {
  documentArrived,
  documentAsked,
  EMPTY_EDITOR,
  isDirty,
  notSent,
  refused,
  saveAsked,
  saveLanded,
  saveOwed,
  typed,
  type EditorState,
} from './editor-model.js';

/**
 * One open document, as an external store the pane owns.
 *
 * ## Why the text lives here and not in React, and not in the hub store
 *
 * What somebody has typed and not yet saved is the one thing in this app that
 * cannot be fetched again, so where it lives is a decision rather than a
 * habit. React state would tie it to a component's mount, and the hub store
 * would tie it to the connection -- that store deliberately drops the document
 * it is holding when the last subscriber leaves, because a document is a file
 * on a machine's disk and a copy it cannot vouch for is worse than none. A
 * store the pane holds for as long as the pane is on screen outlives every
 * reconnection underneath it, which is exactly the lifetime unsaved work has.
 *
 * ## Two ways a save goes out, one path it takes
 *
 * An explicit save (the chord, the button) and the idle save after a burst of
 * typing both end in the same `save()`, which sends only what is owed. The
 * debounce is trailing, so a burst is one write rather than one per keystroke,
 * and the delay is named below.
 *
 * ## What it does when the connection comes back
 *
 * The store re-reads the document, and only when there is nothing unsaved to
 * lose. That matters in both directions: the file is editable on the machine
 * that holds it -- by a person or by the agent it was written for -- so a
 * client that never re-read would show a stale document as though it were the
 * document; and a client that always re-read would throw away what somebody
 * typed while the connection was down. Clean is the one state where the disk
 * is the better answer.
 */

export interface DocEditorHub {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    readonly phase: ConnectionPhase;
    readonly lastDocContent: DocContentView | null;
    readonly lastDocSaved: DocSavedView | null;
    readonly lastRefusal: RefusalView | null;
  };
  sendCommand(command: HubCommand): CommandOutcome;
}

export interface DocEditorStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): EditorState;
  /** Somebody typed. Schedules the idle save; never sends one itself. */
  setText(text: string): void;
  /** Writes what is owed now: the chord, the button, and the idle timer. */
  save(): void;
}

export interface DocEditorStoreDependencies {
  readonly hub: DocEditorHub;
  readonly nodeId: NodeId;
  readonly timers: Timers;
  readonly idleSaveDelayMs?: number;
}

/**
 * How long typing has to stop before a save goes out on its own.
 *
 * Longer than the gap between two words and shorter than the pause before
 * somebody looks away: a sentence typed straight through is one write, and
 * walking off mid-paragraph costs a second and a half of work at most. The
 * explicit save is what somebody uses when they want the certainty now.
 */
export const IDLE_SAVE_DELAY_MS = 1_500;

export function createDocEditorStore(dependencies: DocEditorStoreDependencies): DocEditorStore {
  const { hub, nodeId, timers } = dependencies;
  const idleSaveDelayMs = dependencies.idleSaveDelayMs ?? IDLE_SAVE_DELAY_MS;

  const listeners = new Set<() => void>();
  let state: EditorState = EMPTY_EDITOR;
  let cancelIdleSave: (() => void) | null = null;
  let detachHub: (() => void) | null = null;
  /** The phase at the last notification, so a reconnection is an edge. */
  let phaseBefore: ConnectionPhase = 'idle';

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function moveTo(next: EditorState): void {
    if (next === state) return;
    state = next;
    notify();
  }

  function askForDocument(): void {
    const outcome = hub.sendCommand({ type: 'doc-open', nodeId });
    moveTo(
      outcome.accepted
        ? documentAsked(state, outcome.id, outcome.delivery === 'queued')
        : notSent(state, outcome.reason),
    );
  }

  /**
   * The hub's snapshot changed. Every answer is matched on the frame this
   * editor is waiting for, which is what keeps one pane's refusal out of
   * another pane's document -- the snapshot holds the last answer of each kind
   * for every screen at once.
   */
  function onHubChange(): void {
    const snapshot = hub.getSnapshot();

    const content = snapshot.lastDocContent;
    if (content !== null && state.openFrame === content.replyTo) {
      moveTo(documentArrived(state, content.content, content.updatedAt));
    }
    const written = snapshot.lastDocSaved;
    if (written !== null && state.saveFrame === written.replyTo) {
      moveTo(saveLanded(state, written.updatedAt));
    }
    const no = snapshot.lastRefusal;
    if (no !== null) moveTo(refused(state, no.replyTo, no.message));

    const phase = snapshot.phase;
    const returned = phase === 'connected' && phaseBefore !== 'connected';
    phaseBefore = phase;
    if (
      returned &&
      state.loaded &&
      !isDirty(state) &&
      state.openFrame === null &&
      state.saveFrame === null
    ) {
      askForDocument();
    }
  }

  function scheduleIdleSave(): void {
    cancelIdleSave?.();
    cancelIdleSave = timers.schedule(idleSaveDelayMs, () => {
      cancelIdleSave = null;
      writeWhatIsOwed();
    });
  }

  function writeWhatIsOwed(): void {
    if (!saveOwed(state)) return;
    cancelIdleSave?.();
    cancelIdleSave = null;
    const text = state.text;
    if (text.length > DOC_CONTENT_MAX_CHARS) {
      // Refused here rather than on the wire, and this is the one refusal this
      // client writes itself: a frame past the protocol's bound is one the hub
      // cannot parse, and an unparseable frame costs the socket. Saying so
      // keeps the characters and the connection.
      moveTo(
        notSent(
          state,
          `this document is longer than a document may be: ${String(DOC_CONTENT_MAX_CHARS)} ` +
            'characters is the most one can carry',
        ),
      );
      return;
    }
    const outcome = hub.sendCommand({ type: 'doc-save', nodeId, content: text });
    moveTo(
      outcome.accepted
        ? saveAsked(state, outcome.id, text, outcome.delivery === 'queued')
        : notSent(state, outcome.reason),
    );
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        phaseBefore = hub.getSnapshot().phase;
        detachHub = hub.subscribe(onHubChange);
        // The read goes out now whatever the connection is doing: the store
        // queues a command made while it is down and flushes it on the next
        // welcome, which is the same wait, said once.
        askForDocument();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          // A pending save does not leave with the pane. Unsaved work is the
          // one degradation here that would be silent, and a pane closing is
          // exactly when nobody is left to notice it.
          cancelIdleSave?.();
          cancelIdleSave = null;
          writeWhatIsOwed();
          detachHub?.();
          detachHub = null;
        }
      };
    },

    getSnapshot(): EditorState {
      return state;
    },

    setText(text: string): void {
      const next = typed(state, text);
      if (next === state) return;
      state = next;
      notify();
      scheduleIdleSave();
    },

    save(): void {
      writeWhatIsOwed();
    },
  };
}
