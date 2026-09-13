import { describe, expect, it } from 'vitest';
import type { PtyAvailability } from '@agentplex/pty';
import { MIN_TOKEN_LENGTH } from '@agentplex/node-shared';
import type { Config, HubConfig } from './config.js';
import { formatDoctorReport, inspectMachine } from './doctor.js';
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

/**
 * The hub half of a machine where everything a hub needs is there. Its own
 * rules have their own suite next door; what these cases are about is which
 * half of a machine gets inspected at all.
 */
const workingHub = {
  access: createFakePathAccess({ writable: [DATABASE_DIRECTORY] }),
  ports: createFakePortProbe(),
  resolve: createFakeModuleResolver({ [WEB_MANIFEST]: 'file:///opt/web/package.json' }),
};

const hubSettings: HubConfig = {
  port: 8080,
  databaseFile: DATABASE,
  clientToken: 'x'.repeat(MIN_TOKEN_LENGTH),
  localServerIdentityPath: null,
};

/** The volume a hub check looks at: the directory its database would go in. */
function hubFiles(): ReturnType<typeof createFakeStoreFiles> {
  return createFakeStoreFiles({ directories: [DATABASE_DIRECTORY] });
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

function serverConfig(storePaths: readonly string[], browseRoots: readonly string[] = []): Config {
  return {
    role: 'server',
    logLevel: 'error',
    host: HOST,
    server: {
      port: 8081,
      storePaths,
      binPath: ['/home/robert/.agentplex/bin'],
      // Nothing to browse unless a test is about browsing: that is the default
      // a server ships with, and the doctor reports it rather than judging it.
      browseRoots,
      identityPath: IDENTITY_PATH,
      terminalCap: 8,
      announce: false,
    },
  };
}

const hubConfig: Config = { role: 'hub', logLevel: 'error', host: HOST, hub: hubSettings };

function bothConfig(storePaths: readonly string[]): Config {
  const server = serverConfig(storePaths);
  if (!('server' in server)) throw new Error('serverConfig builds a server half');
  return { role: 'both', logLevel: 'error', host: HOST, hub: hubSettings, server: server.server };
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
      files: createFakeStoreFiles(),
      terminals: workingPty,
    });

    // Carried, not restated. The version and the directory are the two facts an
    // operator came for, and a doctor that summarised them into a word would be
    // the only place the answer had ever existed.
    expect(report.providers).toEqual(found);
  });

  it('says which store paths are there and which are not', async () => {
    const files = createFakeStoreFiles({ directories: ['/volumes/work'] });

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
    const files = createFakeStoreFiles({ files: { '/volumes/work': 'not a directory' } });

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
    const files = createFakeStoreFiles({ directories: ['/volumes/work'] });

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
      files: createFakeStoreFiles({ directories: ['/volumes/work'] }),
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
      files: createFakeStoreFiles({ directories: ['/volumes/work'] }),
      terminals: workingPty,
    });

    expect(report.usable).toBe(true);
  });

  it('is not usable when a provider cannot be started', async () => {
    const report = await inspectMachine(serverConfig([]), {
      providers,
      ...workingHub,
      preflight: { run: async () => [missingProvider('claude')] },
      files: createFakeStoreFiles(),
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
      files: createFakeStoreFiles(),
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
      files: createFakeStoreFiles(),
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
      files: createFakeStoreFiles(),
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
      files: createFakeStoreFiles(),
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
      files: createFakeStoreFiles(),
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
      files: createFakeStoreFiles({ directories: [DATABASE_DIRECTORY, '/volumes/work'] }),
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
      files: createFakeStoreFiles({ directories: [DATABASE_DIRECTORY, '/volumes/work'] }),
      terminals: workingPty,
    });

    // Everything the server half looks at is fine, and the machine still is
    // not: the hub on it would not start.
    expect(heldPort.stores).toEqual([{ path: '/volumes/work', state: 'present', problem: null }]);
    expect(heldPort.usable).toBe(false);
  });
});

describe('formatDoctorReport', () => {
  it('names the directory a provider came from, which is the question being asked', () => {
    const printed = formatDoctorReport({
      role: 'server',
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
});
