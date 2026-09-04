import type { ParseResult } from '@agentplex/protocol';
import { createFrameIdCounter } from './frame-ids.js';
import type { HubStoreDependencies, StoreSocket } from './hub-store.js';
import { browserTimers } from './timers.js';

/**
 * The store's seams, filled with the real browser: `fetch` for the ticket
 * exchange, `WebSocket` for the socket, `setTimeout` for the backoff. This is
 * the one file in the store that touches a platform API, so it is the one file
 * its tests cannot reach past — everything here is either a pure function,
 * tested, or a one-line adapter over the platform.
 *
 * The paths mirror the hub's `client-auth.ts`, which cannot be imported: no
 * code crosses a package line but the protocol, and the protocol package
 * carries frames, not routes.
 */
export const CLIENT_TICKET_PATH = '/client/ticket';
export const CLIENT_SOCKET_PATH = '/client';

/**
 * Reads the ticket out of the exchange's answer. A parser, not a cast: the
 * body came off the network and is a claim until something checks it.
 */
export function parseTicketBody(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'object' || raw === null || !('ticket' in raw)) {
    return { ok: false, reason: 'the ticket exchange answered without a ticket' };
  }
  const ticket = (raw as { ticket: unknown }).ticket;
  if (typeof ticket !== 'string' || ticket.length === 0) {
    return { ok: false, reason: 'the ticket exchange answered with something not a ticket' };
  }
  return { ok: true, value: ticket };
}

/** Where the page came from, as the socket URL needs it. */
export interface PageOrigin {
  /** `location.protocol`: 'http:' or 'https:'. */
  readonly protocol: string;
  /** `location.host`: hostname with its port. */
  readonly host: string;
}

/**
 * The websocket URL for one ticket. `ws` under plain HTTP because the LAN
 * origin this app ordinarily runs on has no TLS — which is the same fact that
 * rules out `crypto.randomUUID` for frame ids.
 */
export function socketUrl(origin: PageOrigin, ticket: string): string {
  const scheme = origin.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${origin.host}${CLIENT_SOCKET_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

export interface BrowserDependencyOptions {
  /**
   * The long-lived credential, read per exchange so the settings screen can
   * change it without rebuilding the store. It goes in a header and never in a
   * URL; the URL only ever carries the single-use ticket.
   */
  readToken(): string;
}

/** One `WebSocket`, behind the store's socket seam. */
function wrapWebSocket(socket: WebSocket): StoreSocket {
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
    onOpen: (fire) => socket.addEventListener('open', fire, { once: true }),
    onMessage: (fire) =>
      socket.addEventListener('message', (event: MessageEvent<unknown>) => {
        // A binary frame would be a claim this protocol never makes; the text
        // parser is where anything else gets said no to.
        if (typeof event.data === 'string') fire(event.data);
      }),
    onClose: (fire) => socket.addEventListener('close', fire, { once: true }),
  };
}

/** The real dependencies for `createHubStore`, minus the future frame seams. */
export function createBrowserDependencies(options: BrowserDependencyOptions): HubStoreDependencies {
  return {
    async fetchTicket(): Promise<string> {
      const response = await fetch(CLIENT_TICKET_PATH, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.readToken()}` },
      });
      if (!response.ok) {
        // The hub says `not authorized` and no more, on purpose; the status is
        // all there is to relay.
        throw new Error(`the hub answered ${String(response.status)} at the ticket exchange`);
      }
      const parsed = parseTicketBody(await response.json());
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.value;
    },
    createSocket: (ticket) => wrapWebSocket(new WebSocket(socketUrl(window.location, ticket))),
    timers: browserTimers,
    frameIds: createFrameIdCounter(),
  };
}
