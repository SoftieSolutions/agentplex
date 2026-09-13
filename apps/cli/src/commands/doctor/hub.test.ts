import { describe, expect, it } from 'vitest';
import { createFakeStoreFiles } from '@agentplex/providers/testing';
import { MIN_TOKEN_LENGTH } from '@agentplex/node-shared';
import type { HubConfig } from './config.js';
import { hubLines, hubUsable, inspectHub, type HubChecks, type HubDependencies } from './hub.js';
import {
  createFakeModuleResolver,
  createFakePathAccess,
  createFakePortProbe,
} from './fake-hub-probes.js';

/**
 * What a hub needs to boot, against a machine a test writes down.
 *
 * Every one of these was `usable: true` before AGX-228: the doctor returned
 * early for `--role=hub` and checked nothing, so a database nothing may write,
 * a token nobody set and a port something else holds all read as a healthy
 * machine. The cases below are the boot failures that produced, one each.
 */

const HOST = '0.0.0.0';
const DATABASE = '/var/lib/agentplex/agentplex.db';
const DATABASE_DIRECTORY = '/var/lib/agentplex';
const IDENTITY_PATH = '/etc/agentplex/server.json';
const WEB_MANIFEST = '@softiesolutions/agentplex-web/package.json';

/** Long enough for the hub, which is the only thing the check reads about it. */
const GOOD_TOKEN = 'x'.repeat(MIN_TOKEN_LENGTH);

function hubConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    port: 8080,
    databaseFile: DATABASE,
    clientToken: GOOD_TOKEN,
    localServerIdentityPath: null,
    ...overrides,
  };
}

/**
 * A machine where everything the hub needs is there: a writable directory for
 * the database, a free port, and the client package installed beside it.
 */
function workingMachine(overrides: Partial<HubDependencies> = {}): HubDependencies {
  return {
    files: createFakeStoreFiles({ directories: [DATABASE_DIRECTORY] }),
    access: createFakePathAccess({ writable: [DATABASE_DIRECTORY, DATABASE] }),
    ports: createFakePortProbe(),
    resolve: createFakeModuleResolver({ [WEB_MANIFEST]: 'file:///opt/web/package.json' }),
    ...overrides,
  };
}

async function inspect(
  config: HubConfig = hubConfig(),
  dependencies: Partial<HubDependencies> = {},
): Promise<HubChecks> {
  return await inspectHub(config, HOST, workingMachine(dependencies));
}

describe('the database file', () => {
  it('is ready when the directory the hub would create it in is writable', async () => {
    const checks = await inspect();

    expect(checks.database).toEqual({ path: DATABASE, state: 'ready', problem: null });
    expect(hubUsable(checks)).toBe(true);
  });

  it('is ready when the file is already there and this process may write it', async () => {
    const checks = await inspect(hubConfig(), {
      files: createFakeStoreFiles({
        directories: [DATABASE_DIRECTORY],
        files: { [DATABASE]: 'a database this test never opens' },
      }),
    });

    expect(checks.database).toMatchObject({ state: 'ready' });
  });

  it('is unusable when the file is there and this process may not write it', async () => {
    // The failure that reads as a healthy hub until the first write: the file
    // opens, and the hub dies on the first statement.
    const checks = await inspect(hubConfig(), {
      files: createFakeStoreFiles({
        directories: [DATABASE_DIRECTORY],
        files: { [DATABASE]: 'a database this test never opens' },
      }),
      access: createFakePathAccess({ writable: [DATABASE_DIRECTORY] }),
    });

    expect(checks.database).toMatchObject({ state: 'unusable' });
    expect(checks.database.problem).toContain(DATABASE);
    expect(hubUsable(checks)).toBe(false);
  });

  it('is unusable when nothing may be created in the directory', async () => {
    const checks = await inspect(hubConfig(), { access: createFakePathAccess() });

    expect(checks.database).toMatchObject({ state: 'unusable' });
    expect(checks.database.problem).toContain(DATABASE_DIRECTORY);
    expect(hubUsable(checks)).toBe(false);
  });

  it('says the directory is missing rather than the file, because the hub creates only the file', async () => {
    const checks = await inspect(hubConfig(), { files: createFakeStoreFiles() });

    expect(checks.database).toMatchObject({ state: 'missing' });
    expect(checks.database.problem).toContain(DATABASE_DIRECTORY);
    expect(hubUsable(checks)).toBe(false);
  });

  it('tells a directory where the database should be apart from a file that cannot be written', async () => {
    const checks = await inspect(hubConfig(), {
      files: createFakeStoreFiles({ directories: [DATABASE_DIRECTORY, DATABASE] }),
    });

    expect(checks.database).toMatchObject({ state: 'unusable' });
    expect(checks.database.problem).toContain('directory');
  });

  it('reports a setting nobody set rather than refusing to inspect the machine', async () => {
    const checks = await inspect(hubConfig({ databaseFile: null }));

    expect(checks.database).toMatchObject({ path: null, state: 'missing' });
    expect(checks.database.problem).toContain('AGENTPLEX_DATABASE_FILE');
    expect(hubUsable(checks)).toBe(false);
  });

  it('opens nothing, on a machine where opening would create a database', async () => {
    // Read-only is the whole contract, and a database file is the one thing
    // here that opening would *mint*: a mistyped path would be created, and
    // then reported healthy.
    const files = createFakeStoreFiles({ directories: [DATABASE_DIRECTORY] });

    await inspect(hubConfig(), { files });

    expect(files.creates).toEqual([]);
  });
});

describe('the client token', () => {
  it('is ready at the length the hub requires', async () => {
    const checks = await inspect(hubConfig({ clientToken: GOOD_TOKEN }));

    expect(checks.clientToken).toEqual({ state: 'ready', problem: null });
  });

  it('is missing when no setting carries one', async () => {
    const checks = await inspect(hubConfig({ clientToken: null }));

    expect(checks.clientToken).toMatchObject({ state: 'missing' });
    expect(checks.clientToken.problem).toContain('AGENTPLEX_CLIENT_TOKEN');
    expect(hubUsable(checks)).toBe(false);
  });

  it('is unusable when it is shorter than the hub will accept', async () => {
    const checks = await inspect(hubConfig({ clientToken: 'x'.repeat(MIN_TOKEN_LENGTH - 1) }));

    expect(checks.clientToken).toMatchObject({ state: 'unusable' });
    expect(checks.clientToken.problem).toContain(String(MIN_TOKEN_LENGTH));
    expect(hubUsable(checks)).toBe(false);
  });

  it('never carries the token anywhere a report could print it', async () => {
    const secret = `secret-${'y'.repeat(MIN_TOKEN_LENGTH)}`;
    const checks = await inspect(hubConfig({ clientToken: secret }));

    expect(JSON.stringify(checks)).not.toContain(secret);
    expect(hubLines(checks).join('\n')).not.toContain(secret);
  });
});

describe('the port', () => {
  it('is free when nothing holds the address the hub would bind', async () => {
    const checks = await inspect();

    expect(checks.port).toEqual({ host: HOST, port: 8080, state: 'free', problem: null });
  });

  it('is in use when something already listens there', async () => {
    const checks = await inspect(hubConfig(), {
      ports: createFakePortProbe({ taken: [`${HOST}:8080`] }),
    });

    expect(checks.port).toMatchObject({ state: 'in-use' });
    expect(hubUsable(checks)).toBe(false);
  });

  it('tells an address this machine cannot bind at all apart from one in use', async () => {
    // A privileged port, or a host that is not an interface on this machine.
    // Two different things to fix, and a boolean reports both as the same
    // shrug.
    const checks = await inspect(hubConfig(), {
      ports: createFakePortProbe({ refused: { [`${HOST}:8080`]: 'EACCES: permission denied' } }),
    });

    expect(checks.port).toMatchObject({ state: 'unusable', problem: 'EACCES: permission denied' });
    expect(hubUsable(checks)).toBe(false);
  });
});

describe('the client package', () => {
  it('is present when the manifest resolves', async () => {
    const checks = await inspect();

    expect(checks.client).toEqual({ state: 'present', problem: null });
  });

  it('is a warning and not a failure when it does not, because the hub still starts', async () => {
    const checks = await inspect(hubConfig(), { resolve: createFakeModuleResolver({}) });

    expect(checks.client).toMatchObject({ state: 'missing' });
    expect(checks.client.problem).toContain('@softiesolutions/agentplex-web');
    // The whole of the difference between a warning and a failure.
    expect(hubUsable(checks)).toBe(true);
  });

  it('says what a hub without it does, because a missing line otherwise reads as broken', async () => {
    const checks = await inspect(hubConfig(), { resolve: createFakeModuleResolver({}) });

    expect(hubLines(checks).join('\n')).toContain('503');
  });
});

describe('the local server', () => {
  it('is not asked about on a hub whose settings name none, which is most hubs', async () => {
    const checks = await inspect();

    expect(checks.localServer).toBeNull();
  });

  it('is ready when the identity file parses', async () => {
    const checks = await inspect(hubConfig({ localServerIdentityPath: IDENTITY_PATH }), {
      files: createFakeStoreFiles({
        directories: [DATABASE_DIRECTORY],
        files: { [IDENTITY_PATH]: '{"serverId":"server-1","token":"a-token-off-the-disk"}' },
      }),
    });

    expect(checks.localServer).toEqual({ path: IDENTITY_PATH, state: 'ready', problem: null });
    expect(hubUsable(checks)).toBe(true);
  });

  it('fails the run when the file the settings point at is not there', async () => {
    // The hub boots either way and logs one warn line, and then the server
    // beside it never appears. Nothing else on the machine says so again.
    const checks = await inspect(hubConfig({ localServerIdentityPath: IDENTITY_PATH }));

    expect(checks.localServer).toMatchObject({ path: IDENTITY_PATH, state: 'unusable' });
    expect(hubUsable(checks)).toBe(false);
  });

  it('fails the run when the file is there and is not a server identity', async () => {
    const checks = await inspect(hubConfig({ localServerIdentityPath: IDENTITY_PATH }), {
      files: createFakeStoreFiles({
        directories: [DATABASE_DIRECTORY],
        files: { [IDENTITY_PATH]: '{"serverId":"server-1"}' },
      }),
    });

    expect(checks.localServer).toMatchObject({ state: 'unusable' });
    expect(checks.localServer?.problem).toContain('identity file');
    expect(hubUsable(checks)).toBe(false);
  });

  it('mints nothing over a file it could not read', async () => {
    // `readServerIdentity` is the read that cannot write, and that is why it is
    // the one this reaches for: `ensureServerIdentity` would mint a fresh
    // identity here and hand this machine a token nobody has ever paired with.
    const files = createFakeStoreFiles({
      directories: [DATABASE_DIRECTORY],
      files: { [IDENTITY_PATH]: 'not json at all' },
    });

    const checks = await inspect(hubConfig({ localServerIdentityPath: IDENTITY_PATH }), { files });

    expect(checks.localServer).toMatchObject({ state: 'unusable' });
    expect(files.creates).toEqual([]);
    expect(files.contents.get(IDENTITY_PATH)).toBe('not json at all');
  });
});

describe('hubLines', () => {
  it('names each thing checked, what it turned out to be, and the path or address', async () => {
    const printed = hubLines(await inspect()).join('\n');

    expect(printed).toContain('database');
    expect(printed).toContain(DATABASE);
    expect(printed).toContain('client token');
    expect(printed).toContain('port');
    expect(printed).toContain(`${HOST}:8080`);
    expect(printed).toContain('web client');
  });

  it('puts the problem underneath the line it belongs to', async () => {
    const printed = hubLines(await inspect(hubConfig({ databaseFile: null }))).join('\n');

    expect(printed).toContain('missing');
    expect(printed).toContain('AGENTPLEX_DATABASE_FILE');
  });

  it('says nothing about a local server on a hub that has none', async () => {
    const printed = hubLines(await inspect()).join('\n');

    expect(printed).not.toContain('local server');
  });
});
