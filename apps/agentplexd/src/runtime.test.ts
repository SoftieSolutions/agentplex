import { afterEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from './runtime.js';
import { createFakeDatabase } from './hub/db/fake-database.js';
import type { MigrationFileSystem } from './hub/db/migration-files.js';
import { createClaudeAdapter } from './server/providers/claude-adapter.js';
import { createFakeProviderFiles } from './server/providers/fake-provider-files.js';
import { createProviderRegistry } from './server/providers/provider-registry.js';
import { createFakePtyFactory } from './server/fake-pty.js';
import { createPtySupervisor } from './server/pty-supervisor.js';
import { createTerminalManager } from './server/terminal-manager.js';
import { createFakeProcessProbe } from './server/fake-process-probe.js';
import { createFakeProcessRunner } from './server/operations/fake-process-runner.js';
import { createOperationRegistry } from './server/operations/operation-registry.js';
import { createFakeStoreFiles } from './server/fake-store-files.js';
import { createUnreachableDialer } from './shared/fake-message-socket.js';
import { createLogger, type LogRecord } from './shared/logger.js';
import { createFakeTimers } from './shared/timers.js';
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

function dependencies(
  database = fakeHubDatabase(),
  storeFileSystem = createFakeStoreFiles(),
  dialer = createUnreachableDialer(),
) {
  return {
    logger,
    ids,
    // Nothing is paired in most of these, so nothing is dialled. Where
    // something is, an unreachable server is the honest default: the hub must
    // come up regardless, which is the claim being made.
    dialer,
    timers: createFakeTimers(),
    openDatabase: () => database,
    migrationsDirectory: '/migrations',
    migrationFileSystem,
    storeFileSystem,
    tokens: { newToken: () => 'token-under-test' },
    // No adapters: this file is about which halves start and stop, and a
    // registry with a real one in it would put a provider's disk layout into
    // every test here.
    providers: createProviderRegistry([]),
    // A manager over a pty nothing ever opens: this file is about which halves
    // start and stop, and a real one would fork a process per test.
    terminals: createTerminalManager({
      supervisor: createPtySupervisor({
        pty: createFakePtyFactory(),
        clock: { now: () => 1_756_000_000_000 },
        ids,
        environment: {},
      }),
      clock: { now: () => 1_756_000_000_000 },
    }),
    // The real registry over a runner that starts nothing: this file is about
    // which halves come up and go down, and the operations are closed anyway —
    // there is no fake registry to build, only a fake machine for it to run on.
    operations: createOperationRegistry(createFakeProcessRunner()),
    // Announcing is off in every configuration in this file, so this is a
    // capability nothing here may reach for. Opening it is the bug, and the
    // fake fails loudly rather than quietly putting a UDP socket into a test
    // about which halves start.
    beacon: {
      open: () => {
        throw new Error('the runtime opened a beacon socket with announcing off');
      },
      localAddresses: () => [],
    },
    clock: { now: () => 1_756_000_000_000 },
  };
}

const HOST = '127.0.0.1';

/**
 * On the fake volume, like everything else here. The server role mints its
 * identity before it serves, so every config that starts one needs somewhere
 * to put it.
 */
const IDENTITY_PATH = '/etc/agentplexd/server.json';
const CLIENT_TOKEN = 'a-client-token-long-enough-to-be-one';

const serverOnly: Config = {
  role: 'server',
  logLevel: 'error',
  host: HOST,
  server: {
    port: 0,
    storePaths: [],
    binPath: [],
    identityPath: IDENTITY_PATH,
    terminalCap: 8,
    // Quiet, like the default. This file is about which halves start and
    // stop, and a beacon would be a second thing coming up with the server.
    announce: false,
  },
};
const hubOnly: Config = {
  role: 'hub',
  logLevel: 'error',
  host: HOST,
  hub: { port: 0, databaseFile: '/unused/agentplex.db', clientToken: CLIENT_TOKEN },
};
const both: Config = {
  role: 'both',
  logLevel: 'error',
  host: HOST,
  hub: { port: 0, databaseFile: '/unused/agentplex.db', clientToken: CLIENT_TOKEN },
  server: {
    port: 0,
    storePaths: [],
    binPath: [],
    identityPath: IDENTITY_PATH,
    terminalCap: 8,
    // Quiet, like the default. This file is about which halves start and
    // stop, and a beacon would be a second thing coming up with the server.
    announce: false,
  },
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

  it('dials the servers the hub is paired with', async () => {
    // The wiring, asserted where the wiring is: a hub that came up without
    // dialling anything would look identical to one whose servers are all
    // asleep, and the difference would surface as a product that does nothing.
    const database = createFakeDatabase({
      respondWith: [
        hubIdentityRow,
        {
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
        },
      ],
    });
    const dialer = createUnreachableDialer();

    runtime = await startRuntime(hubOnly, dependencies(database, createFakeStoreFiles(), dialer));

    expect(runtime.hub?.connections.snapshot().map((report) => report.label)).toEqual(['laptop']);
    expect(dialer.dialled).toEqual(['wss://laptop.example:8443']);
  });

  it('comes up even though the server it is paired with is unreachable', async () => {
    // An unreachable server is a label on a row, never a reason not to start.
    const database = createFakeDatabase({
      respondWith: [
        hubIdentityRow,
        {
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
        },
      ],
    });

    runtime = await startRuntime(hubOnly, dependencies(database));

    expect(runtime.hub).not.toBeNull();
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

  it('mints the identity of each configured store and reports it', async () => {
    const files = createFakeStoreFiles();
    const withStore: Config = {
      ...serverOnly,
      server: { ...serverOnly.server, storePaths: ['/volumes/claude'] },
    };

    runtime = await startRuntime(withStore, dependencies(fakeHubDatabase(), files));

    expect(runtime.server?.stores).toEqual([
      { storeId: 'hub-under-test', path: '/volumes/claude' },
    ]);
    // The identity file too, and before the store: a server that cannot say
    // who it is has nothing useful to report a store to.
    expect([...files.contents.keys()]).toEqual([
      IDENTITY_PATH,
      '/volumes/claude/agentplex-store.json',
    ]);
  });

  it('scans every store it mounted with the adapters it was given', async () => {
    // The wiring, asserted where the wiring is. A misconfigured store path
    // that only surfaces the first time somebody opens the client is a support
    // ticket; one that surfaces in the boot log is a fixed typo.
    const records: LogRecord[] = [];
    const withStore: Config = {
      ...serverOnly,
      server: { ...serverOnly.server, storePaths: ['/volumes/claude'] },
    };

    runtime = await startRuntime(withStore, {
      ...dependencies(),
      logger: createLogger('info', (record) => records.push(record)),
      providers: createProviderRegistry([
        createClaudeAdapter({ files: createFakeProviderFiles(), probe: createFakeProcessProbe() }),
      ]),
    });

    expect(records.filter((record) => record.message === 'store scanned')).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ sessions: 0, providers: ['claude'] }),
      }),
    ]);
  });

  it('comes up without the store it could not read, rather than not coming up', async () => {
    const files = createFakeStoreFiles({ unreadable: ['/volumes/broken/agentplex-store.json'] });
    const withStores: Config = {
      ...serverOnly,
      server: { ...serverOnly.server, storePaths: ['/volumes/broken', '/volumes/claude'] },
    };

    runtime = await startRuntime(withStores, dependencies(fakeHubDatabase(), files));

    expect(runtime.server?.stores.map((store) => store.path)).toEqual(['/volumes/claude']);
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
