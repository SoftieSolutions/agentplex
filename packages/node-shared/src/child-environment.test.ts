import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnvironment, childSearchPath } from './child-environment.js';

describe('childEnvironment', () => {
  it('hands back what was inherited when no directories were configured', () => {
    const inherited = { PATH: '/usr/bin', HOME: '/home/a' };

    // Equal, and no longer identical: the scrub of agentplex's own variables
    // means the result is always a copy. What still holds is that an operator
    // who has set nothing gets every variable they had, value for value, and
    // there is no third state where the PATH was rebuilt from itself.
    expect(childEnvironment({ inherited, binPath: [], timezone: undefined })).toEqual(inherited);
  });

  it('builds the PATH out of the configured directories, in order', () => {
    const environment = childEnvironment({
      inherited: {},
      binPath: ['/opt/homebrew/bin', '/home/a/.local/bin'],
      timezone: undefined,
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
      timezone: undefined,
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
      timezone: undefined,
    });

    expect(environment['PATH']?.split(delimiter)).toContain('/usr/bin');
  });

  it('leaves no empty entry behind, because an empty entry means the working directory', () => {
    // A machine with no PATH at all, and one with a trailing delimiter: both
    // would otherwise end as a list with an empty segment in it, which is how
    // a child silently gets its own cwd on the search path.
    expect(
      childEnvironment({ inherited: {}, binPath: ['/opt/bin'], timezone: undefined })['PATH'],
    ).toBe('/opt/bin');
    expect(
      childEnvironment({
        inherited: { PATH: `/usr/bin${delimiter}` },
        binPath: ['/opt/bin'],
        timezone: undefined,
      })['PATH'],
    ).toBe(['/opt/bin', '/usr/bin'].join(delimiter));
  });

  it('leaves every other inherited variable alone', () => {
    // Only resolution is being decided here. HOME is how a provider finds the
    // credentials the operator logged in with, and taking it away would turn a
    // PATH fix into an authentication failure. LANG is in this list on
    // purpose: it is the variable a timezone setting invites somebody to
    // compose next, and the module comment says why it is inherited instead.
    const environment = childEnvironment({
      inherited: { HOME: '/home/a', LANG: 'C.UTF-8', PATH: '/usr/bin' },
      binPath: ['/opt/bin'],
      timezone: undefined,
    });

    expect(environment['HOME']).toBe('/home/a');
    expect(environment['LANG']).toBe('C.UTF-8');
  });

  it('sets TZ, which is the whole of what the timezone setting means', () => {
    // The failure this closes: a unit file on a container image says nothing
    // about a zone, the server inherits UTC, and every agent it spawns answers
    // the question "what day is it" from UTC.
    const environment = childEnvironment({
      inherited: { PATH: '/usr/bin' },
      binPath: [],
      timezone: 'Europe/Madrid',
    });

    expect(environment['TZ']).toBe('Europe/Madrid');
  });

  it('leaves the PATH it was not asked about alone while setting TZ', () => {
    // The two halves are separable and stay separable: a deployment that chose
    // a zone and no directories gets the PATH it had, character for character,
    // rather than one rebuilt out of itself.
    const inheritedPath = `/usr/bin${delimiter}${delimiter}/bin`;
    const environment = childEnvironment({
      inherited: { PATH: inheritedPath, HOME: '/home/a' },
      binPath: [],
      timezone: 'Europe/Madrid',
    });

    expect(environment['PATH']).toBe(inheritedPath);
    expect(environment['HOME']).toBe('/home/a');
  });

  it('composes both, because a child gets one environment and not two', () => {
    const environment = childEnvironment({
      inherited: { PATH: '/usr/bin' },
      binPath: ['/opt/bin'],
      timezone: 'Asia/Tokyo',
    });

    expect(environment['PATH']).toBe(['/opt/bin', '/usr/bin'].join(delimiter));
    expect(environment['TZ']).toBe('Asia/Tokyo');
  });

  it('passes an inherited TZ through untouched when nothing was configured', () => {
    // Unset means inherit, exactly as an empty binPath does: a deployment that
    // says nothing about a zone gets whatever the unit was started with, which
    // is what every already-installed machine has today.
    const inherited = { TZ: 'America/Asuncion', PATH: '/usr/bin' };

    expect(childEnvironment({ inherited, binPath: [], timezone: undefined })).toEqual(inherited);
  });

  it('replaces an inherited TZ rather than letting the unit file win', () => {
    const environment = childEnvironment({
      inherited: { TZ: 'UTC', PATH: '/usr/bin' },
      binPath: [],
      timezone: 'Europe/Madrid',
    });

    expect(environment['TZ']).toBe('Europe/Madrid');
  });

  it('does not leave a differently-cased TZ beside the one it set', () => {
    // The hazard PATH has, for the reason PATH has it: `process.env` is
    // case-insensitive on Windows and a plain record is not, so a copied `Tz`
    // would survive beside the `TZ` set here, and which of them a child reads
    // would be the platform's decision rather than this function's.
    const environment = childEnvironment({
      inherited: { Tz: 'UTC', HOME: '/home/a' },
      binPath: [],
      timezone: 'Europe/Madrid',
    });

    expect(Object.keys(environment).filter((name) => name.toUpperCase() === 'TZ')).toEqual(['TZ']);
    expect(environment['TZ']).toBe('Europe/Madrid');
    expect(environment['HOME']).toBe('/home/a');
  });

  it('does not leave a differently-cased PATH beside the one it set', () => {
    // `process.env` is case-insensitive on Windows and a plain record is not,
    // so copying one into the other is where a second, stale PATH would
    // appear — and which of the two wins is the platform's decision, not ours.
    const environment = childEnvironment({
      inherited: { Path: '/inherited/bin', HOME: '/home/a' },
      binPath: ['/opt/bin'],
      timezone: undefined,
    });

    const names = Object.keys(environment).filter((name) => name.toUpperCase() === 'PATH');
    expect(names).toEqual(['PATH']);
    // Carried over rather than dropped: whatever it was spelled like, it was
    // the PATH this machine had, and the tools on it still have to resolve.
    expect(environment['PATH']).toBe(['/opt/bin', '/inherited/bin'].join(delimiter));
  });

  // The server's own secrets and settings live in its environment, and every
  // child of it -- a coding agent, a hook, `git` -- would otherwise read them.
  const agentplexInherited = {
    AGENTPLEX_SERVER_TOKEN: 'secret',
    AGENTPLEX_DATA_PATH: '/var/lib/agentplex',
    AGENTPLEX_ROLE: 'server',
    PATH: '/usr/bin',
    HOME: '/home/a',
  };

  function agentplexNames(environment: Readonly<Record<string, string | undefined>>): string[] {
    return Object.keys(environment).filter((name) => name.toUpperCase().startsWith('AGENTPLEX_'));
  }

  it('keeps agentplex variables out of a child when nothing was configured', () => {
    // The case that used to hand `inherited` back untouched, and so the one
    // that leaked the token to every child of an unconfigured machine.
    const environment = childEnvironment({
      inherited: agentplexInherited,
      binPath: [],
      timezone: undefined,
    });

    expect(agentplexNames(environment)).toEqual([]);
    expect(environment['PATH']).toBe('/usr/bin');
    expect(environment['HOME']).toBe('/home/a');
  });

  it('keeps agentplex variables out of a child when both settings are configured', () => {
    const environment = childEnvironment({
      inherited: agentplexInherited,
      binPath: ['/opt/bin'],
      timezone: 'Europe/Madrid',
    });

    expect(agentplexNames(environment)).toEqual([]);
    expect(environment['PATH']).toBe(['/opt/bin', '/usr/bin'].join(delimiter));
    expect(environment['HOME']).toBe('/home/a');
    expect(environment['TZ']).toBe('Europe/Madrid');
  });

  it('drops a differently-cased agentplex variable too', () => {
    // Case-insensitive for the reason PATH and TZ are: on Windows
    // `agentplex_server_token` is the same variable as the upper-case one.
    const environment = childEnvironment({
      inherited: { agentplex_server_token: 'secret', HOME: '/home/a' },
      binPath: [],
      timezone: undefined,
    });

    expect(agentplexNames(environment)).toEqual([]);
    expect(environment['HOME']).toBe('/home/a');
  });
});

describe('childSearchPath', () => {
  it('reads back the directories a child of this environment would search', () => {
    const environment = childEnvironment({
      inherited: { PATH: ['/usr/bin', '/bin'].join(delimiter) },
      binPath: ['/home/a/.agentplex/bin'],
      timezone: undefined,
    });

    // The configured directory first, then the machine's own: the preflight
    // has to report where a program will actually be found, not where it was
    // configured to be looked for.
    expect(childSearchPath(environment)).toEqual(['/home/a/.agentplex/bin', '/usr/bin', '/bin']);
  });

  it('drops the empty segment that would otherwise mean the working directory', () => {
    expect(childSearchPath({ PATH: `/usr/bin${delimiter}${delimiter}/bin` })).toEqual([
      '/usr/bin',
      '/bin',
    ]);
  });

  it('reads the same PATH back from an environment the scrub has passed through', () => {
    // The scrub removes agentplex's own variables and nothing the search path
    // is made of.
    const environment = childEnvironment({
      inherited: { AGENTPLEX_SERVER_TOKEN: 'secret', PATH: ['/usr/bin', '/bin'].join(delimiter) },
      binPath: [],
      timezone: undefined,
    });

    expect(childSearchPath(environment)).toEqual(['/usr/bin', '/bin']);
  });

  it('searches nothing when there is no PATH at all', () => {
    expect(childSearchPath({})).toEqual([]);
  });
});
