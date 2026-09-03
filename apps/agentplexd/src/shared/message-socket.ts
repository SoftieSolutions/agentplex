/**
 * The socket seam.
 *
 * Two peers exchanging text frames, reduced to what the protocol needs and
 * nothing the transport happens to offer. It is an interface because a real
 * websocket is a port, a TLS chain and an event emitter — none of which a unit
 * test can supply — and because the handshake rules above it are the part worth
 * testing: what a server does with a wrong token, what a hub does with a reply
 * that names the wrong frame, who closes and with what code.
 *
 * `ws-message-socket.ts` is the implementation both roles run with;
 * `fake-message-socket.ts` is the one tests drive, including as a linked pair
 * so that the two real state machines can be run against each other.
 *
 * Text, not bytes. Every frame on this direction of the protocol is JSON, and
 * a seam carrying `Uint8Array` would push the decoding decision into every
 * caller. Terminal bytes are the exception that proves it: they never travel
 * as frames and they get their own path.
 */
export interface MessageSocket {
  /** Fire and forget. A socket that has closed drops what it is handed. */
  send(text: string): void;
  /** Closes from this end. Closing twice is allowed and does nothing the second time. */
  close(closure: SocketClosure): void;
  /** Subscribing twice delivers to both; nothing that already arrived is replayed. */
  onMessage(listener: (text: string) => void): void;
  /** Delivered exactly once, whichever end closed and whether or not it was clean. */
  onClose(listener: (closure: SocketClosure) => void): void;
}

export interface SocketClosure {
  readonly code: number;
  /**
   * Why, in words, for a log line and for the pairing screen.
   *
   * A websocket close reason is capped at 123 bytes by RFC 6455 and a longer
   * one throws in `ws` rather than being cut down, so everything that builds
   * one goes through `closure()` below.
   */
  readonly reason: string;
}

/**
 * The close codes this protocol uses, and only these.
 *
 * `1008` is the policy-violation code, and every refusal here is one: a token
 * that did not verify, a protocol version that is not ours, a frame that could
 * not be read. The frame sent just before the close is what says which — the
 * code is for the socket layer, the frame is for the user.
 */
export const CLOSE_NORMAL = 1000;
export const CLOSE_POLICY = 1008;

/** RFC 6455 caps the reason at 123 bytes. Longer reasons are cut, not thrown. */
const MAX_REASON_BYTES = 123;

/** Builds a closure whose reason a real websocket will accept. */
export function closure(code: number, reason: string): SocketClosure {
  return { code, reason: truncateUtf8(reason, MAX_REASON_BYTES) };
}

/**
 * Cuts on a code point boundary, so a reason ending in a multi-byte character
 * is shortened rather than turned into a byte sequence nothing can decode.
 */
function truncateUtf8(text: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= limit) return text;

  let cut = text;
  while (cut.length > 0 && encoder.encode(cut).length > limit) {
    cut = [...cut].slice(0, -1).join('');
  }
  return cut;
}

export type DialResult =
  | { readonly ok: true; readonly socket: MessageSocket }
  /**
   * The dial never got a socket. A value rather than a throw: an unreachable
   * server is the expected state of a laptop that is asleep, not an exception,
   * and the supervisor above has to schedule a retry either way.
   */
  | { readonly ok: false; readonly problem: string };

/**
 * What the hub dials with. Only the hub has one: a server dials out to nothing.
 */
export interface SocketDialer {
  /** The address has already been parsed; see `hub/pairing/server-address.ts`. */
  dial(address: string): Promise<DialResult>;
}
