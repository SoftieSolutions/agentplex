import type { HubStore } from '../store/hub-store.js';
import { browserTimers } from '../store/timers.js';
import { createLayoutStore, type LayoutStore } from './layout-store.js';

/**
 * The one layout store the page holds, for the reason the hub store is one.
 *
 * It was built per mounted screen until the catalogue tree needed it too, and
 * one per screen is exactly what must not happen now: the store writes the
 * single opaque blob the hub keeps for this user, the hub echoes no save back,
 * and a second instance would therefore adopt an answer that predates what the
 * first one saved and then write its own half over it. The arrangement of this
 * tab is one fact, so it is one store — the session route's panes and the
 * catalogue's collapsed containers are two sections of it.
 *
 * Lazy, like the hub store, and inert until something subscribes: constructing
 * it sends nothing and asks for nothing. The hub store is passed in rather than
 * reached for -- the page's one hub store is built in `main.tsx` and handed
 * down -- and only the first caller's is kept, which is the whole point: there
 * is one of each per page.
 */
let singleton: LayoutStore | null = null;

export function appLayoutStore(hub: HubStore): LayoutStore {
  singleton ??= createLayoutStore({ hub, timers: browserTimers });
  return singleton;
}
