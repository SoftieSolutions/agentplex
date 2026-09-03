import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  closure,
  CLOSE_NORMAL,
  type DialResult,
  type MessageSocket,
  type SocketClosure,
  type SocketDialer,
} from './message-socket.js';
import type { UpgradeHandler } from './http.js';

/**
 * The real socket, named in one place so nothing above ever imports `ws`.
 *
 * TLS is not configured here and that is deliberate. The design terminates TLS
 * at the reverse proxy — Caddy in the shipped compose file, or whatever the
 * operator already runs — so the hub dials a `wss://` URL and Node verifies the
 * chain against the system trust store on its own. Hand-rolling a TLS context
 * in this file would mean re-deciding certificate verification, and a
 * verification decision made in application code is one that gets loosened
 * under deadline. `server-address.ts` refuses anything but `wss://` for the
 * same reason: the token travels on this socket.
 */

export interface WebSocketDialerOptions {
  /**
   * How long the TCP connect and websocket upgrade may take.
   *
   * Distinct from the handshake deadline above it: this one bounds getting a
   * socket at all, and that one bounds the peer answering on it. A server whose
   * machine is asleep fails here; a server that accepts and says nothing fails
   * there.
   */
  readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export function createWebSocketDialer(options: WebSocketDialerOptions = {}): SocketDialer {
  const handshakeTimeout = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return {
    dial(address: string): Promise<DialResult> {
      return new Promise<DialResult>((resolve) => {
        let opened = false;
        const socket = new WebSocket(address, { handshakeTimeout });

        socket.once('open', () => {
          opened = true;
          resolve({ ok: true, socket: wrapWebSocket(socket) });
        });

        // Before `open` this is the dial failing, and the caller gets a value.
        // After it, the socket is somebody else's and its errors reach them as
        // the close that `ws` always emits next.
        socket.once('error', (error: Error) => {
          if (opened) return;
          resolve({ ok: false, problem: String(error) });
        });
      });
    },
  };
}

/**
 * Wraps a live websocket as the seam.
 *
 * Everything the rest of the codebase knows about a socket is these four
 * methods, which is what lets the handshake rules be tested with no port open.
 */
export function wrapWebSocket(socket: WebSocket): MessageSocket {
  let ended = false;

  return {
    send(text: string): void {
      // A send on a closing socket throws in `ws`. Dropping it is right: the
      // peer is gone, and there is nothing a caller could do with the throw
      // that it will not also learn from the close it is about to be handed.
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(text);
    },

    close(reason: SocketClosure): void {
      if (ended) return;
      ended = true;
      socket.close(reason.code, reason.reason);
    },

    onMessage(listener: (text: string) => void): void {
      // Frames are JSON text. A peer sending binary on this direction is
      // sending something no parser here reads, and decoding it as UTF-8 lets
      // the parser say so rather than this layer inventing an answer.
      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        listener(toText(data));
      });
    },

    onClose(listener: (reason: SocketClosure) => void): void {
      socket.once('close', (code: number, reason: Buffer) => {
        ended = true;
        listener({ code, reason: reason.toString('utf8') });
      });
      // An error that arrives before any close is still a close as far as
      // anything above is concerned; `ws` emits `close` after it, and `once`
      // above means whichever lands first is the one delivered.
      socket.once('error', (error: Error) => {
        if (ended) return;
        ended = true;
        listener(closure(CLOSE_NORMAL, String(error)));
      });
    },
  };
}

function toText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8');
}

export interface WebSocketListener {
  /** Hand this to `startHttpServer` so the socket shares the role's one port. */
  readonly onUpgrade: UpgradeHandler;
  /** Closes every live connection and the server with them. */
  close(): void;
}

/**
 * What an accepted upgrade is allowed to remember about the request that made
 * it.
 *
 * The URL, and nothing else. Not the `IncomingMessage`: a browser cannot set a
 * header on a websocket, so a rule written against one would be a rule no
 * client could satisfy, and holding the request object here is how somebody
 * later writes one anyway. It is the raw request target, which on the hub's
 * client route carries a ticket — so it is a secret, and `requestPath` is what
 * anything logging it goes through.
 */
export interface UpgradeRequest {
  readonly url: string;
}

export interface WebSocketListenerOptions {
  /**
   * Called once per accepted connection, with the seam rather than the
   * websocket.
   *
   * Every path is accepted here, deliberately, and what to do about that is the
   * caller's. The hub dials a server at the address the user typed and nothing
   * appends to it, because that address may be a tunnel or a reverse proxy with
   * a prefix this process cannot know about — and a path check in this file
   * would reject exactly the deployments the transport-agnostic design exists
   * to support. Nothing is protected by it either: on the server role the token
   * is what admits a peer, checked on the first frame whatever path the socket
   * arrived on, and on the hub's client route the ticket in the URL is, checked
   * before the socket is served.
   */
  readonly onConnection: (socket: MessageSocket, request: UpgradeRequest) => void;
  /** How large a frame may be, in bytes, before the connection is dropped. */
  readonly maxPayloadBytes?: number;
}

/**
 * A frame ceiling, because a socket is reachable by anything that can open a
 * TCP connection and `ws` will otherwise buffer whatever arrives. Every frame
 * on this direction is small; a store list from a server with many mounts is
 * the largest thing here and is nowhere near this.
 */
const DEFAULT_MAX_PAYLOAD_BYTES = 1_000_000;

/**
 * The listening side. Only the server role has one — a hub dials and is never
 * dialled by a server — and it hangs off the role's existing HTTP listener so
 * that the machine needs exactly one inbound port open, which is the promise
 * the connectivity design makes to anyone opening a firewall.
 */
export function createWebSocketListener(options: WebSocketListenerOptions): WebSocketListener {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });

  server.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    options.onConnection(wrapWebSocket(socket), { url: request.url ?? '/' });
  });

  return {
    onUpgrade(request, socket, head) {
      server.handleUpgrade(request, socket, head, (websocket) => {
        server.emit('connection', websocket, request);
      });
    },
    close(): void {
      for (const client of server.clients) client.terminate();
      server.close();
    },
  };
}
