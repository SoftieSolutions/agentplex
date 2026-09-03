import { frameIdSchema, type FrameId } from '@agentplex/protocol';

/**
 * Where the id on an outbound frame comes from.
 *
 * A counter, not `crypto.randomUUID`: that API exists only in a secure
 * context, and this app's ordinary origin — plain HTTP on a LAN, opened on a
 * phone — is not one. A counter needs no such context and is enough, because
 * the only thing a frame id has to be is unique within one connection, and a
 * value that never repeats within one store is unique within every connection
 * the store opens.
 *
 * A seam rather than a module-level counter so a test can assert on the exact
 * ids the store put on the wire, and so two stores in one page never share a
 * sequence.
 */
export interface FrameIds {
  /** The next id. Starts at 1 and only ever grows. */
  next(): FrameId;
}

export function createFrameIdCounter(): FrameIds {
  let last = 0;
  return {
    next(): FrameId {
      last += 1;
      // Through the schema rather than a cast: the brand is a parser's to
      // grant, even to a producer that cannot emit anything else.
      return frameIdSchema.parse(last);
    },
  };
}
