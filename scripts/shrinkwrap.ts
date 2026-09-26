import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * The `npm-shrinkwrap.json` each published package carries, derived from the
 * `pnpm-lock.yaml` CI installed from.
 *
 * A published manifest declares ranges, and npm resolves ranges fresh against
 * the registry on every machine that installs the package. The lockfile is
 * what pins the versions CI tested, transitive ones included, and a shrinkwrap
 * is the one lockfile npm reads out of a package it installs. So the
 * derivation's job is to say, in npm's layout, what pnpm already decided.
 *
 * The shape is what the probes on AGX-322 established against npm 11.19, each
 * requirement a failure somebody watched rather than a reading of the docs:
 *
 * - Every entry carries its edges, `dependencies` and `optionalDependencies` at
 *   the exact versions pnpm resolved. Without them npm prunes every transitive
 *   as unreachable and `npm ls --all` still exits 0 (Q10).
 * - No `resolved`, so a missing entry is fetched from whatever registry the
 *   installing machine is configured with, and `integrity` checks the bytes
 *   (Q4). A bundled entry carries neither: npm leaves it alone (Q13).
 * - A peer is written as a peer. A required one is placed beside its dependent;
 *   an optional one, which pnpm lists among a snapshot's
 *   `optionalDependencies` once it has resolved it, is not placed (Q12).
 * - `optional: true` on everything only optional edges reach, so a machine with
 *   no compiler drops the command's node-pty and exits 0 (Q3).
 * - `hasInstallScript: true` on the names `pnpm-workspace.yaml` lets build.
 *   Without it npm runs an implicit `node-gyp rebuild` and never node-pty's own
 *   lifecycle (Q11). pnpm's lockfile records nothing to read this from.
 * - Every entry satisfies the edge that reaches it. An entry that does not is
 *   not an error to npm: it installs the registry's newest instead and exits 0
 *   (Q5b). The placement below is checked for that before anything is written.
 *
 * Why a derivation rather than `npm install --package-lock-only` against the
 * published manifest: that would resolve the ranges against the registry again,
 * on the day the package is assembled, which is exactly the fresh resolution
 * this file exists to take out of the install.
 */

/** The file npm reads out of an installed package, at the package root. */
export const SHRINKWRAP_FILE = 'npm-shrinkwrap.json';

/** The lockfile, at the workspace root. */
export const LOCKFILE = 'pnpm-lock.yaml';

/** The workspace file, at the workspace root, whose `allowBuilds` this reads. */
export const WORKSPACE_FILE = 'pnpm-workspace.yaml';

const dependencyMap = z.record(z.string(), z.string());

const importerSection = z.record(
  z.string(),
  z.object({ specifier: z.string(), version: z.string() }),
);

const importerSchema = z.object({
  dependencies: importerSection.optional(),
  optionalDependencies: importerSection.optional(),
  devDependencies: importerSection.optional(),
});

/**
 * What a `packages` entry says about a package whatever it was resolved
 * against. `resolution` holds an `integrity` for a registry package and a
 * `tarball` or a `repo` for anything else; the second kind is parsed and then
 * refused where it is used, naming the package, rather than refused here for
 * the whole file.
 */
const packageSchema = z.object({
  resolution: z.object({ integrity: z.string().optional() }),
  engines: dependencyMap.optional(),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
  libc: z.array(z.string()).optional(),
  peerDependencies: dependencyMap.optional(),
  peerDependenciesMeta: z
    .record(z.string(), z.object({ optional: z.boolean().optional() }))
    .optional(),
  bundledDependencies: z.union([z.array(z.string()), z.boolean()]).optional(),
});

/**
 * What a `snapshots` entry says about one package in one peer context: the
 * versions its dependencies resolved to, each still carrying its own peer
 * suffix so that it names the snapshot to follow next.
 */
const snapshotSchema = z.object({
  dependencies: dependencyMap.optional(),
  optionalDependencies: dependencyMap.optional(),
});

/**
 * The lockfile, as far as this reads it. Version 9.0 is the format this was
 * written against: `importers`, `packages` and `snapshots` as three sections,
 * and a peer suffix on a snapshot key. Another version is refused rather than
 * read as though it were this one.
 */
const lockfileSchema = z.object({
  lockfileVersion: z.literal('9.0'),
  importers: z.record(z.string(), importerSchema),
  packages: z.record(z.string(), packageSchema).default({}),
  snapshots: z.record(z.string(), snapshotSchema).default({}),
});

export type Lockfile = z.infer<typeof lockfileSchema>;
type LockfilePackage = z.infer<typeof packageSchema>;

function parseYamlFile(path: string, text: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not YAML this can read: ${reason}`);
  }
}

/** The lockfile off disk, through a parser that can say no. */
export function parseLockfile(path: string, text: string): Lockfile {
  const parsed = lockfileSchema.safeParse(parseYamlFile(path, text));
  if (!parsed.success) {
    throw new Error(
      `${path} is not a pnpm lockfile this can read: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * `allowBuilds` names a package by name alone. A key with a version selector
 * would let some versions build and not others, which a name-keyed
 * `hasInstallScript` cannot say, so it is refused rather than read as the name.
 */
const workspaceSchema = z.object({
  allowBuilds: z
    .record(
      z.string().regex(/^(@[^@/]+\/)?[^@/]+$/, 'a package name with no version selector'),
      z.boolean(),
    )
    .optional(),
});

/**
 * The packages whose install scripts the workspace lets run: `pnpm-workspace.yaml`'s
 * `allowBuilds`, the names set to `true`.
 */
export function parseAllowBuilds(path: string, text: string): readonly string[] {
  const parsed = workspaceSchema.safeParse(parseYamlFile(path, text));
  if (!parsed.success) {
    throw new Error(
      `${path} is not a pnpm workspace this can read: ${z.prettifyError(parsed.error)}`,
    );
  }
  return Object.entries(parsed.data.allowBuilds ?? {})
    .filter(([, allowed]) => allowed)
    .map(([name]) => name);
}

/**
 * The fields of a published manifest the root entry repeats and the walk
 * starts from. The manifest is the assembly's own output, and it is still
 * parsed: this file is called with whatever it is handed.
 */
const publishedSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.string().optional(),
  engines: dependencyMap.optional(),
  bin: z.union([z.string(), dependencyMap]).optional(),
  scripts: dependencyMap.optional(),
  dependencies: dependencyMap.default({}),
  optionalDependencies: dependencyMap.default({}),
  bundleDependencies: z.array(z.string()).default([]),
});

/** The lifecycle scripts npm runs at install, which `hasInstallScript` stands for. */
const INSTALL_SCRIPTS: readonly string[] = ['preinstall', 'install', 'postinstall'];

/** The root entry: the published manifest, restated. */
export interface ShrinkwrapRoot {
  readonly name: string;
  readonly version: string;
  readonly license?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly bundleDependencies?: readonly string[];
  readonly engines?: Readonly<Record<string, string>>;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly hasInstallScript?: true;
}

/** One package at one path in npm's `node_modules` layout. */
export interface ShrinkwrapEntry {
  readonly version: string;
  readonly integrity?: string;
  readonly inBundle?: true;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<
    Record<string, { readonly optional?: boolean | undefined }>
  >;
  readonly engines?: Readonly<Record<string, string>>;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
  readonly hasInstallScript?: true;
  readonly optional?: true;
}

export interface Shrinkwrap {
  readonly name: string;
  readonly version: string;
  readonly lockfileVersion: 3;
  readonly requires: true;
  /** `''` is the root; every other key is a `node_modules/...` path. */
  readonly packages: Readonly<Record<string, ShrinkwrapRoot | ShrinkwrapEntry>>;
}

/**
 * A version as pnpm writes one in `importers` and `snapshots`: a registry
 * version, then one parenthesised peer context per resolved peer. An alias
 * (`string-width@4.2.3`), a `link:` or a URL is none of these, and a
 * shrinkwrap would have to say each one differently; none is in a published
 * closure, so each is refused where it is met rather than guessed at.
 */
const RESOLVED = /^(\d+\.\d+\.\d+[^()]*)((?:\(.+\))*)$/;

function withoutPeers(version: string): string | undefined {
  return RESOLVED.exec(version)?.[1];
}

/** `node_modules/<name>` under `owner`, which is `''` for the package root. */
function under(owner: string, name: string): string {
  return owner === '' ? `node_modules/${name}` : `${owner}/node_modules/${name}`;
}

/** The directory whose `node_modules` holds `location`: `''` at the top. */
function ownerOf(location: string): string {
  const cut = location.lastIndexOf('/node_modules/');
  return cut === -1 ? '' : location.slice(0, cut);
}

/** `owner` and every directory above it, nearest first, ending at the root. */
function ownersFrom(owner: string): readonly string[] {
  const owners = [owner];
  let at = owner;
  while (at !== '') {
    at = ownerOf(at);
    owners.push(at);
  }
  return owners;
}

/** One package placed in the tree, and what reaches out of it. */
interface Placed {
  readonly name: string;
  readonly version: string;
  readonly location: string;
  /** The snapshot keys it was reached through: one per peer context. */
  readonly contexts: Set<string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /** Where each edge landed, so reachability and the final check need no second walk. */
  readonly required: Map<string, string>;
  readonly optional: Map<string, string>;
  readonly peers: Map<string, string>;
}

/**
 * The shrinkwrap for one published package.
 *
 * `manifest` is the manifest the package is published with, and the walk
 * starts from its `dependencies` and `optionalDependencies`, not from an
 * importer: the hub's importer links the client, which its published manifest
 * deliberately does not declare. `importers` are the workspace directories
 * whose lockfile entries resolve those names -- the app and every package it
 * bundles, because the assembly lifts a bundled package's third-party
 * dependencies into the published manifest. `installScripts` is the
 * workspace's `allowBuilds`.
 */
export function deriveShrinkwrap(input: {
  readonly lockfile: Lockfile;
  /** For messages: the file the lockfile was read from. */
  readonly lockfilePath: string;
  readonly manifest: Record<string, unknown>;
  readonly importers: readonly string[];
  readonly installScripts: readonly string[];
}): Shrinkwrap {
  const { lockfile, lockfilePath } = input;
  const parsedManifest = publishedSchema.safeParse(input.manifest);
  if (!parsedManifest.success) {
    throw new Error(
      `the published manifest is not one this can derive a shrinkwrap for: ${z.prettifyError(parsedManifest.error)}`,
    );
  }
  const manifest = parsedManifest.data;

  for (const directory of input.importers) {
    if (lockfile.importers[directory] === undefined) {
      throw new Error(
        `${lockfilePath} has no importer ${directory}: run \`pnpm install\` so the lockfile covers the workspace`,
      );
    }
  }

  const packageOf = (name: string, version: string): LockfilePackage => {
    const found = lockfile.packages[`${name}@${version}`];
    if (found === undefined) {
      throw new Error(`${lockfilePath} has no packages entry for ${name}@${version}`);
    }
    if (found.bundledDependencies !== undefined) {
      throw new Error(
        `${name}@${version} bundles dependencies of its own, which this derivation does not place`,
      );
    }
    return found;
  };

  const tree = new Map<string, Placed>();
  const queue: { readonly node: Placed; readonly key: string }[] = [];
  const root: Placed = {
    name: manifest.name,
    version: manifest.version,
    location: '',
    contexts: new Set(),
    required: new Map(),
    optional: new Map(),
    peers: new Map(),
  };

  /**
   * Put `name` at `version` where `requester` resolves it, and return where.
   *
   * The nearest copy up the requester's chain is reused when it is the same
   * version. When it is another, the package goes directly under the requester,
   * which is the one directory nothing else resolves through: a copy placed
   * part-way up would be found first by everything below it that had already
   * settled on the copy further up. When there is none, it goes to the top.
   *
   * A peer is resolved from the requester's parent rather than from inside it,
   * because that is where npm looks for one: a peer nested under its own
   * dependent is a peer npm reports as invalid.
   */
  const place = (requester: Placed, name: string, key: string, peer: boolean): string => {
    const version = withoutPeers(key.slice(name.length + 1));
    if (version === undefined) {
      throw new Error(
        `${requester.name} depends on ${key} in ${lockfilePath}, which is not a registry version this can pin`,
      );
    }
    const owners = ownersFrom(peer ? ownerOf(requester.location) : requester.location);
    let location = under('', name);
    for (const owner of owners) {
      const existing = tree.get(under(owner, name));
      if (existing === undefined) continue;
      if (existing.version === version) {
        if (!existing.contexts.has(key)) {
          existing.contexts.add(key);
          queue.push({ node: existing, key });
        }
        return existing.location;
      }
      const nearest = owners[0] ?? '';
      if (owner === nearest) {
        throw new Error(
          `${requester.name} needs ${name}@${version} where ${name}@${existing.version} ` +
            `already sits, at ${existing.location}`,
        );
      }
      location = under(nearest, name);
      break;
    }
    packageOf(name, version);
    const node: Placed = {
      name,
      version,
      location,
      contexts: new Set([key]),
      required: new Map(),
      optional: new Map(),
      peers: new Map(),
    };
    tree.set(location, node);
    queue.push({ node, key });
    return location;
  };

  const bundled = new Set(manifest.bundleDependencies);
  const inBundle = new Map<string, string>();
  const rootEdges = [
    ...Object.entries(manifest.dependencies).map(([name, range]) => ({
      name,
      range,
      optional: false,
    })),
    ...Object.entries(manifest.optionalDependencies).map(([name, range]) => ({
      name,
      range,
      optional: true,
    })),
  ].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  for (const edge of rootEdges) {
    if (bundled.has(edge.name)) {
      // The copy in the tarball, at the version the manifest pins it to:
      // nothing to resolve, nothing to fetch, nothing below it to walk.
      inBundle.set(under('', edge.name), edge.range);
      continue;
    }
    const version = resolvedByImporters(
      lockfile,
      lockfilePath,
      input.importers,
      edge.name,
      edge.range,
    );
    const location = place(root, edge.name, `${edge.name}@${version}`, false);
    (edge.optional ? root.optional : root.required).set(edge.name, location);
  }

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { node, key } = next;
    const snapshot = lockfile.snapshots[key];
    if (snapshot === undefined) throw new Error(`${lockfilePath} has no snapshot ${key}`);
    const known = packageOf(node.name, node.version);
    const peers = known.peerDependencies ?? {};
    const optionalPeer = (name: string): boolean =>
      known.peerDependenciesMeta?.[name]?.optional === true;

    const dependencies: Record<string, string> = {};
    const optionalDependencies: Record<string, string> = {};
    const sections = [
      { entries: snapshot.dependencies ?? {}, optional: false },
      { entries: snapshot.optionalDependencies ?? {}, optional: true },
    ];
    for (const section of sections) {
      for (const name of Object.keys(section.entries).sort()) {
        const value = section.entries[name] ?? '';
        if (Object.hasOwn(peers, name)) {
          // An optional peer is the dependent's to accept, not to install.
          if (optionalPeer(name)) continue;
          node.peers.set(name, place(node, name, `${name}@${value}`, true));
          continue;
        }
        const location = place(node, name, `${name}@${value}`, false);
        const version = tree.get(location)?.version ?? '';
        (section.optional ? optionalDependencies : dependencies)[name] = version;
        (section.optional ? node.optional : node.required).set(name, location);
      }
    }

    // Two peer contexts of one version are one directory on disk, so they had
    // better agree on everything but their peers.
    const edges = JSON.stringify([dependencies, optionalDependencies]);
    if (node.dependencies !== undefined) {
      if (JSON.stringify([node.dependencies, node.optionalDependencies]) !== edges) {
        throw new Error(
          `${node.name}@${node.version} resolves different dependencies in two peer contexts of ${lockfilePath}`,
        );
      }
    }
    node.dependencies = dependencies;
    node.optionalDependencies = optionalDependencies;
  }

  const lookup = (from: string, name: string): string | undefined =>
    ownersFrom(from)
      .map((owner) => under(owner, name))
      .find((location) => tree.has(location) || inBundle.has(location));

  // A later placement may have landed between an earlier requester and the copy
  // it settled on. Every edge is resolved again the way Node and npm will, and
  // a tree in which one lands elsewhere is refused rather than written: npm
  // would install whatever the registry has instead and exit 0.
  for (const node of tree.values()) {
    const check = (edges: ReadonlyMap<string, string>, from: string): void => {
      for (const [name, location] of edges) {
        if (lookup(from, name) !== location) {
          throw new Error(
            `${node.name}@${node.version} at ${node.location} would resolve ${name} ` +
              `somewhere other than ${location}; this layout cannot hold ${lockfilePath}`,
          );
        }
      }
    };
    check(node.required, node.location);
    check(node.optional, node.location);
    check(node.peers, ownerOf(node.location));
  }

  // Everything a required edge reaches from the root is required; the rest is
  // reached only through an optional one.
  const required = new Set<string>();
  const pending = [...root.required.values()];
  for (let location = pending.pop(); location !== undefined; location = pending.pop()) {
    if (required.has(location)) continue;
    required.add(location);
    const node = tree.get(location);
    if (node === undefined) continue;
    pending.push(...node.required.values(), ...node.peers.values());
  }

  const allowed = new Set(input.installScripts);
  const packages: Record<string, ShrinkwrapRoot | ShrinkwrapEntry> = {
    '': rootEntry(manifest),
  };
  const locations = [...tree.keys(), ...inBundle.keys()].sort();
  for (const location of locations) {
    const bundledVersion = inBundle.get(location);
    if (bundledVersion !== undefined) {
      packages[location] = { version: bundledVersion, inBundle: true };
      continue;
    }
    const node = tree.get(location);
    if (node === undefined) continue;
    const known = packageOf(node.name, node.version);
    const integrity = known.resolution.integrity;
    if (integrity === undefined) {
      throw new Error(
        `${node.name}@${node.version} has no integrity in ${lockfilePath}; only a registry package can be pinned`,
      );
    }
    packages[location] = {
      version: node.version,
      integrity,
      ...(filled(node.dependencies) ? { dependencies: node.dependencies } : {}),
      ...(filled(node.optionalDependencies)
        ? { optionalDependencies: node.optionalDependencies }
        : {}),
      ...(known.peerDependencies === undefined ? {} : { peerDependencies: known.peerDependencies }),
      ...(known.peerDependenciesMeta === undefined
        ? {}
        : { peerDependenciesMeta: known.peerDependenciesMeta }),
      ...(known.engines === undefined ? {} : { engines: known.engines }),
      ...(known.os === undefined ? {} : { os: known.os }),
      ...(known.cpu === undefined ? {} : { cpu: known.cpu }),
      ...(known.libc === undefined ? {} : { libc: known.libc }),
      ...(allowed.has(node.name) ? { hasInstallScript: true as const } : {}),
      ...(required.has(location) ? {} : { optional: true as const }),
    };
  }

  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };
}

/**
 * The one version the lockfile resolved `name` to, across every importer the
 * package draws on, for exactly the range the published manifest declares.
 *
 * All three sections are read: the hub's `ws` is published because a bundled
 * package needs it, and the hub's own importer holds it as a dev dependency.
 * A specifier that differs from the published range means the lockfile was
 * written for a different manifest, and two versions of one name across the
 * importers is a choice the tarball cannot carry both sides of: either is
 * refused rather than resolved to a winner.
 */
function resolvedByImporters(
  lockfile: Lockfile,
  lockfilePath: string,
  importers: readonly string[],
  name: string,
  range: string,
): string {
  let found: { readonly directory: string; readonly version: string } | undefined;
  for (const directory of importers) {
    const importer = lockfile.importers[directory];
    for (const section of [
      importer?.dependencies,
      importer?.optionalDependencies,
      importer?.devDependencies,
    ]) {
      const entry = section?.[name];
      if (entry === undefined) continue;
      if (entry.specifier !== range) {
        throw new Error(
          `${lockfilePath} is behind package.json: ${directory} resolves ${name} for ` +
            `${entry.specifier}, and the published manifest declares ${range}`,
        );
      }
      if (found !== undefined && found.version !== entry.version) {
        throw new Error(
          `${lockfilePath} resolves ${name} to ${found.version} in ${found.directory} and to ` +
            `${entry.version} in ${directory}, and one package can carry one`,
        );
      }
      found = { directory, version: entry.version };
    }
  }
  if (found === undefined) {
    throw new Error(
      `${lockfilePath} is behind package.json: none of ${importers.join(', ') || 'no importers'} ` +
        `resolves ${name}@${range}; run \`pnpm install\``,
    );
  }
  if (withoutPeers(found.version) === undefined) {
    throw new Error(
      `${found.directory} resolves ${name} to ${found.version} in ${lockfilePath}, which is not a registry version this can pin`,
    );
  }
  return found.version;
}

function rootEntry(manifest: z.infer<typeof publishedSchema>): ShrinkwrapRoot {
  const installs = INSTALL_SCRIPTS.some((script) => manifest.scripts?.[script] !== undefined);
  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.license === undefined ? {} : { license: manifest.license }),
    ...(filled(manifest.dependencies) ? { dependencies: manifest.dependencies } : {}),
    ...(filled(manifest.optionalDependencies)
      ? { optionalDependencies: manifest.optionalDependencies }
      : {}),
    ...(manifest.bundleDependencies.length === 0
      ? {}
      : { bundleDependencies: manifest.bundleDependencies }),
    ...(manifest.engines === undefined ? {} : { engines: manifest.engines }),
    ...(manifest.bin === undefined ? {} : { bin: manifest.bin }),
    ...(installs ? { hasInstallScript: true as const } : {}),
  };
}

/** An edge map worth writing: npm reads an absent map and an empty one alike. */
function filled(
  value: Readonly<Record<string, string>> | undefined,
): value is Readonly<Record<string, string>> {
  return value !== undefined && Object.keys(value).length > 0;
}

/**
 * The published manifest's `allowScripts`: every package in the shrinkwrap
 * that has an install script.
 *
 * npm 12 runs no dependency install script that this field does not name, and
 * says nothing when it skips one: the install exits 0 with node-pty unbuilt.
 * It also refuses `--allow-scripts` on a project install, so the field in the
 * package's own manifest is the one place the permission can be granted, and
 * npm 11.19 accepts it too (AGX-322). Derived from the shrinkwrap rather than
 * named, so it is the same list `pnpm-workspace.yaml` already grants.
 */
export function allowedScripts(shrinkwrap: Shrinkwrap): Readonly<Record<string, true>> {
  const names = new Set<string>();
  for (const [location, value] of Object.entries(shrinkwrap.packages)) {
    if (location === '' || value.hasInstallScript !== true) continue;
    names.add(location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length));
  }
  return Object.fromEntries([...names].sort().map((name) => [name, true as const]));
}
