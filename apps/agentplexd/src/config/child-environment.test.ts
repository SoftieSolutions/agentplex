import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnvironment } from './child-environment.js';

describe('childEnvironment', () => {
  it('hands back what was inherited when no directories were configured', () => {
    const inherited = { PATH: '/usr/bin', HOME: '/home/a' };

    // Identity, not a copy that happens to match: an operator who has set
    // nothing gets the behaviour they had before this setting existed, and
    // there is no third state where the PATH was rebuilt from itself.
    expect(childEnvironment({ inherited, binPath: [] })).toBe(inherited);
  });

  it('builds the PATH out of the configured directories, in order', () => {
    const environment = childEnvironment({
      inherited: {},
      binPath: ['/opt/homebrew/bin', '/home/a/.local/bin'],
    });

    expect(environment['PATH']).toBe(['/opt/homebrew/bin', '/home/a/.local/bin'].join(delimiter));
  });

  it('replaces the inherited PATH rather than extending it', () => {
    // The point of the setting: systemd's minimal PATH stops deciding which
    // binary resolves, so a directory the operator did not record cannot
    // supply one.
    const environment = childEnvironment({
      inherited: { PATH: '/usr/local/sbin:/usr/sbin' },
      binPath: ['/opt/bin'],
    });

    expect(environment['PATH']).toBe('/opt/bin');
  });

  it('leaves every other inherited variable alone', () => {
    // Only resolution is being decided here. HOME is how a provider finds the
    // credentials the operator logged in with, and taking it away would turn a
    // PATH fix into an authentication failure.
    const environment = childEnvironment({
      inherited: { HOME: '/home/a', LANG: 'C.UTF-8', PATH: '/usr/bin' },
      binPath: ['/opt/bin'],
    });

    expect(environment['HOME']).toBe('/home/a');
    expect(environment['LANG']).toBe('C.UTF-8');
  });

  it('does not leave a differently-cased PATH beside the one it set', () => {
    // `process.env` is case-insensitive on Windows and a plain record is not,
    // so copying one into the other is where a second, stale PATH would
    // appear — and which of the two wins is the platform's decision, not ours.
    const environment = childEnvironment({
      inherited: { Path: 'C:\\stale', HOME: '/home/a' },
      binPath: ['/opt/bin'],
    });

    const names = Object.keys(environment).filter((name) => name.toUpperCase() === 'PATH');
    expect(names).toEqual(['PATH']);
    expect(environment['PATH']).toBe('/opt/bin');
  });
});
