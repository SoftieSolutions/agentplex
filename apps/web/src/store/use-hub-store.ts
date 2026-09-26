import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { Layout } from '@agentplex/protocol';
import type { HubStore } from './hub-store.js';
import type { HubSnapshot } from './views.js';

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
 * One slice of the hub, re-rendering only when that slice changes.
 *
 * `useHubSnapshot` commits on every publication, and the store publishes for
 * facts no leaf control draws: a terminal printing its first byte, a catalogue
 * page, somebody else's reply. A button that shows one answer has no business
 * re-rendering for any of them, and on a list of cards it re-renders once per
 * card per publication.
 *
 * `select` runs on every read, never keyed on the snapshot's identity: a
 * selector closes over component state -- the id a control is waiting on --
 * and that changes without the snapshot changing. What makes a read cheap to
 * React is the answer: when `isEqual` says the new selection is the old one,
 * the old reference comes back, and `useSyncExternalStore` compares by
 * reference and skips the commit. A selector that builds an object therefore
 * needs an `isEqual` that looks inside it; with `Object.is` a fresh object
 * would be a change on every read.
 */
export function useHubSelector<T>(
  store: HubStore,
  select: (snapshot: HubSnapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  // Inside the component because the cache is this subscriber's and nobody
  // else's: two controls selecting from one store hold two last values. A ref
  // rather than state, because writing it must not itself schedule a render --
  // it is read and written inside `getSnapshot`, which React calls during
  // render and again whenever the store notifies.
  const last = useRef<{ readonly value: T } | null>(null);
  function getSelection(): T {
    const next = select(store.getSnapshot());
    const held = last.current;
    if (held !== null && isEqual(held.value, next)) return held.value;
    last.current = { value: next };
    return next;
  }
  return useSyncExternalStore(store.subscribe, getSelection);
}

/**
 * Equal when both hold the same own fields with the same values by identity.
 *
 * One level and no further, which is what a follow-up is: a `kind` and at most
 * a few words or a reference taken whole off the answers map.
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = Object.keys(a);
  if (left.length !== Object.keys(b).length) return false;
  return left.every(
    (key) => Object.hasOwn(b, key) && Object.is(Reflect.get(a, key), Reflect.get(b, key)),
  );
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
