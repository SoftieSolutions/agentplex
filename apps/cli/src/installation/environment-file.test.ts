import { describe, expect, it } from 'vitest';
import { upsertSettings } from '../commands/setup/settings-file.js';
import { readEnvironmentFile } from './environment-file.js';

/**
 * Reading back what the installer and setup write, which is the only thing this
 * is for.
 *
 * The round trip is the assertion that matters. `settings-file.ts` is what
 * writes into this file, and the two have to agree about quoting or setup
 * records a prefix that reads back as something else -- so the last case below
 * writes through that module rather than quoting by hand.
 */
describe('the settings file', () => {
  it('reads the two lines the installer writes bare', () => {
    // Verbatim from `write_environment_file`, comments and all.
    const written = [
      '# agentplex settings, read by the systemd units as an EnvironmentFile.',
      '',
      'AGENTPLEX_ROLE=both',
      '',
      '# The prefix this install created, recorded so that it can be given back.',
      'AGENTPLEX_PREFIX=/home/alice/.agentplex',
      '',
      'AGENTPLEX_BIN_PATH=/home/alice/.agentplex/bin',
      '#AGENTPLEX_CLIENT_TOKEN=',
      '',
    ].join('\n');

    expect(readEnvironmentFile(written)).toEqual({
      prefix: '/home/alice/.agentplex',
      role: 'both',
    });
  });

  it('says nothing about a key the file does not carry', () => {
    // A `--no-setup` install that somebody edited down, and a file that is
    // simply not an agentplex one. Both are `null` rather than a guess.
    expect(readEnvironmentFile('AGENTPLEX_ROLE=hub\n')).toEqual({ prefix: null, role: 'hub' });
    expect(readEnvironmentFile('')).toEqual({ prefix: null, role: null });
  });

  it('does not read a commented-out line as a setting', () => {
    // The installer leaves every setting it could not know commented out, and a
    // reader that took one would report a prefix nobody chose.
    expect(readEnvironmentFile('#AGENTPLEX_PREFIX=/opt/agentplex\n').prefix).toBeNull();
  });

  it('takes the last assignment, which is what systemd hands the daemon', () => {
    expect(readEnvironmentFile('AGENTPLEX_ROLE=hub\nAGENTPLEX_ROLE=both\n').role).toBe('both');
  });

  it('reports a role that is not a role, because that is what the file says', () => {
    // Not parsed against the three roles. `status` reports installation state,
    // and "this file says hubb" is both true and the thing that explains why
    // the daemon will not start; "no role" would be neither.
    expect(readEnvironmentFile('AGENTPLEX_ROLE=hubb\n').role).toBe('hubb');
  });

  it('reads back a prefix that setup had to quote', () => {
    const written = upsertSettings(null, [
      { key: 'AGENTPLEX_PREFIX', value: '/home/a person/.agentplex' },
    ]);

    expect(written).toContain('"/home/a person/.agentplex"');
    expect(readEnvironmentFile(written).prefix).toBe('/home/a person/.agentplex');
  });

  it('skips a line it cannot make sense of rather than refusing the file', () => {
    // An operator's own note, with no `=` in it. A `status` that said nothing
    // about a machine over one typed line would be worse than one that reads
    // the two keys it came for.
    expect(readEnvironmentFile('this is not a setting\nAGENTPLEX_ROLE=hub\n').role).toBe('hub');
  });
});
