import { PROTOCOL_VERSION } from '@agentplex/protocol';
import { sendJson, startHttpServer, type HttpListener } from '../shared/http.js';
import type { Logger } from '../shared/logger.js';

/**
 * The server role.
 *
 * A session runner and nothing else: it holds no database, and it dials out to
 * nothing. The hub dials it. Milestone 1 opens the port the hub will dial and
 * answers a health check; store identity, the provider adapters and the PTY
 * supervisor arrive in milestone 2.
 */

export interface SessionServerDependencies {
  readonly logger: Logger;
  readonly host: string;
  readonly port: number;
}

export interface SessionServer {
  readonly port: number;
  stop(): Promise<void>;
}

export async function startSessionServer(
  dependencies: SessionServerDependencies,
): Promise<SessionServer> {
  const { host, port } = dependencies;
  const logger = dependencies.logger.child({ role: 'server' });

  const listener: HttpListener = await startHttpServer(port, host, (request, response) => {
    if (request.url === '/health') {
      sendJson(response, 200, { status: 'ok', role: 'server', protocolVersion: PROTOCOL_VERSION });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  });

  logger.info('server listening', { port: listener.port });

  return {
    port: listener.port,
    async stop() {
      await listener.close();
      logger.info('server stopped');
    },
  };
}
