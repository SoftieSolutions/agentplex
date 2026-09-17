import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { TEST_TIMINGS } from './test-write-guard.js';

/**
 * The one vitest configuration every Node suite in the workspace runs under,
 * named by each package's `test` script rather than copied into each package as
 * a file of its own.
 *
 * It exists for `setupFiles`. `test-home.ts` beside it is the whole point --
 * the argument for it is there -- and a suite that opted in by having its own
 * config copied would be a suite that a future package could forget to copy.
 * There is one path to get wrong instead of nine files to keep in step.
 *
 * `root` is the working directory and not this file's: vitest resolves a
 * project's root from its config by default, so without this every package
 * would collect the whole workspace's tests through `scripts/`.
 *
 * `apps/web` is the one member that does not use it. That package owns a
 * `vite.config.ts` carrying the React plugin its component suites are
 * transformed by, and it is a browser bundle that starts no child process --
 * nothing there has a home to leak.
 */
const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The reporters, which are the default one unless `test-write-guard.ts` is
 * running this suite.
 *
 * The guard compares two walks of the filesystem and can say when a path
 * outside the sandbox appeared; what it cannot say on its own is which test
 * wrote it, and "something wrote to /root" costs more to diagnose than the leak
 * it caught. A JSON report carries a start and an end per test file, which
 * turns that timestamp into a list of the files that were running.
 *
 * One file per workspace member, named after the member, because `pnpm test` is
 * `pnpm -r test`: every member runs this config with its own `root`, and a
 * fixed name would be nine members overwriting one report.
 *
 * Off unless the variable is set, so a native `pnpm test` writes nothing it did
 * not write before.
 */
function reporters(): ViteUserConfig['test'] {
  const directory = process.env[TEST_TIMINGS];
  if (directory === undefined) return {};

  const member = relative(workspaceRoot, process.cwd()).replaceAll('/', '-') || 'workspace';
  return { reporters: ['default', ['json', { outputFile: join(directory, `${member}.json`) }]] };
}

export default defineConfig({
  test: {
    root: process.cwd(),
    // The parent of the throwaway homes, made and removed in the main process
    // so that a file whose tests are all skipped still gives its own back.
    globalSetup: [fileURLToPath(new URL('test-home-root.ts', import.meta.url))],
    setupFiles: [fileURLToPath(new URL('test-home.ts', import.meta.url))],
    ...reporters(),
  },
});
