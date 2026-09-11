import { join } from 'node:path';
import { parseVersionsManifest, type VersionsManifest } from '@agentplex/release';
import { z } from 'zod';
import type { InstallationFiles } from '../installation/installation-files.js';

/**
 * The answer to "what is current", kept on disk so that the next command does
 * not have to ask.
 *
 * The passive update notice is the reason this exists, and its one hard
 * constraint is what shapes the whole file: **no command an operator typed
 * makes a network call to print a notice.** So the notice reads this, and
 * nothing else; when what it reads is too old it asks for a refresh in the
 * background and says nothing that run. Every command stays fast and
 * offline-safe, and the notice is at most one run late.
 *
 * ## Where it lives, and who can write it
 *
 * Under the running user's cache directory -- `$XDG_CACHE_HOME/agentplex`, or
 * `~/.cache/agentplex` -- and deliberately not under the prefix.
 *
 * A `--system` machine runs this command as more than one identity: root
 * installed it, the service account runs the daemons, and an operator types
 * `agentplex status`. The prefix is root-owned, so a cache in it would be
 * writable by exactly one of the three and unreadable-by-accident for the
 * others -- and a cache one identity cannot write is a notice that is either an
 * error or a lie for that identity. In a per-user directory every one of them
 * has one, each describing what that identity last managed to check.
 *
 * The duplication is the point rather than a cost: this file holds no state
 * anybody owns. It is a copy of something published, it is rebuilt by one
 * fetch, and deleting it costs a machine nothing but one stale notice.
 *
 * ## Degrading
 *
 * Every failure here is silence. No home directory, a cache directory that
 * cannot be made, a file that will not parse, a clock that says the file was
 * written in the future: each of them is a machine with no cached answer, which
 * is a run without a notice. The one caller that reports a failure is
 * `--check`, which was asked to refresh the cache and owes an answer about
 * whether it could.
 */

/** The directory agentplex keeps its cache in, under whichever cache home. */
export const CACHE_DIRECTORY = 'agentplex';

/** The file inside it. Named for what it holds, not for the command that wrote it. */
export const CACHE_FILE_NAME = 'versions.json';

/** `$XDG_CACHE_HOME`, and the fallback the specification names. */
export const CACHE_HOME_VARIABLE = 'XDG_CACHE_HOME';
export const CACHE_HOME_FALLBACK = '.cache';

/**
 * How old a cached answer may be before the notice stops trusting it enough to
 * leave it alone.
 *
 * A day. Short enough that somebody who updates twice a week hears about a
 * release the day after it happens; long enough that a machine running a
 * command a minute starts one refresh a day rather than one an hour.
 *
 * The two readers do different things past it, and both are right. The notice
 * goes quiet, because an unprompted claim that keeps being repeated out of a
 * file nothing can refresh is one an operator learns to disbelieve. `agentplex
 * status` still prints what it has, because somebody asked -- and it prints the
 * age beside it, which is the whole of the difference between an answer and a
 * claim.
 */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Where this identity's cache file is, or `null` when there is nowhere to put
 * one.
 *
 * `null` rather than a path under `/` or under the working directory. A cache
 * written somewhere arbitrary is litter that nothing will ever clean up, and a
 * machine with no home directory -- a daemon's environment, a container run
 * with `--env HOME=` -- is a machine that does without a notice.
 */
export function versionsCacheFile(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicit = environment[CACHE_HOME_VARIABLE];
  if (explicit !== undefined && explicit.length > 0) {
    return join(explicit, CACHE_DIRECTORY, CACHE_FILE_NAME);
  }
  const home = environment['HOME'];
  if (home === undefined || home.length === 0) return null;
  return join(home, CACHE_HOME_FALLBACK, CACHE_DIRECTORY, CACHE_FILE_NAME);
}

/** The directory the file above lives in, which is what has to be made first. */
export function versionsCacheDirectory(file: string): string {
  return join(file, '..');
}

/**
 * What was cached: the manifest, when it was read, and where from.
 *
 * The source is kept because it is what the age is a claim about. A cache
 * written from an `AGENTPLEX_VERSIONS` directory and one written from the
 * release branch are answers to the same question from different origins, and a
 * report that named neither would be telling an operator that a version is
 * current without saying current according to what.
 */
export interface CachedVersions {
  readonly checkedAt: number;
  readonly source: string;
  readonly manifest: VersionsManifest;
}

/**
 * The cache file's own shape, checked before the manifest inside it is.
 *
 * A file this program wrote is still a file off a disk: it can be truncated by
 * a full disk mid-write, edited by somebody curious, or left behind by an older
 * version of this command. It is a claim, so it goes through a parser, and a
 * refusal is a machine with no cached answer rather than a crash in the middle
 * of an unrelated command.
 */
const cacheSchema = z.object({
  checkedAt: z.number().int().positive(),
  source: z.string().min(1),
  // `unknown` here and the release schema below, rather than the manifest shape
  // twice. There is one parser for a versions manifest and it lives in the
  // package both this command and the release job read it through.
  manifest: z.unknown(),
});

/** What was cached, or `null` for anything this cannot read as a cache. */
export function parseCachedVersions(text: string): CachedVersions | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  const outer = cacheSchema.safeParse(value);
  if (!outer.success) return null;

  try {
    return {
      checkedAt: outer.data.checkedAt,
      source: outer.data.source,
      manifest: parseVersionsManifest('the version cache', JSON.stringify(outer.data.manifest)),
    };
  } catch {
    return null;
  }
}

/** What is written. Indented, because somebody will open it to see why. */
export function serializeCachedVersions(cached: CachedVersions): string {
  return `${JSON.stringify(cached, null, 2)}\n`;
}

/**
 * How old a cached answer is, in the words a person uses.
 *
 * The existing rule, applied: a stale cache is labelled with its age. "1.5.0 is
 * available" is a claim this program cannot make on its own, because what it
 * has is a file that was written at some point; "1.5.0 is available (checked 3
 * days ago)" is exactly what it knows.
 *
 * Rounded down and never to zero units: "0 days ago" is the shape that reads as
 * a bug. A cache stamped in the future -- a clock that moved backwards, a file
 * copied from another machine -- is reported as just now rather than as a
 * negative age, which is the direction that does not over-claim: it makes the
 * notice look fresher than it is only when the alternative is nonsense.
 */
export function describeAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(ageMs, 0) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${plural(minutes)} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${plural(hours)} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${plural(days)} ago`;
}

/**
 * What this identity last managed to check, or nothing at all.
 *
 * The one reader both the notice and `agentplex status` share, which is what
 * makes "there is one version-check mechanism" true rather than aspirational:
 * `update --check` writes this file, and everything that reports what is
 * available reads it through here. Neither of them may fetch.
 *
 * Every failure is `null` and none of them is reported. A missing cache, an
 * unreadable one, a truncated one and a machine with nowhere to keep one are
 * the same thing to a caller: there is no cached answer, so nothing is said
 * about what is available.
 */
export async function readCachedVersions(
  path: string | null,
  files: InstallationFiles,
): Promise<CachedVersions | null> {
  if (path === null) return null;
  const read = await files.readFile(path);
  return read.kind === 'read' ? parseCachedVersions(read.contents) : null;
}

/** Whether a cached answer is old enough to be worth refreshing in the background. */
export function isStale(cached: CachedVersions, now: number): boolean {
  return now - cached.checkedAt >= CACHE_MAX_AGE_MS;
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}
