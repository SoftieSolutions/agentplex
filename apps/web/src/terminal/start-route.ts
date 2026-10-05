import { frameIdSchema, type FrameId } from '@agentplex/protocol';
import { useMemo, useSyncExternalStore } from 'react';

/**
 * A start's address: `#/start/<frameId>`, the id of the `session-start` frame
 * that asked for it.
 *
 * The sibling of `#/session/...` for the one thing that is on screen before it
 * is a session. A sidebar row for an accepted spawn opens a pending pane, and
 * the content region has to know to draw the panes rather than the list; the
 * route is what says so, the same way it says so for a session. The frame id
 * is this tab's own name for the start, so the address means nothing in
 * another tab or after a reload -- and the shell reads it only when this
 * store holds the start and `startShown` says there is still something true to
 * draw for it, falling back to the list otherwise.
 *
 * Parsed, never cast: the segment has to be digits and nothing else before it
 * reaches the schema, because `Number` would read `7.0`, ` 7` and `1e1` as
 * ids, and an address is what was written, not what can be coerced out of it.
 */

const PREFIX = '#/start/';

export function startHash(startId: FrameId): string {
  return `${PREFIX}${String(startId)}`;
}

export function parseStartHash(hash: string): FrameId | null {
  if (!hash.startsWith(PREFIX)) return null;
  const segment = hash.slice(PREFIX.length);
  if (!/^\d+$/.test(segment)) return null;
  const parsed = frameIdSchema.safeParse(Number(segment));
  return parsed.success ? parsed.data : null;
}

function subscribeToHash(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function readHash(): string {
  return window.location.hash;
}

/**
 * The current start route, or `null` for every other address. Read off the
 * hash through `useSyncExternalStore` and memoised on the raw string, as
 * `useSessionRoute` is.
 */
export function useStartRoute(): FrameId | null {
  const hash = useSyncExternalStore(subscribeToHash, readHash);
  return useMemo(() => parseStartHash(hash), [hash]);
}
