import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PACKAGES,
  parseManifest,
  publishedManifest,
  type Manifest,
  type PackageTarget,
} from './assemble-package.js';
import {
  allowedScripts,
  deriveShrinkwrap,
  parseAllowBuilds,
  parseLockfile,
  SHRINKWRAP_FILE,
  type Lockfile,
  type Shrinkwrap,
  type ShrinkwrapEntry,
} from './shrinkwrap.js';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptsDirectory, '..');
const fixtureDirectory = join(scriptsDirectory, 'fixtures', 'shrinkwrap');
const fixtureLockfilePath = join(fixtureDirectory, 'pnpm-lock.yaml');

const fixtureText = await readFile(fixtureLockfilePath, 'utf8');
const fixture = parseLockfile(fixtureLockfilePath, fixtureText);
const fixtureBuilds = parseAllowBuilds(
  join(fixtureDirectory, 'pnpm-workspace.yaml'),
  await readFile(join(fixtureDirectory, 'pnpm-workspace.yaml'), 'utf8'),
);

/**
 * What `publishedManifest` would write for `apps/probe` if it were a package:
 * the bundled protocol at its exact version, the protocol's `zod` carried up,
 * the member's own dependencies at their ranges, and `fsevents` optional. Written
 * out rather than derived, because the probe is no target and the subject here
 * is the lockfile, not the assembly.
 */
const probe = {
  name: '@agentplex/probe',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  engines: { node: '>=24' },
  dependencies: {
    '@agentplex/protocol': '1.2.3',
    debug: '4.3.1',
    ms: '2.1.3',
    'supports-color': '7.2.0',
    zod: '>=4.5.4 <5.0.0',
  },
  optionalDependencies: { fsevents: '2.3.3' },
  bundleDependencies: ['@agentplex/protocol'],
};
const probeImporters = ['apps/probe', 'packages/protocol'];

/** The command's published manifest, as the assembly writes it for the fixture workspace. */
const command = {
  name: '@softiesolutions/agentplex',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  engines: { node: '>=24' },
  bin: { agentplex: './apps/cli/dist/main.js' },
  scripts: { postinstall: 'node packages/pty/scripts/node-pty-postinstall.js' },
  dependencies: {
    '@agentplex/node-shared': '1.2.3',
    '@agentplex/protocol': '1.2.3',
    '@agentplex/providers': '1.2.3',
    '@agentplex/pty': '1.2.3',
    '@agentplex/release': '1.2.3',
    ws: '>=8.21.3 <9.0.0',
    zod: '>=4.5.4 <5.0.0',
  },
  optionalDependencies: { 'node-pty': '1.1.0' },
  bundleDependencies: [
    '@agentplex/node-shared',
    '@agentplex/protocol',
    '@agentplex/providers',
    '@agentplex/pty',
    '@agentplex/release',
  ],
};
const commandImporters = [
  'apps/cli',
  'packages/protocol',
  'packages/node-shared',
  'packages/providers',
  'packages/pty',
  'packages/release',
];

function derive(
  manifest: Record<string, unknown>,
  importers: readonly string[],
  lockfile: Lockfile = fixture,
): Shrinkwrap {
  return deriveShrinkwrap({
    lockfile,
    lockfilePath: fixtureLockfilePath,
    manifest,
    importers,
    installScripts: fixtureBuilds,
  });
}

function entry(shrinkwrap: Shrinkwrap, location: string): ShrinkwrapEntry {
  const found = shrinkwrap.packages[location];
  if (found === undefined) throw new Error(`no ${location} in the shrinkwrap`);
  return found as ShrinkwrapEntry;
}

/** Where a package lives, one directory up: `''` for a top-level one. */
function parentOf(location: string): string {
  const cut = location.lastIndexOf('/node_modules/');
  return cut === -1 ? '' : location.slice(0, cut);
}

/**
 * Node's resolver, over the shrinkwrap's keys: `node_modules/<name>` beside
 * the requester's own, then each directory up to the root.
 */
function resolveFrom(
  packages: Shrinkwrap['packages'],
  from: string,
  name: string,
): string | undefined {
  let owner = from;
  for (;;) {
    const location = owner === '' ? `node_modules/${name}` : `${owner}/node_modules/${name}`;
    if (location in packages) return location;
    if (owner === '') return undefined;
    owner = parentOf(owner);
  }
}

/**
 * Every edge in the tree lands on an entry at exactly the version it names,
 * and every required peer resolves from beside its dependent. npm does not fail
 * an entry that misses its parent's edge: it installs the registry's newest
 * instead and exits 0 (AGX-322, Q5b), so this is the one place it is caught.
 */
function unresolvedEdges(shrinkwrap: Shrinkwrap): readonly string[] {
  const failures: string[] = [];
  for (const [location, value] of Object.entries(shrinkwrap.packages)) {
    if (location === '') continue;
    const node = value as ShrinkwrapEntry;
    const edges = { ...node.dependencies, ...node.optionalDependencies };
    for (const [name, version] of Object.entries(edges)) {
      const target = resolveFrom(shrinkwrap.packages, location, name);
      const found = target === undefined ? undefined : entry(shrinkwrap, target).version;
      if (found !== version) failures.push(`${location} -> ${name}@${version}: ${String(found)}`);
    }
    for (const name of Object.keys(node.peerDependencies ?? {})) {
      if (node.peerDependenciesMeta?.[name]?.optional === true) continue;
      if (resolveFrom(shrinkwrap.packages, parentOf(location), name) === undefined) {
        failures.push(`${location} -> peer ${name}: unplaced`);
      }
    }
  }
  return failures;
}

describe('parseLockfile', () => {
  it('reads the importers, packages and snapshots of a lockfile pnpm wrote', () => {
    expect(Object.keys(fixture.importers)).toContain('apps/probe');
    expect(fixture.packages['debug@4.3.1']?.resolution.integrity).toMatch(/^sha512-/);
    expect(fixture.snapshots['debug@4.3.1(supports-color@7.2.0)']?.dependencies).toEqual({
      ms: '2.1.2',
    });
  });

  it('refuses YAML that does not parse, naming the file', () => {
    expect(() => parseLockfile('/w/pnpm-lock.yaml', 'importers: [\n')).toThrow('/w/pnpm-lock.yaml');
  });

  it('refuses a lockfile version it was not written against, naming the file and the field', () => {
    const older = fixtureText.replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'");

    expect(() => parseLockfile('/w/pnpm-lock.yaml', older)).toThrow('/w/pnpm-lock.yaml');
    expect(() => parseLockfile('/w/pnpm-lock.yaml', older)).toThrow('lockfileVersion');
  });
});

describe('parseAllowBuilds', () => {
  it('reads the names the workspace lets run install scripts', () => {
    expect([...fixtureBuilds].sort()).toEqual(['esbuild', 'node-pty']);
  });

  it('refuses a workspace file that does not parse, naming it', () => {
    expect(() => parseAllowBuilds('/w/pnpm-workspace.yaml', 'allowBuilds: [\n')).toThrow(
      '/w/pnpm-workspace.yaml',
    );
  });

  it('leaves out a name the workspace lists and refuses', () => {
    expect(parseAllowBuilds('/w/pnpm-workspace.yaml', 'allowBuilds:\n  esbuild: false\n')).toEqual(
      [],
    );
  });
});

describe('deriveShrinkwrap, against a lockfile pnpm wrote', () => {
  const shrinkwrap = derive(probe, probeImporters);

  it('is a version 3 lockfile named for the package', () => {
    expect(SHRINKWRAP_FILE).toBe('npm-shrinkwrap.json');
    expect(shrinkwrap).toMatchObject({
      name: '@agentplex/probe',
      version: '1.2.3',
      lockfileVersion: 3,
      requires: true,
    });
  });

  /**
   * npm does not fail a root entry that disagrees with the manifest beside it:
   * it takes the manifest and rewrites the lockfile (AGX-322, Q4). So the
   * equality is held here.
   */
  it('repeats the published manifest as its root entry', () => {
    expect(shrinkwrap.packages['']).toEqual({
      name: probe.name,
      version: probe.version,
      license: probe.license,
      dependencies: probe.dependencies,
      optionalDependencies: probe.optionalDependencies,
      bundleDependencies: probe.bundleDependencies,
      engines: probe.engines,
    });
  });

  it('turns a bundled workspace package into an entry npm leaves alone', () => {
    expect(shrinkwrap.packages['node_modules/@agentplex/protocol']).toEqual({
      version: '1.2.3',
      inBundle: true,
    });
  });

  it('strips the peer suffix off a version', () => {
    expect(entry(shrinkwrap, 'node_modules/debug').version).toBe('4.3.1');
  });

  it('nests the version one dependent needs under it, beside the one the root needs', () => {
    expect(entry(shrinkwrap, 'node_modules/ms').version).toBe('2.1.3');
    expect(entry(shrinkwrap, 'node_modules/debug/node_modules/ms').version).toBe('2.1.2');
    expect(entry(shrinkwrap, 'node_modules/debug').dependencies).toEqual({ ms: '2.1.2' });
  });

  /**
   * Without edges npm prunes every transitive as unreachable, and `npm ls
   * --all` still exits 0 (AGX-322, Q10).
   */
  it('writes every entry with its edges, at exact versions', () => {
    expect(entry(shrinkwrap, 'node_modules/supports-color').dependencies).toEqual({
      'has-flag': '4.0.0',
    });
    expect(entry(shrinkwrap, 'node_modules/has-flag').version).toBe('4.0.0');
    expect(unresolvedEdges(shrinkwrap)).toEqual([]);
  });

  /**
   * pnpm lists an optional peer it resolved under the snapshot's
   * `optionalDependencies`. It is a peer, not an optional dependency: npm is
   * told the range and places nothing for it (AGX-322, Q12).
   */
  it('writes an optional peer as a peer, not as an optional dependency', () => {
    const debug = entry(shrinkwrap, 'node_modules/debug');

    expect(debug.optionalDependencies).toBeUndefined();
    expect(debug.peerDependencies).toEqual({ 'supports-color': '*' });
    expect(debug.peerDependenciesMeta).toEqual({ 'supports-color': { optional: true } });
  });

  it('keeps a dev dependency out', () => {
    expect(Object.keys(shrinkwrap.packages).filter((key) => key.includes('picocolors'))).toEqual(
      [],
    );
  });

  it('marks what only an optional edge reaches, with the platform it installs on', () => {
    expect(entry(shrinkwrap, 'node_modules/fsevents')).toMatchObject({
      version: '2.3.3',
      optional: true,
      os: ['darwin'],
    });
    expect(entry(shrinkwrap, 'node_modules/debug').optional).toBeUndefined();
    expect(entry(shrinkwrap, 'node_modules/has-flag').optional).toBeUndefined();
  });

  /**
   * npm fetches a missing entry from the registry it is configured with, so an
   * operator's mirror is honoured, and checks the bytes against `integrity`
   * (AGX-322, Q4). A bundled entry is not fetched at all (Q13).
   */
  it('gives every fetched entry its integrity and no entry a resolved URL', () => {
    for (const [location, value] of Object.entries(shrinkwrap.packages)) {
      if (location === '') continue;
      const node = value as ShrinkwrapEntry;
      expect(node, location).not.toHaveProperty('resolved');
      if (node.inBundle === true) expect(node, location).not.toHaveProperty('integrity');
      else expect(node.integrity, location).toMatch(/^sha512-/);
    }
  });

  it('resolves a range a bundled package declares through that package', () => {
    expect(entry(shrinkwrap, 'node_modules/zod').version).toBe('4.6.5');
  });

  it('places nothing the published manifest does not reach', () => {
    expect(Object.keys(shrinkwrap.packages).sort()).toEqual([
      '',
      'node_modules/@agentplex/protocol',
      'node_modules/debug',
      'node_modules/debug/node_modules/ms',
      'node_modules/fsevents',
      'node_modules/has-flag',
      'node_modules/ms',
      'node_modules/supports-color',
      'node_modules/zod',
    ]);
  });
});

describe('deriveShrinkwrap, for the packages the fixture workspace publishes', () => {
  /**
   * Without `hasInstallScript` npm runs only an implicit `node-gyp rebuild`
   * and skips node-pty's own install and postinstall (AGX-322, Q11).
   */
  it('marks an entry the workspace lets build as having an install script', () => {
    const shrinkwrap = derive(command, commandImporters);

    expect(entry(shrinkwrap, 'node_modules/node-pty')).toMatchObject({
      version: '1.1.0',
      hasInstallScript: true,
      optional: true,
      dependencies: { 'node-addon-api': '7.1.1' },
    });
    expect(allowedScripts(shrinkwrap)).toEqual({ 'node-pty': true });
  });

  it('marks the root as having an install script when the manifest has a postinstall', () => {
    const shrinkwrap = derive(command, commandImporters);

    expect(shrinkwrap.packages['']).toMatchObject({
      hasInstallScript: true,
      bin: { agentplex: './apps/cli/dist/main.js' },
    });
  });

  it('marks what only an optional dependency reaches as optional too', () => {
    const shrinkwrap = derive(command, commandImporters);

    expect(entry(shrinkwrap, 'node_modules/node-addon-api').optional).toBe(true);
    expect(entry(shrinkwrap, 'node_modules/zod').optional).toBeUndefined();
    expect(unresolvedEdges(shrinkwrap)).toEqual([]);
  });

  /**
   * The hub's importer links the client, which its published manifest does not
   * declare: the client is installed beside the hub, not inside it.
   */
  it('walks from the published manifest, not from the importer', () => {
    const shrinkwrap = derive(
      {
        name: '@softiesolutions/agentplex-hub',
        version: '1.2.3',
        license: 'Apache-2.0',
        dependencies: { '@agentplex/protocol': '1.2.3', zod: '>=4.5.4 <5.0.0' },
        bundleDependencies: ['@agentplex/protocol'],
      },
      ['apps/hub', 'packages/protocol'],
    );

    expect(Object.keys(shrinkwrap.packages).sort()).toEqual([
      '',
      'node_modules/@agentplex/protocol',
      'node_modules/zod',
    ]);
  });

  /** The client declares nothing, so its importer's react never enters. */
  it('writes the root entry alone for a manifest that declares nothing', () => {
    const shrinkwrap = derive(
      {
        name: '@softiesolutions/agentplex-web',
        version: '1.2.3',
        license: 'Apache-2.0',
        engines: { node: '>=24' },
      },
      [],
    );

    expect(shrinkwrap.packages).toEqual({
      '': {
        name: '@softiesolutions/agentplex-web',
        version: '1.2.3',
        license: 'Apache-2.0',
        engines: { node: '>=24' },
      },
    });
  });
});

describe('deriveShrinkwrap refuses', () => {
  it('an importer the lockfile does not have, naming the file and the directory', () => {
    const attempt = (): Shrinkwrap => derive(probe, ['apps/absent', 'packages/protocol']);

    expect(attempt).toThrow(fixtureLockfilePath);
    expect(attempt).toThrow('apps/absent');
  });

  it('a declared dependency its importers do not resolve', () => {
    const attempt = (): Shrinkwrap =>
      derive(
        { ...probe, dependencies: { ...probe.dependencies, 'left-pad': '1.3.0' } },
        probeImporters,
      );

    expect(attempt).toThrow('pnpm-lock.yaml is behind package.json');
    expect(attempt).toThrow('left-pad');
  });

  it('a range an importer resolved for a different specifier', () => {
    const attempt = (): Shrinkwrap =>
      derive({ ...probe, dependencies: { ...probe.dependencies, ms: '2.1.2' } }, probeImporters);

    expect(attempt).toThrow('pnpm-lock.yaml is behind package.json');
    expect(attempt).toThrow('ms');
  });

  it('two importers resolving one name to two versions', () => {
    const text = fixtureText.replace(
      "      zod:\n        specifier: '>=4.5.4 <5.0.0'\n        version: 4.6.5\n\n  packages/providers:",
      "      zod:\n        specifier: '>=4.5.4 <5.0.0'\n        version: 4.5.4\n\n  packages/providers:",
    );
    expect(text).not.toBe(fixtureText);
    const lockfile = parseLockfile(fixtureLockfilePath, text);

    expect(() =>
      derive(probe, [...probeImporters, 'packages/providers', 'packages/release'], lockfile),
    ).toThrow('zod');
  });
});

/**
 * The lockfile the workspace actually installs from, and the manifests the
 * assembly actually publishes, in the style of "the ranges the real workspace
 * publishes" in `assemble-package.test.ts`: what the fixture proves about the
 * derivation, this proves about the four shrinkwraps that ship.
 */
describe('the shrinkwraps the real workspace publishes', async () => {
  const lockfilePath = join(workspaceRoot, 'pnpm-lock.yaml');
  const lockfile = parseLockfile(lockfilePath, await readFile(lockfilePath, 'utf8'));
  const builds = parseAllowBuilds(
    'pnpm-workspace.yaml',
    await readFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8'),
  );

  async function manifestAt(directory: string): Promise<Manifest> {
    const path = join(workspaceRoot, directory, 'package.json');
    return parseManifest(path, await readFile(path, 'utf8'));
  }

  function importersOf(target: PackageTarget): readonly string[] {
    return [...target.declares, ...target.bundled.map((bundle) => bundle.directory)];
  }

  async function derived(
    target: PackageTarget,
  ): Promise<{ manifest: Record<string, unknown>; shrinkwrap: Shrinkwrap }> {
    const manifest = publishedManifest({
      target,
      root: await manifestAt('.'),
      manifests: await Promise.all(target.declares.map((path) => manifestAt(path))),
      bundled: await Promise.all(target.bundled.map((bundle) => manifestAt(bundle.directory))),
    });
    const shrinkwrap = deriveShrinkwrap({
      lockfile,
      lockfilePath,
      manifest,
      importers: importersOf(target),
      installScripts: builds,
    });
    return { manifest, shrinkwrap };
  }

  /** The version an importer of this target resolved `name` to, suffix and all stripped. */
  function importerVersion(target: PackageTarget, name: string): string | undefined {
    for (const directory of importersOf(target)) {
      const importer = lockfile.importers[directory];
      const found =
        importer?.dependencies?.[name] ??
        importer?.optionalDependencies?.[name] ??
        importer?.devDependencies?.[name];
      if (found !== undefined) return found.version.replace(/\(.*$/, '');
    }
    return undefined;
  }

  it.each(PACKAGES.map((target) => [target.name, target] as const))(
    'pins everything %s declares at the version the lockfile resolved',
    async (_name, target) => {
      const { manifest, shrinkwrap } = await derived(target);
      const bundled = new Set(manifest['bundleDependencies'] as string[]);
      const declared = {
        ...(manifest['dependencies'] as Record<string, string>),
        ...(manifest['optionalDependencies'] as Record<string, string>),
      };

      for (const [name, range] of Object.entries(declared)) {
        const pinned = entry(shrinkwrap, `node_modules/${name}`);
        if (bundled.has(name)) {
          expect(pinned, name).toEqual({ version: range, inBundle: true });
        } else {
          expect(pinned.version, name).toBe(importerVersion(target, name));
        }
      }
      for (const name of bundled) {
        expect(entry(shrinkwrap, `node_modules/${name}`).inBundle, name).toBe(true);
      }
    },
  );

  it.each(PACKAGES.map((target) => [target.name, target] as const))(
    'keeps what %s only develops against out of it',
    async (_name, target) => {
      const { manifest, shrinkwrap } = await derived(target);
      const runtime = new Set([
        ...Object.keys(manifest['dependencies'] as Record<string, string>),
        ...Object.keys(manifest['optionalDependencies'] as Record<string, string>),
      ]);

      for (const directory of importersOf(target)) {
        for (const name of Object.keys(lockfile.importers[directory]?.devDependencies ?? {})) {
          if (runtime.has(name)) continue;
          expect(
            Object.keys(shrinkwrap.packages).filter((key) => key.endsWith(`node_modules/${name}`)),
            `${directory} develops against ${name}`,
          ).toEqual([]);
        }
      }
    },
  );

  it.each(PACKAGES.map((target) => [target.name, target] as const))(
    'resolves every edge in %s to the version it names',
    async (_name, target) => {
      const { shrinkwrap } = await derived(target);

      expect(unresolvedEdges(shrinkwrap)).toEqual([]);
    },
  );

  it.each(PACKAGES.map((target) => [target.name, target] as const))(
    'repeats the published manifest of %s as its root entry',
    async (_name, target) => {
      const { manifest, shrinkwrap } = await derived(target);
      const root: Readonly<Record<string, unknown>> = { ...shrinkwrap.packages[''] };

      for (const field of [
        'name',
        'version',
        'license',
        'engines',
        'bin',
        'dependencies',
        'optionalDependencies',
        'bundleDependencies',
      ]) {
        const value = manifest[field];
        const empty =
          value === undefined ||
          (Array.isArray(value) ? value.length === 0 : Object.keys(value as object).length === 0);
        expect(root[field], `${target.name} ${field}`).toEqual(empty ? undefined : value);
      }
    },
  );

  /**
   * A required peer is placed, beside its dependent, and written as a peer
   * rather than as a dependency. The hub's closure is where one is: the
   * assertion that there is one keeps the edge check above from passing on a
   * tree that happens to hold none.
   */
  it('places a required peer beside the package that needs it', async () => {
    const hub = PACKAGES.find((target) => target.component === 'hub');
    if (hub === undefined) throw new Error('no hub package');
    const { shrinkwrap } = await derived(hub);

    const withRequiredPeers = Object.entries(shrinkwrap.packages).filter(([location, value]) => {
      if (location === '') return false;
      const node = value as ShrinkwrapEntry;
      return Object.keys(node.peerDependencies ?? {}).some(
        (name) => node.peerDependenciesMeta?.[name]?.optional !== true,
      );
    });
    expect(withRequiredPeers.length).toBeGreaterThan(0);
    for (const [location, value] of withRequiredPeers) {
      const node = value as ShrinkwrapEntry;
      for (const name of Object.keys(node.peerDependencies ?? {})) {
        expect(node.dependencies?.[name], `${location} peer ${name}`).toBeUndefined();
      }
    }
  });

  /**
   * The two packages that carry node-pty let its install script run, and no
   * other package has a script to let run.
   */
  it('lets node-pty build in exactly the packages that carry it', async () => {
    for (const target of PACKAGES) {
      const { shrinkwrap } = await derived(target);
      const carriesPty = target.bundled.some((bundle) => bundle.name === '@agentplex/pty');

      expect(allowedScripts(shrinkwrap), target.name).toEqual(
        carriesPty ? { 'node-pty': true } : {},
      );
    }
  });
});
