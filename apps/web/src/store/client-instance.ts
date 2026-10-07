import { clientInstanceSchema, type ClientInstance } from '@agentplex/protocol';

/**
 * How many random bytes name a page: sixteen, which `clientInstanceSchema`
 * expects as 32 hex digits.
 */
const INSTANCE_BYTES = 16;

/**
 * Mints the name one store says on every hello it sends.
 *
 * Once per store, in `browser.ts`, and never as a constant anywhere: two tabs
 * that said the same name would be one page to the hub, and the second to dial
 * would take the first's starts over. Random rather than counted for the same
 * reason -- a counter starts at the same number in every tab.
 *
 * `crypto.getRandomValues` and not `crypto.randomUUID`: the second exists only
 * in a secure context and this app's ordinary origin is plain HTTP on a LAN,
 * which `frame-ids.ts` says too. `getRandomValues` is available on any origin.
 *
 * `fill` is injected so a test can pin the bytes; the app takes the default.
 */
export function mintClientInstance(
  fill: (bytes: Uint8Array) => void = (bytes) => {
    crypto.getRandomValues(bytes);
  },
): ClientInstance {
  const bytes = new Uint8Array(INSTANCE_BYTES);
  fill(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  // Through the schema rather than a cast, as a frame id is: the shape is the
  // schema's claim to check, even for a producer that cannot emit another.
  return clientInstanceSchema.parse(hex);
}
