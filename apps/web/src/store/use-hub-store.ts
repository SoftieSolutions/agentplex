import { useCallback, useSyncExternalStore } from 'react';
import type { Layout } from '@agentplex/protocol';
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

/**
 * The node tree, with this component's interest in it declared.
 *
 * Two subscriptions and not one, because they are two different things: the
 * store's listener list is how React is told something changed, and
 * `subscribeLayout` is how the hub is told anybody is looking. The second is
 * what sends the `layout-request` -- now, and again after every reconnection --
 * and a component that only listened would render whatever the last screen
 * happened to have asked for.
 *
 * No effect, for the reason `useHubSnapshot` has none: `useSyncExternalStore`
 * already owns a subscribe-and-unsubscribe lifecycle, and declaring interest is
 * exactly what subscribing means here. The cleanup runs in the order the setup
 * did not: listening stops first, so nothing re-renders on the way down.
 */
export function useHubLayout(store: HubStore): Layout | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      const stopWatching = store.subscribeLayout();
      const stopListening = store.subscribe(listener);
      return () => {
        stopListening();
        stopWatching();
      };
    },
    [store],
  );
  return useSyncExternalStore(subscribe, () => store.getSnapshot().layout);
}
