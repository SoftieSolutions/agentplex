import { describe, expect, it } from 'vitest';
import { createFakeMessageSocket, createSocketPair, PEER_GONE } from './fake-message-socket.js';

/**
 * The fake's own bound, tested here because other suites assert against it.
 *
 * `bufferedBytes` is the one thing on the socket seam that a fake could
 * quietly get wrong in the direction that makes a backpressure test pass: a
 * fake reporting zero forever would let an unbounded producer look bounded.
 * So the number it reports is asserted here, against the byte counts a real
 * socket would hold, rather than only through the code that reads it.
 */

const settle = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 0));

describe('createFakeMessageSocket buffering', () => {
  it('holds nothing when the peer is reading, which is every other test', () => {
    const socket = createFakeMessageSocket();

    socket.send('a frame');
    socket.send('another');

    expect(socket.bufferedBytes).toBe(0);
    expect(socket.sent).toEqual(['a frame', 'another']);
  });

  it('holds everything when the peer is not reading', () => {
    const socket = createFakeMessageSocket({ drains: false });

    socket.send('12345');
    socket.send('678');

    expect(socket.bufferedBytes).toBe(8);
  });

  it('counts bytes and not characters, as a socket does', () => {
    // A cap measured in characters would be a different cap on every alphabet,
    // and a terminal chunk is base64 precisely so that it is neither.
    const socket = createFakeMessageSocket({ drains: false });

    socket.send('é');

    expect(socket.bufferedBytes).toBe(2);
  });

  it('empties on a drain, which is a slow reader catching up', async () => {
    const { hubEnd, serverEnd } = createSocketPair();
    const slow = createFakeMessageSocket({ drains: false });
    slow.connectTo(hubEnd);
    const heard: string[] = [];
    hubEnd.onMessage((text) => void heard.push(text));

    slow.send('first');
    slow.send('second');
    expect(slow.bufferedBytes).toBe(11);

    slow.drain();
    await settle();

    expect(slow.bufferedBytes).toBe(0);
    // Written out in order, as a socket that caught up would: a drain is a
    // delivery and not a discard.
    expect(heard).toEqual(['first', 'second']);
    expect(serverEnd.sent).toEqual([]);
  });

  it('holds nothing more once it has closed', () => {
    const socket = createFakeMessageSocket({ drains: false });
    socket.send('before');

    socket.closeFromPeer(PEER_GONE);
    socket.send('after');

    expect(socket.bufferedBytes).toBe(6);
    expect(socket.sent).toEqual(['before']);
  });
});
