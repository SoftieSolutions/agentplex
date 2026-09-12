import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll } from 'vitest';
import { TEST_HOME_ROOT } from './test-home-root.js';

/**
 * Every suite runs with `$HOME` pointing at a throwaway directory, so that a
 * test cannot read or write the operator's real one.
 *
 * The injected seams already keep the unit suites honest: a fake machine is
 * handed `/home/dev` as a literal and nothing goes near a disk. The seams stop
 * at the process boundary, though, and that is what this is for. A child gets
 * an environment, not an injected filesystem, so a test that spawns the real
 * bin is testing against whatever `$HOME` the runner happened to have -- the
 * developer's, holding their real `~/.claude` login and their real
 * `~/.agentplex` database. The installer suite writes a prefix; the setup
 * wizard surveys provider state and can drive a real login. Neither should be
 * able to reach the machine it is running on.
 *
 * It is set here rather than at each spawn because the property has to hold for
 * a test written tomorrow by someone who never read this file. There are three
 * ways a child ends up with the operator's home -- inheriting `process.env`
 * wholesale, being handed an environment built from it, or being handed one
 * with no `HOME` in it at all -- and only the first two are visible at the call
 * site. The third is the one that bites silently: `os.homedir()` does not read
 * `$HOME` and give up when it is missing, it falls back to the passwd entry,
 * which is the operator's real home whatever the environment says. So an
 * explicit `env: { PATH }` that reads as sealed is not sealed, and a rule that
 * depended on someone spotting that at review time would be a rule that fails
 * quietly. Redirecting the variable the whole suite inherits makes the default
 * safe and leaves a call site free to seal further when that is what it is
 * about.
 *
 * `$XDG_CACHE_HOME` travels with it. `versions-cache.ts` reads that variable
 * first and only falls back to `$HOME/.cache`, so a home redirected on its own
 * would still let an operator who exports one have the update check write into
 * their real cache.
 *
 * A fresh directory per test file, because vitest runs a setup file once per
 * file: suites running in parallel cannot see each other's, and a test that
 * leaves something behind cannot change what the next one finds.
 */
const home = mkdtempSync(join(process.env[TEST_HOME_ROOT] ?? tmpdir(), 'home-'));

process.env['HOME'] = home;
process.env['XDG_CACHE_HOME'] = join(home, '.cache');

/**
 * Removed here for promptness and by the run's teardown for completeness.
 *
 * `afterAll` is what keeps a long run from holding every home it ever made. It
 * does not run for a file whose tests are all skipped, though -- there is no
 * suite for vitest to hang it on -- so it cannot be the only cleanup. The
 * parent directory is removed wholesale by `test-home-root.ts`, which is why
 * this one is allowed to be best-effort.
 */
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
