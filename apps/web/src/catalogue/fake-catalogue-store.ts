import type { NodeId } from '@agentplex/protocol';
import { DEFAULT_SHAPE, type CataloguePages, type CatalogueShape } from './catalogue-model.js';
import type { CatalogueSnapshot, CatalogueStore } from './catalogue-store.js';

/** A catalogue store that also says what its controls asked of it. */
export interface FakeCatalogueStore extends CatalogueStore {
  /** Every shape a control handed to `reshape`, in the order it did. */
  readonly reshapes: readonly CatalogueShape[];
  /**
   * Every open set handed to `openProjects`, in the order it was. Each call,
   * including one that names the set already held: whether that asks the hub
   * anything is the real store's rule and its suite's, and a fake that
   * applied it would hide what the panel actually asked.
   */
  readonly opened: readonly (readonly NodeId[] | null)[];
}

/**
 * A catalogue store holding one answer and asking for nothing.
 *
 * The seam the panel already offers, rather than the real store over a fake
 * socket: a suite about what the panel draws over a held answer does not want
 * the paging rules -- which have their own suite -- sitting between it and the
 * sentence on screen. It lives here rather than in either suite because
 * several of them need it, and a fake copied into a second file is a fake that
 * can disagree with itself about what a store does.
 *
 * `reshape` records the shape it was handed and holds it as the question, and
 * tells whoever subscribed, as the real store does the moment a control moves:
 * a control drawn from the shape has to read back what it wrote, or a suite
 * could not press it twice. What it never does is answer: the pages stay the
 * ones it was built with, because a fake that re-answered a reshape would be
 * deciding what the hub says, and that is `catalogue-store`'s subject. For the
 * same reason `loadMore` is inert. `openProjects` is the same as `reshape`:
 * recorded, held and told, never answered.
 */
export function fakeCatalogueStore(
  pages: CataloguePages,
  shape: CatalogueShape = DEFAULT_SHAPE,
): FakeCatalogueStore {
  const listeners = new Set<() => void>();
  const reshapes: CatalogueShape[] = [];
  const opened: (readonly NodeId[] | null)[] = [];
  let snapshot: CatalogueSnapshot = {
    shape,
    open: [],
    pages,
    loading: false,
    notice: null,
    problem: null,
  };
  function notify(): void {
    for (const listener of [...listeners]) listener();
  }
  return {
    reshapes,
    opened,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    reshape: (next) => {
      reshapes.push(next);
      snapshot = { ...snapshot, shape: next };
      notify();
    },
    loadMore: () => {},
    openProjects: (open) => {
      opened.push(open);
      snapshot = { ...snapshot, open };
      notify();
    },
  };
}
