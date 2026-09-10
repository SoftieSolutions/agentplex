import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, usage, type ConfigResult } from './config.js';

const IDENTITY_FILE = '/etc/agentplexd/server.json';

/**
 * Every case needs an identity file.
 *
 * They are supplied through the environment rather than written into each argv
 * so that a test about the terminal cap stays a test about the terminal cap. A
 * caller's own env wins, and the block that is actually about one of these
 * settings calls `loadConfig` directly so it can leave it out.
 */
function load(argv: string[], env: Record<string, string | undefined> = {}): ConfigResult {
  return loadConfig({
    argv: ['doctor', ...argv],
    env: {
      AGENTPLEX_SERVER_IDENTITY_FILE: IDENTITY_FILE,
      ...env,
    },
  });
}

function expectProblems(result: ConfigResult): readonly string[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.problems;
}

describe('loadConfig roles', () => {
  it('reads the role from a flag', () => {
    const result = load(['--role=server']);
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('reads the role from the environment when no flag is given', () => {
    const result = load([], { AGENTPLEX_ROLE: 'server' });
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('lets a flag override the environment, because a flag was just typed', () => {
    const result = load(['--role=server'], { AGENTPLEX_ROLE: 'both' });
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('refuses to start with no role rather than picking one', () => {
    expect(expectProblems(load([]))[0]).toContain('no role');
  });

  it('names the accepted roles when given an unknown one', () => {
    const problems = expectProblems(load(['--role=worker']));
    expect(problems[0]).toContain('hub, server, both');
  });

  it('refuses the hub and both roles, and names the program that runs the hub', () => {
    // Still words setup and the installer know, so the refusal is not "unknown
    // role": the operator who typed one is not confused about roles; the layout
    // changed under them.
    for (const role of ['hub', 'both']) {
      const problems = expectProblems(load([`--role=${role}`]));
      expect(problems[0]).toContain('apps/hub');
    }
  });
});

describe('loadConfig ports', () => {
  it('defaults the port so a first run needs no port decision', () => {
    const result = load(['--role=server']);
    expect(result).toMatchObject({ ok: true, config: { server: { port: 8081 } } });
  });

  it('accepts a flag value given as a separate argument', () => {
    const result = load(['--role', 'server', '--server-port', '9000']);
    expect(result).toMatchObject({ ok: true, config: { server: { port: 9000 } } });
  });

  it('refuses a port outside the valid range instead of letting bind fail later', () => {
    expect(expectProblems(load(['--role=server', '--server-port=70000']))).toHaveLength(1);
    expect(expectProblems(load(['--role=server', '--server-port=0']))).toHaveLength(1);
  });

  it('refuses a port that is not a number', () => {
    const problems = expectProblems(load(['--role=server', '--server-port=eight']));
    expect(problems[0]).toContain('port number');
  });
});

describe('loadConfig failure reporting', () => {
  it('reports every problem at once rather than one env var per restart', () => {
    const problems = expectProblems(
      load(['--role=server', '--server-port=abc', '--log-level=loud', '--announce=maybe']),
    );
    expect(problems).toHaveLength(3);
  });

  it('refuses an unknown flag rather than silently ignoring a typo', () => {
    const problems = expectProblems(load(['--role=server', '--databse-file=x']));
    expect(problems[0]).toContain('--databse-file');
  });

  it('refuses a flag left without a value', () => {
    const problems = expectProblems(load(['--role', '--server-port=9000']));
    expect(problems[0]).toContain('--role needs a value');
  });

  it('treats an empty environment variable as absent, not as an empty value', () => {
    const problems = expectProblems(load([], { AGENTPLEX_ROLE: '   ' }));
    expect(problems[0]).toContain('no role');
  });
});

describe('loadConfig store paths', () => {
  function storePaths(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok && 'server' in result.config ? result.config.server.storePaths : undefined;
  }

  it('starts a server with no stores rather than demanding a volume that may be mounted later', () => {
    expect(storePaths(['--role=server'])).toEqual([]);
  });

  it('reads a store path from a flag', () => {
    expect(storePaths(['--role=server', '--store-path=/volumes/claude'])).toEqual([
      '/volumes/claude',
    ]);
  });

  it('takes one store per repeated flag, in the order they were given', () => {
    expect(
      storePaths(['--role=server', '--store-path=/volumes/a', '--store-path', '/volumes/b']),
    ).toEqual(['/volumes/a', '/volumes/b']);
  });

  it('splits the environment variable on the path delimiter, as a container sets it', () => {
    const value = ['/volumes/a', '/volumes/b'].join(delimiter);
    expect(storePaths(['--role=server'], { AGENTPLEX_STORE_PATH: value })).toEqual([
      '/volumes/a',
      '/volumes/b',
    ]);
  });

  it('ignores an empty segment, which is what a trailing delimiter is', () => {
    const value = `/volumes/a${delimiter}${delimiter}`;
    expect(storePaths(['--role=server'], { AGENTPLEX_STORE_PATH: value })).toEqual(['/volumes/a']);
  });

  it('lets flags replace the environment rather than adding to it', () => {
    const result = storePaths(['--role=server', '--store-path=/volumes/flag'], {
      AGENTPLEX_STORE_PATH: '/volumes/env',
    });
    expect(result).toEqual(['/volumes/flag']);
  });

  it('refuses a relative path, which means nothing to a service started from anywhere', () => {
    const problems = expectProblems(load(['--role=server', '--store-path=volumes/claude']));
    expect(problems[0]).toContain('absolute');
  });

  it('normalizes so the same volume named twice is one store, not two', () => {
    expect(
      storePaths([
        '--role=server',
        '--store-path=/volumes/claude/',
        '--store-path=/volumes/claude',
        '--store-path=/volumes/other/../claude',
      ]),
    ).toEqual(['/volumes/claude']);
  });
});

describe('loadConfig bin path', () => {
  function binPath(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok && 'server' in result.config ? result.config.server.binPath : undefined;
  }

  it('is empty by default, which leaves the child inheriting exactly what it did before', () => {
    expect(binPath(['--role=server'])).toEqual([]);
  });

  it('reads a directory from a flag', () => {
    expect(binPath(['--role=server', '--bin-path=/opt/homebrew/bin'])).toEqual([
      '/opt/homebrew/bin',
    ]);
  });

  it('takes one directory per repeated flag, in the order they were given', () => {
    // The order is the setting: two directories both holding a `claude` is the
    // case the operator is deciding between when they write this list down.
    expect(
      binPath([
        '--role=server',
        '--bin-path=/opt/homebrew/bin',
        '--bin-path',
        '/home/a/.local/bin',
      ]),
    ).toEqual(['/opt/homebrew/bin', '/home/a/.local/bin']);
  });

  it('splits the environment variable on the path delimiter, as a unit file sets it', () => {
    const value = ['/opt/homebrew/bin', '/usr/bin'].join(delimiter);
    expect(binPath(['--role=server'], { AGENTPLEX_BIN_PATH: value })).toEqual([
      '/opt/homebrew/bin',
      '/usr/bin',
    ]);
  });

  it('lets flags replace the environment rather than adding to it', () => {
    expect(
      binPath(['--role=server', '--bin-path=/from/flag'], { AGENTPLEX_BIN_PATH: '/from/env' }),
    ).toEqual(['/from/flag']);
  });

  it('refuses a relative directory, which resolves against wherever a unit left the process', () => {
    const problems = expectProblems(load(['--role=server', '--bin-path=bin']));
    expect(problems[0]).toContain('absolute');
  });

  it('normalizes so the same directory named twice is searched once', () => {
    expect(
      binPath(['--role=server', '--bin-path=/opt/bin/', '--bin-path=/opt/other/../bin']),
    ).toEqual(['/opt/bin']);
  });

  it('is listed in the usage message like every other setting', () => {
    expect(usage()).toContain('--bin-path');
    expect(usage()).toContain('AGENTPLEX_BIN_PATH');
  });
});

describe('loadConfig terminal cap', () => {
  function terminalCap(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok && 'server' in result.config ? result.config.server.terminalCap : undefined;
  }

  it('defaults to a number a laptop survives', () => {
    expect(terminalCap(['--role=server'])).toBe(8);
  });

  it('reads a cap from the environment, which is all a container is configured with', () => {
    expect(terminalCap(['--role=server'], { AGENTPLEX_TERMINAL_CAP: '2' })).toBe(2);
  });

  it('refuses a cap of zero rather than starting a server that can never run one', () => {
    const problems = expectProblems(load(['--role=server', '--terminal-cap=0']));
    expect(problems[0]).toContain('at least 1');
  });

  it('refuses a cap that is not a whole number of terminals', () => {
    expect(expectProblems(load(['--role=server', '--terminal-cap=lots']))).toHaveLength(1);
    expect(expectProblems(load(['--role=server', '--terminal-cap=2.5']))).toHaveLength(1);
  });
});

describe('loadConfig announce', () => {
  function announce(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok && 'server' in result.config ? result.config.server.announce : undefined;
  }

  it('is off until somebody says otherwise', () => {
    // A default of on would be a program that broadcasts its address on
    // whatever network it was installed next to. No default is right for both
    // the homelab and the laptop on a cafe wifi, so the operator says.
    expect(announce(['--role=server'])).toBe(false);
  });

  it('is turned on by the flag and by the environment alike', () => {
    expect(announce(['--role=server', '--announce=true'])).toBe(true);
    expect(announce(['--role=server'], { AGENTPLEX_ANNOUNCE: 'true' })).toBe(true);
  });

  it('can be turned back off on the command line', () => {
    // Why the setting takes a value rather than being a bare presence flag: an
    // image that sets the environment variable has to be overridable by the
    // person typing the command, and `--announce` alone could only say yes.
    expect(announce(['--role=server', '--announce=false'], { AGENTPLEX_ANNOUNCE: 'true' })).toBe(
      false,
    );
  });

  it('refuses a value it would have to guess at', () => {
    // Guessing wrong in one direction starts broadcasting on a network where
    // nobody asked for it.
    const problems = expectProblems(load(['--role=server', '--announce=yes']));
    expect(problems[0]).toContain('true or false');
  });
});

describe('loadConfig server identity file', () => {
  /**
   * Deliberately not the helper above: these cases are about the identity
   * file's absence, so it is the one setting left out.
   */
  function loadBare(argv: string[], env: Record<string, string | undefined> = {}): ConfigResult {
    return loadConfig({ argv: ['doctor', ...argv], env });
  }

  function identityPath(argv: string[], env: Record<string, string | undefined> = {}) {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok && 'server' in result.config ? result.config.server.identityPath : undefined;
  }

  it('requires one for the server role', () => {
    const problems = expectProblems(loadBare(['--role=server']));
    expect(problems[0]).toContain('AGENTPLEX_SERVER_IDENTITY_FILE');
  });

  it('reads it from a flag', () => {
    expect(identityPath(['--role=server', '--server-identity-file=/srv/id.json'])).toBe(
      '/srv/id.json',
    );
  });

  it('reads it from the environment, which is all a container is configured with', () => {
    expect(identityPath(['--role=server'])).toBe(IDENTITY_FILE);
  });

  it('refuses a relative path, which would be a different file per working directory', () => {
    // The failure this prevents is silent: a server started from elsewhere
    // mints a second identity, and the pairing the user completed stops
    // working with nothing anywhere saying why.
    const problems = expectProblems(load(['--role=server', '--server-identity-file=server.json']));
    expect(problems[0]).toContain('absolute path');
  });

  it('normalizes the path it was given', () => {
    expect(identityPath(['--role=server', '--server-identity-file=/srv/../srv/id.json'])).toBe(
      '/srv/id.json',
    );
  });
});

describe('loadConfig log level', () => {
  it('defaults to info', () => {
    expect(load(['--role=server'])).toMatchObject({ ok: true, config: { logLevel: 'info' } });
  });

  it('reads a level from the environment', () => {
    const result = load(['--role=server'], { AGENTPLEX_LOG_LEVEL: 'debug' });
    expect(result).toMatchObject({ ok: true, config: { logLevel: 'debug' } });
  });

  it('names the accepted levels when given an unknown one', () => {
    const problems = expectProblems(load(['--role=server', '--log-level=loud']));
    expect(problems[0]).toContain('debug, info, warn, error');
  });
});

describe('loadConfig host', () => {
  it('defaults to every interface, because a container is reached from outside its loopback', () => {
    expect(load(['--role=server'])).toMatchObject({ ok: true, config: { host: '0.0.0.0' } });
  });

  it('reads a host from the environment', () => {
    const result = load(['--role=server'], { AGENTPLEX_HOST: '127.0.0.1' });
    expect(result).toMatchObject({ ok: true, config: { host: '127.0.0.1' } });
  });

  it('takes a flag, which the setting did not have while main read the env directly', () => {
    const result = load(['--role=server', '--host=::1'], { AGENTPLEX_HOST: '0.0.0.0' });
    expect(result).toMatchObject({ ok: true, config: { host: '::1' } });
  });

  it('refuses an empty host rather than binding somewhere unstated', () => {
    const problems = expectProblems(load(['--role=server', '--host=']));
    expect(problems[0]).toContain('--host');
  });

  it('is listed in the usage message like every other setting', () => {
    expect(usage()).toContain('--host');
    expect(usage()).toContain('AGENTPLEX_HOST');
  });
});

describe('loadConfig commands', () => {
  it('refuses to serve, and names the program that does', () => {
    // The bare invocation every unit file used to use. The server is its own
    // program now, and a unit that still starts this one is told which to
    // start rather than left running nothing.
    const problems = expectProblems(
      loadConfig({
        argv: ['--role=server'],
        env: { AGENTPLEX_SERVER_IDENTITY_FILE: IDENTITY_FILE },
      }),
    );

    expect(problems[0]).toContain('apps/server');
  });

  it('reads a command word before the flags', () => {
    const result = load(['--role=server']);

    expect(result).toMatchObject({ ok: true, command: 'doctor', config: { role: 'server' } });
  });

  it('refuses a command nothing implements, rather than falling through to serving', () => {
    // Falling through would start a long-running service for somebody who
    // typed a word they expected to be read-only.
    const problems = expectProblems(load(['doctro', '--role=server']));

    expect(problems.join(' ')).toContain('doctro');
  });

  it('collects a bad command alongside every other problem', () => {
    const problems = expectProblems(loadConfig({ argv: ['nonsense', '--role=nonsense'], env: {} }));

    expect(problems.length).toBeGreaterThan(1);
  });

  it('reads a command only as the first argument, so a value is never one', () => {
    // `--role server` puts a bare word in argv that is not a command, and a
    // parser scanning for the first non-flag anywhere would take it as one.
    const result = load(['--role', 'server']);

    expect(result).toMatchObject({ ok: true, command: 'doctor', config: { role: 'server' } });
  });

  it('names the commands in the usage message', () => {
    expect(usage()).toContain('doctor');
  });
});
