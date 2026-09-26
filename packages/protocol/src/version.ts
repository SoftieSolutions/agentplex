/**
 * The wire contract versions, one per leg, each compared with `===` and never
 * with a range.
 *
 * Two peers either speak the same protocol or they do not speak. A hub that
 * tolerates "close enough" versions has to carry, forever, the question of
 * which fields the other end actually understood; refusing the connection
 * turns that into one legible error at pairing time.
 *
 * The hub speaks two contracts that change for different reasons: the client
 * leg (`clientFrameSchema` / `hubFrameSchema`, the browser and the MCP
 * surface) and the server leg (`hubToServerFrameSchema` /
 * `serverToHubFrameSchema` and the discovery beacon). One number for both made
 * a client-only change refuse every paired server until each machine
 * upgraded. Each leg now counts its own contracts, so a change strands only
 * the peers that speak the leg it touched.
 *
 * These integers are not the "v0" the design document uses. That name
 * describes how settled the protocol is — pre-1.0, still free to change
 * shape. Each counts wire contracts, starts at 1, and only ever increases. It
 * never takes the value 0, because a falsy version is indistinguishable from a
 * missing one in any code that tests it before comparing.
 *
 * Bump a leg in the same commit as any change to its shape. The wire-shape
 * guard (`wire-shape.test.ts`) snapshots each leg under its number, so a
 * shape change without a bump fails the suite, and so does a bump without the
 * new snapshot committed.
 */
export const CLIENT_PROTOCOL_VERSION = 40;

/** The hub-to-server leg's contract; see `CLIENT_PROTOCOL_VERSION` above. */
export const SERVER_PROTOCOL_VERSION = 40;

export type ProtocolLeg = 'client' | 'server';

/** Each leg's version by name, for anything that records or compares both. */
export const PROTOCOL_VERSIONS: Readonly<Record<ProtocolLeg, number>> = Object.freeze({
  client: CLIENT_PROTOCOL_VERSION,
  server: SERVER_PROTOCOL_VERSION,
});

export type ProtocolVersionMismatch = {
  readonly expected: number;
  readonly received: number;
};

function compareProtocolVersion(
  expected: number,
  received: number,
): ProtocolVersionMismatch | null {
  return received === expected ? null : { expected, received };
}

/** Returns the mismatch to report, or null when a client speaks our client leg. */
export function checkClientProtocolVersion(received: number): ProtocolVersionMismatch | null {
  return compareProtocolVersion(CLIENT_PROTOCOL_VERSION, received);
}

/** Returns the mismatch to report, or null when a server speaks our server leg. */
export function checkServerProtocolVersion(received: number): ProtocolVersionMismatch | null {
  return compareProtocolVersion(SERVER_PROTOCOL_VERSION, received);
}
