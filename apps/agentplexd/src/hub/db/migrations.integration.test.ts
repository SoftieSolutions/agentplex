import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresDatabase } from './postgres.js';
import { loadMigrations } from './migration-files.js';
import { nodeMigrationFileSystem } from './node-migration-files.js';
import { migrate } from './migrations.js';
import { ensureHubIdentity } from '../hub-identity.js';
import { createLogger } from '../../shared/logger.js';
import { randomIdGenerator } from '../../shared/ids.js';

/**
 * The migrations run against a real Postgres.
 *
 * The fake in `migrations.test.ts` covers the runner's control flow; only a
 * real server can say whether the SQL is valid. `pnpm docker:test` supplies the
 * database; without one the suite is skipped rather than passing quietly.
 */
const DATABASE_URL = process.env['AGENTPLEX_TEST_DATABASE_URL'];

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../../migrations', import.meta.url));

describe.skipIf(DATABASE_URL === undefined)('migrations against Postgres', () => {
  const database = createPostgresDatabase(DATABASE_URL ?? '');
  const logger = createLogger('error', () => {});

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    // Each test starts from nothing, so "applies from empty" means it.
    await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  });

  it('applies every shipped migration to an empty database', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
    expect(migrations.length).toBeGreaterThan(0);

    const outcome = await migrate(database, migrations, logger);

    expect(outcome.applied).toHaveLength(migrations.length);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
    await migrate(database, migrations, logger);

    const second = await migrate(database, migrations, logger);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(migrations.length);
  });

  it('refuses to open a database that has run a migration this build does not ship', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
    await migrate(database, migrations, logger);
    await database.query('INSERT INTO schema_migrations (version, name) VALUES (9999, $1)', [
      'from_a_newer_build',
    ]);

    await expect(migrate(database, migrations, logger)).rejects.toMatchObject({
      code: 'database-ahead',
    });
  });

  it('mints one hub id and returns the same one on every later start', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
    await migrate(database, migrations, logger);

    const first = await ensureHubIdentity(database, randomIdGenerator);
    const second = await ensureHubIdentity(database, randomIdGenerator);

    expect(second).toBe(first);
  });
});
