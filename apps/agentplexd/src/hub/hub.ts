import { PROTOCOL_VERSION, type HubId } from '@agentplex/protocol';
import { sendJson, startHttpServer, type HttpListener } from '../shared/http.js';
import type { Logger } from '../shared/logger.js';
import type { IdGenerator } from '../shared/ids.js';
import type { Database } from './db/database.js';
import { loadMigrations, type MigrationFileSystem } from './db/migration-files.js';
import { migrate } from './db/migrations.js';
import { ensureHubIdentity } from './hub-identity.js';

/**
 * The hub role.
 *
 * Milestone 1 brings up what everything later stands on: the database is
 * migrated before anything is served, the hub knows its own id, and it answers
 * a health check. Pairing, the reducer and the client socket arrive with the
 * milestones that own them.
 */

export interface HubDependencies {
  readonly database: Database;
  readonly logger: Logger;
  readonly ids: IdGenerator;
  readonly migrationsDirectory: string;
  readonly migrationFileSystem: MigrationFileSystem;
  readonly host: string;
  readonly port: number;
}

export interface Hub {
  readonly hubId: HubId;
  readonly port: number;
  stop(): Promise<void>;
}

export async function startHub(dependencies: HubDependencies): Promise<Hub> {
  const { database, ids, migrationsDirectory, migrationFileSystem, host, port } = dependencies;
  const logger = dependencies.logger.child({ role: 'hub' });

  // Migrating before listening is the point of doing it here: a hub that serves
  // from a schema it has not reconciled has already told a client something.
  const migrations = await loadMigrations(migrationsDirectory, migrationFileSystem);
  const outcome = await migrate(database, migrations, logger);
  logger.info('database ready', {
    applied: outcome.applied.length,
    alreadyApplied: outcome.alreadyApplied,
  });

  const hubId = await ensureHubIdentity(database, ids);

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
