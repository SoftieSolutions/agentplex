import type { FrameId, NodeId, SessionRef } from '@agentplex/protocol';
import { terminalKey, type StartedView } from '../store/hub-store.js';
import type { Timers } from '../store/timers.js';
import { pendingSession, type NamedTerminal } from '../terminal/pending-pane-model.js';
import {
  closePane,
  findPaneShowing,
  moveFocus,
  paneAt,
  panes,
  pendingStarts,
  rebindPending,
  setPaneContent,
  setRatio,
  splitPane,
  type FocusDirection,
} from './operations.js';
import {
  DEFAULT_TREE,
  type LayoutTree,
  type PaneContent,
  type PanePath,
  type SplitDirection,
} from './tree.js';
import { MAX_REMEMBERED_COLLAPSES, parseWorkspace, serializeWorkspace } from './workspace.js';

/**
 * The layout as this tab lives with it: an external store, read through
 * `useSyncExternalStore` and never through an effect.
 *
 * Three facts live here and one of them is never saved:
 *
 *   * the tree — splits, ratios, what each pane shows — which is the layout
 *     and goes to the hub, whole, on every structural change;
 *   * which containers of the catalogue tree are collapsed, which the hub
 *     stores in the same opaque blob as a section of its own (`workspace.ts`
 *     argues why one blob and not two). It is here rather than beside the
 *     catalogue view for the reason that file gives: the hub echoes no save
 *     back, so a second writer would write a stale copy of this file's section
 *     over a change made a moment earlier. One store writes the blob;
 *     everything else asks it to;
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
  /**
   * The catalogue containers this user has closed, oldest first.
   *
   * Closed and not open: see `workspace.ts`. A folder nobody has said anything
   * about is drawn open, so a folder that appears while you are looking at the
   * tree shows what was just put in it.
   */
  readonly collapsed: readonly NodeId[];
}

/** The slice of the hub store the layout needs; `HubStore` satisfies it. */
export interface LayoutHub {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    readonly paneLayout: { readonly layout: string | null } | null;
    /**
     * The watched terminals, which is where a pending pane learns its name.
     *
     * Read here rather than reported up from the pane that is watching,
     * because the tree is this store's and a component that had to tell it
     * "the start I am drawing turned out to be this session" could only do it
     * from an effect. The store already hears every hub change; the session a
     * start became is one of them.
     */
    readonly terminals: ReadonlyMap<string, NamedTerminal>;
    /** The hub's answer to the newest start, for the one a resume names. */
    readonly lastStarted: StartedView | null;
  };
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
  /**
   * Shows a document, by the same three rules a session is shown by: focus the
   * pane already holding it, or put it in the focused pane, and wait for the
   * hub's answer rather than arranging a screen over the stored one.
   */
  showDoc(nodeId: NodeId): void;
  /**
   * Opens a pane on a session that has just been asked for, by the handle the
   * asking has: the id of the `session-start` frame that carried it.
   *
   * The same three rules again, and one more that is this call's own: the pane
   * stops being pending the moment the hub says which session that start
   * became, and the store is what notices -- see `rebindPendingPanes`.
   */
  showPendingSession(startId: FrameId): void;
  /** Moves focus to the pane across the boundary. Never saves. */
  focusMove(direction: FocusDirection): void;
  /** Focuses the pane at `path` (a click landed in it). Never saves. */
  focusPane(path: PanePath): void;
  /**
   * Opens a closed container of the catalogue tree, or closes an open one.
   *
   * A structural change like a split: it is the arrangement, and it saves on
   * the same debounce. Asked before the hub has answered it does nothing --
   * the same rule `showSession` follows, and for the same reason: writing this
   * tab's first click over a stored arrangement that has not arrived yet is
   * how a person loses one.
   */
  toggleCollapsed(nodeId: NodeId): void;
}

const DEFAULT_SAVE_DELAY_MS = 750;

export function createLayoutStore(dependencies: LayoutStoreDependencies): LayoutStore {
  const { hub, timers } = dependencies;
  const saveDelayMs = dependencies.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;

  const listeners = new Set<() => void>();
  let snapshot: LayoutSnapshot = {
    loaded: false,
    tree: DEFAULT_TREE,
    focus: [],
    collapsed: [],
  };
  /** Sections of the blob this build does not read, kept to be written back. */
  let rest: Readonly<Record<string, unknown>> = {};
  /** True once a hub answer has been adopted or a local edit outranks one. */
  let settled = false;
  let cancelSave: (() => void) | null = null;
  /** True while an edit has happened that no save has carried yet. */
  let dirty = false;
  /** Something asked for before the answer arrived, waiting for it. */
  let requested: PaneContent | null = null;

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
    hub.sendCommand({
      type: 'pane-layout-save',
      layout: serializeWorkspace({ panes: snapshot.tree, collapsed: snapshot.collapsed, rest }),
    });
  }

  /** A structural change happened: the tree is the user's now, and it saves. */
  function structural(changes: Partial<LayoutSnapshot>): void {
    settled = true;
    dirty = true;
    cancelSave?.();
    cancelSave = timers.schedule(saveDelayMs, saveNow);
    update({ loaded: true, ...changes });
  }

  function adoptAnswer(): void {
    if (settled) return;
    const answer = hub.getSnapshot().paneLayout;
    if (answer === null) return;
    settled = true;
    const stored = parseWorkspace(answer.layout);
    const tree = stored.panes;
    rest = stored.rest;
    const firstPane = panes(tree)[0];
    update({ loaded: true, tree, focus: firstPane?.path ?? [], collapsed: stored.collapsed });
    const waiting = requested;
    requested = null;
    if (waiting !== null) show(waiting);
  }

  /**
   * Every pending pane whose start has since been named, become its session.
   *
   * Run on every hub change, which is what makes the moment exact: the store
   * publishes when the hub's own answer says which session a start turned out
   * to be -- the subscription's reply, or a chunk of output carrying both
   * names -- and this is the next thing that happens. Nothing here compares
   * times, and nothing waits for a scan to appear in a list.
   *
   * It is structural, so it saves. That is the point of the rebind rather than
   * a side effect of it: the pending pane was saved as an empty one, and the
   * session pane it becomes is the first version of this arrangement worth
   * writing down.
   */
  function rebindPendingPanes(): void {
    const waiting = pendingStarts(snapshot.tree);
    if (waiting.length === 0) return;
    const answer = hub.getSnapshot();
    let tree = snapshot.tree;
    for (const startId of waiting) {
      const watch = answer.terminals.get(terminalKey({ by: 'start', startId })) ?? null;
      const session = pendingSession(startId, answer.lastStarted, watch);
      if (session === null) continue;
      tree = rebindPending(tree, startId, session);
    }
    if (tree === snapshot.tree) return;
    structural({ tree });
  }

  /** Everything this store does when the hub publishes, in the order it does it. */
  function onHubChange(): void {
    adoptAnswer();
    rebindPendingPanes();
  }

  /** The showing rules, shared by the live call and the deferred one. */
  function show(content: PaneContent): void {
    const showing = findPaneShowing(snapshot.tree, content);
    if (showing !== null) {
      // Already on screen: this is a focus change, which never saves.
      if (JSON.stringify(showing) !== JSON.stringify(snapshot.focus)) {
        update({ focus: showing });
      }
      return;
    }
    const tree = setPaneContent(snapshot.tree, snapshot.focus, content);
    // A focus that names no pane can only mean a snapshot nothing renders;
    // showing it as the whole layout over-claims nothing.
    if (tree === null) {
      structural({ tree: { kind: 'pane', content }, focus: [] });
      return;
    }
    structural({ tree });
  }

  /**
   * Not before the hub has answered: replacing the default pane now and
   * marking the tree the user's would outrank the stored layout the moment
   * before it arrived, and then save one pane over it. The request waits
   * instead, applied by `adoptAnswer`.
   */
  function showOrWait(content: PaneContent): void {
    if (!snapshot.loaded) {
      requested = content;
      return;
    }
    show(content);
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        detachInterest = hub.subscribePaneLayout();
        detachHub = hub.subscribe(onHubChange);
        onHubChange();
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
      structural({ tree: changed.tree, focus: changed.focus });
    },

    close(): void {
      const changed = closePane(snapshot.tree, snapshot.focus);
      if (changed === null) return;
      structural({ tree: changed.tree, focus: changed.focus });
    },

    commitRatio(path: PanePath, ratio: number): void {
      const tree = setRatio(snapshot.tree, path, ratio);
      if (tree === null || tree === snapshot.tree) return;
      structural({ tree });
    },

    showSession(session: SessionRef): void {
      showOrWait({ type: 'session', session });
    },

    showDoc(nodeId: NodeId): void {
      showOrWait({ type: 'doc', nodeId });
    },

    showPendingSession(startId: FrameId): void {
      showOrWait({ type: 'pending', startId });
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

    toggleCollapsed(nodeId: NodeId): void {
      if (!snapshot.loaded) return;
      const closed = snapshot.collapsed.includes(nodeId);
      // Appended rather than inserted, so the list stays oldest-first and the
      // bound drops the stalest entry rather than an arbitrary one.
      const collapsed = closed
        ? snapshot.collapsed.filter((id) => id !== nodeId)
        : [...snapshot.collapsed, nodeId].slice(-MAX_REMEMBERED_COLLAPSES);
      structural({ collapsed });
    },
  };
}
