import { afterEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from './boot.js';
import { createClaudeAdapter, createProviderRegistry } from '@agentplex/providers';
import {
  createFakeProviderFiles,
  createFakeProcessProbe,
  createFakeProcessRunner,
  createFakeStoreFiles,
} from '@agentplex/providers/testing';
import { createFakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import { createTerminalManager } from './terminal-manager.js';
import { createFakeDataRoot, type FakeDataRoot } from './fake-data-root.js';
import { createOperationRegistry } from './operations/operation-registry.js';
import { createFakeTimers } from '@agentplex/node-shared/testing';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import type { ServerConfig } from './config.js';

const logger = createLogger('error', () => {});
const ids = { newId: () => 'hub-under-test' };

function dependencies(
  storeFileSystem = createFakeStoreFiles(),
  dataRootFileSystem: FakeDataRoot = createFakeDataRoot(),
) {
  return {
    logger,
    ids,
    timers: createFakeTimers(),
    storeFileSystem,
    dataRootFileSystem,
    tokens: { newToken: () => 'token-under-test' },
    // No adapters: this file is about which halves start and stop, and a
    // registry with a real one in it would put a provider's disk layout into
    // every test here.
    providers: createProviderRegistry([]),
    // Nothing to preflight, because there are no adapters: this file is about
    // which halves start and stop, and a preflight that resolved real programs
    // would put the machine's PATH into every test here.
    preflight: { run: async () => [] },
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
const IDENTITY_PATH = '/etc/agentplex/server.json';

/** The server's own directory, which it creates before it serves anything. */
const DATA_PATH = '/var/lib/agentplex';

const serverOnly: ServerConfig = {
  logLevel: 'error',
  host: HOST,
  port: 0,
  storePaths: [],
  binPath: [],
  identityPath: IDENTITY_PATH,
  dataPath: DATA_PATH,
  terminalCap: 8,
  // Quiet, like the default. This file is about what starts and stops, and a
  // beacon would be a second thing coming up with the server.
  announce: false,
};
let runtime: Runtime | undefined;

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
});

describe('startRuntime', () => {
  it('starts the server and stops it', async () => {
    runtime = await startRuntime(serverOnly, dependencies());

    expect(runtime.server.port).toBeGreaterThan(0);
    await runtime.stop();
  });

  it('answers a health check on the port it bound', async () => {
    runtime = await startRuntime(serverOnly, dependencies());
    const port = runtime.server?.port ?? 0;

    const response = await fetch(`http://127.0.0.1:${port}/health`);

    await expect(response.json()).resolves.toMatchObject({ status: 'ok', role: 'server' });
  });

  it('mints the identity of each configured store and reports it', async () => {
    const files = createFakeStoreFiles();
    const withStore: ServerConfig = {
      ...serverOnly,
      storePaths: ['/volumes/claude'],
    };

    runtime = await startRuntime(withStore, dependencies(files));

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
    const withStore: ServerConfig = {
      ...serverOnly,
      storePaths: ['/volumes/claude'],
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
    const withStores: ServerConfig = {
      ...serverOnly,
      storePaths: ['/volumes/broken', '/volumes/claude'],
    };

    runtime = await startRuntime(withStores, dependencies(files));

    expect(runtime.server?.stores.map((store) => store.path)).toEqual(['/volumes/claude']);
  });

  it('creates its data root before it binds a port', async () => {
    const dataRoot = createFakeDataRoot();

    runtime = await startRuntime(serverOnly, dependencies(createFakeStoreFiles(), dataRoot));

    expect(dataRoot.creates).toEqual([DATA_PATH]);
  });

  it('does not come up at all when it cannot write its own state', async () => {
    // The asymmetry with a store, asserted where the two meet: an unreadable
    // store costs itself and the server comes up without it, and a data root
    // it cannot write costs the start. A server that served anyway would be
    // one that forgets at its next restart and says so at neither moment.
    const dataRoot = createFakeDataRoot({ uncreatable: [DATA_PATH] });

    await expect(
      startRuntime(serverOnly, dependencies(createFakeStoreFiles(), dataRoot)),
    ).rejects.toThrow(DATA_PATH);
  });

  it('is safe to stop twice, because a signal can arrive twice', async () => {
    runtime = await startRuntime(serverOnly, dependencies());

    await runtime.stop();

    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});
