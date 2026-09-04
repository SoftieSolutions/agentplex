import { sessionRefSchema, type SessionRef } from '@agentplex/protocol';
import { useMemo, useSyncExternalStore } from 'react';

/**
 * The session pane's address: `#/session/<storeId>/<sessionId>`.
 *
 * A hash route rather than a router dependency, deliberately small: the app
 * has exactly two states today — the placeholder shell and one open session —
 * and the layout ticket (AGX-34) owns deciding what navigation grows into.
 * The hash also survives being served by the hub from one static path, which
 * a path route would need server cooperation for.
 *
 * A hash is user input — typed, pasted, or restored by the browser — so it is
 * parsed, never cast: the segments go through the protocol's session-ref
 * schema, and anything that does not parse is the placeholder screen rather
 * than a pane addressing a session that cannot exist.
 */

const PREFIX = '#/session/';

export function sessionHash(ref: SessionRef): string {
  return `${PREFIX}${encodeURIComponent(ref.storeId)}/${encodeURIComponent(ref.sessionId)}`;
}

export function parseSessionHash(hash: string): SessionRef | null {
  if (!hash.startsWith(PREFIX)) return null;
  const segments = hash.slice(PREFIX.length).split('/');
  if (segments.length !== 2) return null;
  let decoded: string[];
  try {
    decoded = segments.map(decodeURIComponent);
  } catch {
    // A malformed percent-escape is a bad address, not an exception.
    return null;
  }
  const parsed = sessionRefSchema.safeParse({ storeId: decoded[0], sessionId: decoded[1] });
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
 * The current session route, or `null` for every other address. The hash is
 * an external store and is read through `useSyncExternalStore`, not an
 * effect; the snapshot is the raw string (stable between changes), and the
 * parsed ref is memoized on it so an unchanged hash yields one object —
 * consumers hang subscriptions and callbacks off the ref's identity.
 */
export function useSessionRoute(): SessionRef | null {
  const hash = useSyncExternalStore(subscribeToHash, readHash);
  return useMemo(() => parseSessionHash(hash), [hash]);
}
