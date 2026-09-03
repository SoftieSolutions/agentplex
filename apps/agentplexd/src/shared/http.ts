import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * A listening HTTP server, reduced to what a caller needs: the port actually
 * bound (which differs from the requested one when the request was 0) and a
 * close that resolves when the socket is really gone.
 */
export interface HttpListener {
  readonly port: number;
  close(): Promise<void>;
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * A connection asking to stop being HTTP.
 *
 * Taken as a handler rather than by exposing the `http.Server` itself, so that
 * this module stays the only thing that has the server object and a caller
 * cannot quietly add a second listener to it. The websocket a role serves goes
 * on the port it already binds: a server needs exactly one inbound port
 * reachable by the hub, and two would make that promise false.
 *
 * A handler that does not want the connection destroys the socket. There is no
 * response to write: the request has already left HTTP.
 */
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface HttpTimeouts {
  /**
   * How long a connection may take to finish sending its request headers.
   *
   * This is the slowloris bound: a socket that opens and then dribbles headers
   * a byte at a time costs the attacker nothing and holds a connection here.
   * Node's own default is 60 seconds, times however many sockets somebody
   * cares to open. No real client needs anything like this long.
   */
  readonly headersMs: number;
  /**
   * How long a whole request may take, body included.
   *
   * `headersMs` says nothing about a body that arrives one byte per second, so
   * without this the same attack works one layer down. Node defaults to 300
   * seconds. It must stay above `headersMs`, or a request could time out
   * before its headers were even due.
   */
  readonly requestMs: number;
  /**
   * How long an idle connection is kept for reuse.
   *
   * A hub on the public internet behind TLS accumulates idle sockets from
   * clients that walked away, and each one is a file descriptor. Long enough
   * that Caddy and the PWA reuse connections rather than reconnecting per
   * request; short enough that nothing lingers.
   */
  readonly keepAliveMs: number;
  /**
   * How often the server sweeps connections looking for the two deadlines
   * above.
   *
   * Node enforces them on a timer rather than per socket, and that timer
   * defaults to 30 seconds — so a 20-second header deadline can be up to 50
   * seconds old before anything acts on it. Sweeping more often is what makes
   * the numbers above mean roughly what they say.
   */
  readonly checkIntervalMs: number;
}

/** One place, so the two roles cannot end up defended differently. */
export const HTTP_TIMEOUTS: HttpTimeouts = {
  headersMs: 20_000,
  requestMs: 60_000,
  keepAliveMs: 10_000,
  checkIntervalMs: 5_000,
};

export function startHttpServer(
  port: number,
  host: string,
  handler: RequestHandler,
  timeouts: HttpTimeouts = HTTP_TIMEOUTS,
  onUpgrade?: UpgradeHandler,
): Promise<HttpListener> {
  const server = createServer({ connectionsCheckingInterval: timeouts.checkIntervalMs }, handler);

  // Without a listener Node destroys every upgrade request itself, which is
  // the right default for a role that serves no socket: the hub role has no
  // websocket for a server to dial, because it is the hub that dials.
  if (onUpgrade !== undefined) server.on('upgrade', onUpgrade);

  // Set explicitly rather than left to the runtime: Node's defaults are chosen
  // for a service behind something else, and this one is the edge.
  server.headersTimeout = timeouts.headersMs;
  server.requestTimeout = timeouts.requestMs;
  server.keepAliveTimeout = timeouts.keepAliveMs;

  return new Promise((resolve, reject) => {
    const onListenFailed = (error: Error): void => reject(error);
    server.once('error', onListenFailed);

    server.listen(port, host, () => {
      server.off('error', onListenFailed);
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;

      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.closeAllConnections();
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
