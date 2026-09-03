import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * A real program, under a name nothing else on the machine answers to, in a
 * directory nothing else searches.
 *
 * It exists so that a test can prove where a spawn resolved its program from.
 * Asserting on `node` would prove nothing: `node` is on the PATH the test
 * runner inherited, so a child that found it may have found it anywhere. A
 * name no PATH entry holds can only have come from the directory the test
 * configured, and its absence is equally decisive — with that directory taken
 * away, nothing resolves rather than something else quietly does.
 *
 * The program is a symlink to the node binary running the suite, so the child
 * is real node and can be asked with `-e` to print what it was handed, and so
 * the executable bit comes from a binary that already has one. That makes this
 * POSIX-only, which is what the rest of the spawn tests already are: they turn
 * on `spawn-helper` and on a pty.
 */

/** Bare, and shaped like every other program name the operation registry allows. */
const PROBE_NAME = 'agentplex-probe';

export interface ProbeProgram {
  /** Absolute, and suitable as a `binPath` entry. */
  readonly directory: string;
  /** The bare name to spawn. Never a path: that is the point of it. */
  readonly name: string;
  remove(): void;
}

export function createProbeProgram(): ProbeProgram {
  const directory = mkdtempSync(join(tmpdir(), 'agentplex-bin-'));
  symlinkSync(process.execPath, join(directory, PROBE_NAME));

  return {
    directory,
    name: PROBE_NAME,
    remove(): void {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
