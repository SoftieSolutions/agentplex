import { z } from 'zod';
import type { Logger } from '@agentplex/node-shared';
import { daemonVersionSchema, machineOsSchema } from '@agentplex/protocol';
import { runOperation, type ProcessRunner } from '@agentplex/providers';
import { osNameOperation } from '../operations/os-name.js';
import { OS_RELEASE_PATHS, osReleaseName } from './os-release.js';

/**
 * What this server says about itself in every handshake: the operating system
 * it runs and which build of the daemon is answering. Both are labels for the
 * machine card, and either is `null` when it could not be read -- never a
 * placeholder word, which a card would draw as though it were a fact.
 */
export interface ServerAbout {
  readonly os: string | null;
  readonly daemonVersion: string | null;
}

/**
 * Everything the boot read touches outside this process, handed in by `main`.
 *
 * The platform and the kernel's name are values rather than calls because
 * they cannot change while a process runs, and a test that could not write
 * them down would be asserting on whichever machine ran it.
 */
export interface AboutSources {
  /** `process.platform`: which of the three readings applies. */
  readonly platform: string;
  /** `os.type()` and `os.release()`: the fallback every platform has. */
  readonly kernel: { readonly type: string; readonly release: string };
  /** What `system.os-name` is run through, on a Mac. */
  readonly runner: ProcessRunner;
  /** A whole text file, rejecting when it cannot be read. */
  readFile(path: string): Promise<string>;
  /** The installed package's own manifest, whose version is this daemon's. */
  readonly manifest: string;
  readonly logger: Logger;
}

/**
 * Reads both, once, at boot.
 *
 * Once, because neither changes while the process runs: an OS upgrade and a
 * daemon upgrade both restart this server. It never rejects, because a
 * machine that cannot name itself is still a machine that can run sessions,
 * and refusing to start over a label would trade the thing a person came for
 * for a line on a card.
 */
export async function readServerAbout(sources: AboutSources): Promise<ServerAbout> {
  const [os, daemonVersion] = await Promise.all([readOsName(sources), readDaemonVersion(sources)]);
  return { os, daemonVersion };
}

/**
 * The marketing name where the platform keeps one, and the kernel's otherwise.
 *
 * A Mac is asked through `sw_vers`, a Linux machine's distribution through its
 * `os-release` file; everything else, and either of those when its source is
 * missing or unreadable, is named by the kernel -- `Darwin 25.6.0`,
 * `Linux 6.8.0` -- which is true, less friendly, and logged as the fallback so
 * an operator wondering why the card says Darwin can find out.
 */
async function readOsName(sources: AboutSources): Promise<string | null> {
  const { platform, logger } = sources;

  if (platform === 'darwin') {
    const outcome = await runOperation(osNameOperation, {}, sources.runner);
    if (outcome.ok) return outcome.result;
    return kernelName(sources, outcome.problem);
  }

  if (platform === 'linux') {
    for (const path of OS_RELEASE_PATHS) {
      let text: string;
      try {
        text = await sources.readFile(path);
      } catch {
        continue;
      }
      const name = osReleaseName(text);
      if (name !== null) return name;
      logger.debug('os-release names no distribution', { path });
    }
    return kernelName(sources, 'no os-release file names a distribution');
  }

  return kernelName(sources, null);
}

function kernelName(sources: AboutSources, problem: string | null): string | null {
  if (problem !== null) sources.logger.warn('naming this machine by its kernel', { problem });
  const parsed = machineOsSchema.safeParse(`${sources.kernel.type} ${sources.kernel.release}`);
  return parsed.success ? parsed.data : null;
}

/**
 * The shape read out of the manifest: an object with a version, and whatever
 * else a manifest carries left alone.
 */
const manifestSchema = z.object({ version: daemonVersionSchema });

/**
 * The version the installed package's manifest carries.
 *
 * On an installed machine that manifest is the one packaging wrote, with the
 * version the release tag named. In a checkout and in the image it is the
 * workspace's own, which says `0.0.0` on purpose -- and that is what this
 * reports there, because it is true: nothing released is running.
 */
async function readDaemonVersion(sources: AboutSources): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await sources.readFile(sources.manifest));
  } catch (error) {
    sources.logger.warn('this server cannot name its version', {
      manifest: sources.manifest,
      problem: String(error),
    });
    return null;
  }

  const manifest = manifestSchema.safeParse(parsed);
  if (!manifest.success) {
    sources.logger.warn('this server cannot name its version', {
      manifest: sources.manifest,
      problem: 'the manifest carries no version this server will send',
    });
    return null;
  }
  return manifest.data.version;
}
