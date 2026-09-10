import { randomUUID } from 'node:crypto';

/**
 * The identifier seam.
 *
 * Injected so that a test asserting on a minted id does not have to match a
 * pattern, and so the one place ids come from is visible in the wiring.
 */
export interface IdGenerator {
  /** A durable, globally unique identifier: a store id, a server id, a hub id. */
  newId(): string;
}

export const randomIdGenerator: IdGenerator = { newId: () => randomUUID() };

/**
 * Frame ids come from a counter, not `randomUUID`: that API exists only in a
 * secure context and a client served over plain HTTP on a LAN is not one. An
 * id only has to be unique within a single connection.
 */
export function createFrameIdCounter(): () => number {
  let next = 0;
  return () => (next += 1);
}
