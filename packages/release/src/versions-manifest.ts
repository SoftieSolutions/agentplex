import { z } from 'zod';

/**
 * `versions.json`: what is current, for every component at once.
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
 * ## Why the protocol is in it
 *
 * It is the whole reason independent versions are safe. `PROTOCOL_VERSION` is
 * the single compatibility constant, packaging writes it into every published
 * manifest, and the release copies it in here -- so `install.sh` can ask one
 * question, before it installs anything, about a set of components it has not
 * downloaded. A protocol change releases every affected component together, so
 * these numbers always agree; `install.sh` refuses loudly with both named if
 * they ever do not.
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
 * The same grammar `install.sh` carries as `RELEASE_VERSION` and refuses a pin
 * against, restated here for the command that takes the same pins. Exact, and
 * that is forced rather than chosen: a pin names a release tag, and a tag is a
 * string that either exists or does not. `hub@1.3` is refused for the reason
 * the installer gives -- there is no registry to resolve it against and this
 * manifest describes only what is current, so accepting a range would mean
 * guessing which release was meant. AGX-198 is the ticket that would give the
 * manifest history and make it resolvable; until it lands, refusing at the flag
 * with the grammar named is the honest end of it.
 */
export function isReleaseVersion(value: string): boolean {
  return SEMVER.test(value);
}

/**
 * One component's line: what is current, and what it speaks.
 *
 * `strict`, so a field nobody listed stops the release rather than being
 * carried forward into a file every installing machine reads. The protocol is a
 * positive integer because `PROTOCOL_VERSION` never takes the value 0 -- a
 * falsy version is indistinguishable from a missing one in anything that tests
 * it before comparing.
 */
const entrySchema = z
  .object({
    version: z.string().regex(SEMVER),
    protocol: z.int().positive(),
  })
  .strict();

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
 * The manifest this release publishes: the previous one with this component's
 * line replaced.
 *
 * The keys are sorted, so the file a release writes differs from the one before
 * it in exactly the lines that changed. A diff nobody can read is a diff nobody
 * checks, and this file is the one artifact of a release that a person might
 * actually look at on the branch.
 */
export function updateVersionsManifest(
  previous: VersionsManifest,
  component: string,
  entry: VersionsEntry,
): VersionsManifest {
  const merged = { ...previous, [component]: entrySchema.parse(entry) };
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

/** What is written to the branch: two-space JSON with a trailing newline. */
export function serializeVersionsManifest(manifest: VersionsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
