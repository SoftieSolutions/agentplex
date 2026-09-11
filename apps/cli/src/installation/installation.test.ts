import { describe, expect, it } from 'vitest';
import { createFakeInstallationFiles } from './fake-installation-files.js';
import { protocolDisagreement, readInstallation, type Installation } from './installation.js';

/**
 * A prefix as a literal, which is the whole point of the seam under this.
 *
 * Every machine below is a table: a settings file with two lines in it, a
 * manifest or three, a unit file that is there or is not. None of them is a
 * directory anybody had to build, and the half-finished ones -- a manifest that
 * is not JSON, a unit for one daemon and not the other, a settings file that
 * refuses to be read -- are the cases that matter and the ones a real prefix
 * would be tedious to get into.
 */

const HOME = '/home/alice';
const PREFIX = `${HOME}/.agentplex`;
const UNITS = `${HOME}/.config/systemd/user`;

function manifest(name: string, version: string, protocol: number | null): string {
  return JSON.stringify(
    protocol === null ? { name, version } : { name, version, agentplex: { protocol } },
  );
}

function packageAt(prefix: string, name: string): string {
  return `${prefix}/lib/node_modules/${name}/package.json`;
}

/** A user install of role=both, everything in place, nothing running. */
function wholeMachine(): Record<string, string> {
  return {
    [`${PREFIX}/agentplex.env`]: 'AGENTPLEX_ROLE=both\nAGENTPLEX_PREFIX=' + PREFIX + '\n',
    [packageAt(PREFIX, '@softiesolutions/agentplex')]: manifest(
      '@softiesolutions/agentplex',
      '1.4.0',
      3,
    ),
    [packageAt(PREFIX, '@softiesolutions/agentplex-hub')]: manifest(
      '@softiesolutions/agentplex-hub',
      '1.2.0',
      3,
    ),
    [packageAt(PREFIX, '@softiesolutions/agentplex-server')]: manifest(
      '@softiesolutions/agentplex-server',
      '1.5.0',
      3,
    ),
    [packageAt(PREFIX, '@softiesolutions/agentplex-web')]: manifest(
      '@softiesolutions/agentplex-web',
      '1.1.0',
      3,
    ),
    [`${PREFIX}/node/.agentplex-node-version`]: 'v24.9.0\n',
  };
}

async function read(
  files: Parameters<typeof readInstallation>[1],
  lookup: Partial<Parameters<typeof readInstallation>[0]> = {},
): Promise<Installation> {
  const found = await readInstallation(
    { home: HOME, prefix: null, system: false, ...lookup },
    files,
  );
  if (!found.ok) throw new Error(`expected an installation: ${found.problems.join('; ')}`);
  return found.installation;
}

describe('finding an installation', () => {
  it('reads the user install in the operator home, with the scope its units are in', async () => {
    const installation = await read(createFakeInstallationFiles({ files: wholeMachine() }));

    expect(installation.layout.scope).toBe('user');
    expect(installation.layout.prefix).toBe(PREFIX);
    expect(installation.layout.unitDirectory).toBe(UNITS);
    expect(installation.role).toBe('both');
  });

  it('falls back to the fleet install when the operator has none of their own', async () => {
    const files = createFakeInstallationFiles({
      files: { '/etc/agentplex/agentplex.env': 'AGENTPLEX_ROLE=hub\n' },
    });

    const installation = await read(files);

    expect(installation.layout.scope).toBe('system');
    expect(installation.layout.prefix).toBe('/opt/agentplex');
    expect(installation.layout.unitDirectory).toBe('/etc/systemd/system');
  });

  it('prefers the operator own install on a machine that has both', async () => {
    const files = createFakeInstallationFiles({
      files: {
        ...wholeMachine(),
        '/etc/agentplex/agentplex.env': 'AGENTPLEX_ROLE=hub\n',
      },
    });

    // Theirs is the one they meant; --system is how they say otherwise.
    expect((await read(files)).layout.scope).toBe('user');
    expect((await read(files, { system: true })).layout.scope).toBe('system');
  });

  it('takes a fleet prefix from the line install.sh recorded, because /etc does not say', async () => {
    // The one place `AGENTPLEX_PREFIX` is load-bearing. A `--system --prefix`
    // install puts its settings at the fixed `/etc` path, so the file's
    // location says nothing about where the packages went.
    const files = createFakeInstallationFiles({
      files: { '/etc/agentplex/agentplex.env': 'AGENTPLEX_PREFIX=/srv/agentplex\n' },
    });

    expect((await read(files)).layout.prefix).toBe('/srv/agentplex');
  });

  it('lets a typed --prefix win over a recorded one', async () => {
    const files = createFakeInstallationFiles({
      files: {
        '/etc/agentplex/agentplex.env': 'AGENTPLEX_PREFIX=/srv/agentplex\n',
        '/srv/other/agentplex.env': 'AGENTPLEX_ROLE=hub\n',
      },
    });

    expect((await read(files, { prefix: '/srv/other' })).layout.prefix).toBe('/srv/other');
  });

  it('refuses a directory that is not an agentplex prefix, and says where it looked', async () => {
    const found = await readInstallation(
      { home: HOME, prefix: '/srv/nothing', system: false },
      createFakeInstallationFiles({}),
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    // Named, because the next thing the operator does is look there.
    expect(found.problems.join('\n')).toContain('/srv/nothing/agentplex.env');
    expect(found.problems.join('\n')).toContain('--prefix');
  });

  it('does not call a settings file it may not read an absence', async () => {
    // The fleet file is root:agentplex at 0640, so this is what an operator who
    // is neither gets. "No agentplex here" would send them looking in the one
    // wrong place.
    const found = await readInstallation(
      { home: HOME, prefix: null, system: false },
      createFakeInstallationFiles({
        unreadable: { '/etc/agentplex/agentplex.env': 'EACCES: permission denied' },
      }),
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.problems[0]).toContain('cannot read /etc/agentplex/agentplex.env');
    expect(found.problems[0]).toContain('permission denied');
  });
});

describe('what is installed under a prefix', () => {
  it('reports every package with the version and protocol its manifest declares', async () => {
    const installation = await read(createFakeInstallationFiles({ files: wholeMachine() }));

    expect(installation.packages).toEqual([
      {
        component: 'cli',
        name: '@softiesolutions/agentplex',
        state: 'installed',
        version: '1.4.0',
        protocol: 3,
        problem: null,
      },
      {
        component: 'hub',
        name: '@softiesolutions/agentplex-hub',
        state: 'installed',
        version: '1.2.0',
        protocol: 3,
        problem: null,
      },
      {
        component: 'server',
        name: '@softiesolutions/agentplex-server',
        state: 'installed',
        version: '1.5.0',
        protocol: 3,
        problem: null,
      },
      {
        component: 'web',
        name: '@softiesolutions/agentplex-web',
        state: 'installed',
        version: '1.1.0',
        protocol: 3,
        problem: null,
      },
    ]);
  });

  it('calls a package a role does not install absent, not missing', async () => {
    // A hub machine installs no server package. Reporting that as missing would
    // make every correctly installed machine in a fleet look broken.
    const whole = wholeMachine();
    const files = createFakeInstallationFiles({
      files: Object.fromEntries(
        Object.entries(whole).filter(
          ([path]) => !path.includes('@softiesolutions/agentplex-server'),
        ),
      ),
    });

    const server = (await read(files)).packages.find((one) => one.component === 'server');
    expect(server?.state).toBe('absent');
    expect(server?.problem).toBeNull();
  });

  it('lets an unreadable manifest cost itself rather than the listing', async () => {
    const files = createFakeInstallationFiles({
      files: {
        ...wholeMachine(),
        [packageAt(PREFIX, '@softiesolutions/agentplex-hub')]: '{ this is not json',
      },
    });

    const packages = (await read(files)).packages;
    expect(packages.find((one) => one.component === 'hub')?.state).toBe('unreadable');
    // The other three are still reported, which is the whole rule.
    expect(packages.filter((one) => one.state === 'installed')).toHaveLength(3);
  });

  it('refuses a manifest whose version is not a version rather than printing it', async () => {
    const files = createFakeInstallationFiles({
      files: {
        ...wholeMachine(),
        [packageAt(PREFIX, '@softiesolutions/agentplex-web')]: JSON.stringify({ version: 7 }),
      },
    });

    const web = (await read(files)).packages.find((one) => one.component === 'web');
    expect(web?.state).toBe('unreadable');
    expect(web?.version).toBeNull();
  });
});

describe('the units and the runtime', () => {
  it('names only a unit that is there', async () => {
    const files = createFakeInstallationFiles({
      files: wholeMachine(),
      present: [`${UNITS}/agentplex-hub.service`],
    });

    expect((await read(files)).units).toEqual([
      { daemon: 'hub', unit: 'agentplex-hub.service', file: `${UNITS}/agentplex-hub.service` },
    ]);
  });

  it('names both when both are there, and none when neither is', async () => {
    const both = createFakeInstallationFiles({
      files: wholeMachine(),
      present: [`${UNITS}/agentplex-hub.service`, `${UNITS}/agentplex-server.service`],
    });

    expect((await read(both)).units.map((one) => one.daemon)).toEqual(['hub', 'server']);
    expect((await read(createFakeInstallationFiles({ files: wholeMachine() }))).units).toEqual([]);
  });

  it('reports the runtime install.sh stamped, and an adopted one as adopted', async () => {
    const owned = await read(createFakeInstallationFiles({ files: wholeMachine() }));
    expect(owned.runtime).toEqual({ kind: 'installed', version: 'v24.9.0' });

    const whole = wholeMachine();
    delete whole[`${PREFIX}/node/.agentplex-node-version`];
    // No stamp is not "no runtime": the script writes one only when it unpacked
    // a Node, so its absence means it adopted one the machine already had.
    expect((await read(createFakeInstallationFiles({ files: whole }))).runtime).toEqual({
      kind: 'adopted',
    });
  });
});

describe('whether the components can talk to each other', () => {
  it('says nothing when they agree', async () => {
    expect(
      protocolDisagreement(await read(createFakeInstallationFiles({ files: wholeMachine() }))),
    ).toBeNull();
  });

  it('names every component that declared one when they do not', async () => {
    // A hub upgraded on its own, across a protocol change. The two would
    // connect and refuse each other's frames with nothing in either log naming
    // the cause, which is why this command is the one that says so.
    const files = createFakeInstallationFiles({
      files: {
        ...wholeMachine(),
        [packageAt(PREFIX, '@softiesolutions/agentplex-hub')]: manifest(
          '@softiesolutions/agentplex-hub',
          '2.0.0',
          4,
        ),
      },
    });

    const disagreement = protocolDisagreement(await read(files));
    expect(disagreement?.map((one) => [one.component, one.protocol])).toEqual([
      ['cli', 3],
      ['hub', 4],
      ['server', 3],
      ['web', 3],
    ]);
  });

  it('does not count a package that declares no protocol as a disagreement', async () => {
    // A build from before the field existed, or a local one. "This one does not
    // say" is a smaller fact than "these two say different things".
    const files = createFakeInstallationFiles({
      files: {
        ...wholeMachine(),
        [packageAt(PREFIX, '@softiesolutions/agentplex-web')]: manifest(
          '@softiesolutions/agentplex-web',
          '1.1.0',
          null,
        ),
      },
    });

    expect(protocolDisagreement(await read(files))).toBeNull();
  });
});
