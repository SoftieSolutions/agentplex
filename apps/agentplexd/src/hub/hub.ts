import { PROTOCOL_VERSION, type HubId } from '@agentplex/protocol';
import { sendJson, startHttpServer, type HttpListener } from '../shared/http.js';
import type { Logger } from '../shared/logger.js';
import type { IdGenerator } from '../shared/ids.js';

/**
 * The hub role.
 *
 * The skeleton binds the port everything later hangs off and answers a health
 * check. The database, pairing, the reducer and the client socket arrive with
 * the milestones that own them; until the database does, the hub's id is minted
 * per process rather than remembered.
 */

export interface HubDependencies {
  readonly logger: Logger;
  readonly ids: IdGenerator;
  readonly host: string;
  readonly port: number;
}

export interface Hub {
  readonly hubId: HubId;
  readonly port: number;
  stop(): Promise<void>;
}

export async function startHub(dependencies: HubDependencies): Promise<Hub> {
  const { ids, host, port } = dependencies;
  const logger = dependencies.logger.child({ role: 'hub' });

  const hubId = ids.newId() as HubId;

  const listener: HttpListener = await startHttpServer(port, host, (request, response) => {
    if (request.url === '/health') {
      sendJson(response, 200, { status: 'ok', role: 'hub', protocolVersion: PROTOCOL_VERSION });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  });

  logger.info('hub listening', { port: listener.port, hubId });

  return {
    hubId,
    port: listener.port,
    async stop() {
      await listener.close();
      logger.info('hub stopped');
    },
  };
}
