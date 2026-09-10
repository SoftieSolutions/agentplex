import { describe, expect, it } from 'vitest';
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
 * `agentplexd doctor`, against a configuration and a volume a test writes down.
 *
 * The preflight is injected whole rather than driven through a fake PATH,
 * because it has its own tests and this file is about a different claim: that
 * the same reading the handshake carries is the reading the operator is shown.
 * Two code paths that could disagree about whether `claude` is installed would
 * be the worst possible version of this feature.
 */

const HOST = '127.0.0.1';
const IDENTITY_PATH = '/etc/agentplexd/server.json';

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

describe('inspectMachine', () => {
  it('reports each provider exactly as the preflight found it', async () => {
    const found = [readyProvider('claude')];

    const report = await inspectMachine(serverConfig([]), {
      providers,
      preflight: { run: async () => found },
      files: createFakeStoreFiles(),
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
    });

    expect(report).toMatchObject({ role: 'hub', providers: [], stores: [] });
  });

  it('is usable when everything it checked is', async () => {
    const report = await inspectMachine(serverConfig(['/volumes/work']), {
      providers,
      preflight: { run: async () => [readyProvider('claude')] },
      files: createFakeStoreFiles({ directories: ['/volumes/work'] }),
    });

    expect(report.usable).toBe(true);
  });

  it('is not usable when a provider cannot be started', async () => {
    const report = await inspectMachine(serverConfig([]), {
      providers,
      preflight: { run: async () => [missingProvider('claude')] },
      files: createFakeStoreFiles(),
    });

    expect(report.usable).toBe(false);
  });

  it('is not usable when a configured store is not there', async () => {
    const report = await inspectMachine(serverConfig(['/volumes/gone']), {
      providers,
      preflight: { run: async () => [readyProvider('claude')] },
      files: createFakeStoreFiles(),
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
    }).join('\n');

    expect(printed).toContain('/volumes/work');
    expect(printed).toContain('/volumes/gone');
    expect(printed).toContain('there is nothing at that path');
  });

  it('says so plainly when a role has nothing of its own to check', () => {
    const printed = formatDoctorReport({
      role: 'hub',
      usable: true,
      providers: [],
      stores: [],
    }).join('\n');

    // An empty section reads as a listing that failed. Words say which it is.
    expect(printed).toContain('runs no server');
  });
});
