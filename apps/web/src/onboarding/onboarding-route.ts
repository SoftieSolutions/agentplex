import { useSyncExternalStore } from 'react';

/**
 * The wizard's address: `#/onboarding`.
 *
 * Hash routing on the session pane's and the document pane's precedent
 * (src/terminal/session-route.ts, src/docs/doc-route.ts) -- no router
 * dependency, and an address the hub serves from one static path.
 *
 * The whole address, because the wizard has no subject: it walks the person in
 * front of this screen through getting a first machine paired, and which step
 * they are on is the wizard's own state rather than something a pasted link
 * should be able to assert. So the parser answers yes or no, and exported as a
 * constant rather than a builder: there is one address, and a caller that
 * wants it wants exactly this string.
 *
 * Exact, not a prefix. `#/onboarding/x` is somebody's guess at a deeper route
 * that does not exist, and answering it with the wizard would teach that the
 * guess worked.
 */

export const ONBOARDING_HASH = '#/onboarding';

export function parseOnboardingHash(hash: string): boolean {
  return hash === ONBOARDING_HASH;
}

function subscribeToHash(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function readHash(): string {
  return window.location.hash;
}

/**
 * Whether the wizard is the current address. The hash is an external store
 * read through `useSyncExternalStore` and never an effect.
 *
 * No `useMemo` around the parse, unlike its two neighbours: they memoize
 * because they yield an object whose identity consumers hang callbacks off,
 * and this yields a boolean that React's own comparison settles.
 */
export function useOnboardingRoute(): boolean {
  return parseOnboardingHash(useSyncExternalStore(subscribeToHash, readHash));
}
