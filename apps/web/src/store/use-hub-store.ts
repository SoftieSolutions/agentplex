import { useSyncExternalStore } from 'react';
import type { HubSnapshot, HubStore } from './hub-store.js';

/**
 * How a component reads the hub: `useSyncExternalStore`, never an effect.
 *
 * The store already is an external store — the socket lives in it, and its
 * lifecycle is a function of subscriber count, not of any component's mount.
 * An effect-based connection would re-run on dependency churn and tie the
 * socket to whichever component happened to own the effect; here the first
 * subscriber connects, the last one leaving disconnects, and a component only
 * ever declares that it is looking.
 */
export function useHubSnapshot(store: HubStore): HubSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
