import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadServerConfig, serverUsage, type ServerConfigResult } from './config.js';

const IDENTITY_FILE = '/etc/agentplex/server.json';
const HOME = '/home/dev';

/**
 * Every case needs an identity file, and a home for the data root to default
 * from.
 *
 * They are supplied through the environment rather than written into each argv
 * so that a test about the terminal cap stays a test about the terminal cap. A
 * caller's own env wins, and the block that is actually about one of these
 * settings calls `loadConfig` directly so it can leave it out.
 */
function load(argv: string[], env: Record<string, string | undefined> = {}): ServerConfigResult {
  return loadServerConfig({
    argv,
    env: {
      AGENTPLEX_SERVER_IDENTITY_FILE: IDENTITY_FILE,
      HOME,
      ...env,
    },
  });
}

function expectProblems(result: ServerConfigResult): readonly string[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.problems;
}

describe('loadServerConfig', () => {
  it('has no --role: which daemon runs is which program was started', () => {
    expect(expectProblems(load(['--role=server']))[0]).toContain('--role');
  });

  it('reads the keys it needs out of a settings file the hub also reads', () => {
    // A key the hub owns is not an error: a setting the server never reads is
    // a setting it never sees.
    const result = load([], {
      AGENTPLEX_ROLE: 'both',
      AGENTPLEX_DATABASE_FILE: '/var/lib/agentplex/hub.db',
      AGENTPLEX_CLIENT_TOKEN: 'a-client-token-long-enough-to-be-one',
    });

    expect(result).toMatchObject({ ok: true, config: { port: 8081 } });
  });
});

describe('loadServerConfig ports', () => {
  it('defaults the port so a first run needs no port decision', () => {
    const result = load([]);
    expect(result).toMatchObject({ ok: true, config: { port: 8081 } });
  });

  it('accepts a flag value given as a separate argument', () => {
    const result = load(['--server-port', '9000']);
    expect(result).toMatchObject({ ok: true, config: { port: 9000 } });
  });

  it('refuses a port outside the valid range instead of letting bind fail later', () => {
    expect(expectProblems(load(['--server-port=70000']))).toHaveLength(1);
    expect(expectProblems(load(['--server-port=0']))).toHaveLength(1);
  });

  it('refuses a port that is not a number', () => {
    const problems = expectProblems(load(['--server-port=eight']));
    expect(problems[0]).toContain('port number');
  });
});

describe('loadServerConfig failure reporting', () => {
  it('reports every problem at once rather than one env var per restart', () => {
    const problems = expectProblems(
      load(['--server-port=abc', '--log-level=loud', '--announce=maybe', '--server-token=short']),
    );
    expect(problems).toHaveLength(4);
  });

  it('refuses an unknown flag rather than silently ignoring a typo', () => {
    const problems = expectProblems(load(['--databse-file=x']));
    expect(problems[0]).toContain('--databse-file');
  });

  it('refuses a flag left without a value', () => {
    const problems = expectProblems(load(['--host', '--server-port=9000']));
    expect(problems[0]).toContain('--host needs a value');
  });

  it('treats an empty environment variable as absent, not as an empty value', () => {
    const problems = expectProblems(
      loadServerConfig({ argv: [], env: { AGENTPLEX_SERVER_IDENTITY_FILE: '   ' } }),
    );
    expect(problems[0]).toContain('AGENTPLEX_SERVER_IDENTITY_FILE');
  });
});

describe('loadServerConfig store paths', () => {
  function storePaths(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok ? result.config.storePaths : undefined;
  }

  it('starts a server with no stores rather than demanding a volume that may be mounted later', () => {
    expect(storePaths([])).toEqual([]);
  });

  it('reads a store path from a flag', () => {
    expect(storePaths(['--store-path=/volumes/claude'])).toEqual(['/volumes/claude']);
  });

  it('takes one store per repeated flag, in the order they were given', () => {
    expect(storePaths(['--store-path=/volumes/a', '--store-path', '/volumes/b'])).toEqual([
      '/volumes/a',
      '/volumes/b',
    ]);
  });

  it('splits the environment variable on the path delimiter, as a container sets it', () => {
    const value = ['/volumes/a', '/volumes/b'].join(delimiter);
    expect(storePaths([], { AGENTPLEX_STORE_PATH: value })).toEqual(['/volumes/a', '/volumes/b']);
  });

  it('ignores an empty segment, which is what a trailing delimiter is', () => {
    const value = `/volumes/a${delimiter}${delimiter}`;
    expect(storePaths([], { AGENTPLEX_STORE_PATH: value })).toEqual(['/volumes/a']);
  });

  it('lets flags replace the environment rather than adding to it', () => {
    const result = storePaths(['--store-path=/volumes/flag'], {
      AGENTPLEX_STORE_PATH: '/volumes/env',
    });
    expect(result).toEqual(['/volumes/flag']);
  });

  it('refuses a relative path, which means nothing to a service started from anywhere', () => {
    const problems = expectProblems(load(['--store-path=volumes/claude']));
    expect(problems[0]).toContain('absolute');
  });

  it('normalizes so the same volume named twice is one store, not two', () => {
    expect(
      storePaths([
        '--store-path=/volumes/claude/',
        '--store-path=/volumes/claude',
        '--store-path=/volumes/other/../claude',
      ]),
    ).toEqual(['/volumes/claude']);
  });
});

describe('loadServerConfig browse roots', () => {
  function browseRoots(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok ? result.config.browseRoots : undefined;
  }

  it('grants nothing by default, so a machine nobody configured browses nothing', () => {
    // The direction that does not over-claim. What a root grants is a listing
    // of this machine's files to anybody who can reach a paired hub.
    expect(browseRoots([])).toEqual([]);
  });

  it('reads a browse root from a flag', () => {
    expect(browseRoots(['--browse-root=/home/dev/code'])).toEqual(['/home/dev/code']);
  });

  it('takes one root per repeated flag, in the order they were given', () => {
    expect(browseRoots(['--browse-root=/home/dev/code', '--browse-root', '/srv/work'])).toEqual([
      '/home/dev/code',
      '/srv/work',
    ]);
  });

  it('splits the environment variable on the path delimiter, as the installer writes it', () => {
    // The same spelling `settings-file.ts` joins on, which is the one place
    // setup and this parser have to agree without being able to import each
    // other.
    const value = ['/home/dev/code', '/srv/work'].join(delimiter);
    expect(browseRoots([], { AGENTPLEX_BROWSE_ROOTS: value })).toEqual([
      '/home/dev/code',
      '/srv/work',
    ]);
  });

  it('refuses a relative root, which would mean a different directory per boot', () => {
    const problems = expectProblems(load(['--browse-root=code']));
    expect(problems[0]).toContain('absolute');
  });

  it('normalizes so the same directory named twice is one root, not two', () => {
    expect(browseRoots(['--browse-root=/srv/work/', '--browse-root=/srv/agents/../work'])).toEqual([
      '/srv/work',
    ]);
  });

  it('is a separate list from the stores, which often name the same directory', () => {
    // Different permissions: a store is a provider's volume this server
    // watches, and a browse root is where somebody may look for a checkout.
    const result = load(['--store-path=/volumes/claude', '--browse-root=/home/dev/code']);
    expect(result.ok && result.config.storePaths).toEqual(['/volumes/claude']);
    expect(result.ok && result.config.browseRoots).toEqual(['/home/dev/code']);
  });
});

describe('loadServerConfig bin path', () => {
  function binPath(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok ? result.config.binPath : undefined;
  }

  it('is empty by default, which leaves the child inheriting exactly what it did before', () => {
    expect(binPath([])).toEqual([]);
  });

  it('reads a directory from a flag', () => {
    expect(binPath(['--bin-path=/opt/homebrew/bin'])).toEqual(['/opt/homebrew/bin']);
  });

  it('takes one directory per repeated flag, in the order they were given', () => {
    // The order is the setting: two directories both holding a `claude` is the
    // case the operator is deciding between when they write this list down.
    expect(binPath(['--bin-path=/opt/homebrew/bin', '--bin-path', '/home/a/.local/bin'])).toEqual([
      '/opt/homebrew/bin',
      '/home/a/.local/bin',
    ]);
  });

  it('splits the environment variable on the path delimiter, as a unit file sets it', () => {
    const value = ['/opt/homebrew/bin', '/usr/bin'].join(delimiter);
    expect(binPath([], { AGENTPLEX_BIN_PATH: value })).toEqual(['/opt/homebrew/bin', '/usr/bin']);
  });

  it('lets flags replace the environment rather than adding to it', () => {
    expect(binPath(['--bin-path=/from/flag'], { AGENTPLEX_BIN_PATH: '/from/env' })).toEqual([
      '/from/flag',
    ]);
  });

  it('refuses a relative directory, which resolves against wherever a unit left the process', () => {
    const problems = expectProblems(load(['--bin-path=bin']));
    expect(problems[0]).toContain('absolute');
  });

  it('normalizes so the same directory named twice is searched once', () => {
    expect(binPath(['--bin-path=/opt/bin/', '--bin-path=/opt/other/../bin'])).toEqual(['/opt/bin']);
  });

  it('is listed in the usage message like every other setting', () => {
    expect(serverUsage()).toContain('--bin-path');
    expect(serverUsage()).toContain('AGENTPLEX_BIN_PATH');
  });
});

/**
 * The settings whose rules are shared with the hub and the doctor. What each
 * value may be is `daemon-settings.test.ts` in `@agentplex/node-shared`; what
 * these cases pin is that the setting reaches this server's configuration, by
 * flag and by environment, and that its problems join everyone else's.
 */
describe('loadServerConfig terminal cap', () => {
  function terminalCap(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok ? result.config.terminalCap : undefined;
  }

  it('defaults to a number a laptop survives', () => {
    expect(terminalCap([])).toBe(8);
  });

  it('reads a cap from the environment, which is all a container is configured with', () => {
    expect(terminalCap([], { AGENTPLEX_TERMINAL_CAP: '2' })).toBe(2);
  });

  it('refuses a cap of zero rather than starting a server that can never run one', () => {
    const problems = expectProblems(load(['--terminal-cap=0']));
    expect(problems[0]).toContain('at least 1');
  });
});

describe('loadServerConfig drain budget', () => {
  function drainMs(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok ? result.config.drainMs : undefined;
  }

  it('defaults to the number install.sh renders beside the unit timeout', () => {
    expect(drainMs([])).toBe(15_000);
  });

  it('is read in seconds, because the unit line it has to agree with is', () => {
    expect(drainMs(['--drain-seconds=30'])).toBe(30_000);
    expect(drainMs([], { AGENTPLEX_SERVER_DRAIN_SECONDS: '5' })).toBe(5_000);
  });

  it('refuses a budget that is negative', () => {
    expect(expectProblems(load(['--drain-seconds=-1']))).toHaveLength(1);
  });

  it('is listed in the usage message like every other setting', () => {
    expect(serverUsage()).toContain('--drain-seconds');
    expect(serverUsage()).toContain('AGENTPLEX_SERVER_DRAIN_SECONDS');
  });
});

describe('loadServerConfig announce', () => {
  function announce(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok ? result.config.announce : undefined;
  }

  it('is off until somebody says otherwise', () => {
    expect(announce([])).toBe(false);
  });

  it('is turned on by the flag and by the environment alike', () => {
    expect(announce(['--announce=true'])).toBe(true);
    expect(announce([], { AGENTPLEX_ANNOUNCE: 'true' })).toBe(true);
  });

  it('can be turned back off on the command line', () => {
    // Why the setting takes a value rather than being a bare presence flag: an
    // image that sets the environment variable has to be overridable by the
    // person typing the command, and `--announce` alone could only say yes.
    expect(announce(['--announce=false'], { AGENTPLEX_ANNOUNCE: 'true' })).toBe(false);
  });
});

describe('loadServerConfig server identity file', () => {
  /**
   * Deliberately not the helper above: these cases are about the identity
   * file's absence, so it is the one setting left out.
   */
  function loadBare(
    argv: string[],
    env: Record<string, string | undefined> = {},
  ): ServerConfigResult {
    return loadServerConfig({ argv, env });
  }

  function identityPath(argv: string[], env: Record<string, string | undefined> = {}) {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok ? result.config.identityPath : undefined;
  }

  it('defaults to where setup mints it, under the account home', () => {
    // `agentplex setup` writes the identity at `$HOME/.agentplex/server.json`
    // and records it only for the hub. A server that required the setting
    // refused to start on every machine set up that way.
    expect(loadBare([], { HOME })).toMatchObject({
      ok: true,
      config: { identityPath: '/home/dev/.agentplex/server.json' },
    });
  });

  it('refuses to guess when there is no home to default from, and names the setting', () => {
    const problems = expectProblems(loadBare([], { AGENTPLEX_DATA_PATH: '/srv/agentplex' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('AGENTPLEX_SERVER_IDENTITY_FILE');
  });

  it('reads it from a flag', () => {
    expect(identityPath(['--server-identity-file=/srv/id.json'])).toBe('/srv/id.json');
  });

  it('reads it from the environment, over the default the home would have given', () => {
    expect(identityPath([])).toBe(IDENTITY_FILE);
  });

  it('refuses a relative path, which would be a different file per working directory', () => {
    const problems = expectProblems(load(['--server-identity-file=server.json']));
    expect(problems[0]).toContain('absolute path');
  });
});

describe('loadServerConfig data path', () => {
  /**
   * Deliberately not the helper above: these cases are about what the data
   * root falls back to, so the home it falls back to is the thing each one
   * says for itself.
   */
  function loadBare(
    argv: string[],
    env: Record<string, string | undefined> = {},
  ): ServerConfigResult {
    return loadServerConfig({
      argv,
      env: { AGENTPLEX_SERVER_IDENTITY_FILE: IDENTITY_FILE, ...env },
    });
  }

  function dataPath(argv: string[], env: Record<string, string | undefined> = {}) {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok ? result.config.dataPath : undefined;
  }

  it('defaults to the directory under the account home an install already owns', () => {
    expect(dataPath([])).toBe('/home/dev/.agentplex');
  });

  it('reads it from a flag', () => {
    expect(dataPath(['--data-path=/var/lib/agentplex'])).toBe('/var/lib/agentplex');
  });

  it('reads it from the environment, which is all a container is configured with', () => {
    expect(dataPath([], { AGENTPLEX_DATA_PATH: '/var/lib/agentplex' })).toBe('/var/lib/agentplex');
  });

  it('lets the flag win over the environment, like every other setting', () => {
    expect(dataPath(['--data-path=/from/flag'], { AGENTPLEX_DATA_PATH: '/from/env' })).toBe(
      '/from/flag',
    );
  });

  it('refuses to guess when there is no home to default from', () => {
    const problems = expectProblems(loadBare([]));
    expect(problems[0]).toContain('AGENTPLEX_DATA_PATH');
  });

  it('is collected with every other problem rather than reported on its own', () => {
    // The contract the whole file is built around: one restart per bad
    // settings file, not one per bad line in it.
    const problems = expectProblems(loadBare(['--server-port=abc', '--log-level=loud']));
    expect(problems).toHaveLength(3);
  });

  it('is listed in the usage message like every other setting', () => {
    expect(serverUsage()).toContain('--data-path');
    expect(serverUsage()).toContain('AGENTPLEX_DATA_PATH');
  });
});

describe('loadServerConfig timezone', () => {
  function timezone(argv: string[], env: Record<string, string | undefined> = {}) {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok ? result.config.timezone : undefined;
  }

  it('is unset until somebody says otherwise, which leaves a child inheriting', () => {
    expect(timezone([])).toBeUndefined();
  });

  it('reads a zone from a flag and from the environment alike', () => {
    expect(timezone(['--tz=Europe/Madrid'])).toBe('Europe/Madrid');
    expect(timezone([], { AGENTPLEX_TZ: 'Europe/Madrid' })).toBe('Europe/Madrid');
  });

  it('lets the flag win over the environment, like every other setting', () => {
    expect(timezone(['--tz=Asia/Tokyo'], { AGENTPLEX_TZ: 'UTC' })).toBe('Asia/Tokyo');
  });

  it('is collected with every other problem rather than reported on its own', () => {
    const problems = expectProblems(load(['--server-port=abc', '--tz=Mars/Phobos']));
    expect(problems).toHaveLength(2);
  });

  it('is listed in the usage message like every other setting', () => {
    expect(serverUsage()).toContain('--tz');
    expect(serverUsage()).toContain('AGENTPLEX_TZ');
  });
});

describe('loadServerConfig log level', () => {
  it('defaults to info', () => {
    expect(load([])).toMatchObject({ ok: true, config: { logLevel: 'info' } });
  });

  it('reads a level from the environment', () => {
    const result = load([], { AGENTPLEX_LOG_LEVEL: 'debug' });
    expect(result).toMatchObject({ ok: true, config: { logLevel: 'debug' } });
  });

  it('names the accepted levels when given an unknown one', () => {
    const problems = expectProblems(load(['--log-level=loud']));
    expect(problems[0]).toContain('debug, info, warn, error');
  });
});

describe('loadServerConfig host', () => {
  it('defaults to every interface, because a container is reached from outside its loopback', () => {
    expect(load([])).toMatchObject({ ok: true, config: { host: '0.0.0.0' } });
  });

  it('reads a host from the environment', () => {
    const result = load([], { AGENTPLEX_HOST: '127.0.0.1' });
    expect(result).toMatchObject({ ok: true, config: { host: '127.0.0.1' } });
  });

  it('takes a flag, which the setting did not have while main read the env directly', () => {
    const result = load(['--host=::1'], { AGENTPLEX_HOST: '0.0.0.0' });
    expect(result).toMatchObject({ ok: true, config: { host: '::1' } });
  });

  it('refuses an empty host rather than binding somewhere unstated', () => {
    const problems = expectProblems(load(['--host=']));
    expect(problems[0]).toContain('--host');
  });

  it('is listed in the usage message like every other setting', () => {
    expect(serverUsage()).toContain('--host');
    expect(serverUsage()).toContain('AGENTPLEX_HOST');
  });
});

describe('loadServerConfig server token', () => {
  /**
   * Longer than the floor, and nothing a minter would produce, so a test that
   * finds this string found the configured token.
   */
  const TOKEN = 'a-token-the-deployment-already-held-0123';

  it('mints nothing when the deployment set none, which is every machine with a disk', () => {
    expect(load([])).toMatchObject({ ok: true, config: { serverToken: undefined } });
  });

  it('takes a token the orchestrator injected, and names the setting it came from', () => {
    const result = load([], { AGENTPLEX_SERVER_TOKEN: TOKEN });
    expect(result).toMatchObject({
      ok: true,
      config: { serverToken: { token: TOKEN, setting: 'AGENTPLEX_SERVER_TOKEN' } },
    });
  });

  it('takes the flag over the environment, like every other setting', () => {
    const result = load([`--server-token=${TOKEN}`], { AGENTPLEX_SERVER_TOKEN: 'inherited-one' });
    expect(result).toMatchObject({ ok: true, config: { serverToken: { token: TOKEN } } });
  });

  it('is a setting nobody set when the env var is blank, not an empty token', () => {
    // What an env file with nothing after the `=` means, decided the same way
    // for this as for every other setting.
    const result = load([], { AGENTPLEX_SERVER_TOKEN: '   ' });
    expect(result).toMatchObject({ ok: true, config: { serverToken: undefined } });
  });

  it('is listed in the usage message like every other setting', () => {
    expect(serverUsage()).toContain('--server-token');
    expect(serverUsage()).toContain('AGENTPLEX_SERVER_TOKEN');
  });
});
