import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import type { Downloader } from '../commands/update/runtime.js';
import type { FileOutcome } from '../commands/update/update-machine.js';
import { nodeInstallationFiles } from '../installation/node-installation-files.js';
import type { ManifestRead, ManifestReader, ManifestSource } from './version-check.js';

/**
 * The network, and the local file that stands in for it, in the one module that
 * has either.
 *
 * This is the only thing in `apps/cli` that can reach off the machine. Composed
 * here rather than reached for, so that a command which is not supposed to go
 * out -- `status`, `doctor`, `start`, `stop` -- cannot acquire the ability by
 * importing something: they are not handed one, and there is nothing in their
 * dependency types to put one in.
 *
 * ## Timeouts, and why both of them are short
 *
 * The two things read here are text files of a few kilobytes, and the command
 * reading them has already told an operator what it is about to do. A fetch
 * that hangs is worse than one that fails: the failure says "could not check",
 * which is an honest answer this command knows what to do with, and the hang is
 * a terminal somebody eventually interrupts -- possibly between the units being
 * stopped and the packages being installed.
 *
 * The archive gets longer, because it is fifty megabytes and the machine
 * downloading it may be a small instance on a bad link. It is still bounded:
 * an update that has stopped the daemons must not be able to wait for ever.
 */

/** A manifest or a checksum file: small, and read before anything is decided. */
const TEXT_TIMEOUT_MS = 15_000;

/** A Node release archive. */
const ARCHIVE_TIMEOUT_MS = 300_000;

/**
 * https only.
 *
 * The same floor `install.sh`'s `fetch` carries, and for the same reason: these
 * bytes decide what gets installed on this machine, and a URL that downgraded
 * to http would be a release manifest anybody on the path could write. It is
 * checked here rather than trusted from the caller because this is where a
 * string becomes a request.
 */
function refuseInsecure(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url} is not a URL`;
  }
  return parsed.protocol === 'https:' ? null : `${url} is not https, and this only reads https`;
}

export const nodeNetwork: ManifestReader & Downloader = {
  async read(source: ManifestSource): Promise<ManifestRead> {
    if (source.kind === 'file') {
      // A local directory laid out as a release is: the seam `install.sh` calls
      // `AGENTPLEX_VERSIONS`, which is what an air-gapped mirror uses and what
      // keeps this repository's own end-to-end checks off the network.
      const read = await nodeInstallationFiles.readFile(source.path);
      if (read.kind === 'read') return { kind: 'read', text: read.contents };
      return {
        kind: 'failed',
        problem:
          read.kind === 'missing'
            ? `${source.path} is not there`
            : `${source.path} could not be read: ${read.reason}`,
      };
    }

    const insecure = refuseInsecure(source.url);
    if (insecure !== null) return { kind: 'failed', problem: insecure };

    try {
      const response = await fetch(source.url, {
        signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (!response.ok) {
        return {
          kind: 'failed',
          problem: `${source.url} answered ${response.status} ${response.statusText}`,
        };
      }
      return { kind: 'read', text: await response.text() };
    } catch (error) {
      // Every failure is a value: no route, DNS that will not answer, a proxy
      // that refuses, the timeout above. All of them mean the same thing to the
      // caller -- this run could not check -- and none of them may be an
      // exception unwinding out of a command that has stopped the daemons.
      return { kind: 'failed', problem: `${source.url} could not be reached: ${String(error)}` };
    }
  },

  /**
   * A file, written whole.
   *
   * Buffered rather than streamed to disk, which is a deliberate limit and not
   * an oversight: the one thing downloaded here is a Node release archive of
   * around fifty megabytes, it is verified against a checksum before anything
   * is done with it, and a partial file on disk is exactly what a streamed
   * write leaves behind when a connection drops. Holding it and writing it once
   * means the file either is the download or is not there.
   */
  async download(url: string, path: string): Promise<FileOutcome> {
    const insecure = refuseInsecure(url);
    if (insecure !== null) return { ok: false, problem: insecure };

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (!response.ok) {
        return { ok: false, problem: `${url} answered ${response.status} ${response.statusText}` };
      }
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
      return { ok: true };
    } catch (error) {
      return { ok: false, problem: `${url} could not be downloaded: ${String(error)}` };
    }
  },
};
