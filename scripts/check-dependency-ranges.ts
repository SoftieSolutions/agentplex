import { access, glob, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * `node scripts/check-dependency-ranges.ts`, run by `pnpm lint`.
 *
 * The `## Dependency versions` section of `CONTRIBUTING.md` says every
 * dependency value in this workspace is `workspace:*`, an exact `x.y.z`, or a
 * window `>=x.y.z <X.0.0`, and carries the argument for each. This is that
 * section with nothing added: its closing paragraph, "What a check reads", is
 * the grammar below written out as regular expressions.
 *
 * It exists because the policy was applied by hand once and `pnpm add` writes a
 * caret by default. A rule that lives only in a document is a rule that survives
 * exactly until the next `pnpm add -D`, which writes `^4.1.13` into the manifest
 * somebody is already reviewing for something else. There is nothing to notice
 * here and nothing to remember: the sweep holds because a red check holds it.
 *
 * The failure names the bound it wanted rather than the document it came from,
 * because the fix is a string and the contributor is mid-edit. `^0.11.0` and
 * `^4.1.13` want different things -- an exact pin and a window -- and deriving
 * which is the caret's whole problem, so the check does that derivation once and
 * prints the answer.
 */

/** The four fields a dependency range can appear under, and no other. */
export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/**
 * What the check wanted when it cannot derive a version from what it found.
 * `*`, `latest` and a git specifier name no floor, so there is no window to
 * write out and the grammar itself is the most specific thing to say.
 */
export const GRAMMAR = 'workspace:*, an exact x.y.z, or >=x.y.z <X.0.0';

/** A sibling in this tree. `scripts/assemble-package.ts` replaces it at publish. */
const WORKSPACE = 'workspace:*';

/**
 * An exact pin: three numeric parts with no leading zeroes and an optional
 * prerelease. Build metadata is left out because nothing here has ever carried
 * one, and a form the tree does not use is a form nobody has decided about.
 */
const EXACT =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;

/**
 * The window's shape: a floor, a single space, a ceiling. The shape is all a
 * regular expression can say, because the rule is arithmetic -- the ceiling is
 * the floor's major plus one, with a zero minor and patch -- and `isWindow`
 * below does that part.
 */
const WINDOW =
  /^>=(0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*) <(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * A window, with its ceiling where the policy puts it.
 *
 * One major above the floor and not two. A range spanning two majors is a
 * different rule rather than a wider reading of this one, so widening one is an
 * edit to `CONTRIBUTING.md` and a review of it, not a value that quietly passes
 * a lint. This is the half the grammar used to leave to inference: `X` at least
 * 1 admitted `>=4.1.13 <9.0.0`, which broke the rule while passing the check.
 *
 * A floor below 1.0 takes no window at all. The formula would happily produce
 * one -- `>=0.11.0 <1.0.0` -- and it is the one place where a ceiling a major
 * above the floor is not a promise anybody made: below 1.0 semver puts the
 * breaking change in the minor, so that window spans every break between 0.11
 * and 1.0 while looking like the form that spans none. The only compliant form
 * there is exact, which is what `wantedFor` names for a sub-1.0 value, and this
 * is the one line in the grammar that knows about 0.x.
 */
function isWindow(value: string): boolean {
  const [, floorMajor, ceilingMajor, ceilingMinor, ceilingPatch] = WINDOW.exec(value) ?? [];
  if (floorMajor === undefined || ceilingMajor === undefined) return false;
  if (floorMajor === '0') return false;
  return (
    ceilingMajor === String(Number(floorMajor) + 1) && ceilingMinor === '0' && ceilingPatch === '0'
  );
}

/**
 * The floor hiding inside a value that failed. Deliberately looser than the two
 * above: it reads past a caret, a tilde, a stray space or a second comparator,
 * because its only job is to recover the version the author meant so the
 * message can name a bound instead of a grammar.
 */
const FLOOR =
  /^(?:\^|~|>=|>|=|v)?\s*(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/;

/** Whether a value is one of the three forms the policy names. */
export function isAllowed(value: string): boolean {
  return value === WORKSPACE || EXACT.test(value) || isWindow(value);
}

/**
 * The bound the policy wanted in place of a value that failed.
 *
 * Below 1.0 that is an exact pin, because semver puts the breaking change in
 * the minor there and the widest honest window would admit patch releases of a
 * package whose author has promised nothing about patches. At 1.0 and above it
 * is the window the caret stood for, written out so that the manifest states it
 * rather than implying it.
 */
export function wantedFor(value: string): string {
  const floor = FLOOR.exec(value);
  const [, major, minor, patch] = floor ?? [];
  if (major === undefined || minor === undefined || patch === undefined) return GRAMMAR;
  const version = `${major}.${minor}.${patch}`;
  return major === '0' ? version : `>=${version} <${Number(major) + 1}.0.0`;
}

/** One value that is not one of the three forms, and what it should have been. */
export interface Offence {
  /** The manifest's path relative to the workspace root, as a person would type it. */
  manifest: string;
  field: DependencyField;
  dependency: string;
  value: string;
  wanted: string;
}

/** One offence, one line: the manifest, the dependency, and the bound it wanted. */
export function offenceLine(offence: Offence): string {
  return `${offence.manifest}: ${offence.field}.${offence.dependency} is ${offence.value}, wanted ${offence.wanted}`;
}

/**
 * As much of a package.json as this reads. `engines` resolves nothing and
 * fetches nothing, `packageManager` is corepack's, and a `pnpm` key is neither;
 * none of the three is a dependency field, so none of them is in this schema and
 * a manifest that carries them passes through untouched.
 */
const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * Every offence in one manifest, in the order a reader would find them: field
 * by field, and within a field in the order the file writes them.
 *
 * A manifest read off disk is a claim like any other, so it goes through a
 * parser that can say no. A dependency value that is not a string is not a
 * range this can judge, and reporting it as a failing range would be a worse
 * answer than refusing the file by name.
 */
export function manifestOffences(manifest: string, text: string): readonly Offence[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    // A `SyntaxError` names a position and not a file, and this walks twelve of
    // them, so the bare message would send a reader looking through all twelve
    // for the one with a trailing comma in it.
    throw new Error(`${manifest} is not JSON: ${String(cause)}`, { cause });
  }

  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${manifest} is not a manifest this can read: ${parsed.error.message}`);
  }

  const offences: Offence[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependency, value] of Object.entries(parsed.data[field] ?? {})) {
      if (isAllowed(value)) continue;
      offences.push({ manifest, field, dependency, value, wanted: wantedFor(value) });
    }
  }
  return offences;
}

/**
 * The member globs, read out of `pnpm-workspace.yaml` rather than repeated here.
 *
 * A list of directories in two files is a list that disagrees with itself the
 * first time somebody adds a package, and the one that would go stale is this
 * one: pnpm fails loudly when its own file is wrong, while a check that quietly
 * stopped reading a member would report a clean workspace it had not looked at.
 *
 * It reads the one key it needs rather than the file: a YAML parser is a
 * dependency, and what is wanted here is a block of list items under `packages:`
 * ending at the next key. Anything else in the file -- `allowBuilds`, the
 * comments that carry its argument -- is none of this program's business.
 *
 * The part that has to be right is what an item's value ends at, because getting
 * it wrong is silent. `- packages/*` with a comment after it is a glob pnpm
 * reads as `packages/*`, and taking the comment as part of the glob would match
 * no directory, skip five manifests and print a smaller count that nobody would
 * think to disbelieve. So a trailing comment is stripped, and anything still
 * holding whitespace afterwards is refused by name rather than guessed at: this
 * reads a subset of YAML, and the honest failure for the rest is to say so.
 */
export function parseWorkspaceGlobs(source: string, text: string): readonly string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (start === -1) {
    throw new Error(`${source} declares no packages: key, so there are no members to check`);
  }

  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    // A sequence under a key may be indented or start at column 0; pnpm takes
    // both, so this does too. The first line that is neither blank, a comment
    // nor an item is the next key, and the list ended above it.
    const item = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (item?.[1] === undefined) break;
    globs.push(globFrom(source, line, item[1]));
  }

  if (globs.length === 0) {
    throw new Error(`${source} lists no members under packages:, so there is nothing to check`);
  }
  return globs;
}

/**
 * One item's value: what is left after a quoted scalar is unwrapped and an
 * unquoted trailing comment is dropped.
 *
 * A `#` opens a comment in YAML only when a space precedes it, so `a#b` is the
 * scalar `a#b` and ` # b` is a comment -- which is why the strip is anchored to
 * the whitespace rather than to the `#`.
 *
 * Whitespace left in the value means this did not understand the line. A glob
 * with a space in it is not something this tree has, and inventing a reading
 * for one would put the check back where the comment bug had it: looking at
 * fewer manifests than it says it did.
 */
function globFrom(source: string, line: string, item: string): string {
  const quoted = /^(['"])(.*?)\1\s*(?:#.*)?$/.exec(item);
  const glob = quoted?.[2] ?? item.replace(/\s+#.*$/, '');
  if (glob === '' || /\s/.test(glob)) {
    throw new Error(
      `${source} has a member this cannot read: ${line.trim()}. ` +
        'One glob per item, optionally quoted, with an optional trailing comment.',
    );
  }
  return glob;
}

/** Whether a path exists, asked of the filesystem rather than assumed. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every manifest the policy covers: the root's, which is a package.json in this
 * workspace whether or not pnpm calls it a member, and one per member directory
 * that has one. Sorted, so that a failing run reads the same way twice.
 *
 * This is the set git tracks, reached through the member list rather than
 * through git. The two coincide by construction: a manifest on disk that git
 * does not track is an assembled one, under a `dist/` or an app's `release/`, and
 * neither of those is a workspace member -- a member is a directory a glob in
 * `pnpm-workspace.yaml` matches, and no glob reaches inside one. So the
 * assembled manifests are not skipped by a rule that could be got wrong; they
 * are never candidates. `git ls-files '*package.json'` returns exactly what
 * this does, and was run to check it.
 *
 * Asking git directly would mean starting a child, which nothing in this
 * directory may do: `eslint.config.js` refuses `node:child_process` under
 * `scripts/**` and says why. Reading `.git/index` to get around that would be a
 * worse answer than the member list, which is what the policy is about anyway.
 *
 * A member glob can match a directory with no manifest -- `tests/*` matched a
 * README once -- and that is not an offence, it is not a package.
 */
export async function workspaceManifests(workspaceRoot: string): Promise<readonly string[]> {
  const source = 'pnpm-workspace.yaml';
  const globs = parseWorkspaceGlobs(source, await readFile(join(workspaceRoot, source), 'utf8'));

  const manifests = new Set<string>(['package.json']);
  for await (const match of glob([...globs], { cwd: workspaceRoot })) {
    const directory = match.split(/[\\/]/);
    if (directory.includes('node_modules')) continue;
    const path = [...directory, 'package.json'].join('/');
    if (await exists(join(workspaceRoot, path))) manifests.add(path);
  }
  return [...manifests].sort();
}

/**
 * The sweep itself: every manifest the policy covers, and every offence in
 * them. Both halves come back because the report names a count of manifests --
 * a check that found none would otherwise pass in silence, which is the one
 * failure mode a green run cannot tell you about.
 */
async function sweep(
  workspaceRoot: string,
): Promise<{ manifests: readonly string[]; offences: readonly Offence[] }> {
  const manifests = await workspaceManifests(workspaceRoot);
  const offences: Offence[] = [];
  for (const manifest of manifests) {
    const text = await readFile(join(workspaceRoot, manifest), 'utf8');
    offences.push(...manifestOffences(manifest, text));
  }
  return { manifests, offences };
}

/** Every offence in the workspace, manifest by manifest. */
export async function checkWorkspace(workspaceRoot: string): Promise<readonly Offence[]> {
  return (await sweep(workspaceRoot)).offences;
}

/**
 * The closing line, and the only place a document is named. The lines above it
 * already say what to write; this says where the argument for it is, for the
 * contributor who wants to disagree with the rule rather than satisfy it.
 */
const POLICY = 'The three forms, and why: CONTRIBUTING.md, "Dependency versions".';

/**
 * The report, as lines and a verdict, so that a test reads what an operator
 * reads. Writing them and choosing an exit code is `main`'s, which is the part
 * a test cannot call.
 */
export async function report(
  workspaceRoot: string,
): Promise<{ ok: boolean; lines: readonly string[] }> {
  const { manifests, offences } = await sweep(workspaceRoot);

  if (offences.length === 0) {
    return { ok: true, lines: [`${manifests.length} manifests checked, every range bounded`] };
  }
  return { ok: false, lines: [...offences.map(offenceLine), POLICY] };
}

/**
 * Run from the workspace root by `pnpm lint`, before eslint and prettier
 * because it costs milliseconds and a manifest nobody may merge should not wait
 * behind a full lint of the tree.
 *
 * The root is this file's parent and not the working directory: `pnpm lint`
 * runs at the root today, and a check that silently reported on whatever
 * directory it was started from would be a check that passes by accident.
 */
async function main(): Promise<void> {
  const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
  const { ok, lines } = await report(workspaceRoot);
  const stream = ok ? process.stdout : process.stderr;
  for (const line of lines) stream.write(`${line}\n`);
  if (!ok) process.exitCode = 1;
}

// Imported by its test; executed by `pnpm lint`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
