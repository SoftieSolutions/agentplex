import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUB_SETTINGS, SERVER_SETTINGS } from '@agentplex/node-shared';
import type { RecordedDeployment } from '../../installation/recorded-settings.js';
import { loadDoctorConfig, doctorUsage, type ConfigResult, type HubConfig } from './config.js';

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
function load(argv: string[], env: Record<string, string | undefined> = {}): ConfigResult {
  return loadDoctorConfig({
    argv,
    env: {
      AGENTPLEX_SERVER_IDENTITY_FILE: IDENTITY_FILE,
      HOME,
      ...env,
    },
  });
}

/** A settings file the doctor found, as `readRecordedSettings` hands it over. */
function recordedFile(
  values: Readonly<Record<string, string>>,
  overrides: Partial<RecordedDeployment> = {},
): RecordedDeployment {
  return {
    scope: 'user',
    file: `${HOME}/.agentplex/agentplex.env`,
    values: new Map(Object.entries(values)),
    problems: [],
    ...overrides,
  };
}

function expectProblems(result: ConfigResult): readonly string[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.problems;
}

describe('loadDoctorConfig roles', () => {
  it('reads the role from a flag', () => {
    const result = load(['--role=server']);
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('reads the role from the environment when no flag is given', () => {
    const result = load([], { AGENTPLEX_ROLE: 'server' });
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('lets a flag override the environment, because a flag was just typed', () => {
    const result = load(['--role=server'], { AGENTPLEX_ROLE: 'hub' });
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('refuses to start with no role rather than picking one', () => {
    expect(expectProblems(load([]))[0]).toContain('no role');
  });

  it('names the accepted roles when given an unknown one', () => {
    const problems = expectProblems(load(['--role=worker']));
    expect(problems[0]).toContain('hub, server, both');
  });

  it('inspects a hub-only machine as one with no server half', () => {
    const result = load(['--role=hub']);
    expect(result).toMatchObject({ ok: true, config: { role: 'hub' } });
    expect(result.ok && 'server' in result.config).toBe(false);
  });

  it('gives the both role a server half to inspect', () => {
    const result = load(['--role=both']);
    expect(result).toMatchObject({ ok: true, config: { role: 'both', server: { port: 8081 } } });
  });
});

describe('loadDoctorConfig ports', () => {
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

describe('loadDoctorConfig failure reporting', () => {
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

describe('loadDoctorConfig store paths', () => {
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

describe('loadDoctorConfig browse roots', () => {
  function browseRoots(argv: string[], env: Record<string, string | undefined> = {}): unknown {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok && 'server' in result.config ? result.config.server.browseRoots : undefined;
  }

  it('reads them the way the server reads them, which is the whole point', () => {
    // A doctor with its own idea of a setting would eventually disagree with
    // the service, and the one moment that happens is the one where somebody
    // is already staring at a machine wondering why a browse is refused.
    const value = ['/home/robert/code', '/srv/work'].join(delimiter);
    expect(browseRoots(['--role=server'], { AGENTPLEX_BROWSE_ROOTS: value })).toEqual([
      '/home/robert/code',
      '/srv/work',
    ]);
  });

  it('reads none as none, which is the default a server ships with', () => {
    expect(browseRoots(['--role=server'])).toEqual([]);
  });

  it('takes one root per repeated flag', () => {
    expect(browseRoots(['--role=server', '--browse-root=/a', '--browse-root=/b'])).toEqual([
      '/a',
      '/b',
    ]);
  });

  it('refuses a relative root', () => {
    const problems = expectProblems(load(['--role=server', '--browse-root=code']));
    expect(problems[0]).toContain('absolute');
  });
});

describe('loadDoctorConfig bin path', () => {
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
    expect(doctorUsage()).toContain('--bin-path');
    expect(doctorUsage()).toContain('AGENTPLEX_BIN_PATH');
  });
});

describe('loadDoctorConfig terminal cap', () => {
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

describe('loadDoctorConfig announce', () => {
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

describe('loadDoctorConfig server identity file', () => {
  /**
   * Deliberately not the helper above: these cases are about the identity
   * file's absence, so it is the one setting left out.
   */
  function loadBare(argv: string[], env: Record<string, string | undefined> = {}): ConfigResult {
    return loadDoctorConfig({ argv, env });
  }

  function identityPath(argv: string[], env: Record<string, string | undefined> = {}) {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok && 'server' in result.config ? result.config.server.identityPath : undefined;
  }

  it('defaults to where the server defaults it, under the home', () => {
    // The server reads `$HOME/.agentplex/server.json` when nothing names the
    // file, so a doctor that refused to look without one would be refusing
    // the configuration the service actually runs.
    const result = loadBare(['--role=server'], { HOME });
    expect(result).toMatchObject({
      ok: true,
      config: { server: { identityPath: '/home/dev/.agentplex/server.json' } },
    });
  });

  it('says whether the path is the default or one a setting named', () => {
    // The default is the one path the doctor can be wrong about: nothing named
    // it, so whether it is the file a unit reads depends on the unit's settings,
    // which this run may not have found.
    const defaulted = (argv: string[], env: Record<string, string | undefined>): unknown => {
      const result = loadBare(argv, env);
      return result.ok && 'server' in result.config
        ? result.config.server.identityPathDefaulted
        : undefined;
    };

    expect(defaulted(['--role=server'], { HOME })).toBe(true);
    expect(defaulted(['--role=server', '--server-identity-file=/srv/id.json'], { HOME })).toBe(
      false,
    );
    expect(
      defaulted(['--role=server'], { HOME, AGENTPLEX_SERVER_IDENTITY_FILE: IDENTITY_FILE }),
    ).toBe(false);
  });

  it('refuses to guess when there is no home to default from, and names the setting', () => {
    const problems = expectProblems(loadBare(['--role=server', '--data-path=/srv/agentplex']));
    expect(problems).toHaveLength(1);
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

  it('asks a hub-only machine for none, even one with no home', () => {
    // A hub starts no server, so neither of the server's home defaults is
    // this machine's business; refusing a hub over one would be refusing to
    // inspect it over a setting it never reads.
    expect(loadBare(['--role=hub'])).toMatchObject({ ok: true, config: { role: 'hub' } });
  });
});

describe('loadDoctorConfig data path', () => {
  function dataPath(argv: string[], env: Record<string, string | undefined> = {}) {
    const result = load(argv, env);
    expect(result.ok).toBe(true);
    return result.ok && 'server' in result.config ? result.config.server.dataPath : undefined;
  }

  it('is accepted, which a doctor that read its own copy of the settings did not do', () => {
    expect(dataPath(['--role=server', '--data-path=/x'])).toBe('/x');
  });

  it('defaults from the home, as the server does', () => {
    expect(dataPath(['--role=server'])).toBe('/home/dev/.agentplex');
  });

  it('refuses a relative path', () => {
    const problems = expectProblems(load(['--role=server', '--data-path=agentplex']));
    expect(problems[0]).toContain('absolute path');
  });

  it('defaults from the service account home on the fleet tier, whatever this shell says', () => {
    // A `--system` daemon runs as the account whose home `install.sh` made the
    // state directory. The operator's HOME -- or root's, under sudo -- is not
    // the one its defaults come from.
    const result = loadDoctorConfig({
      argv: ['--role=server'],
      env: { HOME: '/root' },
      recorded: recordedFile({}, { scope: 'system', file: '/etc/agentplex/agentplex.env' }),
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        server: {
          dataPath: '/var/lib/agentplex/.agentplex',
          identityPath: '/var/lib/agentplex/.agentplex/server.json',
        },
      },
    });
  });
});

describe('loadDoctorConfig the settings file', () => {
  it('reads the deployment from the file the daemons are started with', () => {
    const result = loadDoctorConfig({
      argv: [],
      env: { HOME },
      recorded: recordedFile({
        AGENTPLEX_ROLE: 'server',
        AGENTPLEX_BIN_PATH: '/home/dev/.agentplex/bin',
        AGENTPLEX_SERVER_IDENTITY_FILE: '/home/dev/.agentplex/server.json',
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      config: {
        role: 'server',
        server: {
          binPath: ['/home/dev/.agentplex/bin'],
          identityPath: '/home/dev/.agentplex/server.json',
        },
      },
    });
  });

  it('lets the environment win over the file, and a flag win over both', () => {
    const recorded = recordedFile({ AGENTPLEX_ROLE: 'server', AGENTPLEX_SERVER_PORT: '9001' });
    const port = (argv: string[], env: Record<string, string>): unknown => {
      const result = loadDoctorConfig({ argv, env: { HOME, ...env }, recorded });
      return result.ok && 'server' in result.config ? result.config.server.port : undefined;
    };

    expect(port([], {})).toBe(9001);
    expect(port([], { AGENTPLEX_SERVER_PORT: '9002' })).toBe(9002);
    expect(port(['--server-port=9003'], { AGENTPLEX_SERVER_PORT: '9002' })).toBe(9003);
  });

  it('does not let a blank variable in this shell hide what the file says', () => {
    // A blank variable is a setting nobody set, everywhere else in this
    // program; an exported empty one must not erase the file's line.
    const result = loadDoctorConfig({
      argv: [],
      env: { HOME, AGENTPLEX_ROLE: '' },
      recorded: recordedFile({ AGENTPLEX_ROLE: 'server' }),
    });
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('says which file it read', () => {
    const result = loadDoctorConfig({
      argv: ['--role=hub'],
      env: {},
      recorded: recordedFile({}),
    });
    expect(result).toMatchObject({
      ok: true,
      config: { settings: { file: '/home/dev/.agentplex/agentplex.env', problems: [] } },
    });
  });

  it('carries a file it could not read as a finding, and reads the rest', () => {
    const result = loadDoctorConfig({
      argv: ['--role=hub'],
      env: {},
      recorded: {
        scope: 'system',
        file: '/etc/agentplex/agentplex.env',
        values: new Map(),
        problems: ['cannot read /etc/agentplex/agentplex.env: EACCES'],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      config: {
        settings: {
          file: '/etc/agentplex/agentplex.env',
          problems: ['cannot read /etc/agentplex/agentplex.env: EACCES'],
        },
      },
    });
  });

  it('reads none when there is none', () => {
    expect(load(['--role=hub'])).toMatchObject({
      ok: true,
      config: { settings: { file: null, problems: [] } },
    });
  });
});

/**
 * Every flag either daemon accepts, accepted here. The doctor's promise is
 * that it reads the deployment the way the daemons do, and a flag one of them
 * takes that this refuses is a deployment it cannot be pointed at.
 */
describe('loadDoctorConfig flag parity with the daemons', () => {
  const tables = { server: SERVER_SETTINGS, hub: HUB_SETTINGS };

  for (const [daemon, table] of Object.entries(tables)) {
    for (const setting of Object.values(table)) {
      it(`accepts the ${daemon}'s ${setting.flag}`, () => {
        const result = load(['--role=both', `${setting.flag}=x`]);
        const problems = result.ok ? [] : result.problems;
        expect(problems.filter((problem) => problem.includes('unknown argument'))).toEqual([]);
      });
    }
  }

  it('lists each flag once in its usage, though both daemons read some of them', () => {
    const lines = doctorUsage().split('\n');
    for (const flag of ['--log-level', '--host']) {
      expect(lines.filter((line) => line.trim().startsWith(`${flag} `))).toHaveLength(1);
    }
  });
});

describe('loadDoctorConfig log level', () => {
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

describe('loadDoctorConfig host', () => {
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
    expect(doctorUsage()).toContain('--host');
    expect(doctorUsage()).toContain('AGENTPLEX_HOST');
  });
});

/**
 * The hub's settings, read the way the hub reads them, because the doctor's
 * question is what *this* deployment starts. The rules they feed are in
 * `hub.test.ts`; what these cases pin is which of them stop a run and which
 * become a finding.
 */
describe('loadDoctorConfig hub settings', () => {
  function hubHalf(result: ConfigResult): HubConfig {
    expect(result.ok).toBe(true);
    if (!result.ok || !('hub' in result.config)) throw new Error('no hub half was parsed');
    return result.config.hub;
  }

  it('reads the database file, the port, the token and the local server', () => {
    const result = load(['--role=hub'], {
      AGENTPLEX_DATABASE_FILE: '/var/lib/agentplex/agentplex.db',
      AGENTPLEX_HUB_PORT: '9090',
      AGENTPLEX_CLIENT_TOKEN: 'a-token-long-enough-for-anybody',
      AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE: IDENTITY_FILE,
    });

    expect(hubHalf(result)).toEqual({
      port: 9090,
      databaseFile: '/var/lib/agentplex/agentplex.db',
      clientToken: 'a-token-long-enough-for-anybody',
      localServer: { identityPath: IDENTITY_FILE, port: 8081 },
    });
  });

  it('defaults the hub port so a first run needs no port decision', () => {
    expect(hubHalf(load(['--role=hub']))).toMatchObject({ port: 8080 });
  });

  it('carries settings nobody set rather than refusing to inspect the machine', () => {
    // A half-finished hub is the machine somebody runs a doctor on. Answering
    // with a usage message instead of a report would refuse the one question
    // they asked.
    expect(hubHalf(load(['--role=hub']))).toMatchObject({
      databaseFile: null,
      clientToken: null,
      localServer: null,
    });
  });

  it('still refuses a database path that is not absolute, which is a typo and not a finding', () => {
    const problems = expectProblems(load(['--role=hub', '--database-file=agentplex.db']));
    expect(problems[0]).toContain('absolute path');
  });

  it('reads the local server port the hub pairs it on', () => {
    const result = load(['--role=hub'], {
      AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE: IDENTITY_FILE,
      AGENTPLEX_LOCAL_SERVER_PORT: '9091',
    });
    expect(hubHalf(result)).toMatchObject({
      localServer: { identityPath: IDENTITY_FILE, port: 9091 },
    });
  });

  it('refuses a local server identity path that is not absolute', () => {
    const problems = expectProblems(
      load(['--role=hub', '--local-server-identity-file=server.json']),
    );
    expect(problems[0]).toContain('absolute path');
  });

  it('gives the both role both halves to inspect', () => {
    const result = load(['--role=both'], { AGENTPLEX_DATABASE_FILE: '/srv/agentplex.db' });

    expect(result).toMatchObject({
      ok: true,
      config: { role: 'both', hub: { databaseFile: '/srv/agentplex.db' }, server: { port: 8081 } },
    });
  });

  it('gives a server-only machine no hub half at all', () => {
    const result = load(['--role=server']);
    expect(result.ok && 'hub' in result.config).toBe(false);
  });

  it('does not hold a hub setting against a machine that runs no hub', () => {
    // The environment of a `both` machine, read with `--role=server`: the
    // settings file is one file, and a path this run never uses must not be
    // able to refuse the run.
    const result = load(['--role=server'], { AGENTPLEX_DATABASE_FILE: 'relative.db' });
    expect(result).toMatchObject({ ok: true, config: { role: 'server' } });
  });

  it('lists every hub setting in the usage message', () => {
    for (const flag of [
      '--hub-port',
      '--database-file',
      '--client-token',
      '--local-server-identity-file',
      '--local-server-port',
    ]) {
      expect(doctorUsage()).toContain(flag);
    }
    expect(doctorUsage()).toContain('AGENTPLEX_DATABASE_FILE');
  });
});
