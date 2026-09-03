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

  it('puts the configured directories in front of the inherited PATH, not after it', () => {
    // Prepended rather than appended: the recorded directories are the ones
    // setup probed, so they are the ones that decide, and systemd's minimal
    // PATH stops being what resolves a provider.
    const inheritedPath = ['/usr/local/sbin', '/usr/sbin'].join(delimiter);
    const environment = childEnvironment({
      inherited: { PATH: inheritedPath },
      binPath: ['/opt/bin'],
    });

    expect(environment['PATH']).toBe(['/opt/bin', inheritedPath].join(delimiter));
  });

  it('keeps the inherited PATH reachable, which is where the machine tools are', () => {
    // The regression this guards: `git.status` spawns `git` and
    // `process.start-time` spawns `ps`, both resolved from this PATH, and a
    // coding agent shells out to whatever the operator's project needs. None
    // of those live in a provider directory, and a PATH holding only the
    // recorded ones would take every one of them away.
    const environment = childEnvironment({
      inherited: { PATH: '/usr/bin' },
      binPath: ['/opt/bin'],
    });

    expect(environment['PATH']?.split(delimiter)).toContain('/usr/bin');
  });

  it('leaves no empty entry behind, because an empty entry means the working directory', () => {
    // A machine with no PATH at all, and one with a trailing delimiter: both
    // would otherwise end as a list with an empty segment in it, which is how
    // a child silently gets its own cwd on the search path.
    expect(childEnvironment({ inherited: {}, binPath: ['/opt/bin'] })['PATH']).toBe('/opt/bin');
    expect(
      childEnvironment({ inherited: { PATH: `/usr/bin${delimiter}` }, binPath: ['/opt/bin'] })[
        'PATH'
      ],
    ).toBe(['/opt/bin', '/usr/bin'].join(delimiter));
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
      inherited: { Path: '/inherited/bin', HOME: '/home/a' },
      binPath: ['/opt/bin'],
    });

    const names = Object.keys(environment).filter((name) => name.toUpperCase() === 'PATH');
    expect(names).toEqual(['PATH']);
    // Carried over rather than dropped: whatever it was spelled like, it was
    // the PATH this machine had, and the tools on it still have to resolve.
    expect(environment['PATH']).toBe(['/opt/bin', '/inherited/bin'].join(delimiter));
  });
});
