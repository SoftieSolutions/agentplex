import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Assemble the tree that gets published as `@softiesolutions/agentplex`.
 *
 * A bare machine must not need pnpm, vite or a checkout, so the package carries
 * the five compiled programs, the compiled packages they import, the built PWA
 * and the migrations inside it, and installation is `npm install --global
 * @softiesolutions/agentplex`. The command that arrives is `agentplex`: `bin`
 * maps a command name to a path and owes the package name nothing.
 *
 * ## The layout is the workspace's, on purpose
 *
 * The obvious package is a flat one: `dist/`, `migrations/`, `web/` at the
 * root. It is also a second layout, and a second layout means a second set of
 * relative paths that exist only in the published artifact and are therefore
 * exercised by nothing until somebody installs it. `main.ts` resolves its
 * migrations as `../migrations` and the client as `../../web/dist`; both
 * expressions are correct from source and correct in the runtime image because
 * both keep the workspace layout, and they are correct here for the same
 * reason. Packaging preserves the invariant rather than adding an exception to
 * it, and nothing under `main.ts` learns that a fourth home exists.
 *
 * ## The contents are data
 *
 * `packageEntries()` is the whole of what the tarball holds. A test can read
 * it, and an entry whose source was never built stops the assembly with the
 * paths named, rather than shipping a package that installs and then serves
 * 503 forever.
 */

/** Where the assembled tree is written, relative to the workspace root. */
export const OUTPUT_DIRECTORY = 'apps/install/release';

/** The manifest the bin belongs to: this app's. */
export const BIN_APP = 'apps/install';

/**
 * The apps in the package besides the one that owns the bin, and where each
 * lives. Each is copied at its workspace path, so `apps/hub/dist/main.js`
 * resolves its migrations and the client at the same distances it does in a
 * checkout, and what each needs is declared by the published manifest.
 */
export const OTHER_APPS: readonly BundledPackage[] = [
  { name: '@agentplex/hub', directory: 'apps/hub' },
  { name: '@agentplex/server', directory: 'apps/server' },
  { name: '@agentplex/setup', directory: 'apps/setup' },
  { name: '@agentplex/doctor', directory: 'apps/doctor' },
];

/** What the bin dispatches to, by name; what `main.ts` in this app imports by path. */
export const PROGRAMS = ['hub', 'server', 'setup', 'doctor'] as const;

/**
 * The workspace packages the compiled service imports, and where each lives.
 *
 * Every one is published under no name of its own, so each travels inside the
 * tarball as a bundled dependency, at the one path Node's resolver reaches from
 * `apps/install/dist/main.js`. The list is the whole of what gets bundled: a
 * package the service imports that is not here stops the assembly by name,
 * rather than shipping a tarball whose first import fails.
 */
export const BUNDLED_PACKAGES: readonly BundledPackage[] = [
  { name: '@agentplex/protocol', directory: 'packages/protocol' },
  { name: '@agentplex/node-shared', directory: 'packages/node-shared' },
  { name: '@agentplex/providers', directory: 'packages/providers' },
  { name: '@agentplex/pty', directory: 'packages/pty' },
];

export interface BundledPackage {
  readonly name: string;
  /** Relative to the workspace root. */
  readonly directory: string;
}

/**
 * The file `bin` links, in the package and in the workspace alike.
 *
 * Named once because two things have to agree about it: the manifest, and the
 * check that it is startable. `bin` is a path and not an interpreter -- a file
 * without a `#!` line is handed to the shell, which reads the first `import`
 * statement as a command name -- and nothing in this repository would notice,
 * because every other way of starting the service says `node` out loud.
 */
export const ENTRYPOINT = 'apps/install/dist/main.js';

/**
 * Dependencies the published package declares optional, by name.
 *
 * One entry, and the reason it is a list rather than a boolean on node-pty is
 * that the question "why is this optional" has to be answerable from here.
 *
 * node-pty is a native addon with no Linux prebuild, so npm compiles it from
 * source on every Linux install, and that compile is the single most likely
 * step of an install to fail: it needs python3, make and a C++ compiler, none
 * of which a stock `debian:bookworm-slim` has. It reaches this manifest as a
 * dependency of the bundled `@agentplex/pty`, carried up by the rule below
 * that a bundled package's needs are declared here -- and `@agentplex/pty`
 * reaches the package through the server and the wizard.
 *
 * The hub is the machine that never opens a pseudoterminal, and the hub was
 * paying that bill: `apps/hub` depends on node-shared, protocol, providers and
 * zod, and on nothing that touches a pty. Optional is what lets npm finish
 * without it.
 *
 * What optional costs, and what pays it back. npm exits 0 when an optional
 * dependency's build fails and removes the package from the tree without
 * printing an error -- verified against npm 11.19 -- so a server installed on a
 * machine with no compiler would otherwise report a clean install and then fail
 * to open a session. Three things close that, and none of them may be dropped
 * while this list has an entry in it: `agentplex server` refuses to start and
 * says what to install, `agentplex doctor` reports the seam as unusable, and
 * the package's own postinstall fails the install outright when
 * AGENTPLEX_REQUIRE_PTY says the machine is one that runs a server.
 */
export const OPTIONAL_DEPENDENCIES: readonly string[] = ['node-pty'];

/**
 * The one install script, at the workspace path, in the package and in the
 * workspace alike. It lives in the pty package because the helper it repairs
 * is node-pty's, and node-pty is declared there and nowhere else. It resolves
 * node-pty through `createRequire`, which from this path walks up to the
 * package's own `node_modules` in the published tree exactly as it walks up to
 * `packages/pty/node_modules` in a checkout.
 */
export const POSTINSTALL_SCRIPT = 'packages/pty/scripts/node-pty-postinstall.js';

/** Where a bundled dependency has to sit for Node's resolver to find it. */
function bundledDirectory(name: string): string {
  return `node_modules/${name}`;
}

/**
 * As much of a package.json as this needs to be sure of. Unknown fields are
 * kept out of the type and off the derived manifest: what the package declares
 * is decided here, not inherited by accident.
 */
const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  license: z.string(),
  type: z.literal('module'),
  engines: z.record(z.string(), z.string()).optional(),
  repository: z.unknown().optional(),
  dependencies: z.record(z.string(), z.string()).default({}),
});

export type Manifest = z.infer<typeof manifestSchema>;

/**
 * A package.json read off disk is external input like anything else, so it goes
 * through a parser that can say no rather than through a cast.
 */
export function parseManifest(source: string, text: string): Manifest {
  const parsed = manifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`${source} is not a manifest this can publish: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Names a compiled `dist` carries for the workspace and for nothing on a
 * machine that installed the package.
 *
 * **`*.js.map` and `*.d.ts.map`.** `tsc` emits them with `sources` naming
 * `../src/*.ts` and no `sourcesContent`, and the tarball carries no sources, so
 * every one of them resolves to nothing wherever the package is installed. The
 * `sourceMappingURL` comment left in the `.js` is read by nothing unless Node
 * is started with `--enable-source-maps`, and a map it cannot find is a map it
 * does not apply.
 *
 * **`*.d.ts`.** Nothing consumes types from this package. It is a bin and four
 * daemons, installed to be run and imported by no one, and the `types`
 * conditions the bundled manifests carry are read by TypeScript alone -- never
 * by Node's resolver, which resolves through `import`, `require` and `default`.
 *
 * **`testing.js` and the `fake-*` modules it re-exports.** A package exports
 * its fakes from a `testing` entry for the tests of the packages above it.
 * Every import of one is in a `.test.ts`, which `tsconfig.build.json` excludes
 * from the emit, so no compiled file in the package reaches `./testing` and no
 * test file ships to reach it either. The `./testing` subpath the bundled
 * manifests declare is left where it is: it can only be reached by an import
 * naming it, the package contains none, and stripping it would be the first
 * half of a job -- the `types` conditions dangle the same way for the same
 * reason -- that buys nothing a resolver would ever notice.
 */
function isWorkspaceOnly(name: string): boolean {
  return (
    name.endsWith('.map') ||
    name.endsWith('.d.ts') ||
    name === 'testing.js' ||
    name.startsWith('fake-')
  );
}

/** One thing copied into the package, and the path that proves it arrived. */
export interface PackageEntry {
  /** Relative to the workspace root. */
  readonly from: string;
  /** Relative to the package root, and the same as `from` wherever it can be. */
  readonly to: string;
  readonly kind: 'directory' | 'file';
  /**
   * A path inside `from` whose absence means that source was never built. A
   * directory that exists and is empty is the shape a half-finished build
   * leaves behind, and it is indistinguishable from a good one by `stat` alone.
   */
  readonly proof?: string;
  /**
   * Given the name of a file inside `from`, whether to leave it behind. It is
   * asked about file names only: see `copyFilter`.
   */
  readonly exclude?: (name: string) => boolean;
  /** Why this is in the package. */
  readonly reason: string;
}

/**
 * A `cp` filter that drops files by name and never prunes a directory.
 *
 * `cp` asks the filter about every entry it walks, directories included, and a
 * `false` for a directory takes everything beneath it as well -- verified
 * against Node 24.20. So a name test alone would turn a directory called
 * `fake-parent` into a missing program, which is why the directory is
 * established first and only files are ever refused.
 */
function copyFilter(exclude: (name: string) => boolean): (source: string) => Promise<boolean> {
  return async (source: string): Promise<boolean> => {
    if ((await lstat(source)).isDirectory()) return true;
    return !exclude(basename(source));
  };
}

/**
 * Everything the published package holds, apart from the two manifests this
 * module writes itself.
 */
export function packageEntries(): readonly PackageEntry[] {
  return [
    {
      from: 'apps/install/dist',
      to: 'apps/install/dist',
      kind: 'directory',
      proof: 'main.js',
      exclude: isWorkspaceOnly,
      reason: 'the agentplex bin, dispatching to the four programs below by path',
    },
    ...PROGRAMS.map((program): PackageEntry => ({
      from: `apps/${program}/dist`,
      to: `apps/${program}/dist`,
      kind: 'directory',
      proof: 'main.js',
      exclude: isWorkspaceOnly,
      reason: `the compiled ${program}`,
    })),
    {
      from: 'apps/hub/migrations',
      to: 'apps/hub/migrations',
      kind: 'directory',
      proof: '0001_hub_identity.sql',
      reason: 'the schema the hub applies before it listens',
    },
    {
      from: POSTINSTALL_SCRIPT,
      to: POSTINSTALL_SCRIPT,
      kind: 'file',
      reason: "the package's postinstall",
    },
    {
      from: 'apps/web/dist',
      to: 'apps/web/dist',
      kind: 'directory',
      proof: 'index.html',
      // Whole, map included, unlike every compiled directory above. Vite
      // writes `sourcesContent` into it, so it is the one map in the package
      // that resolves without a checkout, and a browser is the thing that
      // fetches it -- only when devtools are open, and from a machine that is
      // already reading the bundle beside it.
      reason: 'the built PWA the hub serves',
    },
    ...BUNDLED_PACKAGES.map((bundled): PackageEntry => ({
      from: `${bundled.directory}/dist`,
      to: `${bundledDirectory(bundled.name)}/dist`,
      kind: 'directory',
      proof: 'index.js',
      exclude: isWorkspaceOnly,
      reason: `the compiled ${bundled.name}, bundled because it is published nowhere`,
    })),
    {
      from: 'LICENSE',
      to: 'LICENSE',
      kind: 'file',
      reason: 'Apache-2.0, which npm shows on the package page',
    },
    {
      from: 'apps/install/README.md',
      to: 'README.md',
      kind: 'file',
      reason: 'the package page: what this is, and what installing it needs',
    },
  ];
}

/**
 * Every version this can publish, as semver.org writes it: three numeric parts
 * with no leading zeroes, an optional prerelease, an optional build.
 *
 * Written out rather than pulled from a package, because it is read once per
 * release and a dependency whose install script runs on a machine holding a
 * publish token is a worse trade than a regular expression with a citation.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * The version a release tag names.
 *
 * Nothing in this workspace carries a version: every manifest says `0.0.0` and
 * no script bumps one, because a version in a manifest is a second place the
 * release lives and the day it disagrees with the tag, the tarball on npm and
 * the commit it claims to come from are different things. The tag is the
 * single statement of what is being released, and this is the one reader of
 * it.
 *
 * The tag is an argument out of another program, so it is parsed rather than
 * trusted: a tag the workflow's `v*` filter admits but semver does not -- a
 * `v1.2`, a `vlatest`, a branch somebody tagged -- stops the release with the
 * tag named, instead of publishing a version npm will happily accept and
 * nobody can install by the range they meant.
 */
export function versionFromTag(tag: string): string {
  if (!tag.startsWith('v')) {
    throw new Error(`a release tag is \`v<semver>\`, and this one is ${tag}`);
  }
  const version = tag.slice(1);
  if (!SEMVER.test(version)) {
    throw new Error(`a release tag is \`v<semver>\`, and this one is ${tag}`);
  }
  return version;
}

/**
 * The manifest the package is published with.
 *
 * Derived from the workspace's rather than written twice: a hand-kept copy is a
 * second place the dependency ranges live, and the day they disagree the
 * package installs a `ws` that nothing here was tested against.
 *
 * Four things are decided rather than inherited.
 *
 * **`private` is gone, and `devDependencies` never arrive.** The workspace
 * manifest is private precisely so that a stray `npm publish` in a checkout
 * cannot ship it. The publishable manifest is made here, in a staging directory
 * that holds no sources, so the thing that can be published is the thing that
 * was assembled.
 *
 * **A `workspace:` range becomes a bundled dependency.** No workspace package
 * is published under a name of its own, so a range pointing at a registry
 * entry would be a dependency on a package that does not exist. Each one
 * travels inside the tarball instead, at the one path Node's resolver reaches
 * from `apps/install/dist/main.js`, and a bundled package's own workspace
 * dependencies have to be bundled too, since the resolver walks up out of one
 * bundled directory into the next.
 *
 * **What a bundled package needs, the published package declares.** npm treats
 * every dependency of a bundled dependency as bundled too and never fetches it,
 * so `bundledManifest` drops the field and the ranges are carried up here
 * instead. One range per dependency name, across every manifest that goes in:
 * nothing takes precedence over anything, and two manifests asking for
 * different ranges of the same thing stop the assembly, because a tarball
 * cannot carry both and picking one silently would ship a dependency that one
 * of them was never tested against.
 *
 * **The version comes from the release, not from the manifest.** Every manifest
 * in the workspace says `0.0.0`, deliberately: the tag is the single statement
 * of what is being released, and a version kept in a file as well is a second
 * statement that drifts. `version` is the seam the release writes through, so
 * the manifest is built with the released version rather than assembled and
 * then edited -- an edit is a step between what was checked and what is
 * published, and there is nowhere for one to go wrong if it does not exist.
 * Without an override this falls back to the service manifest, which is what a
 * contributor assembling locally wants: the same `0.0.0` the workspace says.
 *
 * **The name is the service manifest's, and there is no `publishConfig`.** The
 * unscoped `agentplex` on npm is an unrelated placeholder, so `apps/install`
 * is named `@softiesolutions/agentplex` and this reads that name rather than
 * holding a second copy of it -- `bin` is written below and stays `agentplex`,
 * because a command name and a package name are independent. A scoped
 * package's first publish needs `--access public`, and the release workflow
 * passes it unconditionally on the command line; declaring it here as well
 * would be the same fact in two places, and the only place it is ever read
 * from is the one that runs the publish.
 *
 * **`engines` keeps node and drops pnpm.** The whole point of the artifact is a
 * machine with Node and nothing else; declaring pnpm would make the package
 * refuse the machine it was built for.
 *
 * **The `postinstall` survives, deliberately.** node-pty ships prebuilt
 * binaries for macOS and Windows, the npm tarball drops the executable bit from
 * the `spawn-helper` beside them, and the only symptom is `posix_spawnp
 * failed.` out of a native addon, for a session that never starts. On Linux
 * node-gyp compiles and sets the bit, so this artifact is the first one where
 * the prebuilt path is the common one. It is also the one place that can still
 * turn a skipped optional build into a failed install, which is what
 * AGENTPLEX_REQUIRE_PTY asks it for on a machine that runs a server.
 *
 * **`optionalDependencies` is a field, not an afterthought.** See
 * `OPTIONAL_DEPENDENCIES`: one name goes there, npm is then allowed to finish
 * without it, and three other things exist to stop that being a silent success.
 */
export function publishedManifest(input: {
  readonly root: Manifest;
  readonly service: Manifest;
  /** The other apps in the package: what they need, the package declares too. */
  readonly apps?: readonly Manifest[];
  readonly bundled: readonly Manifest[];
  /** The version the release names. Absent outside a release. */
  readonly version?: string;
}): Record<string, unknown> {
  const versions = new Map(input.bundled.map((manifest) => [manifest.name, manifest.version]));
  const dependencies: Record<string, string> = {};
  const optional: Record<string, string> = {};
  const declaredBy = new Map<string, string>();
  const bundleDependencies = new Set<string>();

  // The service first, then the other apps, then each bundled package. The
  // order decides nothing but which manifest an error names as the incumbent:
  // there is one range per dependency name across all of them, and a
  // disagreement stops the assembly rather than resolving to a winner.
  for (const manifest of [input.service, ...(input.apps ?? []), ...input.bundled]) {
    for (const name of Object.keys(manifest.dependencies).sort()) {
      const range = manifest.dependencies[name] ?? '';
      if (range.startsWith('workspace:')) {
        const version = versions.get(name);
        if (version === undefined) {
          throw new Error(
            `${name} is a workspace dependency of ${manifest.name} and nothing bundles it`,
          );
        }
        // Exact, not a range: the copy in the tarball is the only copy there
        // will ever be, so a range would describe a choice npm does not get to
        // make.
        dependencies[name] = version;
        bundleDependencies.add(name);
        continue;
      }
      // An optional dependency is carried up the same way and lands in a
      // different field. The name is what decides, not the manifest it came
      // from: node-pty is an ordinary dependency of `packages/pty`, which is
      // correct -- a checkout that cannot compile it cannot run its tests --
      // and it is the published package, installed on machines that run only a
      // hub, that has a reason to let npm continue without it.
      const into = OPTIONAL_DEPENDENCIES.includes(name) ? optional : dependencies;

      const existing = into[name];
      if (existing === undefined) {
        into[name] = range;
        declaredBy.set(name, manifest.name);
        continue;
      }
      // npm never fetches a bundled package's own dependencies: `zod` declared
      // by a bundled package while the tarball carries no `node_modules/zod`
      // installs as an empty directory, and the first import dies with
      // ERR_MODULE_NOT_FOUND from a package npm says is installed. Verified
      // against npm 11.19. So the range is carried up here, and one range per
      // name is the invariant that keeps carrying it up honest.
      if (existing !== range && !bundleDependencies.has(name)) {
        throw new Error(
          `${manifest.name} needs ${name}@${range} and ${declaredBy.get(name) ?? 'the service'} ` +
            `needs ${name}@${existing}: one range, declared in both manifests, or the tarball ` +
            'ships a dependency one of them was never tested against',
        );
      }
    }
  }

  const node = input.root.engines?.['node'];
  if (node === undefined) throw new Error('the root manifest declares no node engine');

  return {
    name: input.service.name,
    version: input.version ?? input.service.version,
    description: input.root.description ?? '',
    license: input.service.license,
    ...(input.root.repository === undefined ? {} : { repository: input.root.repository }),
    type: 'module',
    engines: { node },
    bin: { agentplex: `./${ENTRYPOINT}` },
    // The staging directory holds only what belongs in the package, so this
    // changes nothing about what npm packs. It is here so that the contents are
    // legible from the manifest -- and reviewable in a diff to it -- without
    // running `npm pack`. A bundled dependency is not listed: npm always
    // excludes `node_modules` from a tarball and then adds the bundled subtrees
    // back, and `files` has no say either way.
    files: packageEntries()
      .map((entry) => entry.to)
      .filter((path) => !path.startsWith('node_modules/')),
    scripts: { postinstall: `node ${POSTINSTALL_SCRIPT}` },
    dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
    optionalDependencies: Object.fromEntries(Object.entries(optional).sort()),
    bundleDependencies: [...bundleDependencies].sort(),
  };
}

/**
 * What `exports` is allowed to hold.
 *
 * Node resolves a subpath to a string, to a `null` that refuses it, to an array
 * of alternatives, or to a map of conditions holding more of the same, nested
 * as deep as a package cares to nest it. This is carried across untouched, so
 * the schema describes that shape and flattens nothing: a type that stopped one
 * level down would either reject the conditional exports every package here
 * writes or quietly drop what it could not name, and either way the bundled
 * directory is one the resolver cannot enter.
 */
export type ExportsEntry =
  string | null | readonly ExportsEntry[] | { readonly [condition: string]: ExportsEntry };

const exportsSchema: z.ZodType<ExportsEntry> = z.lazy(() =>
  z.union([z.string(), z.null(), z.array(exportsSchema), z.record(z.string(), exportsSchema)]),
);

/**
 * Exactly the fields a bundled package is extracted with. Everything else a
 * workspace manifest carries is dropped by parsing it away, and an optional
 * field the source never declared is absent from the result rather than present
 * and undefined, so the object and the JSON written from it say the same thing.
 */
const bundledManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.string(),
  type: z.literal('module'),
  sideEffects: z.union([z.boolean(), z.array(z.string())]).optional(),
  exports: exportsSchema.optional(),
  main: z.string().optional(),
  types: z.string().optional(),
});

export type BundledManifest = z.infer<typeof bundledManifestSchema>;

/**
 * The manifest the bundled protocol is extracted with.
 *
 * Its `exports` is what makes the bundled directory resolvable, so that is
 * carried across untouched. Everything that only means something inside a
 * workspace -- `private`, the scripts, the dev dependencies -- is dropped,
 * because a consumer's npm reads this file and none of it is true there.
 *
 * `dependencies` is dropped too, and that one is not tidying. npm considers a
 * bundled package's dependencies bundled as well and will not fetch them, so a
 * declaration the tarball does not satisfy installs an empty directory: `npm
 * ls` reports `zod@ invalid`, the install exits 0, and the first import fails
 * with ERR_MODULE_NOT_FOUND against a package npm believes is present. The
 * protocol's needs are declared by the package that carries it -- see the guard
 * in `publishedManifest` -- and Node's resolver walks up out of the bundled
 * directory to find them, which is the same walk it does in the workspace.
 *
 * `bundledManifestSchema` is the whole of what survives, so what a bundled package
 * declares is decided here rather than inherited: an unreadable source stops
 * the assembly with its path named, and a field nobody listed cannot reach a
 * consumer's npm by accident.
 */
export function bundledManifest(source: string, text: string): BundledManifest {
  const parsed = bundledManifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`${source} is not a manifest this can bundle: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** A source the assembly needs and did not find. */
export interface MissingInput {
  readonly path: string;
  readonly reason: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every input that is not there, rather than the first one.
 *
 * Somebody who has not built the workspace is missing three of these, and one
 * message per run would send them round the loop three times.
 */
export async function missingInputs(
  workspaceRoot: string,
  entries: readonly PackageEntry[],
): Promise<readonly MissingInput[]> {
  const missing: MissingInput[] = [];
  for (const entry of entries) {
    const source = join(workspaceRoot, entry.from);
    if (!(await exists(source))) {
      missing.push({ path: entry.from, reason: entry.reason });
      continue;
    }
    if (entry.proof !== undefined && !(await exists(join(source, entry.proof)))) {
      missing.push({ path: join(entry.from, entry.proof), reason: entry.reason });
    }
  }
  return missing;
}

export interface AssembledPackage {
  readonly directory: string;
  readonly manifest: Record<string, unknown>;
  readonly entries: readonly PackageEntry[];
}

/**
 * Write the package into `<workspaceRoot>/<OUTPUT_DIRECTORY>`, replacing
 * whatever was there.
 *
 * Replacing rather than merging: a staging directory that keeps yesterday's
 * `dist` beside today's is the one way to publish a file no build produced.
 */
export async function assemblePackage(options: {
  readonly workspaceRoot: string;
  /** The version the release names; see `publishedManifest`. Absent outside a release. */
  readonly version?: string;
  readonly log?: (line: string) => void;
}): Promise<AssembledPackage> {
  const { workspaceRoot } = options;
  const log = options.log ?? ((): void => {});
  const entries = packageEntries();

  const missing = await missingInputs(workspaceRoot, entries);
  if (missing.length > 0) {
    const lines = missing.map((item) => `  ${item.path} -- ${item.reason}`);
    throw new Error(`nothing to package; run \`pnpm build\` first:\n${lines.join('\n')}`);
  }

  if (!(await readFile(join(workspaceRoot, ENTRYPOINT), 'utf8')).startsWith('#!')) {
    throw new Error(
      `${ENTRYPOINT} has no shebang, so \`bin\` would link a file the kernel hands to the shell`,
    );
  }

  const read = async (path: string): Promise<string> =>
    await readFile(join(workspaceRoot, path), 'utf8');
  const rootManifest = parseManifest('package.json', await read('package.json'));
  const serviceManifest = parseManifest(
    `${BIN_APP}/package.json`,
    await read(`${BIN_APP}/package.json`),
  );
  const bundled = await Promise.all(
    BUNDLED_PACKAGES.map(async (item) => {
      const path = `${item.directory}/package.json`;
      const text = await read(path);
      return { item, path, text, manifest: parseManifest(path, text) };
    }),
  );

  const apps = await Promise.all(
    OTHER_APPS.map(async (item) => {
      const path = `${item.directory}/package.json`;
      return parseManifest(path, await read(path));
    }),
  );

  const manifest = publishedManifest({
    root: rootManifest,
    service: serviceManifest,
    apps,
    bundled: bundled.map((entry) => entry.manifest),
    ...(options.version === undefined ? {} : { version: options.version }),
  });

  const directory = join(workspaceRoot, OUTPUT_DIRECTORY);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  for (const entry of entries) {
    const destination = join(directory, entry.to);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(workspaceRoot, entry.from), destination, {
      recursive: entry.kind === 'directory',
      ...(entry.exclude === undefined ? {} : { filter: copyFilter(entry.exclude) }),
    });
    log(`  ${entry.to}  ${entry.reason}`);
  }

  for (const entry of bundled) {
    await writeJson(
      join(directory, bundledDirectory(entry.item.name), 'package.json'),
      bundledManifest(entry.path, entry.text),
    );
  }
  await writeJson(join(directory, 'package.json'), manifest);
  log(`  package.json  ${String(manifest['name'])}@${String(manifest['version'])}`);

  return { directory, manifest, entries };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Run from the workspace root, after `pnpm build`. It writes a directory and
 * nothing more: publishing is a separate, deliberate command aimed at the tree
 * this leaves behind.
 *
 * The one argument is the release tag, which the workflow passes as
 * `pnpm --filter ./apps/install package "$GITHUB_REF_NAME"` and a contributor
 * passes never. Without it the package is assembled at the workspace's own
 * `0.0.0`, which is assembleable, installable from a tarball, and not
 * publishable -- exactly the distinction between a local check and a release.
 */
async function main(): Promise<void> {
  const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const tag = process.argv[2];
  const assembled = await assemblePackage({
    workspaceRoot,
    ...(tag === undefined ? {} : { version: versionFromTag(tag) }),
    log: (line) => void process.stdout.write(`${line}\n`),
  });
  process.stdout.write(`assembled ${relative(workspaceRoot, assembled.directory)}\n`);
}

// Imported by its test; executed by `pnpm --filter ./apps/install package`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
