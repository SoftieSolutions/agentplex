import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/** The variable `test-home.ts` reads to find the directory it may build in. */
export const TEST_HOME_ROOT = 'AGENTPLEX_TEST_HOME_ROOT';

/**
 * One directory per suite run, holding the throwaway homes `test-home.ts` hands
 * out, and removed when the run ends.
 *
 * This exists because the per-file cleanup cannot be complete on its own. A
 * setup file runs for every test file vitest loads, including one whose tests
 * are all skipped -- `capture-terminal-fixtures.test.ts` and
 * `capture-client-fixtures.test.ts` are both gated on `$CAPTURE_FIXTURES` -- and
 * such a file has no suite for `afterAll` to hang on, so it takes a home and
 * never gives it back. A `process.once('exit')` backstop does not catch it
 * either: the worker does not exit the way a plain Node process does. The
 * result was two directories left in `$TMPDIR` on every full run.
 *
 * A global setup is the level that can answer it, because it runs in the main
 * process and its teardown is called whatever the workers did. It owns the
 * parent; `test-home.ts` owns what it puts inside.
 *
 * Per run rather than a shared fixed name: `pnpm test` is `pnpm -r test`, which
 * runs the members in parallel, so a sweep of everything matching a pattern
 * would be one package deleting another's live homes mid-test.
 */
export default function setupTestHomeRoot(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'agentplex-test-homes-'));
  process.env[TEST_HOME_ROOT] = root;

  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
