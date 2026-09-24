import { nodeIdSchema, type NodeId } from '@agentplex/protocol';
import { useMemo, useSyncExternalStore } from 'react';

/**
 * A graph's address: `#/graph/<nodeId>`.
 *
 * The same hash routing a document has, for the same reasons -- no router
 * dependency, an address the hub serves from one static path, and a hash that
 * is parsed and never cast because a browser restores it and a person pastes
 * it. The node and nothing else: which project it belongs to and what it is
 * called are the hub's rows, and an address restating either could disagree
 * with the tree.
 *
 * What differs from a document is where the address lands. A document opens
 * in a pane of the layout screen; a graph is a screen of its own, drawn
 * straight into the content region, so this route is read by the shell and
 * never by the pane layout.
 */

const PREFIX = '#/graph/';

export function graphHash(nodeId: NodeId): string {
  return `${PREFIX}${encodeURIComponent(nodeId)}`;
}

export function parseGraphHash(hash: string): NodeId | null {
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
 * The current graph route, or `null` for every other address. The hash is an
 * external store read through `useSyncExternalStore` and never an effect; the
 * parsed node is memoized on the raw string, so an unchanged address yields
 * one value.
 */
export function useGraphRoute(): NodeId | null {
  const hash = useSyncExternalStore(subscribeToHash, readHash);
  return useMemo(() => parseGraphHash(hash), [hash]);
}
