import { useMemo, useSyncExternalStore } from 'react';
import type { ShellForm } from './shell-form.js';

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
 * Sessions and Projects are not in that list because on a wide screen they are
 * not places the content region goes: they are the sidebar's two readings of
 * the same fleet, and the tab pair that chooses between them lives in
 * `sidebar.tsx`. On a phone there is no sidebar to hold either reading, so
 * both are addresses -- and so is More, which is where the nav went. That is
 * why the two forms of the shell share this file rather than forking into a
 * mobile app and a desktop app: one set of addresses, one parser, and one
 * function (`resolveDestination`) saying what each means where.
 *
 * The address is a hash, the way the session and document routes already are:
 * no router dependency, and an address the hub serves from one static path.
 * A hash is typed, pasted or restored by a browser, so it is parsed and never
 * cast -- anything this file does not recognize is the session list, which is
 * where the app starts.
 */

/** A place the content region can show, by name. */
export type Destination = 'sessions' | 'projects' | 'settings' | 'more';

/** The address of each. `#/sessions` is also what an unreadable hash means. */
const HASHES: Record<Destination, string> = {
  sessions: '#/sessions',
  projects: '#/projects',
  settings: '#/settings',
  more: '#/more',
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
  if (hash === HASHES.projects) return 'projects';
  if (hash === HASHES.more) return 'more';
  return 'sessions';
}

/**
 * What an address means in the form the shell is actually in.
 *
 * Projects and More are places only where the sidebar is not. On a wide screen
 * the tree and the nav are on screen at every moment, so a content region
 * holding either would be a second copy of the thing beside it -- the argument
 * AGX-122 made for moving the tree into the chrome in the first place. Rather
 * than refuse those addresses on a wide screen, which would make a link sent
 * from a phone a dead one, both resolve to the list the sidebar sits next to.
 *
 * A function and not a second parser: the hash means one thing, and this says
 * where that one thing is drawn.
 */
export function resolveDestination(destination: Destination, form: ShellForm): Destination {
  if (form === 'phone') return destination;
  return destination === 'projects' || destination === 'more' ? 'sessions' : destination;
}

/** One row of the nav at the foot of the sidebar, or one tab of the phone's. */
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

/**
 * The phone chrome's tab bar: Sessions, Projects, More.
 *
 * The mockup's fourth tab is Graphs and is not drawn, for the reason the nav
 * draws no row for it. More is drawn even though it holds one thing today,
 * because what it holds is `NAV` -- the same list the sidebar's foot draws --
 * and a phone with no sidebar needs somewhere for that list to be. It grows
 * when the nav does, from the one list, rather than from a copy kept in step.
 *
 * Sessions is a tab here although it is not a nav row on a wide screen: on a
 * phone the brand mark is not in the chrome to lead back to the list, and a
 * tab bar missing the place the app opens on would be a tab bar you can leave
 * and not return to.
 */
export const TABS: readonly NavEntry[] = [
  { destination: 'sessions', label: 'Sessions' },
  { destination: 'projects', label: 'Projects' },
  { destination: 'more', label: 'More' },
];

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
