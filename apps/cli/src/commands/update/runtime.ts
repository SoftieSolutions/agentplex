import { join } from 'node:path';
import { runOperation, type Operation, type ProcessRunner } from '@agentplex/providers';
import { z } from 'zod';
import type { Installation } from '../../installation/installation.js';
import { NODE_DIRECTORY, NODE_STAMP, type Layout } from '../../installation/layout.js';
import type { ManifestReader } from '../../versions/version-check.js';
import type { FileOutcome, UpdateMachine } from './update-machine.js';

/**
 * The runtime, and why it moves before the packages do.
 *
 * node-pty compiles from source on every Linux install, and a native addon has
 * to be built against the runtime that will load it. `install.sh` carries a
 * captured note about exactly this: a v20 shim ahead of PATH had npm's shebang
 * find the shim, compile against it, print a version and exit 0, and the
 * install reported success with nothing that worked. So the interpreter the
 * units name is replaced first, and npm is then run through it -- an update
 * that did it the other way round would compile the addon against the runtime
 * it is about to delete.
 *
 * The swap itself is safe while this very process is running on the runtime
 * being replaced, and that is worth stating because it looks like it should not
 * be: deleting the binary of a running process leaves the process alive on the
 * old inode. `install.sh` already does exactly this on every re-run, and this
 * command is started from the prefix's own `bin/agentplex`, whose shebang
 * resolved the interpreter before any of this ran.
 *
 * ## What this will not touch
 *
 * A runtime nobody stamped. `install.sh` writes `<prefix>/node/<stamp>` only
 * when it unpacked a runtime itself, so its absence means the install adopted a
 * Node the machine already had -- somebody's system package, somebody's version
 * manager. Replacing that would be this command taking ownership of a directory
 * it does not own, and `uninstall_node` bets on the same record when it refuses
 * to remove one.
 */

/** The Node major this project declares in `engines` and installs. */
export const NODE_MAJOR = '24';

/**
 * Where the current release of that major is named.
 *
 * The same URL `install.sh` carries as `NODE_DIST_URL`, and the checksum file
 * under it is what makes one fetch answer all three questions: which version is
 * current, whether it is the one already here, and what the archive should hash
 * to.
 */
export const NODE_DIST_URL = `https://nodejs.org/dist/latest-v${NODE_MAJOR}.x`;

/**
 * `.tar.gz` and not `.tar.xz`, on purpose: a stock `debian:bookworm-slim` has
 * `tar` and no `xz`, and a command that needs a package installed before it can
 * install anything has a second prerequisite nobody documented.
 */
const ARCHIVE_SUFFIX = '.tar.gz';

/** Platforms this can name a Node tarball for. The installer's `detect_platform`. */
export type RuntimePlatform = 'linux' | 'darwin';
export type RuntimeArchitecture = 'x64' | 'arm64';

/** Unpacking a runtime is the one thing here that is slow, and it is not that slow. */
const EXTRACT_TIMEOUT_MS = 120_000;

/**
 * What should happen to the runtime, decided before anything is stopped.
 *
 * Five answers and not a boolean, because each one leads somewhere different:
 * a machine with an adopted runtime is not asked for consent, a machine whose
 * runtime is current is not asked either, and a machine that could not reach
 * nodejs.org is told the question went unanswered rather than that the answer
 * was no.
 */
export type RuntimeDecision =
  /** Not this install's to replace. See the note above. */
  | { readonly kind: 'adopted' }
  /** The stamp names what the release names. */
  | { readonly kind: 'current'; readonly version: string }
  /** A newer release exists, and here is everything needed to install it. */
  | {
      readonly kind: 'stale';
      readonly installed: string;
      readonly available: string;
      readonly url: string;
      readonly checksum: string;
    }
  /**
   * The question could not be asked. Never folded into `current`: "whether a
   * newer one exists is unknown" is what `install.sh` says when it cannot reach
   * nodejs.org, and reporting it as up to date is the one degrade that
   * over-claims.
   */
  | { readonly kind: 'unknown'; readonly installed: string; readonly problem: string };

export interface RuntimeCheckDependencies {
  readonly reader: ManifestReader;
  readonly platform: RuntimePlatform;
  readonly architecture: RuntimeArchitecture;
}

/**
 * Which release the dist URL names, and whether it is the one this prefix has.
 *
 * One fetch of a small text file. The checksum file names every archive of that
 * release, so the line for this platform carries the version in its file name
 * and the hash in its first field, and nothing else has to be asked.
 */
export async function checkRuntime(
  installation: Installation,
  { reader, platform, architecture }: RuntimeCheckDependencies,
): Promise<RuntimeDecision> {
  if (installation.runtime.kind === 'adopted') return { kind: 'adopted' };
  const installed = installation.runtime.version;

  const read = await reader.read({ kind: 'url', url: `${NODE_DIST_URL}/SHASUMS256.txt` });
  if (read.kind === 'failed') {
    return { kind: 'unknown', installed, problem: read.problem };
  }

  const found = findArchive(read.text, platform, architecture);
  if (found === null) {
    return {
      kind: 'unknown',
      installed,
      problem: `nothing at ${NODE_DIST_URL} builds for ${platform}-${architecture}`,
    };
  }

  return found.version === installed
    ? { kind: 'current', version: installed }
    : {
        kind: 'stale',
        installed,
        available: found.version,
        url: `${NODE_DIST_URL}/${found.file}`,
        checksum: found.checksum,
      };
}

/**
 * One line of `SHASUMS256.txt`: `<sha256>  <file>`.
 *
 * Parsed rather than read. It is a file off the network whose hash is about to
 * be trusted to decide whether a downloaded archive is the one that was asked
 * for, so a line that is not two fields, or a first field that is not 64 hex
 * characters, is not a checksum and is skipped rather than compared against.
 */
function findArchive(
  sums: string,
  platform: RuntimePlatform,
  architecture: RuntimeArchitecture,
): { readonly file: string; readonly version: string; readonly checksum: string } | null {
  const suffix = `-${platform}-${architecture}${ARCHIVE_SUFFIX}`;
  for (const line of sums.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const checksum = fields[0] ?? '';
    const file = fields[1] ?? '';
    if (!/^[0-9a-f]{64}$/.test(checksum) || !file.endsWith(suffix)) continue;

    // `node-v24.9.0-linux-x64.tar.gz` -> `v24.9.0`, which is the string `node
    // --version` prints and the string install.sh stamps, so the two compare
    // without either being reshaped.
    const version = file.slice('node-'.length, file.length - suffix.length);
    if (!/^v\d+\.\d+\.\d+$/.test(version)) continue;
    return { file, version, checksum };
  }
  return null;
}

/** Everything the swap needs that is not a decision. */
export interface RuntimeSwapDependencies {
  readonly machine: UpdateMachine;
  readonly downloader: Downloader;
  readonly runner: ProcessRunner;
}

/** The half of the network seam that writes a file rather than returning text. */
export interface Downloader {
  download(url: string, path: string): Promise<FileOutcome>;
}

export type RuntimeSwap =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly lines: readonly string[] };

/**
 * Replace the runtime in the prefix, in the order that leaves the shortest gap.
 *
 * Downloaded to a temporary directory, verified, unpacked *beside* the old
 * runtime and moved into place. Every one of those is `ensure_node`'s, and the
 * reason is the same: by the time anything under `<prefix>/node` is touched the
 * archive has already been proved to be the one nodejs.org published, so a
 * failure at the last step is a full disk or a signal rather than a bad
 * download -- and the moment where this machine has no interpreter is a rename.
 *
 * `--no-same-owner` is the flag that was learned rather than reasoned about: a
 * nodejs.org tarball carries `iojs:iojs`, no machine has that account, and tar
 * run by root falls back to the numeric uid -- so a `--system` install unpacked
 * the interpreter its unit names as uid 1001, which on a machine with a first
 * human account is that person.
 */
export async function swapRuntime(
  layout: Layout,
  stale: Extract<RuntimeDecision, { kind: 'stale' }>,
  { machine, downloader, runner }: RuntimeSwapDependencies,
): Promise<RuntimeSwap> {
  const home = join(layout.prefix, NODE_DIRECTORY);
  const staging = `${home}.new`;

  const work = await machine.temporaryDirectory();
  if (work === null) {
    return {
      ok: false,
      lines: ['no temporary directory to download a runtime into, so it was left alone'],
    };
  }

  const archive = join(work, 'node.tar.gz');
  const failed = (problem: string): RuntimeSwap => ({
    ok: false,
    lines: [`${stale.installed} left in place: ${problem}`],
  });

  try {
    const downloaded = await downloader.download(stale.url, archive);
    if (!downloaded.ok) return failed(downloaded.problem);

    const actual = await machine.sha256(archive);
    if (actual !== stale.checksum) {
      // Named rather than summarised. A checksum mismatch is the one failure
      // here that is worth an operator's attention on its own.
      return failed(
        `the archive at ${stale.url} hashed to ${actual ?? 'nothing readable'} and ` +
          `${NODE_DIST_URL} says ${stale.checksum}`,
      );
    }

    const cleared = await machine.removeDirectory(staging);
    if (!cleared.ok) return failed(cleared.problem);
    const made = await machine.makeDirectory(staging);
    if (!made.ok) return failed(made.problem);

    const extracted = await runOperation(extractOperation, { archive, directory: staging }, runner);
    if (!extracted.ok) return failed(extracted.problem);

    // The stamp goes in before the move, so the directory that arrives is
    // either a complete runtime with its record or is not there at all. A
    // stamp written afterwards has a window in which this prefix owns a runtime
    // it cannot prove it installed, and `uninstall_node` refuses to remove
    // exactly that.
    const stamped = await machine.writeFile(join(staging, NODE_STAMP), `${stale.available}\n`);
    if (!stamped.ok) return failed(stamped.problem);

    const removed = await machine.removeDirectory(home);
    if (!removed.ok) return failed(removed.problem);
    const moved = await machine.rename(staging, home);
    if (!moved.ok) {
      return {
        ok: false,
        // The worst moment to fail, and the only one where the machine is left
        // worse than it was found. Said plainly, with the directory named,
        // because the fix is to run this again.
        lines: [
          `this machine has no runtime in ${home}: ${moved.problem}`,
          `The unpacked ${stale.available} is at ${staging}; running this again replaces it.`,
        ],
      };
    }

    return { ok: true, lines: [`replaced ${stale.installed} with ${stale.available} in ${home}`] };
  } finally {
    // The download, whatever happened. The staging directory is deliberately
    // left where it is on a failure: it is inside the prefix, it is named in
    // the line above, and the next run removes it before it unpacks.
    await machine.removeDirectory(work);
  }
}

const extractOperation: Operation<{ readonly archive: string; readonly directory: string }, null> =
  {
    name: 'node.unpack',
    summary: 'unpack a Node release into the directory the prefix keeps its runtime in',
    request: z.strictObject({ archive: z.string().min(1), directory: z.string().min(1) }),
    timeoutMs: EXTRACT_TIMEOUT_MS,
    argv: (request) => ({
      file: 'tar',
      args: [
        '-xzf',
        request.archive,
        '-C',
        request.directory,
        // The archive is laid out as a prefix -- bin/, include/, lib/, share/ --
        // so one component is stripped and the whole thing lands in the directory
        // the runtime owns.
        '--strip-components=1',
        '--no-same-owner',
      ],
    }),
    read: (completed) =>
      completed.exitCode === 0
        ? { ok: true, result: null }
        : {
            ok: false,
            refusal: 'failed',
            problem: `tar could not unpack the runtime: ${firstLine(completed.stderr)}`,
          },
  };

function firstLine(text: string): string {
  const said = text.trim();
  return said.length === 0 ? 'it said nothing' : (said.split('\n')[0] ?? '');
}
