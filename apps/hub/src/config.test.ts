import { describe, expect, it } from 'vitest';
import { hubUsage, loadHubConfig, type HubConfigResult } from './config.js';

const DATABASE_FILE = '/var/lib/agentplex/agentplex.db';
const CLIENT_TOKEN = 'a-client-token-long-enough-to-be-one';
const IDENTITY = '/var/lib/agentplex/server.json';

/**
 * Every case needs a database file and a client token, supplied through the
 * environment so that a test about the port stays a test about the port. A
 * caller's own env wins, and the block that is about one of these settings
 * calls `loadHubConfig` directly so it can leave it out.
 */
function load(argv: string[], env: Record<string, string | undefined> = {}): HubConfigResult {
  return loadHubConfig({
    argv,
    env: { AGENTPLEX_DATABASE_FILE: DATABASE_FILE, AGENTPLEX_CLIENT_TOKEN: CLIENT_TOKEN, ...env },
  });
}

function expectProblems(result: HubConfigResult): readonly string[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.problems;
}

describe('loadHubConfig', () => {
  it('starts with a database and a token and nothing else, on the default port', () => {
    expect(load([])).toEqual({
      ok: true,
      config: {
        logLevel: 'info',
        host: '0.0.0.0',
        port: 8080,
        databaseFile: DATABASE_FILE,
        clientToken: CLIENT_TOKEN,
        localServer: null,
      },
    });
  });

  it('has no --role: which daemon runs is which program was started', () => {
    expect(expectProblems(load(['--role=hub']))[0]).toContain('--role');
  });

  it('reads the keys it needs out of a settings file the server also reads', () => {
    // A key the server owns is not an error: a setting the hub never reads is
    // a setting it never sees.
    const result = load(['--hub-port=9090'], {
      AGENTPLEX_ROLE: 'both',
      AGENTPLEX_SERVER_IDENTITY_FILE: IDENTITY,
      AGENTPLEX_STORE_PATH: '/srv/stores',
    });

    expect(result).toMatchObject({ ok: true, config: { port: 9090 } });
  });
});

describe('loadHubConfig database file', () => {
  it('requires one rather than inventing a path', () => {
    const result = loadHubConfig({ argv: [], env: { AGENTPLEX_CLIENT_TOKEN: CLIENT_TOKEN } });
    expect(expectProblems(result)[0]).toContain('AGENTPLEX_DATABASE_FILE');
  });

  it('lets a flag override the environment, because a flag was just typed', () => {
    const result = load(['--database-file=/tmp/other.db']);
    expect(result).toMatchObject({ ok: true, config: { databaseFile: '/tmp/other.db' } });
  });

  it('refuses a relative path, which names a different file per working directory', () => {
    expect(expectProblems(load(['--database-file=agentplex.db']))[0]).toContain('absolute');
  });

  it('normalizes the path, so one file is not two names in a log line', () => {
    const result = load(['--database-file=/var/lib/agentplex/../agentplex/hub.db/']);
    expect(result).toMatchObject({
      ok: true,
      config: { databaseFile: '/var/lib/agentplex/hub.db' },
    });
  });
});

describe('loadHubConfig client token', () => {
  it('requires one rather than serving to anybody who asks', () => {
    const result = loadHubConfig({ argv: [], env: { AGENTPLEX_DATABASE_FILE: DATABASE_FILE } });
    expect(expectProblems(result)[0]).toContain('client token');
  });

  it('refuses a token short enough to guess, and says so the same way', () => {
    const result = load(['--client-token=hunter2']);
    expect(expectProblems(result)[0]).toContain('at least 32 characters');
  });

  it('trims the surrounding whitespace an env file leaves behind', () => {
    const result = load([], { AGENTPLEX_CLIENT_TOKEN: `  ${CLIENT_TOKEN}  ` });
    expect(result).toMatchObject({ ok: true, config: { clientToken: CLIENT_TOKEN } });
  });
});

describe('loadHubConfig local server', () => {
  it('names none by default: a hub does not go looking for a server beside it', () => {
    expect(load([])).toMatchObject({ ok: true, config: { localServer: null } });
  });

  it('is an entry once the identity file is named, on the server default port', () => {
    expect(load(['--local-server-identity-file', IDENTITY])).toMatchObject({
      ok: true,
      config: { localServer: { identityPath: IDENTITY, port: 8081 } },
    });
  });

  it('reads both from the environment, which is what a settings file is', () => {
    expect(
      load([], {
        AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE: IDENTITY,
        AGENTPLEX_LOCAL_SERVER_PORT: '9091',
      }),
    ).toMatchObject({ ok: true, config: { localServer: { identityPath: IDENTITY, port: 9091 } } });
  });

  it('refuses a port with no identity file, which names nothing to pair', () => {
    expect(expectProblems(load(['--local-server-port', '9091']))).toEqual([
      expect.stringContaining('--local-server-identity-file'),
    ]);
  });

  it('refuses a relative identity file', () => {
    expect(expectProblems(load(['--local-server-identity-file', 'server.json']))).toEqual([
      expect.stringContaining('absolute'),
    ]);
  });
});

describe('loadHubConfig failure reporting', () => {
  it('reports every problem at once rather than one env var per restart', () => {
    const problems = expectProblems(
      loadHubConfig({ argv: ['--hub-port=abc', '--log-level=loud'], env: {} }),
    );
    expect(problems).toHaveLength(4);
  });

  it('refuses an unknown flag rather than silently ignoring a typo', () => {
    expect(expectProblems(load(['--databse-file=x']))[0]).toContain('--databse-file');
  });

  it('refuses a bare word, because the hub has no commands', () => {
    expect(expectProblems(load(['doctor']))[0]).toContain('doctor');
  });

  it('lists every setting in the usage message', () => {
    for (const flag of [
      '--hub-port',
      '--database-file',
      '--client-token',
      '--local-server-identity-file',
      '--host',
      '--log-level',
    ]) {
      expect(hubUsage()).toContain(flag);
    }
    expect(hubUsage()).not.toContain('--role');
  });
});
