import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The suite's own isolation, asserted rather than assumed.
 *
 * This is worth more than the setup file it checks. A redirected `$HOME` is
 * invisible when it works: nothing fails, no output mentions it, and the day
 * someone drops the shared config from a package's `test` script the suite goes
 * on passing while quietly reading the machine it runs on again. That is the
 * failure this file is here to make loud.
 *
 * The operator's real home is read from the passwd entry, not from the
 * environment, because the environment is the thing under test. `userInfo()`
 * answers what the running user's home actually is whatever `$HOME` says, which
 * is exactly the value a leak would expose and exactly the value `os.homedir()`
 * falls back to when `$HOME` is missing.
 *
 * A real child, because the claim is about the process boundary and nothing in
 * process settles it. `node -e` is the one program certain to exist here and in
 * `node:24-bookworm-slim`; the string is written in this file and assembled
 * from no input.
 */

/** What the running user's home is, whatever the environment has been set to. */
const operatorHome = userInfo().homedir;

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

describe('the suite home', () => {
  it('is not the operator home', () => {
    // The premise of everything below. If these were equal the assertions in
    // the other tests would all hold trivially and prove nothing.
    expect(process.env['HOME']).toBeDefined();
    expect(process.env['HOME']).not.toBe(operatorHome);
    expect(existsSync(process.env['HOME'] ?? '')).toBe(true);
  });

  it('is what this process resolves its own home to', () => {
    // `os.homedir()` prefers `$HOME` when it is set, so redirecting the
    // variable redirects the function -- in this process and in any child that
    // inherits it. This is the half of the mechanism that would still be true
    // if nobody spawned anything.
    expect(homedir()).toBe(process.env['HOME']);
    expect(homedir()).not.toBe(operatorHome);
  });

  it('is what a spawned child sees, never the operator home', () => {
    // A child inheriting `process.env`, which is what every spawn that passes
    // no `env` gets, and what the three suites building an env out of
    // `process.env` get too.
    const seen = ask('process.stdout.write(process.env.HOME ?? "unset")');

    expect(seen).toBe(process.env['HOME']);
    expect(seen).not.toBe(operatorHome);
  });

  it('is what a spawned child resolves its home to, never the operator home', () => {
    // The one a reviewer cannot see at a call site. A child asked for its home
    // through the function rather than the variable would answer with the
    // passwd entry if `$HOME` were absent, so this is the assertion that says
    // the redirect survives the boundary rather than merely crossing it.
    const resolved = ask('process.stdout.write(require("node:os").homedir())');

    expect(resolved).toBe(process.env['HOME']);
    expect(resolved).not.toBe(operatorHome);
  });

  it('is where a child that writes to ~ writes', () => {
    // The claim the installer and wizard suites rest on, made directly: a
    // program that expands `~` lands inside the throwaway directory. Asserted
    // through the child's own resolution so that nothing here has to agree with
    // the setup file about a path.
    const written = ask(
      [
        'const { join } = require("node:path");',
        'const { homedir } = require("node:os");',
        'const { writeFileSync } = require("node:fs");',
        'const file = join(homedir(), ".agentplex-probe");',
        'writeFileSync(file, "probe");',
        'process.stdout.write(file);',
      ].join(''),
    );

    expect(written.startsWith(`${process.env['HOME'] ?? ''}/`)).toBe(true);
    expect(written.startsWith(`${operatorHome}/`)).toBe(false);
    expect(existsSync(written)).toBe(true);
  });

  it('keeps the cache a child would write out of the operator home', () => {
    // `versions-cache.ts` reads `$XDG_CACHE_HOME` before it falls back to
    // `$HOME/.cache`, so the home redirect alone would not cover an operator
    // who exports one.
    const cache = ask('process.stdout.write(process.env.XDG_CACHE_HOME ?? "unset")');

    expect(cache.startsWith(`${process.env['HOME'] ?? ''}/`)).toBe(true);
    expect(cache.startsWith(`${operatorHome}/`)).toBe(false);
  });
});

/**
 * The behavioural test above runs in this package, and this package would find
 * the shared config next to it whether or not its `test` script named one --
 * vitest discovers a `vitest.config.ts` in the directory it is started from. So
 * that test alone guards `scripts/` and nothing else, and the failure this
 * ticket is about is precisely a suite that looks isolated because another one
 * is: a package whose `test` script quietly lost the flag would go on passing
 * while reading the machine it runs on again.
 *
 * This is the half that covers the other members. It is a fact about the
 * manifests rather than about a process, so it is checked by reading them.
 */
describe('the shared vitest config', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const SHARED_CONFIG = fileURLToPath(new URL('vitest.config.ts', import.meta.url));

  /**
   * `apps/web` is excepted by name, not by pattern. It owns a `vite.config.ts`
   * carrying the React plugin its component suites are transformed by, so the
   * shared config would take that away; and it is a browser bundle that starts
   * no child process, so it has no home to leak. An exception that had to be
   * spelled here is one somebody has to argue for.
   */
  const BROWSER_SUITE = 'apps/web';

  function members(): readonly string[] {
    const found: string[] = [];
    for (const group of ['apps', 'packages', 'tests']) {
      for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(root, group, entry.name, 'package.json'))) {
          found.push(`${group}/${entry.name}`);
        }
      }
    }
    return [...found, 'scripts'].sort();
  }

  it.each(members().filter((member) => member !== BROWSER_SUITE))(
    '%s runs its tests under it',
    (member) => {
      const manifest: { scripts?: Record<string, string> } = JSON.parse(
        readFileSync(join(root, member, 'package.json'), 'utf8'),
      );

      // Both scripts, because `test:coverage` is a second way to run the suite
      // and an isolation that only one of them had would be no isolation.
      for (const name of ['test', 'test:coverage']) {
        const script = manifest.scripts?.[name];
        expect(script, `${member} has no ${name} script`).toBeDefined();

        // The path is resolved against the member rather than matched as a
        // string: `scripts` names the same file as `./vitest.config.ts` and
        // every other member as `../../scripts/vitest.config.ts`. What has to
        // be true is which file vitest loads, not how it was spelled.
        const named = /--config\s+(\S+)/.exec(script ?? '')?.[1];
        expect(named, `${member} ${name} names no config`).toBeDefined();
        expect(
          resolve(join(root, member), named ?? ''),
          `${member} ${name} does not run under the shared config`,
        ).toBe(SHARED_CONFIG);
      }
    },
  );

  it('is not claimed by the browser suite, which has its own', () => {
    // The exception, asserted rather than left as an absence -- so that a
    // future member is a failing test here and a decision, rather than a
    // package that silently joined the list of the unisolated.
    const manifest: { scripts?: Record<string, string> } = JSON.parse(
      readFileSync(join(root, BROWSER_SUITE, 'package.json'), 'utf8'),
    );

    expect(manifest.scripts?.['test']).not.toContain('scripts/vitest.config.ts');
    expect(existsSync(join(root, BROWSER_SUITE, 'vite.config.ts'))).toBe(true);
  });
});
