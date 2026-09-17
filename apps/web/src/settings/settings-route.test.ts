// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { pairingFor } from './settings-route.js';

/**
 * One `PairingOperations` per store, and the memo keyed by the store rather
 * than held at module scope.
 *
 * This is asserted because it is the thing a second caller breaks. The wizard
 * now draws the same pairing panel the settings screen does, and a wizard that
 * built its own operations would be a second pairing path over the same
 * socket: a pairing submitted on one and re-rendered away would be waiting on
 * a promise nobody holds. Identity is the whole assertion -- same store, same
 * object -- and the second test is what stops the memo from becoming a
 * module-scope singleton that would hand a second store the first one's
 * socket.
 */

function newStore(): HubStore {
  const sockets = createFakeSocketFactory();
  return createHubStore({
    fetchTicket: () => Promise.resolve('ticket-1'),
    createSocket: (ticket) => sockets.create(ticket),
    timers: createFakeTimers(),
    frameIds: createFrameIdCounter(),
  });
}

describe('pairing operations for a store', () => {
  it('are built once, so a pairing in flight survives a re-render', () => {
    const store = newStore();

    expect(pairingFor(store)).toBe(pairingFor(store));
  });

  it('belong to their own store, so two stores never share one', () => {
    expect(pairingFor(newStore())).not.toBe(pairingFor(newStore()));
  });
});
