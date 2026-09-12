import {
  closure,
  CLOSE_NORMAL,
  type DialResult,
  type MessageSocket,
  type SocketClosure,
  type SocketDialer,
} from './message-socket.js';

/**
 * A socket a test drives by hand, and a pair of them wired to each other.
 *
 * A real implementation of the seam rather than a mock, for the reason
 * `fake-pty` is one: what the handshake has to get right is what it does with
 * a reply that arrives, a reply that names the wrong frame, a peer that closes
 * mid-handshake and a peer that says nothing at all. Every one of those is a
 * value this can produce, and asserting that `send` was called would test the
 * shape of the code instead of its behaviour.
 *
 * Delivery is asynchronous, always. A fake that called the peer's listener
 * inside `send` would let a reply arrive before the sender had subscribed to
 * it — an ordering no real socket can produce, and one that would make a
 * genuine race pass here and fail on a wire.
 */
export interface FakeMessageSocket extends MessageSocket {
  /** Delivers a frame as if the peer had sent it. */
  receive(text: string): void;
  /**
   * Writes out everything queued: the peer receives it and the buffer empties.
   *
   * Only a socket built with `drains: false` has anything to write out. It is
   * the moment a slow reader catches up, which is the other half of what a
   * backpressure rule has to be tested against -- a gate that drops forever is
   * as wrong as one that never drops, and only a drain can tell them apart.
   */
  drain(): void;
  /** Closes as if the peer had closed. */
  closeFromPeer(closure: SocketClosure): void;
  /** Joins this socket to another, so what one sends the other receives. */
  connectTo(peer: FakeMessageSocket): void;
  /** Everything this end sent, in order, as raw text. */
  readonly sent: readonly string[];
  /** The closure that ended it, or `null` while it is open. */
  readonly closure: SocketClosure | null;
}

export interface FakeMessageSocketOptions {
  /**
   * Whether the peer is reading.
   *
   * True by default, which is every socket in every test that is not about
   * backpressure: a frame is written out as it is sent, `bufferedBytes` stays
   * at zero, and the peer hears it on the next microtask as before.
   *
   * False is the case that kills a server. It is not a socket that refuses a
   * write -- no socket does that, which is the whole problem -- but one that
   * accepts every write and never gets rid of it, so the queue is this
   * process's memory and grows for as long as something keeps sending. A test
   * that wants to prove a producer is bounded needs a consumer that provides no
   * bound at all, and this is it.
   */
  readonly drains?: boolean;
}

const encoder = new TextEncoder();

export function createFakeMessageSocket(options: FakeMessageSocketOptions = {}): FakeMessageSocket {
  const writesThrough = options.drains ?? true;
  /** Sent and not yet written out. Empty whenever the peer is reading. */
  const queued: string[] = [];
  let bufferedBytes = 0;
  const sent: string[] = [];
  const messageListeners: ((text: string) => void)[] = [];
  const closeListeners: ((closure: SocketClosure) => void)[] = [];
  let ended: SocketClosure | null = null;
  let peer: FakeMessageSocket | null = null;

  const end = (reason: SocketClosure): void => {
    if (ended !== null) return;
    ended = reason;
    // Asynchronous for the same reason delivery is: a real close is an event,
    // and code that closes and then returns must not have its own close
    // handler run before it got there.
    queueMicrotask(() => {
      for (const listener of closeListeners) listener(reason);
    });
  };

  /** Writes the queue out, in order, exactly as a socket that caught up would. */
  const flush = (): void => {
    const writing = queued.splice(0, queued.length);
    bufferedBytes = 0;
    for (const text of writing) peer?.receive(text);
  };

  return {
    send(text: string): void {
      if (ended !== null) return;
      sent.push(text);
      queued.push(text);
      // Bytes and not characters, because that is what a socket holds and what
      // `ws` counts; a cap measured in characters would be a different cap on
      // every alphabet.
      bufferedBytes += encoder.encode(text).length;
      if (writesThrough) flush();
    },
    close(reason: SocketClosure): void {
      const alreadyEnded = ended !== null;
      end(reason);
      if (!alreadyEnded) peer?.closeFromPeer(reason);
    },
    onMessage(listener: (text: string) => void): void {
      messageListeners.push(listener);
    },
    onClose(listener: (reason: SocketClosure) => void): void {
      closeListeners.push(listener);
    },
    drain(): void {
      flush();
    },
    get bufferedBytes(): number {
      return bufferedBytes;
    },
    receive(text: string): void {
      if (ended !== null) return;
      queueMicrotask(() => {
        for (const listener of messageListeners) listener(text);
      });
    },
    closeFromPeer(reason: SocketClosure): void {
      end(reason);
    },
    connectTo(other: FakeMessageSocket): void {
      peer = other;
    },
    get sent(): readonly string[] {
      return sent;
    },
    get closure(): SocketClosure | null {
      return ended;
    },
  };
}

export interface SocketPair {
  /** The dialling end. In this protocol, always the hub. */
  readonly hubEnd: FakeMessageSocket;
  /** The listening end. In this protocol, always the server. */
  readonly serverEnd: FakeMessageSocket;
}

/**
 * Two sockets joined, so a test can run the hub's handshake against the
 * server's with no port anywhere.
 *
 * This is the test that matters most: both sides are the real code, both
 * parsers run on real JSON, and the only thing replaced is the wire.
 */
export function createSocketPair(): SocketPair {
  const hubEnd = createFakeMessageSocket();
  const serverEnd = createFakeMessageSocket();
  hubEnd.connectTo(serverEnd);
  serverEnd.connectTo(hubEnd);
  return { hubEnd, serverEnd };
}

export interface FakeDialer extends SocketDialer {
  /** Every address dialled, in order. */
  readonly dialled: readonly string[];
}

/** A dialer that answers with whatever `answer` returns for an address. */
export function createFakeDialer(answer: (address: string) => DialResult): FakeDialer {
  const dialled: string[] = [];
  return {
    dial(address: string): Promise<DialResult> {
      dialled.push(address);
      return Promise.resolve(answer(address));
    },
    get dialled(): readonly string[] {
      return dialled;
    },
  };
}

/** The common case: a dialer that never reaches anything. */
export function createUnreachableDialer(problem = 'connection refused'): FakeDialer {
  return createFakeDialer(() => ({ ok: false, problem }));
}

/** A closure standing for a peer that went away without saying why. */
export const PEER_GONE: SocketClosure = closure(CLOSE_NORMAL, 'peer closed');
