import { useMemo, useSyncExternalStore } from 'react';

/**
 * Where the shell can send the content region, and what the sidebar draws to
 * get there.
 *
 * The mockups name five places -- Projects, Sessions, Graphs, Library,
 * Settings -- and two of them exist. A destination with nothing behind it is
 * not drawn, which is the same rule the session list follows for a narrowing
 * whose options are empty and the New popover follows for its node kinds, so
 * `NAV` below lists exactly what this milestone can show. Graphs (AGX-144,
 * AGX-145) and Library are absent rather than disabled: a disabled row is a
 * promise the app cannot keep, and each will add itself here when its epic
 * lands.
 *
 * Projects and Sessions are not in that list because they are not places the
 * content region goes: they are the sidebar's two readings of the same fleet,
 * and the tab pair that chooses between them lives in `sidebar.tsx`.
 *
 * The address is a hash, the way the session and document routes already are:
 * no router dependency, and an address the hub serves from one static path.
 * A hash is typed, pasted or restored by a browser, so it is parsed and never
 * cast -- anything this file does not recognize is the session list, which is
 * where the app starts.
 */

/** A place the content region can show, by name. */
export type Destination = 'sessions' | 'settings';

/** The address of each. `#/sessions` is also what an unreadable hash means. */
const HASHES: Record<Destination, string> = {
  sessions: '#/sessions',
  settings: '#/settings',
};

export function destinationHash(destination: Destination): string {
  return HASHES[destination];
}

/**
 * The destination an address names, or the session list for every address
 * that names none -- including the empty hash the app is first opened on, and
 * including the session and document routes, which the shell resolves before
 * it asks this.
 */
export function parseDestinationHash(hash: string): Destination {
  if (hash === HASHES.settings) return 'settings';
  return 'sessions';
}

/** One row of the nav at the foot of the sidebar. */
export interface NavEntry {
  readonly destination: Destination;
  readonly label: string;
}

/**
 * The nav, as it can honestly be drawn today: Settings, and nothing else.
 *
 * Sessions is deliberately not a row here either. It is where the brand mark
 * leads and where every session row already goes, and a nav row for the place
 * the app opens on would be a fourth way to reach it.
 */
export const NAV: readonly NavEntry[] = [{ destination: 'settings', label: 'Settings' }];

function subscribeToHash(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function readHash(): string {
  return window.location.hash;
}

/**
 * The current destination. The hash is an external store and is read through
 * `useSyncExternalStore` rather than an effect, exactly as the session and
 * document routes read it; the parse is memoized on the raw string so an
 * unchanged address re-renders nothing.
 */
export function useDestination(): Destination {
  const hash = useSyncExternalStore(subscribeToHash, readHash);
  return useMemo(() => parseDestinationHash(hash), [hash]);
}
