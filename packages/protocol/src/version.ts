/**
 * The wire contract version, compared with `===` and never with a range.
 *
 * Two peers either speak the same protocol or they do not speak. A hub that
 * tolerates "close enough" versions has to carry, forever, the question of
 * which fields the other end actually understood; refusing the connection
 * turns that into one legible error at pairing time.
 *
 * Bump this in the same commit as any change to a frame's shape.
 */
export const PROTOCOL_VERSION = 1;

export type ProtocolVersionMismatch = {
  readonly expected: number;
  readonly received: number;
};

/** Returns the mismatch to report, or null when the peer speaks our protocol. */
export function checkProtocolVersion(received: number): ProtocolVersionMismatch | null {
  return received === PROTOCOL_VERSION ? null : { expected: PROTOCOL_VERSION, received };
}
