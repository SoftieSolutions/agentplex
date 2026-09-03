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
import { createLogger, type LogRecord } from './shared/logger.js';
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

function dependencies(database = fakeHubDatabase(), storeFileSystem = createFakeStoreFiles()) {
  return {
    logger,
    ids,
    openDatabase: () => database,
    migrationsDirectory: '/migrations',
    migrationFileSystem,
    storeFileSystem,
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
    clock: { now: () => 1_756_000_000_000 },
  };
}

const HOST = '127.0.0.1';

const serverOnly: Config = {
  role: 'server',
  logLevel: 'error',
  host: HOST,
  server: { port: 0, storePaths: [], binPath: [], terminalCap: 8 },
};
const hubOnly: Config = {
  role: 'hub',
  logLevel: 'error',
  host: HOST,
  hub: { port: 0, databaseFile: '/unused/agentplex.db' },
};
const both: Config = {
  role: 'both',
  logLevel: 'error',
  host: HOST,
  hub: { port: 0, databaseFile: '/unused/agentplex.db' },
  server: { port: 0, storePaths: [], binPath: [], terminalCap: 8 },
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
    expect([...files.contents.keys()]).toEqual(['/volumes/claude/agentplex-store.json']);
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
