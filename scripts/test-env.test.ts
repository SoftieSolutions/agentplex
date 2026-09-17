import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { TEST_ENVIRONMENT_PINS, pinTestEnvironment } from './test-env.js';

/**
 * The pins, asserted where they have to hold rather than where they are
 * written.
 *
 * Setting a variable and reading it back proves nothing here: the failure this
 * guards against is a pin that is present in `process.env` and absent from the
 * engine. `process.env.TZ = 'UTC'` inside a worker thread is exactly that --
 * the variable reads `UTC` and `new Date().getTimezoneOffset()` goes on
 * answering the machine's offset, because a worker thread shares the process
 * whose timezone was already read. Measured on Node 24.18: under vitest's
 * `threads` pool a setup file that assigns `process.env.TZ` leaves
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` at the machine's zone,
 * and so does vitest's own `test.env` option; under `forks` both work, because
 * a fork is a real process. The pin therefore happens while the config module
 * is evaluated, in the main process, before any worker exists -- and these
 * tests ask the engine rather than the variable so that moving it back
 * somewhere that only looks right fails here.
 *
 * A real child for the locale half, because that half is only ever about the
 * boundary. `LANG` and `LC_ALL` do nothing to this process on macOS; what they
 * decide is the language `git`, `npm` and a coding agent answer a parser in.
 * `node -e` is the one program certain to exist here and in
 * `node:24-bookworm-slim`, and the string is written in this file and
 * assembled from no input.
 */

/** Enough for a child to start and print on a loaded machine. */
const TIMEOUT_MS = 20_000;

function ask(source: string): string {
  const result = spawnSync(process.execPath, ['-e', source], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('pinTestEnvironment', () => {
  it('writes every pin into the environment it is given', () => {
    const env: Record<string, string | undefined> = {};

    pinTestEnvironment(env);

    expect(env).toEqual({ ...TEST_ENVIRONMENT_PINS });
  });

  it('overwrites what the machine already had', () => {
    // The case it exists for: a developer in another timezone, whose shell
    // exports the variable the pin is about.
    const env: Record<string, string | undefined> = {
      TZ: 'America/Asuncion',
      LANG: 'de_DE.UTF-8',
      LC_ALL: 'de_DE.UTF-8',
    };

    pinTestEnvironment(env);

    expect(env).toEqual({ ...TEST_ENVIRONMENT_PINS });
  });

  it('leaves the rest of the environment alone', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' };

    pinTestEnvironment(env);

    expect(env['PATH']).toBe('/usr/bin');
  });
});

describe('the suite environment', () => {
  it('carries every pin', () => {
    for (const [name, value] of Object.entries(TEST_ENVIRONMENT_PINS)) {
      expect(process.env[name], `${name} is not pinned for this run`).toBe(value);
    }
  });

  it('is in UTC as far as the date engine is concerned', () => {
    // The assertion the variable cannot make. An offset read off a `Date` is
    // what every timestamp this codebase formats goes through, and it is what
    // a pin applied too late leaves untouched.
    expect(new Date('2024-01-15T12:00:00Z').getTimezoneOffset()).toBe(0);
    expect(new Date('2024-07-15T12:00:00Z').getTimezoneOffset()).toBe(0);
  });

  it('is in UTC as far as Intl is concerned', () => {
    // The other engine reading the same variable, and the one a formatter
    // built with no explicit `timeZone` resolves through.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
  });

  it('formats a local timestamp as the UTC one', () => {
    // The property stated the way a failing fixture would state it: the
    // calendar fields a formatter reads off a known instant.
    const at = new Date('2024-01-15T23:30:00Z');

    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours()]).toEqual([
      2024, 0, 15, 23,
    ]);
  });

  it('hands every pin to a child', () => {
    // The half that is only true across the boundary, and the half the
    // subprocess parsers rest on.
    const seen: unknown = JSON.parse(
      ask(
        [
          'const names = ["TZ", "LANG", "LC_ALL"];',
          'const out = {};',
          'for (const name of names) out[name] = process.env[name] ?? null;',
          'process.stdout.write(JSON.stringify(out));',
        ].join(''),
      ),
    );

    expect(seen).toEqual({ ...TEST_ENVIRONMENT_PINS });
  });

  it('hands a child a clock in UTC too', () => {
    // A child asked through the engine rather than the variable, for the same
    // reason the home suite asks `os.homedir()`: what a spawned program
    // reports is the thing a parser on this side will read.
    expect(
      ask('process.stdout.write(String(new Date("2024-01-15T12:00:00Z").getTimezoneOffset()))'),
    ).toBe('0');
  });
});
