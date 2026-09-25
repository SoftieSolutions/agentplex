import { describe, expect, it } from 'vitest';
import type { PtyAvailability } from '@agentplex/pty';
import { MIN_TOKEN_LENGTH } from '@agentplex/node-shared';
import type { Config, HubConfig, SettingsSource } from './config.js';
import {
  formatDoctorReport,
  inspectMachine,
  type DataRootCheck,
  type IdentityCheck,
} from './doctor.js';
import type { HubChecks } from './hub.js';
import {
  createFakeModuleResolver,
  createFakePathAccess,
  createFakePortProbe,
} from './fake-hub-probes.js';
import {
  createFakeStoreFiles,
  createFakeProviderAdapter,
  missingProvider,
  readyProvider,
} from '@agentplex/providers/testing';
import { createProviderRegistry } from '@agentplex/providers';

/**
 * `agentplex doctor`, against a configuration and a volume a test writes down.
 *
 * The preflight is injected whole rather than driven through a fake PATH,
 * because it has its own tests and this file is about a different claim: that
 * the same reading the handshake carries is the reading the operator is shown.
 * Two code paths that could disagree about whether `claude` is installed would
 * be the worst possible version of this feature.
 */

const HOST = '127.0.0.1';
const IDENTITY_PATH = '/etc/agentplex/server.json';
const DATABASE = '/var/lib/agentplex/agentplex.db';
const DATABASE_DIRECTORY = '/var/lib/agentplex';
const WEB_MANIFEST = '@softiesolutions/agentplex-web/package.json';
/** Where the server writes, and the home it defaulted from. */
const DATA_ROOT = '/home/robert/.agentplex';
const HOME_DIRECTORY = '/home/robert';

/** A machine configured by environment alone, which is how a test is. */
const NO_SETTINGS_FILE: SettingsSource = { file: null, problems: [] };

/** The data root of a server with nothing wrong with it, for the printing cases. */
const WRITABLE_ROOT: DataRootCheck = { path: DATA_ROOT, state: 'ready', detail: null };

/** The identity file of a server with nothing wrong with it, for the printing cases. */
const SERVER_IDENTITY: IdentityCheck = { path: IDENTITY_PATH, problem: null, note: null };

/** A server identity the hub's local pairing reads as one it can present. */
const IDENTITY_CONTENTS = '{"serverId":"server-1","token":"a-token-off-the-disk"}';

/**
 * The hub half of a machine where everything a hub needs is there. Its own
 * rules have their own suite next door; what these cases are about is which
 * half of a machine gets inspected at all.
 */
const workingHub = {
  access: createFakePathAccess({ writable: [DATABASE_DIRECTORY, DATA_ROOT] }),
  ports: createFakePortProbe(),
  resolve: createFakeModuleResolver({ [WEB_MANIFEST]: 'file:///opt/web/package.json' }),
};

const hubSettings: HubConfig = {
  port: 8080,
  databaseFile: DATABASE,
  clientToken: 'x'.repeat(MIN_TOKEN_LENGTH),
  localServer: null,
};

/** The volume a hub check looks at: the directory its database would go in. */
function hubFiles(): ReturnType<typeof createFakeStoreFiles> {
  return createFakeStoreFiles({ directories: [DATABASE_DIRECTORY] });
}

/**
 * The volume a server check looks at: whatever a test names, and the data root
 * the server writes into, which is there on every machine unless a test is
 * about it not being there.
 */
function serverFiles(
  options: Parameters<typeof createFakeStoreFiles>[0] = {},
): ReturnType<typeof createFakeStoreFiles> {
  return createFakeStoreFiles({
    ...options,
    directories: [DATA_ROOT, ...(options.directories ?? [])],
  });
}

/** A hub with nothing wrong with it, for the cases that are about the printing. */
function readyHub(): HubChecks {
  return {
    database: { path: DATABASE, state: 'ready', problem: null },
    clientToken: { state: 'ready', problem: null },
    port: { host: HOST, port: 8080, state: 'free', problem: null },
    client: { state: 'present', problem: null },
    localServer: null,
  };
}

function serverConfig(
  storePaths: readonly string[],
  browseRoots: readonly string[] = [],
  dataPath: string = DATA_ROOT,
): Config {
  return {
    role: 'server',
    logLevel: 'error',
    host: HOST,
    settings: NO_SETTINGS_FILE,
    server: {
      port: 8081,
      storePaths,
      binPath: ['/home/robert/.agentplex/bin'],
      // Nothing to browse unless a test is about browsing: that is the default
      // a server ships with, and the doctor reports it rather than judging it.
      browseRoots,
      identityPath: IDENTITY_PATH,
      identityPathDefaulted: false,
      dataPath,
      serverToken: undefined,
      timezone: undefined,
      terminalCap: 8,
      drainMs: 15_000,
      announce: false,
    },
  };
}

const hubConfig: Config = {
  role: 'hub',
  logLevel: 'error',
  host: HOST,
  settings: NO_SETTINGS_FILE,
  hub: hubSettings,
};

function bothConfig(storePaths: readonly string[]): Config {
  const server = serverConfig(storePaths);
  if (!('server' in server)) throw new Error('serverConfig builds a server half');
  return {
    role: 'both',
    logLevel: 'error',
    host: HOST,
    settings: NO_SETTINGS_FILE,
    hub: hubSettings,
    server: server.server,
  };
}

/**
 * A machine that is both, whose hub pairs the server beside it from the
 * identity file at `identityPath` -- the one setup recorded for the hub, which
 * is not necessarily the one the server reads.
 */
function pairedBothConfig(identityPath: string): Config {
  const both = bothConfig(['/volumes/work']);
  if (both.role !== 'both') throw new Error('bothConfig builds a machine that is both');
  return { ...both, hub: { ...both.hub, localServer: { identityPath, port: 8081 } } };
}

const providers = createProviderRegistry([createFakeProviderAdapter({ provider: 'claude' })]);

/**
 * A machine whose node-pty loads, and one whose does not.
 *
 * Injected rather than mocked: the interesting machine is one where npm dropped
 * an optional dependency whose build failed, and what that machine produces is
 * exactly the value handed in here.
 */
const workingPty = (): PtyAvailability => ({ usable: true });
const brokenPty = (): PtyAvailability => ({
  usable: false,
  problem: "node-pty could not be loaded: Cannot find module 'node-pty'",
});

describe('inspectMachine', () => {
  it('reports each provider exactly as the preflight found it', async () => {
    const found = [readyProvider('claude')];

    const report = await inspectMachine(serverConfig([]), {
      providers,
      ...workingHub,
      preflight: { run: async () => found },
      files: serverFiles(),
      terminals: workingPty,
    });

    // Carried, not restated. The version and the directory are the two facts an
    // operator came for, and a doctor that summarised them into a word would be
    // the only place the answer had ever existed.
    expect(report.providers).toEqual(found);
  });

  it('says which store paths are there and which are not', async () => {
    const files = serverFiles({ directories: ['/volumes/work'] });

    const report = await inspectMachine(serverConfig(['/volumes/work', '/volumes/gone']), {
      providers,
      ...workingHub,
      preflight: { run: async () => [] },
      files,
      terminals: workingPty,
    });

    expect(report.stores).toEqual([
      { path: '/volumes/work', state: 'present', problem: null },
      { path: '/volumes/gone', state: 'missing', problem: expect.any(String) },
    ]);
  });

  it('tells a store root that is not a directory apart from one that is absent', async () => {
    // Two different things to fix, and the boolean version of this question
    // reports them as the same shrug.
    const files = serverFiles({ files: { '/volumes/work': 'not a directory' } });

    const report = await inspectMachine(serverConfig(['/volumes/work']), {
      providers,
      ...workingHub,
      preflight: { run: async () => [] },
      files,
      terminals: workingPty,
    });

    expect(report.stores[0]).toMatchObject({ state: 'unusable' });
    expect(report.stores[0]?.problem).toContain('not a directory');
  });

  it('creates nothing, on a volume where a real setup would mint a store file', async () => {
    // Read-only is the whole contract. `ensureStores` mints an identity file
    // the first time a store is used, and a doctor that did the same would
    // change the machine it was asked to describe.
    const files = serverFiles({ directories: ['/volumes/work'] });

    await inspectMachine(serverConfig(['/volumes/work']), {
      providers,
      ...workingHub,
      preflight: { run: async () => [] },
      files,
      terminals: workingPty,
    });

    expect(files.creates).toEqual([]);
  });

  it('reports a hub-only machine as one that starts no sessions', async () => {
    const report = await inspectMachine(hubConfig, {
      providers,
      ...workingHub,
      preflight: {
        run: async () => {
          throw new Error('a hub-only machine has no providers to probe');
        },
      },
      files: hubFiles(),
      terminals: workingPty,
    });

    expect(report).toMatchObject({ role: 'hub', providers: [], stores: [], terminals: null });
    expect(report.identity).toBeNull();
  });

  describe('the server identity', () => {
    it('names the file the server would open, as the settings resolved it', async () => {
      const report = await inspectMachine(serverConfig([]), {
        providers,
        ...workingHub,
        preflight: { run: async () => [] },
        files: serverFiles(),
        terminals: workingPty,
      });

      expect(report.identity).toEqual({ path: IDENTITY_PATH, problem: null, note: null });
    });

    it('fails a machine whose hub pairs its local server from another file', async () => {
      // The split setup used to leave under a prefix it was handed: the hub
      // reads a token from the file setup minted, and the server beside it
      // reads, and mints, another. The hub is refused by its own server, and
      // until this line nothing on the machine said so.
      const elsewhere = '/opt/agentplex/server.json';
      const report = await inspectMachine(pairedBothConfig(elsewhere), {
        providers,
        ...workingHub,
        preflight: { run: async () => [readyProvider('claude')] },
        files: serverFiles({
          directories: [DATABASE_DIRECTORY, '/volumes/work'],
          files: { [elsewhere]: IDENTITY_CONTENTS, [IDENTITY_PATH]: IDENTITY_CONTENTS },
        }),
        terminals: workingPty,
      });

      expect(report.hub?.localServer).toMatchObject({ state: 'ready' });
      expect(report.identity).toEqual({
        path: IDENTITY_PATH,
        problem: expect.any(String),
        note: null,
      });
      expect(report.identity?.problem).toContain(elsewhere);
      expect(report.usable).toBe(false);
    });

    it('is usable when the hub pairs its local server from the file the server reads', async () => {
      const report = await inspectMachine(pairedBothConfig(IDENTITY_PATH), {
        providers,
        ...workingHub,
        preflight: { run: async () => [readyProvider('claude')] },
        files: serverFiles({
          directories: [DATABASE_DIRECTORY, '/volumes/work'],
          files: { [IDENTITY_PATH]: IDENTITY_CONTENTS },
        }),
        terminals: workingPty,
      });

      expect(report.identity).toEqual({ path: IDENTITY_PATH, problem: null, note: null });
      expect(report.usable).toBe(true);
    });

    describe('when nothing named the file', () => {
      /** A server whose identity path is the home default, read with `settings`. */
      function defaultedConfig(settings: SettingsSource): Config {
        const config = serverConfig([]);
        if (!('server' in config)) throw new Error('serverConfig builds a server half');
        return {
          ...config,
          settings,
          server: { ...config.server, identityPathDefaulted: true },
        };
      }

      async function inspect(config: Config): Promise<IdentityCheck | null> {
        const report = await inspectMachine(config, {
          providers,
          ...workingHub,
          preflight: { run: async () => [] },
          files: serverFiles(),
          terminals: workingPty,
        });
        return report.identity;
      }

      it('says the default is only the default when no settings file was found', async () => {
        // A per-user install under a custom prefix keeps its settings where the
        // doctor does not look, so the path printed is the one under this home
        // and not necessarily the one the unit reads. That is said rather than
        // judged: the default is right on the default prefix.
        const identity = await inspect(defaultedConfig(NO_SETTINGS_FILE));

        expect(identity?.path).toBe(IDENTITY_PATH);
        expect(identity?.problem).toBeNull();
        expect(identity?.note).toContain('the default, because no settings file was found');
        expect(identity?.note).toContain('--server-identity-file');
        expect(identity?.note).toContain('AGENTPLEX_SERVER_IDENTITY_FILE');
      });

      it('does not count the note against the machine', async () => {
        const report = await inspectMachine(defaultedConfig(NO_SETTINGS_FILE), {
          providers,
          ...workingHub,
          preflight: { run: async () => [] },
          files: serverFiles(),
          terminals: workingPty,
        });

        expect(report.usable).toBe(true);
      });

      it('says nothing more when a settings file was found and left it to the default', async () => {
        // The unit reads that file, and it does not name the identity file, so
        // the default is exactly what the server will open.
        const identity = await inspect(
          defaultedConfig({ file: '/home/robert/.agentplex/agentplex.env', problems: [] }),
        );

        expect(identity?.note).toBeNull();
      });

      it('says nothing more when a flag or the environment named the file', async () => {
        const identity = await inspect(serverConfig([]));

        expect(identity?.note).toBeNull();
      });
    });
  });

  /**
   * The failure the whole optional-dependency decision has to be worth: npm
   * exits 0 with node-pty gone, every other check passes, and without this the
   * machine reads as ready right up to the first session that will not start.
   */
  it('is not usable when node-pty will not load, on a role that runs sessions', async () => {
    const report = await inspectMachine(serverConfig(['/volumes/work']), {
      providers,
      ...workingHub,
      preflight: { run: async () => [readyProvider('claude')] },
      files: serverFiles({ directories: ['/volumes/work'] }),
      terminals: brokenPty,
    });

    expect(report.terminals).toEqual({
      state: 'unusable',
      problem: expect.stringContaining('node-pty'),
    });
    expect(report.usable).toBe(false);
  });

  it('asks nothing about terminals on a hub, which opens none', async () => {
    const report = await inspectMachine(hubConfig, {
      providers,
      ...workingHub,
      preflight: { run: async () => [] },
      files: hubFiles(),
      terminals: () => {
        throw new Error('a hub-only machine has no pty to ask about');
      },
    });

    expect(report.terminals).toBeNull();
    expect(report.usable).toBe(true);
  });

  it('is usable when everything it checked is', async () => {
    const report = await inspectMachine(serverConfig(['/volumes/work']), {
      providers,
      ...workingHub,
      preflight: { run: async () => [readyProvider('claude')] },
      files: serverFiles({ directories: ['/volumes/work'] }),
      terminals: workingPty,
    });

    expect(report.usable).toBe(true);
  });

  it('is not usable when a provider cannot be started', async () => {
    const report = await inspectMachine(serverConfig([]), {
      providers,
      ...workingHub,
      preflight: { run: async () => [missingProvider('claude')] },
      files: serverFiles(),
      terminals: workingPty,
    });

    expect(report.usable).toBe(false);
  });

  it('is not usable when a configured browse root is not there', async () => {
    // A root that is not there is a browse that will be refused, which is a
    // fact about this deployment and therefore part of the exit code.
    const report = await inspectMachine(serverConfig([], ['/home/robert/gone']), {
      providers,
      ...workingHub,
      preflight: { run: async () => [readyProvider('claude')] },
      files: serverFiles(),
      terminals: workingPty,
    });

    expect(report.usable).toBe(false);
    expect(report.browseRoots).toEqual([
      { path: '/home/robert/gone', state: 'missing', problem: 'there is nothing at that path' },
    ]);
  });

  it('is usable with no browse roots at all, which is the default', async () => {
    const report = await inspectMachine(serverConfig([]), {
      providers,
      ...workingHub,
      preflight: { run: async () => [readyProvider('claude')] },
      files: serverFiles(),
      terminals: workingPty,
    });

    expect(report.usable).toBe(true);
    expect(report.browseRoots).toEqual([]);
  });

  it('is not usable when a configured store is not there', async () => {
    const report = await inspectMachine(serverConfig(['/volumes/gone']), {
      providers,
      ...workingHub,
      preflight: { run: async () => [readyProvider('claude')] },
      files: serverFiles(),
      terminals: workingPty,
    });

    expect(report.usable).toBe(false);
  });

  /**
   * The claim AGX-228 removed. `--role=hub` returned `usable: true` before
   * anything had been looked at, so every way a hub fails at boot -- this one
   * included -- was reported as a healthy machine.
   */
  it('is not usable when the hub has nowhere to put its database', async () => {
    const report = await inspectMachine(hubConfig, {
      providers,
      ...workingHub,
      preflight: { run: async () => [] },
      // No directory for the database, which is a hub that does not start.
      files: serverFiles(),
      terminals: workingPty,
    });

    expect(report.hub?.database).toMatchObject({ state: 'missing' });
    expect(report.usable).toBe(false);
  });

  it('asks nothing about a hub on a machine that runs none', async () => {
    const report = await inspectMachine(serverConfig([]), {
      providers,
      ...workingHub,
      ports: () => {
        throw new Error('a server-only machine binds no hub port');
      },
      preflight: { run: async () => [readyProvider('claude')] },
      files: serverFiles(),
      terminals: workingPty,
    });

    expect(report.hub).toBeNull();
    expect(report.usable).toBe(true);
  });

  it('runs both halves on a machine that is both, and either half can fail it', async () => {
    const both = await inspectMachine(bothConfig(['/volumes/work']), {
      providers,
      ...workingHub,
      preflight: { run: async () => [readyProvider('claude')] },
      files: serverFiles({ directories: [DATABASE_DIRECTORY, '/volumes/work'] }),
      terminals: workingPty,
    });

    expect(both.hub?.database).toMatchObject({ state: 'ready' });
    expect(both.stores).toHaveLength(1);
    expect(both.usable).toBe(true);

    const heldPort = await inspectMachine(bothConfig(['/volumes/work']), {
      providers,
      ...workingHub,
      ports: createFakePortProbe({ taken: [`${HOST}:8080`] }),
      preflight: { run: async () => [readyProvider('claude')] },
      files: serverFiles({ directories: [DATABASE_DIRECTORY, '/volumes/work'] }),
      terminals: workingPty,
    });

    // Everything the server half looks at is fine, and the machine still is
    // not: the hub on it would not start.
    expect(heldPort.stores).toEqual([{ path: '/volumes/work', state: 'present', problem: null }]);
    expect(heldPort.usable).toBe(false);
  });

  /**
   * The data root, asked the way the server will ask it at boot: it creates
   * the directory with its parents and refuses to start when it cannot write
   * in it. So an existing directory has to be writable, and a missing one
   * needs the nearest directory above it that is there to be writable.
   */
  describe('the data root', () => {
    async function inspectRoot(
      files: ReturnType<typeof createFakeStoreFiles>,
      writable: readonly string[],
    ): Promise<Awaited<ReturnType<typeof inspectMachine>>> {
      return await inspectMachine(serverConfig([]), {
        providers,
        ...workingHub,
        access: createFakePathAccess({ writable }),
        preflight: { run: async () => [readyProvider('claude')] },
        files,
        terminals: workingPty,
      });
    }

    it('is ready when it is there and this user may write in it', async () => {
      const report = await inspectRoot(createFakeStoreFiles({ directories: [DATA_ROOT] }), [
        DATA_ROOT,
      ]);

      expect(report.dataRoot).toEqual({ path: DATA_ROOT, state: 'ready', detail: null });
      expect(report.usable).toBe(true);
    });

    it('is unusable when it is there and this user may not write in it', async () => {
      const report = await inspectRoot(createFakeStoreFiles({ directories: [DATA_ROOT] }), []);

      expect(report.dataRoot).toMatchObject({ path: DATA_ROOT, state: 'unusable' });
      expect(report.dataRoot?.detail).toContain(`EACCES: ${DATA_ROOT}`);
      expect(report.usable).toBe(false);
    });

    it('will be created when it is missing under a directory this user may write in', async () => {
      // The ordinary first start: the home is there, `.agentplex` is not yet.
      const report = await inspectRoot(createFakeStoreFiles({ directories: [HOME_DIRECTORY] }), [
        HOME_DIRECTORY,
      ]);

      expect(report.dataRoot).toMatchObject({ path: DATA_ROOT, state: 'creatable' });
      expect(report.dataRoot?.detail).toContain('will be created');
      expect(report.dataRoot?.detail).toContain(HOME_DIRECTORY);
      expect(report.usable).toBe(true);
    });

    it('looks past every missing directory to the nearest one that is there', async () => {
      // The server's create is recursive, so `/srv/agentplex/data` under a
      // writable `/srv` is a data root it can make.
      const report = await inspectMachine(serverConfig([], [], '/srv/agentplex/data'), {
        providers,
        ...workingHub,
        access: createFakePathAccess({ writable: ['/srv'] }),
        preflight: { run: async () => [readyProvider('claude')] },
        files: createFakeStoreFiles({ directories: ['/srv'] }),
        terminals: workingPty,
      });

      expect(report.dataRoot).toMatchObject({ state: 'creatable' });
      expect(report.dataRoot?.detail).toContain('/srv');
    });

    it('is unusable when it is missing under a directory this user may not write in', async () => {
      const report = await inspectRoot(createFakeStoreFiles({ directories: [HOME_DIRECTORY] }), []);

      expect(report.dataRoot).toMatchObject({ path: DATA_ROOT, state: 'unusable' });
      expect(report.dataRoot?.detail).toContain(HOME_DIRECTORY);
      expect(report.usable).toBe(false);
    });

    it('is unusable when something that is not a directory is in the way', async () => {
      const atPath = await inspectRoot(createFakeStoreFiles({ files: { [DATA_ROOT]: 'x' } }), [
        HOME_DIRECTORY,
      ]);
      expect(atPath.dataRoot).toMatchObject({ state: 'unusable' });
      expect(atPath.dataRoot?.detail).toContain('not a directory');

      const above = await inspectRoot(
        createFakeStoreFiles({ files: { [HOME_DIRECTORY]: 'x' } }),
        [],
      );
      expect(above.dataRoot).toMatchObject({ state: 'unusable' });
      expect(above.dataRoot?.detail).toContain(`${HOME_DIRECTORY} is not a directory`);
    });

    it('creates nothing, even where the server would', async () => {
      const files = createFakeStoreFiles({ directories: [HOME_DIRECTORY] });
      await inspectRoot(files, [HOME_DIRECTORY]);
      expect(files.creates).toEqual([]);
    });

    it('is not asked about on a machine that runs no server', async () => {
      const report = await inspectMachine(hubConfig, {
        providers,
        ...workingHub,
        preflight: { run: async () => [] },
        files: hubFiles(),
        terminals: workingPty,
      });
      expect(report.dataRoot).toBeNull();
    });
  });
});

describe('formatDoctorReport', () => {
  it('names the directory a provider came from, which is the question being asked', () => {
    const printed = formatDoctorReport({
      role: 'server',
      settings: NO_SETTINGS_FILE,
      dataRoot: WRITABLE_ROOT,
      identity: SERVER_IDENTITY,
      hub: null,
      usable: true,
      providers: [readyProvider('claude')],
      stores: [],
      browseRoots: [],
      terminals: { state: 'ready', problem: null },
    }).join('\n');

    expect(printed).toContain('claude');
    expect(printed).toContain('ready');
    expect(printed).toContain('9.9.9');
    expect(printed).toContain('/home/robert/.agentplex/bin');
  });

  it('prints the problem beside the provider that has one', () => {
    const printed = formatDoctorReport({
      role: 'server',
      settings: NO_SETTINGS_FILE,
      dataRoot: WRITABLE_ROOT,
      identity: SERVER_IDENTITY,
      hub: null,
      usable: false,
      providers: [missingProvider('claude')],
      stores: [],
      browseRoots: [],
      terminals: { state: 'ready', problem: null },
    }).join('\n');

    expect(printed).toContain('missing');
    expect(printed).toContain('no directory this server searches holds claude');
  });

  it('says how to make a running server re-read what it just printed', () => {
    // The disagreement this is for: a provider installed since the service
    // started reads `ready` here and `missing` in the client, because the two
    // took their readings at different times. A restart would end it and take
    // every session on the machine with it.
    const printed = formatDoctorReport({
      role: 'server',
      settings: NO_SETTINGS_FILE,
      dataRoot: WRITABLE_ROOT,
      identity: SERVER_IDENTITY,
      hub: null,
      usable: true,
      providers: [readyProvider('claude')],
      stores: [],
      browseRoots: [],
      terminals: { state: 'ready', problem: null },
    }).join('\n');

    expect(printed).toContain('systemctl reload agentplex-server');
  });

  it('says nothing about reloading on a machine that reports no providers', () => {
    // A hub. There is no server on it to have taken a stale reading, and
    // naming a unit this machine does not run would be advice that fails.
    const printed = formatDoctorReport({
      role: 'hub',
      settings: NO_SETTINGS_FILE,
      dataRoot: null,
      identity: null,
      hub: readyHub(),
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: null,
    }).join('\n');

    expect(printed).not.toContain('systemctl reload');
  });

  it('prints each store path and what it turned out to be', () => {
    const printed = formatDoctorReport({
      role: 'server',
      settings: NO_SETTINGS_FILE,
      dataRoot: WRITABLE_ROOT,
      identity: SERVER_IDENTITY,
      hub: null,
      usable: false,
      providers: [],
      stores: [
        { path: '/volumes/work', state: 'present', problem: null },
        { path: '/volumes/gone', state: 'missing', problem: 'there is nothing at that path' },
      ],
      browseRoots: [],
      terminals: { state: 'ready', problem: null },
    }).join('\n');

    expect(printed).toContain('/volumes/work');
    expect(printed).toContain('/volumes/gone');
    expect(printed).toContain('there is nothing at that path');
  });

  it('prints each browse root the same way a store path is printed', () => {
    const printed = formatDoctorReport({
      role: 'server',
      settings: NO_SETTINGS_FILE,
      dataRoot: WRITABLE_ROOT,
      identity: SERVER_IDENTITY,
      hub: null,
      usable: false,
      providers: [],
      stores: [],
      browseRoots: [
        { path: '/home/robert/code', state: 'present', problem: null },
        { path: '/mnt/volumes/gone', state: 'missing', problem: 'there is nothing at that path' },
      ],
      terminals: { state: 'ready', problem: null },
    }).join('\n');

    expect(printed).toContain('/home/robert/code');
    expect(printed).toContain('/mnt/volumes/gone');
    // And what a root actually grants, which is the half of this setting an
    // operator most needs said out loud before they add one.
    expect(printed).toContain('never followed');
  });

  it('says a machine with no browse roots will not list anything, as a fact', () => {
    // Not a problem: it is the default, and a machine nobody asked to offer
    // browsing is working exactly as configured.
    const printed = formatDoctorReport({
      role: 'server',
      settings: NO_SETTINGS_FILE,
      dataRoot: WRITABLE_ROOT,
      identity: SERVER_IDENTITY,
      hub: null,
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: { state: 'ready', problem: null },
    }).join('\n');

    expect(printed).toContain('will not list any directory');
  });

  it('prints the load failure and what to install beneath it', () => {
    const printed = formatDoctorReport({
      role: 'server',
      settings: NO_SETTINGS_FILE,
      dataRoot: WRITABLE_ROOT,
      identity: SERVER_IDENTITY,
      hub: null,
      usable: false,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: { state: 'unusable', problem: 'node-pty could not be loaded: no such module' },
    }).join('\n');

    expect(printed).toContain('terminals');
    expect(printed).toContain('unusable');
    expect(printed).toContain('node-pty could not be loaded');
    // The reason alone is not something an operator can act on.
    expect(printed).toContain('python3');
  });

  it('says so plainly when a role has nothing of its own to check', () => {
    const printed = formatDoctorReport({
      role: 'hub',
      settings: NO_SETTINGS_FILE,
      dataRoot: null,
      identity: null,
      hub: readyHub(),
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: null,
    }).join('\n');

    // An empty section reads as a listing that failed. Words say which it is.
    expect(printed).toContain('runs no server');
    expect(printed).toContain('opens no terminals');
  });

  it('says the same of a machine that runs no hub', () => {
    const printed = formatDoctorReport({
      role: 'server',
      settings: NO_SETTINGS_FILE,
      dataRoot: WRITABLE_ROOT,
      identity: SERVER_IDENTITY,
      hub: null,
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: { state: 'ready', problem: null },
    }).join('\n');

    expect(printed).toContain('runs no hub');
  });

  it('prints what the hub needs, on the machine that runs one', () => {
    const printed = formatDoctorReport({
      role: 'hub',
      settings: NO_SETTINGS_FILE,
      dataRoot: null,
      identity: null,
      hub: readyHub(),
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: null,
    }).join('\n');

    expect(printed).toContain('database');
    expect(printed).toContain(DATABASE);
    expect(printed).toContain('client token');
    expect(printed).toContain(`${HOST}:8080`);
  });

  it('says which settings file it read, which is the deployment being described', () => {
    const printed = formatDoctorReport({
      role: 'hub',
      settings: { file: '/home/robert/.agentplex/agentplex.env', problems: [] },
      dataRoot: null,
      identity: null,
      hub: readyHub(),
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: null,
    });

    expect(printed).toContain('settings');
    expect(printed).toContain('  /home/robert/.agentplex/agentplex.env');
  });

  it('says so when there is no settings file, and what it read instead', () => {
    const printed = formatDoctorReport({
      role: 'hub',
      settings: NO_SETTINGS_FILE,
      dataRoot: null,
      identity: null,
      hub: readyHub(),
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: null,
    }).join('\n');

    expect(printed).toContain('no settings file');
    expect(printed).toContain('environment and flags');
  });

  it('prints a settings file it could not read as a line, and carries on', () => {
    // The fleet file is root's at 0640. An operator who is neither gets this,
    // and the report of what the environment and flags make of the machine.
    const printed = formatDoctorReport({
      role: 'hub',
      settings: {
        file: '/etc/agentplex/agentplex.env',
        problems: ['cannot read /etc/agentplex/agentplex.env: EACCES'],
      },
      dataRoot: null,
      identity: null,
      hub: readyHub(),
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: null,
    }).join('\n');

    expect(printed).toContain('cannot read /etc/agentplex/agentplex.env: EACCES');
    expect(printed).toContain('environment and flags');
    expect(printed).toContain('database');
  });

  it('prints the data root, and what the server would do about one that is missing', () => {
    const printed = formatDoctorReport({
      role: 'server',
      settings: NO_SETTINGS_FILE,
      dataRoot: {
        path: DATA_ROOT,
        state: 'creatable',
        detail: `not there yet: it will be created at startup, under ${HOME_DIRECTORY}`,
      },
      identity: SERVER_IDENTITY,
      hub: null,
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: { state: 'ready', problem: null },
    }).join('\n');

    expect(printed).toContain('data root');
    expect(printed).toContain(`creatable  ${DATA_ROOT}`);
    expect(printed).toContain('will be created');
  });

  it('says a machine that runs no server writes no data root', () => {
    const printed = formatDoctorReport({
      role: 'hub',
      settings: NO_SETTINGS_FILE,
      dataRoot: null,
      identity: null,
      hub: readyHub(),
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: null,
    }).join('\n');

    expect(printed).toContain('runs no server, so it writes no data root');
  });

  it('prints the server identity file, and a hub that pairs from another beneath it', () => {
    const printed = formatDoctorReport({
      role: 'both',
      settings: NO_SETTINGS_FILE,
      dataRoot: WRITABLE_ROOT,
      identity: {
        path: IDENTITY_PATH,
        problem: 'the hub pairs from /opt/agentplex/server.json',
        note: null,
      },
      hub: readyHub(),
      usable: false,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: { state: 'ready', problem: null },
    });

    const section = printed.indexOf('server identity');
    expect(section).toBeGreaterThan(-1);
    expect(printed[section + 1]).toBe(`  ${IDENTITY_PATH}`);
    expect(printed[section + 2]).toBe('    the hub pairs from /opt/agentplex/server.json');
  });

  it('prints a note on a defaulted identity file beneath its path', () => {
    const printed = formatDoctorReport({
      role: 'server',
      settings: NO_SETTINGS_FILE,
      dataRoot: WRITABLE_ROOT,
      identity: { path: IDENTITY_PATH, problem: null, note: 'the default, and only that' },
      hub: null,
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: { state: 'ready', problem: null },
    });

    const section = printed.indexOf('server identity');
    expect(printed[section + 1]).toBe(`  ${IDENTITY_PATH}`);
    expect(printed[section + 2]).toBe('    the default, and only that');
  });

  it('says a machine that runs no server holds no server identity', () => {
    const printed = formatDoctorReport({
      role: 'hub',
      settings: NO_SETTINGS_FILE,
      dataRoot: null,
      identity: null,
      hub: readyHub(),
      usable: true,
      providers: [],
      stores: [],
      browseRoots: [],
      terminals: null,
    }).join('\n');

    expect(printed).toContain('runs no server, so it holds no server identity');
  });
});
