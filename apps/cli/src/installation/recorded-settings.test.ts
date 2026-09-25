import { describe, expect, it } from 'vitest';
import { createFakeInstallationFiles } from './fake-installation-files.js';
import { readRecordedSettings } from './recorded-settings.js';

const HOME = '/home/alice';
const PREFIX = `${HOME}/.agentplex`;

/**
 * The settings file as the doctor reads it: every value in it, from the layout
 * `status` would have found, and never a refusal.
 *
 * The doctor reports on the deployment the daemons run, which is this file; a
 * doctor that could not read it still has the environment and its flags, and
 * says what it could not read rather than refusing to look at the machine.
 */
describe('readRecordedSettings', () => {
  const lookup = { home: HOME, prefix: null, system: false } as const;

  it('reads every value out of the per-user file, and says which tier it came from', async () => {
    const files = createFakeInstallationFiles({
      files: {
        [`${PREFIX}/agentplex.env`]:
          'AGENTPLEX_ROLE=server\nAGENTPLEX_BIN_PATH=/home/alice/.agentplex/bin\n',
      },
    });

    expect(await readRecordedSettings(lookup, files)).toEqual({
      scope: 'user',
      file: `${PREFIX}/agentplex.env`,
      values: new Map([
        ['AGENTPLEX_ROLE', 'server'],
        ['AGENTPLEX_BIN_PATH', '/home/alice/.agentplex/bin'],
      ]),
      problems: [],
    });
  });

  it('falls through to the fleet file, as status does', async () => {
    const files = createFakeInstallationFiles({
      files: { '/etc/agentplex/agentplex.env': 'AGENTPLEX_ROLE=hub\n' },
    });

    expect(await readRecordedSettings(lookup, files)).toMatchObject({
      scope: 'system',
      file: '/etc/agentplex/agentplex.env',
      values: new Map([['AGENTPLEX_ROLE', 'hub']]),
      problems: [],
    });
  });

  it('is an empty map and no problem on a machine with no settings file', async () => {
    // A checkout, a container configured by environment alone. Nothing is
    // wrong with either: the doctor reads what it was given.
    expect(await readRecordedSettings(lookup, createFakeInstallationFiles())).toEqual({
      scope: null,
      file: null,
      values: new Map(),
      problems: [],
    });
  });

  it('is a problem, and still the tier, when the file is there and will not be read', async () => {
    // The fleet file is root's at 0640, so this is what an operator who is
    // neither root nor the account gets. It is still a fleet machine, and
    // what its daemons default from is still the account's home.
    const files = createFakeInstallationFiles({
      unreadable: { '/etc/agentplex/agentplex.env': 'EACCES: permission denied' },
    });

    const recorded = await readRecordedSettings(lookup, files);
    expect(recorded).toMatchObject({
      scope: 'system',
      file: '/etc/agentplex/agentplex.env',
      values: new Map(),
    });
    expect(recorded.problems).toEqual([
      'cannot read /etc/agentplex/agentplex.env: EACCES: permission denied',
    ]);
  });
});
