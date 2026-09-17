import { describe, expect, it } from 'vitest';
import {
  nodeIdSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  sessionRefSchema,
  storeIdSchema,
  type FrameId,
  type SessionRef,
} from '@agentplex/protocol';
import { terminalKey, type StartedView } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { createLayoutStore, type LayoutHub } from './layout-store.js';
import {
  DEFAULT_TREE,
  docPane,
  parsePaneLayout,
  pendingPane,
  serializePaneLayout,
  sessionPane,
} from './tree.js';
import { parseWorkspace, serializeWorkspace } from './workspace.js';

const SESSION = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-1' });
const OTHER = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-2' });
const DOC = nodeIdSchema.parse('hub-5');

/**
 * The hub as the layout store sees it: an answer that can arrive, and a place
 * saves go. What the fakes record is the two rules under test — when a save
 * happens (structural changes, debounced) and when one must not (focus).
 */
function fakeHub() {
  const saves: string[] = [];
  const listeners = new Set<() => void>();
  let answer: { layout: string | null } | null = null;
  let interest = 0;
  /** What each watched terminal turned out to be, as the store publishes it. */
  let terminals = new Map<string, { readonly session: SessionRef | null }>();
  let lastStarted: StartedView | null = null;
  const hub: LayoutHub = {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({ paneLayout: answer, terminals, lastStarted }),
    subscribePaneLayout(): () => void {
      interest += 1;
      return () => {
        interest -= 1;
      };
    },
    sendCommand(command: { type: 'pane-layout-save'; layout: string }): unknown {
      saves.push(command.layout);
      return { accepted: true };
    },
  };
  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  return {
    hub,
    saves,
    interest: () => interest,
    answer(layout: string | null): void {
      answer = { layout };
      notify();
    },
    /** The hub says which session a start-addressed watch turned out to be. */
    names(startId: FrameId, session: SessionRef | null): void {
      terminals = new Map([[terminalKey({ by: 'start', startId }), { session }]]);
      notify();
    },
    /** The hub answers a start, the way it answers a resume: with the session. */
    started(view: StartedView): void {
      lastStarted = view;
      notify();
    },
  };
}

function harness(saveDelayMs = 500) {
  const h = fakeHub();
  const timers = createFakeTimers();
  const store = createLayoutStore({ hub: h.hub, timers, saveDelayMs });
  const unsubscribe = store.subscribe(() => {});
  return { ...h, timers, store, unsubscribe };
}

describe('adopting the hub answer', () => {
  it('is not loaded until the hub has answered, then shows what was stored', () => {
    const h = harness();
    expect(h.store.getSnapshot().loaded).toBe(false);
    expect(h.interest()).toBe(1);

    const stored = serializePaneLayout({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: sessionPane(SESSION),
      second: { kind: 'pane', content: { type: 'empty' } },
    });
    h.answer(stored);
    const snapshot = h.store.getSnapshot();
    expect(snapshot.loaded).toBe(true);
    expect(serializePaneLayout(snapshot.tree)).toBe(stored);
    expect(snapshot.focus).toEqual(['first']);
  });

  it('reads never-stored as the default layout, loaded', () => {
    const h = harness();
    h.answer(null);
    expect(h.store.getSnapshot()).toEqual({
      loaded: true,
      tree: { kind: 'pane', content: { type: 'empty' } },
      focus: [],
      collapsed: [],
    });
  });

  it('never adopts a later answer over local edits: a reconnection must not snap back', () => {
    const h = harness();
    h.answer(null);
    h.store.split('row');
    const edited = h.store.getSnapshot().tree;
    // The replayed subscription is answered again, with the stored layout.
    h.answer(serializePaneLayout(sessionPane(OTHER)));
    expect(h.store.getSnapshot().tree).toBe(edited);
  });
});

describe('what saves and what never does', () => {
  it('saves a split once the burst settles, debounced through the clock', () => {
    const h = harness(500);
    h.answer(null);
    h.store.split('row');
    h.store.split('column');
    expect(h.saves).toHaveLength(0);

    h.timers.fireAll();
    // One save carrying the newest tree, not one per edit: the first
    // schedule was cancelled when the second edit arrived.
    expect(h.saves).toEqual([serializePaneLayout(h.store.getSnapshot().tree)]);
    expect(h.timers.delays).toEqual([500, 500]);
  });

  it('saves a committed divider ratio', () => {
    const h = harness();
    h.answer(null);
    h.store.split('row');
    h.timers.fireAll();
    h.store.commitRatio([], 0.3);
    h.timers.fireAll();
    const last = parsePaneLayout(h.saves.at(-1) ?? null);
    expect(last.kind === 'split' && last.ratio).toBe(0.3);
  });

  it('saves a close', () => {
    const h = harness();
    h.answer(null);
    h.store.split('row');
    h.store.close();
    h.timers.fireAll();
    expect(h.saves).toEqual([serializePaneLayout({ kind: 'pane', content: { type: 'empty' } })]);
  });

  it('saves showing a session in the focused pane, and focuses without saving when it shows already', () => {
    const h = harness();
    h.answer(null);
    h.store.showSession(SESSION);
    h.timers.fireAll();
    expect(h.saves).toEqual([serializePaneLayout(sessionPane(SESSION))]);

    h.store.split('row');
    h.timers.fireAll();
    const savesSoFar = h.saves.length;
    // Focus is on the new empty pane; showing the visible session again is a
    // focus change and nothing else.
    h.store.showSession(SESSION);
    expect(h.store.getSnapshot().focus).toEqual(['first']);
    h.timers.fireAll();
    expect(h.saves).toHaveLength(savesSoFar);
  });

  it('shows a document by the same three rules a session is shown by', () => {
    const h = harness();
    h.answer(null);
    h.store.showDoc(DOC);
    h.timers.fireAll();
    expect(h.saves).toEqual([serializePaneLayout(docPane(DOC))]);

    h.store.split('row');
    h.timers.fireAll();
    const savesSoFar = h.saves.length;
    // The document is already on screen: focusing it is not an arrangement.
    h.store.showDoc(DOC);
    expect(h.store.getSnapshot().focus).toEqual(['first']);
    h.timers.fireAll();
    expect(h.saves).toHaveLength(savesSoFar);

    // A session into the focused pane does not disturb the document beside it.
    h.store.focusPane(['second']);
    h.store.showSession(SESSION);
    h.timers.fireAll();
    expect(h.store.getSnapshot().tree).toEqual({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: docPane(DOC),
      second: sessionPane(SESSION),
    });
  });

  it('never saves on focus movement or a click into a pane', () => {
    const h = harness();
    h.answer(
      serializePaneLayout({
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: sessionPane(SESSION),
        second: sessionPane(OTHER),
      }),
    );
    h.store.focusMove('right');
    expect(h.store.getSnapshot().focus).toEqual(['second']);
    h.store.focusPane(['first']);
    expect(h.store.getSnapshot().focus).toEqual(['first']);

    h.timers.fireAll();
    expect(h.saves).toHaveLength(0);
    expect(h.timers.delays).toHaveLength(0);
  });

  it('sends a still-pending save when the last subscriber leaves, not nothing', () => {
    const h = harness();
    h.answer(null);
    h.store.split('row');
    expect(h.saves).toHaveLength(0);
    h.unsubscribe();
    expect(h.saves).toHaveLength(1);
    expect(h.interest()).toBe(0);
  });
});

describe('showSession before the answer', () => {
  it('waits for the stored layout rather than saving one pane over a layout it has not seen', () => {
    const h = harness();
    h.store.showSession(SESSION);
    expect(h.store.getSnapshot().loaded).toBe(false);
    h.timers.fireAll();
    expect(h.saves).toHaveLength(0);

    // The stored layout arrives, is adopted, and only then is the requested
    // session shown — into the arrangement the user actually has.
    h.answer(
      serializePaneLayout({
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: sessionPane(OTHER),
        second: { kind: 'pane', content: { type: 'empty' } },
      }),
    );
    const snapshot = h.store.getSnapshot();
    expect(snapshot.tree).toEqual({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: sessionPane(SESSION),
      second: { kind: 'pane', content: { type: 'empty' } },
    });
    h.timers.fireAll();
    expect(h.saves).toEqual([serializePaneLayout(snapshot.tree)]);
  });

  it('only focuses, and never saves, when the stored layout already shows the session', () => {
    const h = harness();
    h.store.showSession(OTHER);
    h.answer(
      serializePaneLayout({
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: sessionPane(SESSION),
        second: sessionPane(OTHER),
      }),
    );
    expect(h.store.getSnapshot().focus).toEqual(['second']);
    h.timers.fireAll();
    expect(h.saves).toHaveLength(0);
  });
});

/**
 * The catalogue's expansion state, which rides in the same blob.
 *
 * Under test here rather than beside the catalogue view because this is where
 * it is written, and that placement is the decision: the hub echoes no save
 * back, so a second writer of the blob would write a stale copy of the panes
 * over an arrangement made a moment earlier. One store writes; the tree view
 * asks it to.
 */
describe('what is collapsed', () => {
  const FOLDER = nodeIdSchema.parse('hub-5');
  const PROJECT = nodeIdSchema.parse('hub-4');

  it('adopts what was stored and saves a collapse on the same debounce', () => {
    const h = harness();
    h.answer(serializeWorkspace({ panes: DEFAULT_TREE, collapsed: [PROJECT], rest: {} }));
    expect(h.store.getSnapshot().collapsed).toEqual([PROJECT]);

    h.store.toggleCollapsed(FOLDER);
    expect(h.store.getSnapshot().collapsed).toEqual([PROJECT, FOLDER]);
    expect(h.saves).toHaveLength(0);

    h.timers.fireAll();
    expect(parseWorkspace(h.saves.at(-1) ?? null).collapsed).toEqual([PROJECT, FOLDER]);
  });

  it('opens what was closed, and the save carries the panes with it', () => {
    const h = harness();
    h.answer(serializeWorkspace({ panes: sessionPane(SESSION), collapsed: [FOLDER], rest: {} }));
    h.store.toggleCollapsed(FOLDER);
    h.timers.fireAll();

    const saved = parseWorkspace(h.saves.at(-1) ?? null);
    expect(saved.collapsed).toEqual([]);
    // The panes are the other half of the one blob: a save about the tree must
    // not be how a person loses their arrangement.
    expect(saved.panes).toEqual(sessionPane(SESSION));
  });

  it('writes back a section this build cannot read', () => {
    const h = harness();
    h.answer(
      JSON.stringify({
        v: 1,
        root: { kind: 'pane', content: { type: 'empty' } },
        somebodyElses: { keep: 'me' },
      }),
    );
    h.store.toggleCollapsed(FOLDER);
    h.timers.fireAll();
    expect(JSON.parse(h.saves.at(-1) ?? 'null')).toMatchObject({ somebodyElses: { keep: 'me' } });
  });

  it('does nothing before the hub has answered, so a first click cannot outrank the store', () => {
    const h = harness();
    h.store.toggleCollapsed(FOLDER);
    expect(h.store.getSnapshot().collapsed).toEqual([]);
    h.timers.fireAll();
    expect(h.saves).toHaveLength(0);

    h.answer(serializeWorkspace({ panes: DEFAULT_TREE, collapsed: [PROJECT], rest: {} }));
    expect(h.store.getSnapshot().collapsed).toEqual([PROJECT]);
  });
});

describe('a pending pane', () => {
  it('opens on the start handle, in the focused pane, and saves as an empty one', () => {
    const h = harness();
    h.answer(serializePaneLayout(DEFAULT_TREE));

    h.store.showPendingSession(7);

    expect(h.store.getSnapshot().tree).toEqual(pendingPane(7));
    h.timers.fireAll();
    // The arrangement is written down; the handle is not. A tab on another
    // device has no connection this start was made on and could resolve
    // nothing from it.
    expect(parseWorkspace(h.saves[0] ?? null).panes).toEqual({
      kind: 'pane',
      content: { type: 'empty' },
    });
  });

  it('becomes the session the moment the hub says which one the start was', () => {
    const h = harness();
    h.answer(serializePaneLayout(DEFAULT_TREE));
    h.store.showPendingSession(7);
    h.timers.fireAll();

    // The watch this pane declared, now carrying what the hub answered about
    // it: a session id that came off the server's own report, relayed.
    h.names(7, SESSION);

    expect(h.store.getSnapshot().tree).toEqual(sessionPane(SESSION));
    h.timers.fireAll();
    // And this time the pane is worth writing down.
    expect(parseWorkspace(h.saves.at(-1) ?? null).panes).toEqual(sessionPane(SESSION));
  });

  it('stays pending while the watch has no session, however long that is', () => {
    const h = harness();
    h.answer(serializePaneLayout(DEFAULT_TREE));
    h.store.showPendingSession(7);

    h.names(7, null);
    h.names(9, SESSION);

    // Nothing about another start's watch, and nothing about time, moves this
    // pane: the rebind is by the handle the pane holds and by nothing else.
    expect(h.store.getSnapshot().tree).toEqual(pendingPane(7));
  });

  it('becomes the session a resume named, off the hub answer to that start', () => {
    const h = harness();
    h.answer(serializePaneLayout(DEFAULT_TREE));
    h.store.showPendingSession(7);

    h.started({
      replyTo: 7,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
      server: serverRegistrationIdSchema.parse('registration-1'),
    });

    // A start that named a session is answered with it, so the pane can stop
    // being pending before a byte has arrived. Correlated by `replyTo`.
    expect(h.store.getSnapshot().tree).toEqual(sessionPane(SESSION));
  });

  it('ignores an answer to a start no pane here is waiting on', () => {
    const h = harness();
    h.answer(serializePaneLayout(DEFAULT_TREE));
    h.store.showPendingSession(7);

    h.started({
      replyTo: 9,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-2'),
      server: serverRegistrationIdSchema.parse('registration-1'),
    });

    expect(h.store.getSnapshot().tree).toEqual(pendingPane(7));
  });

  it('waits for the stored layout rather than arranging a screen over it', () => {
    const h = harness();
    h.store.showPendingSession(7);

    // Nothing yet: a pane put in the default layout now, and marked the
    // user's, would be saved over the arrangement that has not arrived.
    expect(h.store.getSnapshot().loaded).toBe(false);
    expect(h.saves).toEqual([]);

    h.answer(
      serializePaneLayout({
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: sessionPane(OTHER),
        second: { kind: 'pane', content: { type: 'empty' } },
      }),
    );

    const tree = h.store.getSnapshot().tree;
    expect(tree.kind === 'split' && tree.first).toEqual(pendingPane(7));
  });
});
