/**
 * Which of two released versions is newer.
 *
 * Two questions need this and neither of them is a resolver. The passive notice
 * asks "is what is published newer than what is running", and `agentplex
 * update` asks the same thing of every installed component so that a machine
 * ahead of the manifest is told so rather than quietly moved backwards. Both
 * compare two versions that already exist. Nothing here selects a version out
 * of a set, because there is no set: `versions.json` names exactly one release
 * per component, which is why `hub@1.3` is refused at the flag (AGX-198 is the
 * ticket that would give the manifest history, and it is deliberately not this
 * one).
 *
 * ## What it implements, and what it does not
 *
 * semver's precedence rules, as far as the versions this project publishes can
 * reach: numeric major, minor and patch, then a prerelease tail that sorts
 * *before* the release it belongs to. `1.5.0-rc.1` is older than `1.5.0`, which
 * is the rule that matters here -- a machine on a release candidate should be
 * told the final exists.
 *
 * Build metadata is ignored, because semver says it is not part of precedence
 * and two versions differing only in it are the same release.
 *
 * The prerelease tails themselves are compared identifier by identifier, the
 * numeric ones numerically and the rest as strings, which is semver's rule. It
 * is more than this project needs -- nothing here publishes two prereleases of
 * one version often -- and it is the only version of the rule that never gets
 * `rc.10` and `rc.9` the wrong way round.
 *
 * A version that is not one gets no opinion: the caller is handed `null` and
 * says "could not compare" rather than being told an ordering invented out of
 * `NaN`. Both callers already have a sentence for not knowing, because both
 * already have to survive a manifest they could not reach.
 */

/**
 * Negative when `left` is older, zero when the two are the same release,
 * positive when `left` is newer. `null` when either is not a version.
 */
export function compareVersions(left: string, right: string): number | null {
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return null;

  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }

  // A release beats its own prereleases, and that asymmetry is the whole reason
  // this cannot be a string compare: `1.5.0` sorts before `1.5.0-rc.1`
  // lexically and after it by every rule anybody means.
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;

  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Whether `candidate` is a release later than `installed`. A no when unknown. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const order = compareVersions(candidate, installed);
  return order !== null && order > 0;
}

interface ParsedVersion {
  readonly numbers: readonly number[];
  /** The dot-separated identifiers after a `-`, or `null` for a release. */
  readonly prerelease: readonly string[] | null;
}

function parse(version: string): ParsedVersion | null {
  // Build metadata first, so that a `+` inside it can never be mistaken for
  // part of a prerelease identifier.
  const withoutBuild = version.split('+', 1)[0] ?? '';
  const separator = withoutBuild.indexOf('-');
  const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
  const tail = separator === -1 ? null : withoutBuild.slice(separator + 1);

  const parts = core.split('.');
  if (parts.length !== 3) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    // `Number` is deliberately not the parser here: it reads ` 1 `, `0x2` and
    // `1e3` as numbers, and none of those is a version component.
    if (!/^(0|[1-9]\d*)$/.test(part)) return null;
    numbers.push(Number(part));
  }

  if (tail === null) return { numbers, prerelease: null };
  if (tail.length === 0) return null;
  const identifiers = tail.split('.');
  return identifiers.some((one) => one.length === 0) ? null : { numbers, prerelease: identifiers };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    // A shorter set of identifiers has lower precedence when everything before
    // it is equal: `1.0.0-rc` is older than `1.0.0-rc.1`.
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    // Numeric identifiers always have lower precedence than alphanumeric ones,
    // which is semver's rule and not a tiebreak invented here.
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}
