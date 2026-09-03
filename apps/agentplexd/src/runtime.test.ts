import { afterEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from './runtime.js';
import { createFakeDatabase } from './hub/db/fake-database.js';
import type { MigrationFileSystem } from './hub/db/migration-files.js';
import { createLogger } from './shared/logger.js';
import type { Config } from './config/config.js';

const logger = createLogger('error', () => {});
const ids = { newId: () => 'hub-under-test' };

const migrationFileSystem: MigrationFileSystem = {
  readDirectory: async () => ['0001_hub_identity.sql'],
  readFile: async () => 'CREATE TABLE hub_identity ()',
};

/** The hub reads its own id back after minting it; the fake has to answer that. */
const hubIdentityRow = {
  match: /SELECT hub_id FROM hub_identity/,
  rows: [{ hub_id: 'hub-under-test' }],
};

function fakeHubDatabase(options: Parameters<typeof createFakeDatabase>[0] = {}) {
  return createFakeDatabase({ ...options, respondWith: [hubIdentityRow] });
}

function dependencies(database = fakeHubDatabase()) {
  return {
    logger,
    ids,
    openDatabase: () => database,
    migrationsDirectory: '/migrations',
    migrationFileSystem,
  };
}

const HOST = '127.0.0.1';

const serverOnly: Config = { role: 'server', logLevel: 'error', host: HOST, server: { port: 0 } };
const hubOnly: Config = {
  role: 'hub',
  logLevel: 'error',
  host: HOST,
  hub: { port: 0, databaseUrl: 'postgres://unused' },
};
const both: Config = {
  role: 'both',
  logLevel: 'error',
  host: HOST,
  hub: { port: 0, databaseUrl: 'postgres://unused' },
  server: { port: 0 },
};

let runtime: Runtime | undefined;

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
});

describe('startRuntime', () => {
  it('starts only the server half for the server role, and opens no database', async () => {
    const database = fakeHubDatabase();
    runtime = await startRuntime(serverOnly, {
      ...dependencies(database),
      openDatabase: () => {
        throw new Error('the server role must not open a database');
      },
    });

    expect(runtime.hub).toBeNull();
    expect(runtime.server).not.toBeNull();
    expect(database.statements).toEqual([]);
  });

  it('starts only the hub half for the hub role', async () => {
    runtime = await startRuntime(hubOnly, dependencies());

    expect(runtime.hub).not.toBeNull();
    expect(runtime.server).toBeNull();
  });

  it('starts both halves in one process for the both role', async () => {
    runtime = await startRuntime(both, dependencies());

    expect(runtime.hub).not.toBeNull();
    expect(runtime.server).not.toBeNull();
  });

  it('migrates before it serves', async () => {
    const database = fakeHubDatabase();
    runtime = await startRuntime(hubOnly, dependencies(database));

    expect(database.appliedVersions).toEqual([1]);
  });

  it('answers a health check on the port it bound', async () => {
    runtime = await startRuntime(serverOnly, dependencies());
    const port = runtime.server?.port ?? 0;

    const response = await fetch(`http://127.0.0.1:${port}/health`);

    await expect(response.json()).resolves.toMatchObject({ status: 'ok', role: 'server' });
  });

  it('closes the database when it stops, so a restart is not blocked by a pool', async () => {
    const database = fakeHubDatabase();
    runtime = await startRuntime(hubOnly, dependencies(database));

    await runtime.stop();

    expect(database.closed).toBe(true);
  });

  it('is safe to stop twice, because a signal can arrive twice', async () => {
    runtime = await startRuntime(serverOnly, dependencies());

    await runtime.stop();

    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it('leaves no listener behind when a half fails to start', async () => {
    const database = fakeHubDatabase({ failOn: /CREATE TABLE hub_identity/ });

    await expect(startRuntime(both, dependencies(database))).rejects.toThrow();

    // The database was opened, so shutdown must have closed it.
    expect(database.closed).toBe(true);
  });
});
