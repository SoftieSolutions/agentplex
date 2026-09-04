import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type HubFrame,
} from '@agentplex/protocol';
import { createFakeDatabase } from '../db/fake-database.js';
import type { MigrationFileSystem } from '../db/migration-files.js';
import { createFakeBeaconSource } from '../discovery/fake-beacon-source.js';
import { startHub, type Hub } from '../hub.js';
import { createUnreachableDialer } from '../../shared/fake-message-socket.js';
import { CLOSE_POLICY } from '../../shared/message-socket.js';
import { createLogger } from '../../shared/logger.js';
import { createFakeTimers } from '../../shared/timers.js';
import { CLIENT_SOCKET_PATH, CLIENT_TICKET_PATH, NOT_AUTHORIZED } from './client-auth.js';
import { CLIENT_TICKET_LIFETIME_MS } from './client-tickets.js';

/**
 * The authenticated path, end to end, over a real port and a real websocket.
 *
 * The units below it are tested against values; this file exists for the claims
 * that only hold once there is a socket: that a browser's two-step exchange
 * actually works, that the ticket is spent by the first upgrade and not the
 * second, that an expired one is refused with a code a client can read, and
 * that the long-lived credential is not accepted from a URL by any route.
 */

const CLIENT_TOKEN = 'the-client-token-typed-on-the-device';
const HOST = '127.0.0.1';

const logger = createLogger('error', () => {});

const migrationFileSystem: MigrationFileSystem = {
  readDirectory: async () => ['0001_hub_identity.sql'],
  readFile: async () => 'CREATE TABLE hub_identity ()',
};

/** A clock the test moves, so a ticket can expire without anybody waiting. */
function movableClock(start = 1_756_000_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}

let hub: Hub | undefined;
let sockets: WebSocket[] = [];

afterEach(async () => {
  // `terminate`, not `close`: a socket still in CONNECTING throws out of
  // `close`, and half of these tests are about connections that never get to
  // be established.
  for (const socket of sockets) socket.terminate();
  sockets = [];
  await hub?.stop();
  hub = undefined;
});

async function startTestHub(clock = movableClock()): Promise<Hub> {
  let next = 0;
  hub = await startHub({
    database: createFakeDatabase({
      respondWith: [{ match: /SELECT hub_id FROM hub_identity/, rows: [{ hub_id: 'hub-1' }] }],
    }),
    logger,
    ids: { newId: () => 'hub-1' },
    clock,
    clientToken: CLIENT_TOKEN,
    tokens: { newToken: () => `ticket-${(next += 1)}` },
    dialer: createUnreachableDialer(),
    // A silent network: the hub listens because it always does, and hears
    // nothing, so no candidate reaches the states these tests assert on.
    discovery: createFakeBeaconSource(),
    // Nothing is paired, so nothing is dialled and no broadcast is scheduled.
    // The state a client is sent on hello is read at that moment rather than
    // flushed on a timer, which is exactly the path being exercised here.
    timers: createFakeTimers(),
    migrationsDirectory: '/migrations',
    migrationFileSystem,
    host: HOST,
    port: 0,
  });
  return hub;
}

function ticketUrl(port: number, ticket: string): string {
  return `ws://${HOST}:${port}${CLIENT_SOCKET_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

/** Asks for a ticket the way a client does: a POST, with the credential in a header. */
async function requestTicket(
  port: number,
  authorization: Record<string, string> = { authorization: `Bearer ${CLIENT_TOKEN}` },
  method = 'POST',
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://${HOST}:${port}${CLIENT_TICKET_PATH}`, {
    method,
    headers: authorization,
  });
  return { status: response.status, body: await response.json() };
}

/** Opens a socket and collects what it is told, so a test can await either outcome. */
function open(url: string): {
  readonly socket: WebSocket;
  frames(count: number): Promise<readonly HubFrame[]>;
  closed(): Promise<{ code: number; reason: string }>;
  send(frame: unknown): void;
} {
  const socket = new WebSocket(url);
  sockets.push(socket);

  const received: HubFrame[] = [];
  const waiting: (() => void)[] = [];
  const queued: string[] = [];
  let ended: { code: number; reason: string } | null = null;
  let open = false;

  socket.on('open', () => {
    open = true;
    for (const text of queued.splice(0)) socket.send(text);
  });

  socket.on('message', (data: Buffer) => {
    const parsed = parseTextFrame(parseHubFrame, data.toString('utf8'));
    if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
    received.push(parsed.value);
    for (const wake of waiting.splice(0)) wake();
  });
  socket.on('close', (code: number, reason: Buffer) => {
    ended = { code, reason: reason.toString('utf8') };
    for (const wake of waiting.splice(0)) wake();
  });

  return {
    socket,
    async frames(count: number): Promise<readonly HubFrame[]> {
      while (received.length < count) {
        if (ended !== null) {
          throw new Error(`the socket closed with ${ended.code} before ${count} frames arrived`);
        }
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      return received;
    },
    async closed(): Promise<{ code: number; reason: string }> {
      while (ended === null) await new Promise<void>((resolve) => waiting.push(resolve));
      return ended;
    },
    /** Queued until the socket is open, so a test does not have to await it. */
    send(frame: unknown): void {
      const text = JSON.stringify(frame);
      if (open) socket.send(text);
      else queued.push(text);
    },
  };
}

const HELLO = { type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION };

describe('the client websocket', () => {
  it('takes a client from its credential to the machine state', async () => {
    const started = await startTestHub();

    const exchange = await requestTicket(started.port);
    expect(exchange.status).toBe(200);
    expect(exchange.body).toEqual({ ticket: 'ticket-1', expiresInMs: CLIENT_TICKET_LIFETIME_MS });

    const client = open(ticketUrl(started.port, 'ticket-1'));
    client.send(HELLO);

    // A welcome, and then the whole state -- unasked for, which is the pipeline
    // AGX-26 built and the thing an authenticated socket exists to reach.
    const [welcome, state] = await client.frames(2);
    expect(welcome).toEqual({
      type: 'welcome',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      hubId: 'hub-1',
    });
    expect(state).toMatchObject({ type: 'machine-state', state: { stores: [], servers: [] } });
    expect(started.clients.attached).toBe(1);
  });

  it('refuses a ticket that has already been used, inside its lifetime', async () => {
    const started = await startTestHub();
    await requestTicket(started.port);

    const first = open(ticketUrl(started.port, 'ticket-1'));
    first.send(HELLO);
    await first.frames(2);

    const second = open(ticketUrl(started.port, 'ticket-1'));
    const ended = await second.closed();
    expect(ended.code).toBe(CLOSE_POLICY);
    expect(ended.reason).toBe(NOT_AUTHORIZED);
    // The first client is untouched: a replay is the replayer's problem.
    expect(started.clients.attached).toBe(1);
  });

  it('refuses a ticket whose seconds have run out', async () => {
    const clock = movableClock();
    const started = await startTestHub(clock);
    await requestTicket(started.port);

    clock.advance(CLIENT_TICKET_LIFETIME_MS + 1);

    const late = open(ticketUrl(started.port, 'ticket-1'));
    const ended = await late.closed();
    expect(ended.code).toBe(CLOSE_POLICY);
    expect(ended.reason).toBe(NOT_AUTHORIZED);
    expect(started.clients.attached).toBe(0);
  });

  it('refuses a socket that presents no ticket at all', async () => {
    const started = await startTestHub();
    const bare = open(`ws://${HOST}:${started.port}${CLIENT_SOCKET_PATH}`);
    expect((await bare.closed()).code).toBe(CLOSE_POLICY);
  });

  /**
   * The rule the whole exchange exists to make true. A query string is written
   * into access logs and browser history, so the long-lived credential must not
   * be usable from one -- under the ticket's name or any other.
   */
  it('never accepts the long-lived credential from a URL', async () => {
    const started = await startTestHub();

    const asTicket = open(ticketUrl(started.port, CLIENT_TOKEN));
    expect((await asTicket.closed()).code).toBe(CLOSE_POLICY);

    const asToken = open(
      `ws://${HOST}:${started.port}${CLIENT_SOCKET_PATH}?token=${encodeURIComponent(CLIENT_TOKEN)}`,
    );
    expect((await asToken.closed()).code).toBe(CLOSE_POLICY);

    // Nor at the exchange: the credential is read from the header and from
    // nowhere else, so a request that only puts it in the URL gets a 401.
    const inQuery = await fetch(
      `http://${HOST}:${started.port}${CLIENT_TICKET_PATH}?token=${encodeURIComponent(CLIENT_TOKEN)}`,
      { method: 'POST' },
    );
    expect(inQuery.status).toBe(401);
    expect(started.clients.attached).toBe(0);
  });

  it('answers a wrong credential with a 401 saying only that', async () => {
    const started = await startTestHub();
    const refused = await requestTicket(started.port, {
      authorization: 'Bearer not-the-client-token',
    });
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: NOT_AUTHORIZED });
  });

  /**
   * One fact, two transports. A user who mistyped the token sees the same
   * words whether the hub told them over HTTP or over a socket, and neither
   * answer says which of the two checks it was.
   */
  it('says the same thing at the 401 and at the 1008', async () => {
    const started = await startTestHub();
    const refused = await requestTicket(started.port, { authorization: 'Bearer wrong' });
    const closed = await open(ticketUrl(started.port, 'never-issued')).closed();
    expect(refused.body).toEqual({ error: NOT_AUTHORIZED });
    expect(closed.reason).toBe(NOT_AUTHORIZED);
  });

  it('refuses a GET at the exchange without minting anything', async () => {
    const started = await startTestHub();
    expect((await requestTicket(started.port, undefined, 'GET')).status).toBe(405);

    // The counter has not moved: the first ticket ever issued is still the
    // first one.
    const exchange = await requestTicket(started.port);
    expect(exchange.body).toMatchObject({ ticket: 'ticket-1' });
  });

  it('still answers the health check, which needs no credential', async () => {
    const started = await startTestHub();
    const response = await fetch(`http://${HOST}:${started.port}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', role: 'hub' });
  });
});
