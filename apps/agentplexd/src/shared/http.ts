import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

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

export function startHttpServer(
  port: number,
  host: string,
  handler: RequestHandler,
): Promise<HttpListener> {
  const server = createServer(handler);

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
