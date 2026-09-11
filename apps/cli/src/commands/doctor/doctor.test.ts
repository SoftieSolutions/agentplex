import { describe, expect, it } from 'vitest';
import type { PtyAvailability } from '@agentplex/pty';
import type { Config } from './config.js';
import { formatDoctorReport, inspectMachine } from './doctor.js';
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

function serverConfig(storePaths: readonly string[]): Config {
  return {
    role: 'server',
    logLevel: 'error',
    host: HOST,
    server: {
      port: 8081,
      storePaths,
      binPath: ['/home/robert/.agentplex/bin'],
      identityPath: IDENTITY_PATH,
      terminalCap: 8,
      announce: false,
    },
  };
}

const hubConfig: Config = { role: 'hub', logLevel: 'error', host: HOST };

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
      preflight: { run: async () => [] },
      files,
      terminals: workingPty,
    });

    expect(files.creates).toEqual([]);
  });

  it('reports a hub-only machine as one that starts no sessions', async () => {
    const report = await inspectMachine(hubConfig, {
      providers,
      preflight: {
        run: async () => {
          throw new Error('a hub-only machine has no providers to probe');
        },
      },
      files: createFakeStoreFiles(),
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
      preflight: { run: async () => [] },
      files: createFakeStoreFiles(),
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
      preflight: { run: async () => [readyProvider('claude')] },
      files: createFakeStoreFiles({ directories: ['/volumes/work'] }),
      terminals: workingPty,
    });

    expect(report.usable).toBe(true);
  });

  it('is not usable when a provider cannot be started', async () => {
    const report = await inspectMachine(serverConfig([]), {
      providers,
      preflight: { run: async () => [missingProvider('claude')] },
      files: createFakeStoreFiles(),
      terminals: workingPty,
    });

    expect(report.usable).toBe(false);
  });

  it('is not usable when a configured store is not there', async () => {
    const report = await inspectMachine(serverConfig(['/volumes/gone']), {
      providers,
      preflight: { run: async () => [readyProvider('claude')] },
      files: createFakeStoreFiles(),
      terminals: workingPty,
    });

    expect(report.usable).toBe(false);
  });
});

describe('formatDoctorReport', () => {
  it('names the directory a provider came from, which is the question being asked', () => {
    const printed = formatDoctorReport({
      role: 'server',
      usable: true,
      providers: [readyProvider('claude')],
      stores: [],
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
      usable: false,
      providers: [missingProvider('claude')],
      stores: [],
      terminals: { state: 'ready', problem: null },
    }).join('\n');

    expect(printed).toContain('missing');
    expect(printed).toContain('no directory this server searches holds claude');
  });

  it('prints each store path and what it turned out to be', () => {
    const printed = formatDoctorReport({
      role: 'server',
      usable: false,
      providers: [],
      stores: [
        { path: '/volumes/work', state: 'present', problem: null },
        { path: '/volumes/gone', state: 'missing', problem: 'there is nothing at that path' },
      ],
      terminals: { state: 'ready', problem: null },
    }).join('\n');

    expect(printed).toContain('/volumes/work');
    expect(printed).toContain('/volumes/gone');
    expect(printed).toContain('there is nothing at that path');
  });

  it('prints the load failure and what to install beneath it', () => {
    const printed = formatDoctorReport({
      role: 'server',
      usable: false,
      providers: [],
      stores: [],
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
      usable: true,
      providers: [],
      stores: [],
      terminals: null,
    }).join('\n');

    // An empty section reads as a listing that failed. Words say which it is.
    expect(printed).toContain('runs no server');
    expect(printed).toContain('opens no terminals');
  });
});
