import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '@agentplex/node-shared';
import { createUnreachableDialer, createFakeTimers } from '@agentplex/node-shared/testing';
import { createFakeStoreFiles } from '@agentplex/providers/testing';
import { startHubRuntime, type HubRuntime } from './boot.js';
import type { HubConfig } from './config.js';
import { createFakeDatabase } from './db/fake-database.js';
import type { MigrationFileSystem } from './db/migration-files.js';
import { createFakeBeaconSource } from './discovery/fake-beacon-source.js';
import { createFakeWebAssets } from './web/fake-web-assets.js';

/**
 * The hub as `main` composes it, against fakes: which things come up, in what
 * order, and that all of them go back down.
 */

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

const pairedLaptop = {
  match: /FROM servers/,
  rows: [
    {
      id: 'registration-laptop',
      label: 'laptop',
      address: 'wss://laptop.example:8443',
      token: 'tok-laptop',
      server_id: null,
      created_at: 1_756_000_000_000,
      revoked_at: null,
      last_connected_at: null,
    },
  ],
};

function fakeHubDatabase(options: Parameters<typeof createFakeDatabase>[0] = {}) {
  return createFakeDatabase({ ...options, respondWith: [hubIdentityRow] });
}

function dependencies(database = fakeHubDatabase(), dialer = createUnreachableDialer()) {
  return {
    logger,
    ids,
    dialer,
    timers: createFakeTimers(),
    openDatabase: () => database,
    migrationsDirectory: '/migrations',
    migrationFileSystem,
    // An empty web root: a hub with no client build still starts, which is
    // itself one of the claims below.
    webAssets: createFakeWebAssets(),
    files: createFakeStoreFiles(),
    tokens: { newToken: () => 'token-under-test' },
    discovery: createFakeBeaconSource(),
    clock: { now: () => 1_756_000_000_000 },
  };
}

const config: HubConfig = {
  logLevel: 'error',
  host: '127.0.0.1',
  port: 0,
  databaseFile: '/unused/agentplex.db',
  clientToken: 'a-client-token-long-enough-to-be-one',
  localServer: null,
};

let runtime: HubRuntime | undefined;

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
});

describe('startHubRuntime', () => {
  it('dials the servers the hub is paired with', async () => {
    // The wiring, asserted where the wiring is: a hub that came up without
    // dialling anything would look identical to one whose servers are all
    // asleep, and the difference would surface as a product that does nothing.
    const database = createFakeDatabase({ respondWith: [hubIdentityRow, pairedLaptop] });
    const dialer = createUnreachableDialer();

    runtime = await startHubRuntime(config, dependencies(database, dialer));

    expect(runtime.hub.connections.snapshot().map((report) => report.label)).toEqual(['laptop']);
    expect(dialer.dialled).toEqual(['wss://laptop.example:8443']);
  });

  it('comes up even though the server it is paired with is unreachable', async () => {
    // An unreachable server is a label on a row, never a reason not to start.
    const database = createFakeDatabase({ respondWith: [hubIdentityRow, pairedLaptop] });

    runtime = await startHubRuntime(config, dependencies(database));

    expect(runtime.hub.port).toBeGreaterThan(0);
  });

  it('migrates before it serves', async () => {
    const database = fakeHubDatabase();
    runtime = await startHubRuntime(config, dependencies(database));

    expect(database.appliedVersions).toEqual([1]);
  });

  it('answers a health check on the port it bound', async () => {
    runtime = await startHubRuntime(config, dependencies());

    const response = await fetch(`http://127.0.0.1:${runtime.hub.port}/health`);

    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
  });

  it('closes the database when it stops, so a restart is not blocked by a handle', async () => {
    const database = fakeHubDatabase();
    runtime = await startHubRuntime(config, dependencies(database));

    await runtime.stop();

    expect(database.closed).toBe(true);
  });

  it('is safe to stop twice, because a signal can arrive twice', async () => {
    runtime = await startHubRuntime(config, dependencies());

    await runtime.stop();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it('closes the database when the hub fails to start', async () => {
    // A migration that fails is the hub not starting; the file must not stay
    // open behind it.
    const database = fakeHubDatabase({ failOn: /CREATE TABLE/ });

    await expect(startHubRuntime(config, dependencies(database))).rejects.toThrow();

    expect(database.closed).toBe(true);
  });
});
