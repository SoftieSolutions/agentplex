import { parseVersionsManifest, type VersionsManifest } from '@agentplex/release';

/**
 * What is current, asked of the one file that answers it.
 *
 * This is the only place in `apps/cli` that reaches a network, and it is a
 * boundary rather than an accident of what has been written: `status` and
 * `doctor` describe a machine, which is always available and never wrong about
 * a registry being down, and "a newer version than this exists" is a question
 * about a release somewhere else. Everything that question costs -- a fetch, a
 * timeout, a cache, a stale answer to label with its age -- is paid here and in
 * `versions-cache.ts`, and nowhere else.
 *
 * ## The source is a value, so a test and an air-gapped mirror are the same case
 *
 * `AGENTPLEX_VERSIONS` names a directory laid out as a release is --
 * `versions.json` at its root -- which is exactly what it means to `install.sh`.
 * Reading a local file is not a download, so a machine that has one never
 * touches the network, and the end-to-end suites and the container check assert
 * against a manifest they wrote rather than against whatever github.com is
 * serving today. One seam answers both, because "read this manifest" is one
 * question whichever origin it came from.
 */

/**
 * The manifest every unpinned install and every update resolves through.
 *
 * The same URL `install.sh` carries as `VERSIONS_URL`: the `v1` branch, through
 * the raw.githubusercontent.com path that already serves the installer, written
 * by the same release job that advances that branch. `version-check.test.ts`
 * holds the two together.
 */
export const VERSIONS_URL =
  'https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/versions.json';

/** The directory that stands in for the release, laid out as one. */
export const VERSIONS_DIRECTORY_VARIABLE = 'AGENTPLEX_VERSIONS';

/** The file inside it, at the name the release publishes. */
export const VERSIONS_FILE_NAME = 'versions.json';

/**
 * Where the manifest is to be read from. A path or a URL, and the reader is
 * told which rather than sniffing the string: a path that happens to start with
 * `https:` is not a URL, and a program that guessed would be one more parser
 * nobody wrote down.
 */
export type ManifestSource =
  { readonly kind: 'file'; readonly path: string } | { readonly kind: 'url'; readonly url: string };

/** The source as one line, for the report and for the cache's record of it. */
export function describeSource(source: ManifestSource): string {
  return source.kind === 'file' ? source.path : source.url;
}

/**
 * The source this machine reads from, decided once out of the environment.
 *
 * The environment arrives as a value because the entrypoint is the only reader
 * of `process.env` in this app. An empty variable is treated as an absent one,
 * which is what a shell that exported it without a value leaves behind.
 */
export function manifestSource(
  environment: Readonly<Record<string, string | undefined>>,
  join: (directory: string, file: string) => string,
): ManifestSource {
  const directory = environment[VERSIONS_DIRECTORY_VARIABLE];
  return directory === undefined || directory.length === 0
    ? { kind: 'url', url: VERSIONS_URL }
    : { kind: 'file', path: join(directory, VERSIONS_FILE_NAME) };
}

/** The bytes at a source, or why there are none. Never rejects. */
export type ManifestRead =
  | { readonly kind: 'read'; readonly text: string }
  | { readonly kind: 'failed'; readonly problem: string };

/**
 * The one seam nothing else in this app has: something that can be somewhere
 * else.
 *
 * A test that had to reach github.com to find out what `update` does with a
 * manifest would be a test of github.com, and one that had to reach it to find
 * out what happens when it cannot be reached could not be written at all. Both
 * are literals through this.
 */
export interface ManifestReader {
  read(source: ManifestSource): Promise<ManifestRead>;
}

/**
 * What the manifest says, or why this run cannot say.
 *
 * Two shapes and no third, because the third is the one that must not exist: a
 * check that could not be made is never "up to date". `install.sh` keeps the
 * same rule about nodejs.org, and this is it in the other program -- an
 * unreachable manifest is reported as unknown, with the source named, and
 * nothing downstream is allowed to read that as agreement.
 */
export type VersionCheck =
  | {
      readonly ok: true;
      readonly manifest: VersionsManifest;
      readonly source: string;
      /** When it was read, from the injected clock. The cache is stamped with it. */
      readonly checkedAt: number;
    }
  | { readonly ok: false; readonly source: string; readonly problem: string };

export interface VersionCheckDependencies {
  readonly reader: ManifestReader;
  readonly now: () => number;
}

/**
 * Read the manifest and parse it.
 *
 * Parsed and not read: this file comes off the network, or off a branch anybody
 * with write access can push to, and what an installed machine does with it is
 * hand npm a URL built out of it. A version that is not a version stops here
 * rather than becoming a 404 halfway through an update that has already stopped
 * the daemons. The schema is the one the release job writes through, from
 * `@agentplex/release`, so the two cannot disagree about what a manifest is.
 */
export async function checkVersions(
  source: ManifestSource,
  { reader, now }: VersionCheckDependencies,
): Promise<VersionCheck> {
  const where = describeSource(source);
  const read = await reader.read(source);
  if (read.kind === 'failed') return { ok: false, source: where, problem: read.problem };

  try {
    const manifest = parseVersionsManifest(where, read.text);
    // An empty manifest parses -- the first release of the first component has
    // to be able to write one -- and it answers nothing. Treating it as a
    // successful check would report every component as unknown with no reason
    // beside it, which reads as a machine problem rather than as a file that
    // says nothing yet.
    if (Object.keys(manifest).length === 0) {
      return { ok: false, source: where, problem: `${where} names no component` };
    }
    return { ok: true, manifest, source: where, checkedAt: now() };
  } catch (error) {
    return {
      ok: false,
      source: where,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}
