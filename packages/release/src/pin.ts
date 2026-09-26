import { compareVersions } from './version-order.js';
import { isReleaseVersion, type VersionsEntry } from './versions-manifest.js';

/**
 * What a pin names: one release, or a series of them.
 *
 * The words `install.sh` takes after `@`, read in TypeScript for the command
 * that takes the same words. An exact pin is a release tag with its stem taken
 * off. A series -- `1.3`, or `1` -- names no tag, and resolves to the newest
 * release the manifest lists under it; it is the shape a fleet operator wanting
 * security patches without a minor jump reaches for, and one grammar across
 * the installer and `agentplex update` is what lets somebody learn it once.
 *
 * Two readers, one in bash and one here, because `install.sh` runs before
 * there is a Node on the machine and has nothing to import. What holds them
 * together is the table in `pin-cases.ts`, which both suites run.
 */
export type Pin =
  | { readonly kind: 'exact'; readonly version: string }
  | { readonly kind: 'series'; readonly series: string };

/**
 * A series: a major, or a major and a minor, with no leading zeroes.
 *
 * `1` is taken as well as `1.3`, for `install.sh`'s reason: it is the same
 * resolver either way, a prefix at a dot boundary, and refusing it would be a
 * second grammar in exchange for withholding the pin that constrains semver's
 * breaking axis.
 */
const SERIES = /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?$/;

/** One numeric field of a version, as the pattern below matches it. */
const NUMBER = '(0|[1-9][0-9]*)';

/** The word after `@`, read as a pin, or `null` when it is neither shape. */
export function readPin(word: string): Pin | null {
  if (isReleaseVersion(word)) return { kind: 'exact', version: word };
  if (SERIES.test(word)) return { kind: 'series', series: word };
  return null;
}

/**
 * The newest release in one series, or `null` when the series holds none.
 *
 * `newest_in_series` in `install.sh`, ported. What counts as in the series is a
 * prefix at a dot boundary with the remaining fields plain numbers, built as a
 * pattern rather than tested as a string prefix: `1.3` cannot match `1.30.0`,
 * and a prerelease or a build suffix is excluded by the same expression that
 * fixes the depth. `hub@1.3` must not select `1.3.8-rc1`, because a series is
 * how a fleet asks for the newest patch and a release candidate is not one;
 * naming it exactly still pins it.
 *
 * The comparison is `compareVersions`, the ordering the manifest writer sorts
 * with, so `1.3.10` is newer than `1.3.9` here as it is there.
 */
export function newestInSeries(versions: Iterable<string>, series: string): string | null {
  if (!SERIES.test(series)) return null;
  const escaped = series.replaceAll('.', '\\.');
  const pattern = new RegExp(
    series.includes('.') ? `^${escaped}\\.${NUMBER}$` : `^${escaped}\\.${NUMBER}\\.${NUMBER}$`,
  );

  let best: string | null = null;
  for (const version of versions) {
    if (!pattern.test(version)) continue;
    if (best === null || (compareVersions(version, best) ?? 0) > 0) best = version;
  }
  return best;
}

/**
 * The release a pin names in one component's entry, or `null` when a series
 * finds nothing there.
 *
 * An exact pin is taken as it is, listed or not: it names a tag outright, and
 * whether the manifest lists it is a question about its protocol, which the
 * caller asks separately. A series is resolved against every release the entry
 * lists, and an absent entry holds none.
 */
export function resolvePin(pin: Pin, entry: VersionsEntry | undefined): string | null {
  switch (pin.kind) {
    case 'exact':
      return pin.version;
    case 'series':
      return newestInSeries(Object.keys(entry?.releases ?? {}), pin.series);
  }
}
