import { nodeIdSchema, type NodeId } from '@agentplex/protocol';
import { useMemo, useSyncExternalStore } from 'react';

/**
 * A document's address: `#/doc/<nodeId>`.
 *
 * The same hash routing a session pane has, for the same reasons -- no router
 * dependency, and an address the hub can serve from one static path -- and the
 * same rule about what an address is: a hash is typed, pasted or restored by a
 * browser, so it is parsed and never cast. A node id that does not parse is no
 * route rather than a pane addressing a document that cannot exist.
 *
 * The node and nothing else, because the node is the whole address a document
 * has: which project it belongs to, what the file is called and which machine
 * holds it are the hub's rows, and an address that restated any of them could
 * disagree with the tree.
 */

const PREFIX = '#/doc/';

export function docHash(nodeId: NodeId): string {
  return `${PREFIX}${encodeURIComponent(nodeId)}`;
}

export function parseDocHash(hash: string): NodeId | null {
  if (!hash.startsWith(PREFIX)) return null;
  const segments = hash.slice(PREFIX.length).split('/');
  if (segments.length !== 1) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segments[0] ?? '');
  } catch {
    // A malformed percent-escape is a bad address, not an exception.
    return null;
  }
  const parsed = nodeIdSchema.safeParse(decoded);
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
 * The current document route, or `null` for every other address. The hash is
 * an external store read through `useSyncExternalStore` and never an effect;
 * the parsed node is memoized on the raw string, so an unchanged address
 * yields one value and the callbacks hung off it keep their identity.
 */
export function useDocRoute(): NodeId | null {
  const hash = useSyncExternalStore(subscribeToHash, readHash);
  return useMemo(() => parseDocHash(hash), [hash]);
}
