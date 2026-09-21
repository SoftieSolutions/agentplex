import type { HubStore } from '../store/hub-store.js';
import { clearedFilters, NO_FILTERS, type SessionListFilters } from './session-list-model.js';

/**
 * The narrowings as the page lives with them: an external store, read through
 * `useSyncExternalStore` and never through an effect.
 *
 * The ticket says the narrowings stay "held where they are held today", and
 * they cannot: today they are `useState` in the session list screen, and the
 * popover that offers them is drawn in the sidebar, which is not an ancestor
 * of that screen but a sibling of it. Two surfaces are writing and reading one
 * set of choices — the sidebar's filter row and badge, and the list itself —
 * and the alternatives are worse than moving them. Lifting them to the shell
 * would put six fields nothing in the shell reads through `app-shell.tsx` and
 * down two prop chains; leaving a copy on each side would be the second source
 * of truth the ticket is actually arguing against, with a badge counting one
 * copy and a list narrowed by the other. One holder keeps the ticket's point,
 * which is that the popover is a *presentation* of the narrowings rather than
 * a second place they live.
 *
 * What it holds is the whole of `SessionListFilters`, `server` included,
 * although the machine selector is the one writer of that field: `Clear` has
 * to leave it standing (`clearedFilters` argues why), and a rule about a field
 * held somewhere else is a rule that can only be applied by whoever remembers
 * to. Holding it here makes the reading of the filters one object, which is
 * what `effectiveFilters`, `visibleSessions` and `hiddenCount` all take.
 *
 * The store is the layout store's shape and not the catalogue store's: it
 * asks the hub nothing and it subscribes to nothing, so it is inert between
 * writes and the first subscriber costs nothing. It keeps one snapshot object
 * and replaces it only when a write changes a value, because
 * `useSyncExternalStore` compares what it is handed and a fresh object per
 * keystroke that narrowed nothing would re-render both readers.
 */
/**
 * Which of the two forms the same sessions are drawn in: the mockups' grid of
 * cards, or the one-row-per-session list the toggle beside the heading offers.
 *
 * Its own type rather than a field of `SessionListFilters`, because it is not
 * one: every member of that type answers "which sessions", and this one
 * answers "drawn how". The difference is not bookkeeping -- it is what keeps
 * `Clear` from throwing away a choice about reading that nobody asked it to
 * touch, and what keeps the popover's badge from counting a narrowing that
 * hides nothing. Both rules follow from the field not being there at all,
 * rather than from two call sites remembering to skip it.
 *
 * It lives here beside the narrowings for the reason they live here: the
 * toggle is drawn above the list and read by the list, and a second store
 * would be a second subscription for one screen's worth of state.
 *
 * In memory, and so back to the grid on the next page load. The ticket says to
 * follow the catalogue panel's tree-or-list toggle, and that toggle is not
 * persisted either: `CatalogueShape.view` is a field of the catalogue store's
 * snapshot and nothing writes it anywhere, while the only piece of that panel
 * the hub keeps is the sidebar's `collapsed`. The workspace blob is the one
 * place a preference could go, and putting this there would mean a section of
 * its own in it, versioned the way the catalogue's is, and a save to the hub on
 * every press of the toggle. That is a larger decision than this ticket, and
 * one worth making for both toggles at once rather than for this one alone.
 */
export type SessionListView = 'grid' | 'list';

/**
 * The grid, which is the form selected in every mockup that draws the toggle.
 */
const DEFAULT_VIEW: SessionListView = 'grid';

export interface SessionFiltersStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionListFilters;
  /**
   * The view, read through its own `useSyncExternalStore` off the subscription
   * above. A string, so a reader that only draws the toggle re-renders on a
   * value change and not on every keystroke in the search box.
   */
  getView(): SessionListView;
  setView(view: SessionListView): void;
  /**
   * Writes the narrowings named and leaves the rest standing.
   *
   * A partial rather than a setter per field, because the writers are two
   * surfaces drawing between one and seven controls each: a popover that
   * changed one pill would otherwise have to name the six it did not touch.
   * A field given `undefined` is one nobody wrote; `null` is the choice being
   * taken off, which is a different thing and the one that narrows nothing.
   */
  set(changes: Partial<SessionListFilters>): void;
  /**
   * Every narrowing off and the search box empty, per `clearedFilters`. The
   * view is left standing: it is not one of the things Clear is about.
   */
  clear(): void;
}

export function createSessionFiltersStore(
  initial: SessionListFilters = NO_FILTERS,
): SessionFiltersStore {
  const listeners = new Set<() => void>();
  let snapshot = initial;
  let view = DEFAULT_VIEW;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function publish(next: SessionListFilters): void {
    if (same(snapshot, next)) return;
    snapshot = next;
    notify();
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot(): SessionListFilters {
      return snapshot;
    },

    getView(): SessionListView {
      return view;
    },

    setView(next: SessionListView): void {
      if (view === next) return;
      view = next;
      notify();
    },

    set(changes: Partial<SessionListFilters>): void {
      const written = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined),
      );
      publish({ ...snapshot, ...written });
    },

    clear(): void {
      publish(clearedFilters(snapshot));
    },
  };
}

/** Whether two readings of the narrowings say the same thing. Flat, so shallow. */
function same(one: SessionListFilters, other: SessionListFilters): boolean {
  return (Object.keys(one) as (keyof SessionListFilters)[]).every(
    (field) => one[field] === other[field],
  );
}

/**
 * The one narrowings store the page holds, for the reason the layout store is
 * one: the sidebar's popover and the session list are looking at the same
 * fleet, and two stores would be a badge counting narrowings the list is not
 * applying.
 *
 * Keyed by the page's hub store, which is the fleet these narrowings are
 * choices within — `appLayoutStore` keeps the first caller's for the same
 * reason and `main.tsx` builds one hub store per page, so in the app this is
 * one store either way. A map rather than a module slot because a test mounts
 * several pages in one process, and a slot would hand the second one the
 * first's leftovers. Weak, so a page that is gone takes its narrowings with it.
 */
const perPage = new WeakMap<HubStore, SessionFiltersStore>();

export function appSessionFiltersStore(hub: HubStore): SessionFiltersStore {
  const held = perPage.get(hub);
  if (held !== undefined) return held;
  const store = createSessionFiltersStore();
  perPage.set(hub, store);
  return store;
}
