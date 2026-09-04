import { describe, expect, it } from 'vitest';
import { sessionRefSchema } from '@agentplex/protocol';
import { createFakeTimers } from '../store/timers.js';
import { createLayoutStore, type LayoutHub } from './layout-store.js';
import { parsePaneLayout, serializePaneLayout, sessionPane } from './tree.js';

const SESSION = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-1' });
const OTHER = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-2' });

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
  const hub: LayoutHub = {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({ paneLayout: answer }),
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
  return {
    hub,
    saves,
    interest: () => interest,
    answer(layout: string | null): void {
      answer = { layout };
      for (const listener of [...listeners]) listener();
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
