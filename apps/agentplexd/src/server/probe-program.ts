import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Real programs, under names nothing else on the machine answers to, in
 * directories nothing else searches.
 *
 * They exist so that a test can prove where a spawn resolved its program from.
 * Asserting on `node` would prove nothing: `node` is on the PATH the test
 * runner inherited, so a child that found it may have found it anywhere. A
 * name no PATH entry holds can only have come from the directory the test
 * configured, and its absence is equally decisive — with that directory taken
 * away, nothing resolves rather than something else quietly does.
 *
 * They are made rather than borrowed for a second reason. The programs a real
 * operation spawns are `git` and `ps`, and `node:24-bookworm-slim` — the image
 * the suite runs in — ships neither, so a test built on them would pass on a
 * developer's mac and fail in the image agentplexd deploys as.
 *
 * Both shapes run under the node binary running the suite, so the executable
 * bit comes from a binary that already has one, or from a mode this file sets.
 * That makes them POSIX-only, which is what the rest of the spawn tests
 * already are: they turn on `spawn-helper` and on a pty.
 */

/** Bare, and shaped like every other program name the operation registry allows. */
const DEFAULT_PROBE_NAME = 'agentplex-probe';

/** Readable and executable by everyone, writable by the owner: a program. */
const EXECUTABLE = 0o755;

export interface ProbeProgram {
  /** Absolute, and suitable as a `binPath` entry or as a PATH to inherit. */
  readonly directory: string;
  /** The bare name to spawn. Never a path: that is the point of it. */
  readonly name: string;
  remove(): void;
}

/**
 * A program that is the node binary itself, so a caller can hand it `-e` and
 * have the child report what it was given.
 *
 * The name is a parameter because more than one of these is how a test asks
 * which directory a program came from: two directories, two names, and the one
 * that runs says which of them was reachable.
 */
export function createProbeProgram(name: string = DEFAULT_PROBE_NAME): ProbeProgram {
  const directory = mkdtempSync(join(tmpdir(), 'agentplex-bin-'));
  symlinkSync(process.execPath, join(directory, name));
  return { directory, name, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

/**
 * A program that prints one word and exits, for the question a symlink cannot
 * answer: which of two directories holding the same program name won.
 *
 * Node resolves `argv[0]` and `execPath` through a symlink to the real binary,
 * so two symlinks to the same node are indistinguishable from inside the
 * child — run at the origin, not assumed. A script carrying its own marker is
 * distinguishable, and its shebang names the interpreter absolutely so that it
 * does not need a PATH of its own to start.
 */
export function createMarkerProgram(name: string, marker: string): ProbeProgram {
  const directory = mkdtempSync(join(tmpdir(), 'agentplex-bin-'));
  const file = join(directory, name);
  writeFileSync(
    file,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(marker)});\n`,
    'utf8',
  );
  chmodSync(file, EXECUTABLE);
  return { directory, name, remove: () => rmSync(directory, { recursive: true, force: true }) };
}
