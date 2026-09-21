import { DEFAULT_SHAPE, type CataloguePages, type CatalogueShape } from './catalogue-model.js';
import type { CatalogueSnapshot, CatalogueStore } from './catalogue-store.js';

/**
 * A catalogue store holding one answer and asking for nothing.
 *
 * The seam the panel already offers, rather than the real store over a fake
 * socket: a suite about what the panel draws over a held answer does not want
 * the paging rules -- which have their own suite -- sitting between it and the
 * sentence on screen. It lives here rather than in either suite because two of
 * them need it now, and a fake copied into a second file is a fake that can
 * disagree with itself about what a store does.
 *
 * `reshape` and `loadMore` are deliberately inert: what a control writes is
 * `catalogue-store`'s subject, and a store that answered a reshape would have
 * this fake deciding what the hub says.
 */
export function fakeCatalogueStore(
  pages: CataloguePages,
  shape: CatalogueShape = DEFAULT_SHAPE,
): CatalogueStore {
  const snapshot: CatalogueSnapshot = {
    shape,
    pages,
    loading: false,
    notice: null,
    problem: null,
  };
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    reshape: () => {},
    loadMore: () => {},
  };
}
