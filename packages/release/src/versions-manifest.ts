import { z } from 'zod';
import { compareVersions } from './version-order.js';

/**
 * `versions.json`: every release of every component, and which of them is
 * current.
 *
 * ## Why there is a file at all
 *
 * With one release train, `releases/latest/download/<asset>` answered "the
 * current one" and nothing had to be published to say so. With four it cannot:
 * GitHub's "latest" is the most recently published release *overall*, so on the
 * day the server was released that redirect would hand a machine asking about
 * the CLI the server's tag. There is no per-component redirect, and the API
 * call that would answer it is neither unauthenticated nor one request.
 *
 * So the release publishes the answer. It goes on the `v1` branch, through the
 * same raw.githubusercontent.com path that already serves `install.sh`, written
 * by the same job that already advances that branch -- one mechanism rather
 * than a second one to keep working. One unauthenticated fetch of a few hundred
 * bytes then answers what is current for every component, and whether the set
 * agrees on a protocol, before a byte of any tarball is downloaded.
 *
 * ## Why this is a package rather than a file in `scripts`
 *
 * Three programs read this format now. The release job writes it, `install.sh`
 * reads it with a bash grammar because it runs before there is a Node on the
 * machine, and `agentplex update` reads it to find out what is current. Three
 * parsers for one format is three ways to disagree, and the two that can share
 * one are the two written in TypeScript -- so they do, from here. `apps/cli`
 * may not import from `scripts`, which is dev tooling that ships nothing, and
 * `scripts` may not reach into an app; a package both may name is the only
 * place the schema can be and still be one schema.
 *
 * The bash reader stays separate, because there is nothing for it to import: it
 * runs on a machine with no runtime yet. What holds it against this one is
 * fixtures rather than code -- `install.sh.integration.test.ts` feeds the
 * script manifests written in the same shapes this suite refuses.
 *
 * This package depends on nothing in the workspace, and that emptiness is
 * load-bearing rather than incidental. The release job that advances `v1`
 * installs and builds this package alone, so a manifest update stays
 * independent of whether the hub, the server or the protocol compile.
 *
 * ## Why it is merged rather than written
 *
 * A tag releases one component, so a release knows one entry and inherits the
 * other three. The previous manifest is read off the `v1` branch and the one
 * entry is replaced in it -- which means this module's input is a file written
 * by an earlier run of itself, out of a branch anybody with write access can
 * push to. That is a claim like any other, so it goes through a parser that can
 * say no rather than through `JSON.parse` and a spread: a `v1` whose manifest
 * has been hand-edited into something malformed should fail this release rather
 * than be carried forward and served to every machine that installs.
 *
 * ## Why it carries history
 *
 * Every release this component has ever published, not only the current one,
 * as `<version>: <protocol legs>`. Two things need it and neither could be had from
 * the file that described only what is current.
 *
 * A partial pin is the first. `--role=hub@1.3` is the shape a fleet operator
 * wanting security patches without a minor jump reaches for, and resolving it
 * to the newest `1.3.x` needs the set of `1.3.x` releases to choose from. The
 * alternative was the GitHub releases API, which is deeply nested JSON that
 * `install.sh` has no parser for -- it reads this file with a bash grammar,
 * because `resolve_component_versions` runs before there is a Node on the
 * machine -- and which is rate limited to sixty unauthenticated requests an
 * hour and paginated past a hundred releases, a number four independent
 * release trains reach quickly.
 *
 * The protocol a *pinned* release speaks is the second, and it is what history
 * deletes. That question used to be answered by a second published artifact, a
 * `<component>-v<version>.json` beside each tarball, which existed only
 * because this file had no line for anything but the current release. With
 * history the answer is already in the file `install.sh` has fetched, so the
 * artifact, its upload step and the extra download every pin used to cost are
 * all gone. The release got smaller by giving this file more to say.
 *
 * A thousand releases is roughly thirty kilobytes, which is the whole cost.
 *
 * ## Why the protocol is in it
 *
 * It is the whole reason independent versions are safe. The protocol has two
 * legs, each with its own constant -- `CLIENT_PROTOCOL_VERSION` for the browser
 * and MCP side of the hub, `SERVER_PROTOCOL_VERSION` for the hub-to-server
 * side -- and packaging writes into every published manifest the legs that
 * package speaks: the hub and the web client both, the server only its own,
 * the CLI neither. The release copies that object in here, so `install.sh` can
 * ask one question per leg, before it installs anything, about a set of
 * components it has not downloaded. A change to a leg releases every component
 * that records it together, so the numbers on one leg always agree; `install.sh`
 * refuses loudly with both named if they ever do not. Numbers on different legs
 * are not compared: a hub at client 40 and server 39 beside a server at 39 is
 * the whole point of having two.
 *
 * A release value is always the object. Nothing was ever published in the
 * bare-number form the file had while there was one protocol, so there is no
 * old file to read and a bare number is refused like any other malformed
 * release rather than guessed at.
 */

/**
 * A version as this publishes it: semver.org's grammar, three numeric parts
 * with no leading zeroes and the optional tails.
 *
 * The same expression `assemble-package.ts` carries, and deliberately a second
 * copy rather than an import. That module parses a *tag*, which is a different
 * input arriving from a different place, and it reaches for the compiled
 * protocol package -- so an import in that direction would put a build between
 * the release job and the manifest it writes. The grammar is small enough that
 * two copies of it are cheaper than that coupling, and both are exercised.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Whether a word is a version this can install, asked of something a person
 * typed.
 *
 * The same grammar `install.sh` carries as `RELEASE_VERSION`, restated here for
 * the command that takes the same pins. Exact, and for this caller that is
 * still the whole of it: `agentplex update --hub=1.3.0` names a release tag,
 * and a tag is a string that either exists or does not.
 *
 * `install.sh` now takes a partial pin as well, because it resolves one against
 * the release history this manifest carries before it builds a URL. This
 * command does not, and the difference is deliberate rather than an oversight:
 * the installer is what a fleet points at, so `hub@1.3` earns a resolver there,
 * and a second resolver here would be a second thing to keep agreeing with the
 * first for a command an operator runs by hand on one machine.
 */
export function isReleaseVersion(value: string): boolean {
  return SEMVER.test(value);
}

/**
 * A version as a key or a value: the grammar above, used as a schema.
 */
const versionSchema = z.string().regex(SEMVER);

/**
 * The protocol legs one release speaks, each a positive integer, each absent
 * when the package does not speak that leg.
 *
 * `strict`, so a leg nobody named stops the release rather than being carried
 * into a file `install.sh` reads with a grammar that would not know it. The
 * legs are positive because neither constant ever takes the value 0 -- a falsy
 * version is indistinguishable from a missing one in anything that tests it
 * before comparing.
 *
 * The leg names are restated here rather than imported from the protocol
 * package, for the reason the whole package imports nothing: the release job
 * that advances `v1` builds this package alone.
 */
const releaseProtocolSchema = z
  .object({
    client: z.int().positive().optional(),
    server: z.int().positive().optional(),
  })
  .strict();

export type ReleaseProtocol = z.infer<typeof releaseProtocolSchema>;

/**
 * The legs a release job was handed, as the JSON text the workflow read out of
 * the package's own manifest.
 *
 * It throws naming `source`, because both callers want a failed job that says
 * which word was wrong: the release job reads it off argv, and packaging reads
 * it back off a manifest it has just written.
 */
export function parseReleaseProtocol(source: string, text: string): ReleaseProtocol {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not JSON: ${error instanceof Error ? error.message : ''}`);
  }
  const parsed = releaseProtocolSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${source} is not a release protocol, an object of client and server legs: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * One release: the version its tag names and the protocol legs its tarball
 * declares.
 *
 * What a release job knows and hands to `updateVersionsManifest`, and what
 * `currentRelease` hands back to a reader that wants the current one as a pair
 * rather than as two lookups.
 */
const releaseSchema = z
  .object({
    version: versionSchema,
    protocol: releaseProtocolSchema,
  })
  .strict();

/**
 * One component's line: which release is current, and every release there has
 * been.
 *
 * `strict`, so a field nobody listed stops the release rather than being
 * carried forward into a file every installing machine reads. Each release's
 * value is the legs it speaks; see `releaseProtocolSchema`.
 *
 * The keys of `releases` are checked as versions too. They are what a partial
 * pin is resolved against, so a key that is not a version is a candidate
 * `install.sh` would have to have an opinion about; refusing it here means the
 * bash resolver only ever sees versions.
 *
 * `current` has to be one of them. It is the invariant that makes the file
 * answerable in one read: a reader that wants what is current and what it
 * speaks looks up one key rather than reading two halves that could disagree.
 * A manifest where they do disagree is a `v1` branch somebody hand-edited, and
 * it fails the release rather than being served.
 */
const entrySchema = z
  .object({
    current: versionSchema,
    releases: z.record(versionSchema, releaseProtocolSchema),
  })
  .strict()
  .refine((entry) => entry.current in entry.releases, {
    message: 'the current version is not one of the releases listed beside it',
  });

/**
 * The manifest: one entry per component, keyed by the word its tag carries.
 *
 * The component names are not enumerated here, and that is deliberate rather
 * than lax. `assemble-package.ts` owns that list and refuses a tag naming
 * anything else, so by the time a component reaches this module it has already
 * been through a parser that could say no -- and repeating the list here would
 * be a second copy that has to be edited in step with the first. What this
 * schema is for is the *shape*, which is what a file read back off a branch, or
 * fetched over https by an installed machine, can have got wrong.
 */
const manifestSchema = z.record(z.string().min(1), entrySchema);

export type VersionsManifest = z.infer<typeof manifestSchema>;
export type VersionsEntry = z.infer<typeof entrySchema>;
export type PublishedRelease = z.infer<typeof releaseSchema>;

/**
 * The manifest a previous release left on `v1`, or nothing at all.
 *
 * An absent file is not an error: the first release of the first component has
 * nothing to inherit, and treating that as a failure would make the one release
 * nobody can retry the one that cannot run.
 *
 * It throws, and that is right for the two callers it has. The release job
 * wants a failed job with the file named; `agentplex update` wants a sentence
 * for an operator, and catches this to write one -- see `readVersionsManifest`,
 * which is the boundary where a thrown parse becomes "that is not a manifest".
 */
export function parseVersionsManifest(source: string, text: string): VersionsManifest {
  const trimmed = text.trim();
  if (trimmed === '') return {};

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${source} is not JSON: ${error instanceof Error ? error.message : ''}`);
  }

  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${source} is not a versions manifest this release can carry forward: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * The release one entry says is current, as a pair.
 *
 * Total, because the schema refuses an entry whose `current` is not one of its
 * own releases -- so the lookup cannot come back empty, and no caller has to
 * invent what to do when it does. This is the one place that knows the
 * invariant is what makes it total.
 */
export function currentRelease(entry: VersionsEntry): PublishedRelease {
  const protocol = entry.releases[entry.current];
  if (protocol === undefined) {
    // Unreachable through the parser, and here rather than as a `!` because it
    // is the schema's refinement that makes it unreachable: a cast would be the
    // claim that the refinement will always be there.
    throw new Error(`the manifest calls ${entry.current} current and lists no protocol for it`);
  }
  return { version: entry.current, protocol };
}

/**
 * Which release an entry calls current: the newest one that is not a
 * prerelease.
 *
 * Worked out from the history rather than taken from the release being
 * published, and that is two bugs rather than a nicety.
 *
 * A patch to an older line is published after a newer line exists -- 1.2.1
 * lands the week after 1.3.0 -- and a manifest that called the version just
 * released current would move every unpinned install on the fleet backwards.
 *
 * A prerelease is published on purpose and must never be what the documented
 * one-liner hands out. Recording it in `releases` is what makes
 * `--role=hub@1.3.8-rc1` installable; leaving it out of `current` is what keeps
 * it from being installed by somebody who asked for nothing in particular.
 *
 * The exception is a component that has published nothing else. `current` is
 * what an unpinned install takes and the schema will not let it be absent, so a
 * release candidate that is the only release there is beats naming none. It is
 * the only case where a prerelease is current, and it stops being one the
 * moment anything else ships.
 */
function newestInstallable(releases: Readonly<Record<string, ReleaseProtocol>>): string {
  const versions = Object.keys(releases);
  const released = versions.filter((one) => !isPrerelease(one));
  const candidates = released.length > 0 ? released : versions;
  // Reduced rather than indexed. The set is never empty -- the only caller has
  // just added a release to it -- and `candidates[0]!` would be the claim that
  // it never will be, rather than a use of the fact that it is not.
  return candidates.reduce((newest, one) =>
    (compareVersions(one, newest) ?? 0) > 0 ? one : newest,
  );
}

/**
 * Whether a version is a prerelease: semver's tail after the `-`.
 *
 * Build metadata is stripped first, because a `-` inside `+build-3` is not a
 * prerelease marker. The same rule `install.sh` keeps by shape rather than by
 * parse -- its series pattern fixes the field depth, so anything carrying a `-`
 * or a `+` fails it.
 */
function isPrerelease(version: string): boolean {
  return (version.split('+', 1)[0] ?? '').includes('-');
}

/** Newest first, by precedence and not by text. */
function sortReleases(
  releases: Readonly<Record<string, ReleaseProtocol>>,
): Record<string, ReleaseProtocol> {
  return Object.fromEntries(
    Object.entries(releases).sort(([a], [b]) => -(compareVersions(a, b) ?? 0)),
  );
}

/**
 * The manifest this release publishes: the previous one with this component's
 * release added to its history.
 *
 * Added, not replaced. A component's line is the history of that component, so
 * a release appends to it -- which is what makes `--role=hub@1.3` resolvable
 * later and what lets a pinned release's protocol be read out of a file that is
 * already on disk. Re-cutting a tag writes the same key again, because that is
 * one release published twice and not two.
 *
 * Which of them is current falls out of the set rather than being decided here;
 * see `newestInstallable`.
 *
 * The component keys are sorted and so are the releases under each, newest
 * first, so the file a release writes differs from the one before it in exactly
 * the lines that changed. A diff nobody can read is a diff nobody checks, and
 * this file is the one artifact of a release that a person might actually look
 * at on the branch. Newest first rather than oldest, because the line anybody
 * reading the file is looking for is the one at the top.
 */
export function updateVersionsManifest(
  previous: VersionsManifest,
  component: string,
  release: PublishedRelease,
): VersionsManifest {
  const published = releaseSchema.parse(release);
  const releases = sortReleases({
    ...previous[component]?.releases,
    [published.version]: published.protocol,
  });
  const entry = entrySchema.parse({ current: newestInstallable(releases), releases });

  const merged = { ...previous, [component]: entry };
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

/** What is written to the branch: two-space JSON with a trailing newline. */
export function serializeVersionsManifest(manifest: VersionsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
