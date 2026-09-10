/**
 * The fakes for this package's seams, exported beside the seams they stand in
 * for so that a test in any app reaches the one fake for a seam. A fake is a
 * captured, argued stand-in, and a second copy of one drifts from the first.
 */
export {
  PEER_GONE,
  createFakeDialer,
  createFakeMessageSocket,
  createSocketPair,
  createUnreachableDialer,
} from './fake-message-socket.js';
export type { FakeDialer, FakeMessageSocket, SocketPair } from './fake-message-socket.js';

export { createFakeTimers } from './timers.js';
export type { FakeTimers } from './timers.js';
