import type { SessionRef } from '@agentplex/protocol';
import type { Timers } from '../store/timers.js';
import {
  closePane,
  findSessionPane,
  moveFocus,
  paneAt,
  panes,
  setPaneContent,
  setRatio,
  splitPane,
  type FocusDirection,
} from './operations.js';
import {
  DEFAULT_TREE,
  parsePaneLayout,
  serializePaneLayout,
  sessionPane,
  type LayoutTree,
  type PanePath,
  type SplitDirection,
} from './tree.js';

/**
 * The layout as this tab lives with it: an external store, read through
 * `useSyncExternalStore` and never through an effect.
 *
 * Two facts live here and only one of them is ever saved:
 *
 *   * the tree — splits, ratios, what each pane shows — which is the layout
 *     and goes to the hub, whole, on every structural change;
 *   * focus, which is a fact about this tab. Two tabs on one hub share a
 *     layout and look at different panes of it, so focus is never serialized
 *     and no focus change ever schedules a save. The tests hold that line.
 *
 * Saves are debounced through the injected clock: a drag commits, a split
 * lands, and one frame goes out when the burst settles rather than one per
 * edit. The debounce is trailing, so what is saved is always the newest tree.
 *
 * The hub's answer is adopted once, when the first one arrives. After that
 * this tab's tree is the authority for this tab: a reconnection re-asks (the
 * subscription replays) and is answered with whatever was last saved, and
 * adopting that over live local edits would snap the screen backwards under
 * the user's hands. Cross-tab merging is a problem this ticket deliberately
 * does not have — last save wins at the hub, which is where "one writer wins"
 * already lives.
 */

export interface LayoutSnapshot {
  /** False until the hub's first answer has arrived and been adopted. */
  readonly loaded: boolean;
  readonly tree: LayoutTree;
  /** The focused pane. A fact about this tab; never part of a save. */
  readonly focus: PanePath;
}

/** The slice of the hub store the layout needs; `HubStore` satisfies it. */
export interface LayoutHub {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { readonly paneLayout: { readonly layout: string | null } | null };
  /** Standing interest in the stored pane layout, replayed on reconnection. */
  subscribePaneLayout(): () => void;
  sendCommand(command: { type: 'pane-layout-save'; layout: string }): unknown;
}

export interface LayoutStoreDependencies {
  readonly hub: LayoutHub;
  readonly timers: Timers;
  /** How long a burst of structural edits settles before one save goes out. */
  readonly saveDelayMs?: number;
}

export interface LayoutStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): LayoutSnapshot;
  /** Splits the focused pane. A structural change: it saves. */
  split(direction: SplitDirection): void;
  /** Closes the focused pane, unless it is the last one. Saves. */
  close(): void;
  /** Commits a divider's ratio, at the end of a drag. Saves. */
  commitRatio(path: PanePath, ratio: number): void;
  /**
   * Shows a session: focuses the pane already showing it, or puts it in the
   * focused pane. Only the second is structural, and only it saves. Asked
   * before the hub has answered, the request waits and is applied to the
   * stored layout the moment it arrives — never to the placeholder default,
   * which a save would then write over the real arrangement.
   */
  showSession(session: SessionRef): void;
  /** Moves focus to the pane across the boundary. Never saves. */
  focusMove(direction: FocusDirection): void;
  /** Focuses the pane at `path` (a click landed in it). Never saves. */
  focusPane(path: PanePath): void;
}

const DEFAULT_SAVE_DELAY_MS = 750;

export function createLayoutStore(dependencies: LayoutStoreDependencies): LayoutStore {
  const { hub, timers } = dependencies;
  const saveDelayMs = dependencies.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;

  const listeners = new Set<() => void>();
  let snapshot: LayoutSnapshot = { loaded: false, tree: DEFAULT_TREE, focus: [] };
  /** True once a hub answer has been adopted or a local edit outranks one. */
  let settled = false;
  let cancelSave: (() => void) | null = null;
  /** True while an edit has happened that no save has carried yet. */
  let dirty = false;
  /** A session asked for before the answer arrived, waiting for it. */
  let requested: SessionRef | null = null;

  let detachHub: (() => void) | null = null;
  let detachInterest: (() => void) | null = null;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function update(changes: Partial<LayoutSnapshot>): void {
    snapshot = { ...snapshot, ...changes };
    notify();
  }

  function saveNow(): void {
    cancelSave = null;
    if (!dirty) return;
    dirty = false;
    hub.sendCommand({ type: 'pane-layout-save', layout: serializePaneLayout(snapshot.tree) });
  }

  /** A structural change happened: the tree is the user's now, and it saves. */
  function structural(tree: LayoutTree, focus: PanePath): void {
    settled = true;
    dirty = true;
    cancelSave?.();
    cancelSave = timers.schedule(saveDelayMs, saveNow);
    update({ loaded: true, tree, focus });
  }

  function adoptAnswer(): void {
    if (settled) return;
    const answer = hub.getSnapshot().paneLayout;
    if (answer === null) return;
    settled = true;
    const tree = parsePaneLayout(answer.layout);
    const firstPane = panes(tree)[0];
    update({ loaded: true, tree, focus: firstPane?.path ?? [] });
    const waiting = requested;
    requested = null;
    if (waiting !== null) show(waiting);
  }

  /** The showing rules, shared by the live call and the deferred one. */
  function show(session: SessionRef): void {
    const showing = findSessionPane(snapshot.tree, session);
    if (showing !== null) {
      // Already on screen: this is a focus change, which never saves.
      if (JSON.stringify(showing) !== JSON.stringify(snapshot.focus)) {
        update({ focus: showing });
      }
      return;
    }
    const tree = setPaneContent(snapshot.tree, snapshot.focus, { type: 'session', session });
    // A focus that names no pane can only mean a snapshot nothing renders;
    // showing the session as the whole layout over-claims nothing.
    if (tree === null) {
      structural(sessionPane(session), []);
      return;
    }
    structural(tree, snapshot.focus);
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        detachInterest = hub.subscribePaneLayout();
        detachHub = hub.subscribe(adoptAnswer);
        adoptAnswer();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          // A pending save does not leave with the screen: it is sent now,
          // because a layout the user made and never got saved is the one
          // degradation here that is silent.
          cancelSave?.();
          cancelSave = null;
          saveNow();
          detachHub?.();
          detachHub = null;
          detachInterest?.();
          detachInterest = null;
        }
      };
    },

    getSnapshot(): LayoutSnapshot {
      return snapshot;
    },

    split(direction: SplitDirection): void {
      const changed = splitPane(snapshot.tree, snapshot.focus, direction);
      if (changed === null) return;
      structural(changed.tree, changed.focus);
    },

    close(): void {
      const changed = closePane(snapshot.tree, snapshot.focus);
      if (changed === null) return;
      structural(changed.tree, changed.focus);
    },

    commitRatio(path: PanePath, ratio: number): void {
      const tree = setRatio(snapshot.tree, path, ratio);
      if (tree === null || tree === snapshot.tree) return;
      structural(tree, snapshot.focus);
    },

    showSession(session: SessionRef): void {
      // Not before the hub has answered: replacing the default pane now and
      // marking the tree the user's would outrank the stored layout the
      // moment before it arrived, and then save one pane over it. The
      // request waits instead, applied by `adoptAnswer`.
      if (!snapshot.loaded) {
        requested = session;
        return;
      }
      show(session);
    },

    focusMove(direction: FocusDirection): void {
      const landing = moveFocus(snapshot.tree, snapshot.focus, direction);
      if (landing === null) return;
      update({ focus: landing });
    },

    focusPane(path: PanePath): void {
      if (paneAt(snapshot.tree, path) === null) return;
      update({ focus: path });
    },
  };
}
