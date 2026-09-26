import { PIN_GRAMMAR_CASES } from '@agentplex/release/testing';
import { describe, expect, it } from 'vitest';
import { readInstallFlags, resolveRole, type InstallFlags } from './install-flags.js';

/**
 * `install.sh`'s grammar, word for word, refusals included.
 *
 * The reason it is copied rather than improved on is the handover that comes
 * after this command: `install.sh` will pass its own arguments through to
 * `agentplex install` unchanged, and a word the two read differently is an
 * install that means one thing when typed at the script and another once the
 * script hands over. Every sentence below is the script's `die` text, so the
 * refusal an operator reads does not change either.
 */

function request(argv: readonly string[]) {
  const flags: InstallFlags = readInstallFlags(argv);
  if (!flags.ok) throw new Error(`refused: ${flags.problem}`);
  return flags.value;
}

function refusal(argv: readonly string[]): string {
  const flags = readInstallFlags(argv);
  if (flags.ok) throw new Error(`accepted ${argv.join(' ')}`);
  return flags.problem;
}

describe('readInstallFlags', () => {
  it('takes both when no role is named, as the script defaults', () => {
    expect(request([])).toEqual({
      role: 'both',
      daemons: ['hub', 'server'],
      components: ['cli', 'hub', 'web', 'server'],
      pins: {},
      prefix: null,
      system: false,
      dryRun: false,
      printUnit: false,
    });
  });

  it('takes --role more than once, each with its own pin', () => {
    const value = request(['--role=hub@1.3.0', '--role=server@1.4']);

    expect(value.role).toBe('both');
    expect(value.pins).toEqual({
      hub: { kind: 'exact', version: '1.3.0' },
      server: { kind: 'series', series: '1.4' },
    });
  });

  it('refuses a pin on both, which names two components where a version names one', () => {
    expect(refusal(['--role=both@1.2'])).toBe(
      '--role=both names two components and a version names one: pin them separately, as ' +
        '--role=hub@<version> --role=server@<version>',
    );
  });

  it('refuses cli and web as roles, and says the command is pinned with --package-version', () => {
    for (const word of ['cli', 'web', 'cli@1.4.0']) {
      const component = word.split('@')[0] ?? '';
      expect(refusal([`--role=${word}`])).toBe(
        `"${component}" is not a role: the agentplex command goes on every machine whatever it ` +
          'runs, and the client is part of being a hub. Pin the command with ' +
          '--package-version=<version>',
      );
    }
  });

  it('refuses a role it does not know, the empty one included', () => {
    expect(refusal(['--role=hbu'])).toBe('unknown role "hbu": expected one of hub, server, both');
    expect(refusal(['--role='])).toBe('unknown role "": expected one of hub, server, both');
  });

  it('refuses a component named twice, both included, rather than taking the last', () => {
    const twice =
      '--role names hub twice: two answers to one question is a contradiction rather than a ' +
      'last-one-wins, so nothing was installed';
    expect(refusal(['--role=hub@1.3.0', '--role=hub@1.4.0'])).toBe(twice);
    expect(refusal(['--role=hub', '--role=both'])).toBe(twice);
  });

  it('pins the command with --package-version, through the same reader', () => {
    expect(request(['--package-version=1.4.0']).pins).toEqual({
      cli: { kind: 'exact', version: '1.4.0' },
    });
    expect(refusal(['--package-version=1.4.0', '--package-version=1.5.0'])).toBe(
      'cli is pinned twice, and two versions of one component is a contradiction rather than a ' +
        'last-one-wins',
    );
  });

  it('reads every word of the one pin table as install.sh does', () => {
    for (const { word, kind } of PIN_GRAMMAR_CASES.filter((one) => one.word !== '')) {
      const flags = readInstallFlags([`--role=hub@${word}`]);
      if (kind === 'refused') {
        expect(flags, word).toEqual({
          ok: false,
          problem:
            `"${word}" is not a version this can install: a pin is an exact ` +
            '<major>.<minor>.<patch>, naming the release tag hub-v<version>, or a series -- ' +
            '<major>.<minor> or <major> -- which resolves to the newest release published under it',
        });
      } else {
        expect(flags.ok && flags.value.pins.hub?.kind, word).toBe(kind);
      }
    }
  });

  it('refuses an empty pin as the unset variable it usually is', () => {
    expect(refusal(['--role=server@'])).toBe(
      '--role=server@ was given with nothing after it, which is usually an unset variable: name ' +
        'a version, as --role=server@1.4.0, or leave the pin off to take what is current',
    );
    expect(refusal(['--package-version='])).toBe(
      '--package-version= was given with nothing after it, which is usually an unset variable: ' +
        'name a version, as --package-version=1.4.0, or leave the pin off to take what is current',
    );
  });

  it('takes --prefix=, --system, --dry-run and --print-unit', () => {
    expect(
      request(['--prefix=/srv/agentplex', '--system', '--dry-run', '--print-unit']),
    ).toMatchObject({ prefix: '/srv/agentplex', system: true, dryRun: true, printUnit: true });
  });

  it('refuses a prefix validate_prefix refuses, and trims a trailing slash', () => {
    expect(refusal(['--prefix='])).toBe(
      '--prefix was given with nothing after it, which is usually an unset variable: name the ' +
        'directory, or leave the flag off to take the default',
    );
    expect(refusal(['--prefix=srv/agentplex'])).toBe(
      '--prefix must be an absolute path, not "srv/agentplex"',
    );
    expect(refusal(['--prefix=/srv/../etc'])).toBe(
      '--prefix must name a directory outright, and "/srv/../etc" walks through ..',
    );
    expect(refusal(['--prefix=/opt/'])).toBe(
      '--prefix must be at least two directories deep, and "/opt" is not: this is the directory ' +
        'an install fills and --uninstall empties',
    );
    expect(refusal(['--prefix=/'])).toBe(
      '--prefix must be at least two directories deep, and "/" is not: this is the directory an ' +
        'install fills and --uninstall empties',
    );
    expect(request(['--prefix=/srv/agentplex//']).prefix).toBe('/srv/agentplex');
  });

  it('refuses an unknown flag, and a known one spelled as two words', () => {
    expect(refusal(['--rle=hub'])).toBe('unknown option --rle=hub');
    expect(refusal(['--prefix', '/srv/agentplex'])).toBe('unknown option --prefix');
    expect(refusal(['--system=yes'])).toBe('unknown option --system=yes');
  });
});

describe('resolveRole', () => {
  it('maps the named components to the role, the daemons and the install set', () => {
    expect(resolveRole(['hub'])).toEqual({
      role: 'hub',
      daemons: ['hub'],
      components: ['cli', 'hub', 'web'],
    });
    expect(resolveRole(['server'])).toEqual({
      role: 'server',
      daemons: ['server'],
      components: ['cli', 'server'],
    });
    expect(resolveRole(['server', 'hub'])).toEqual({
      role: 'both',
      daemons: ['hub', 'server'],
      components: ['cli', 'hub', 'web', 'server'],
    });
  });
});
