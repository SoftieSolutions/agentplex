import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
export default defineConfig({
  test: {
    root: process.cwd(),
    // The parent of the throwaway homes, made and removed in the main process
    // so that a file whose tests are all skipped still gives its own back.
    globalSetup: [fileURLToPath(new URL('test-home-root.ts', import.meta.url))],
    setupFiles: [fileURLToPath(new URL('test-home.ts', import.meta.url))],
  },
});
