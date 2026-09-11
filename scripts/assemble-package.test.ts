import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assemblePackage,
  assemblePackages,
  BIN_APP,
  bundledManifest,
  CLI,
  DAEMONS,
  ENTRYPOINT,
  HUB,
  missingInputs,
  PACKAGES,
  parseManifest,
  publishedManifest,
  SERVER,
  versionFromTag,
  WEB,
  type Manifest,
  type PackageTarget,
} from './assemble-package.js';

// The workspace root, named so that a `--filter` cannot match it beside the
// app it would otherwise be a homonym of. Nothing publishes under this name.
const rootManifest: Manifest = {
  name: 'agentplex-workspace',
  version: '1.2.3',
  description: 'Watch and drive coding-agent sessions across machines',
  license: 'Apache-2.0',
  type: 'module',
  engines: { node: '>=24', pnpm: '>=11' },
  repository: { type: 'git', url: 'git+https://example.invalid/agentplex.git' },
  dependencies: {},
};

/**
 * The bin's own manifest. It holds `setup` and `doctor` itself, so what those
 * two commands import is what this app declares -- `pty` included, for the
 * wizard that opens a terminal and the doctor that asks whether one could be
 * opened. The daemons are packages of their own and declare their own.
 */
const cliManifest: Manifest = {
  name: '@softiesolutions/agentplex',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/node-shared': 'workspace:*',
    '@agentplex/protocol': 'workspace:*',
    '@agentplex/providers': 'workspace:*',
    '@agentplex/pty': 'workspace:*',
    zod: '^4.1.13',
  },
};

const protocolManifest: Manifest = {
  name: '@agentplex/protocol',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: { zod: '^4.1.13' },
};

const nodeSharedManifest: Manifest = {
  name: '@agentplex/node-shared',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: { ws: '^8.21.3' },
};

const providersManifest: Manifest = {
  name: '@agentplex/providers',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/node-shared': 'workspace:*',
    '@agentplex/protocol': 'workspace:*',
    zod: '^4.1.13',
  },
};

const ptyManifest: Manifest = {
  name: '@agentplex/pty',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/node-shared': 'workspace:*',
    '@agentplex/providers': 'workspace:*',
    'node-pty': '1.1.0',
  },
};

/** The hub, which depends on the client and bundles no pty. */
const hubManifest: Manifest = {
  name: '@agentplex/hub',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/node-shared': 'workspace:*',
    '@agentplex/protocol': 'workspace:*',
    '@agentplex/providers': 'workspace:*',
    '@softiesolutions/agentplex-web': 'workspace:*',
    zod: '^4.1.13',
  },
};

const serverAppManifest: Manifest = {
  name: '@agentplex/server',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/node-shared': 'workspace:*',
    '@agentplex/protocol': 'workspace:*',
    '@agentplex/providers': 'workspace:*',
    '@agentplex/pty': 'workspace:*',
    zod: '^4.1.13',
  },
};

/** The client: a vite app, whose build-time tree must reach no published manifest. */
const webManifest: Manifest = {
  name: '@softiesolutions/agentplex-web',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/protocol': 'workspace:*',
    react: '^19.2.0',
  },
};

const shared = [protocolManifest, nodeSharedManifest, providersManifest];
const sharedWithPty = [...shared, ptyManifest];

function manifestFor(target: PackageTarget, version?: string): Record<string, unknown> {
  const byTarget: Record<string, { manifests: Manifest[]; bundled: Manifest[] }> = {
    [CLI.name]: { manifests: [cliManifest], bundled: sharedWithPty },
    [HUB.name]: { manifests: [hubManifest], bundled: shared },
    [SERVER.name]: { manifests: [serverAppManifest], bundled: sharedWithPty },
    [WEB.name]: { manifests: [], bundled: [] },
  };
  const input = byTarget[target.name] ?? { manifests: [], bundled: [] };
  return publishedManifest({
    target,
    root: rootManifest,
    manifests: input.manifests,
    bundled: input.bundled,
    ...(version === undefined ? {} : { version }),
  });
}

describe('the four packages', () => {
  it('publishes a command, two daemons and the client, each under its own name', () => {
    expect(PACKAGES.map((target) => target.name)).toEqual([
      '@softiesolutions/agentplex',
      '@softiesolutions/agentplex-hub',
      '@softiesolutions/agentplex-server',
      '@softiesolutions/agentplex-web',
    ]);
  });

  /**
   * The whole point of the split, asserted where it can be asserted cheaply.
   * node-pty has no Linux prebuild, so any dependency set containing it makes a
   * C++ toolchain a prerequisite of the install -- and a hub opens no
   * pseudoterminal. It reaches a manifest only through `@agentplex/pty`, so the
   * claim is about what the hub bundles as much as about what it declares.
   */
  it('leaves node-pty out of the hub entirely, which is what a hub stops paying for', () => {
    const manifest = manifestFor(HUB);

    expect(HUB.bundled.map((item) => item.name)).not.toContain('@agentplex/pty');
    expect(manifest['dependencies']).not.toHaveProperty('node-pty');
    expect(manifest['optionalDependencies']).toEqual({});
    expect(JSON.stringify(manifest)).not.toContain('node-pty');
  });

  /**
   * The other half. A server without a pseudoterminal is not a degraded server,
   * and npm exits 0 when an *optional* dependency's build fails -- so required
   * is what turns a silent success into node-gyp's own error at install time.
   */
  it('requires node-pty in the server, rather than declaring it optional', () => {
    const manifest = manifestFor(SERVER);

    expect(manifest['dependencies']).toMatchObject({ 'node-pty': '1.1.0' });
    expect(manifest['optionalDependencies']).toEqual({});
  });

  /**
   * And the one package where optional is still right: every machine installs
   * the command, hub-only ones included, and a hub-only machine is exactly the
   * one that may have no compiler. What it costs is the wizard's provider
   * login, which `agentplex doctor` reports as unusable in so many words.
   */
  it('declares node-pty optional in the command, so a hub machine installs it', () => {
    const manifest = manifestFor(CLI);

    expect(manifest['optionalDependencies']).toEqual({ 'node-pty': '1.1.0' });
    // In one field, not both: npm reads `dependencies` first, and a name in
    // both is a required dependency wearing an optional label.
    expect(manifest['dependencies']).not.toHaveProperty('node-pty');
  });

  it('installs one command, from the one package that has one', () => {
    expect(CLI.bin).toEqual({ command: 'agentplex', entrypoint: ENTRYPOINT });
    for (const target of [HUB, SERVER, WEB]) {
      expect(target.bin, target.name).toBeUndefined();
      expect(manifestFor(target)['bin'], target.name).toBeUndefined();
    }
  });

  /**
   * The daemons are packages and not commands. Written out in `DAEMONS` and
   * derived here, which is the drift the two forms exist to catch between them:
   * a daemon this list names and no package carries is an ExecStart pointing at
   * a file that is not there, and nothing in this repository would meet it
   * before an operator did.
   */
  it('ships each daemon in a package of its own, at its workspace path', () => {
    for (const daemon of DAEMONS) {
      const target = PACKAGES.find((candidate) => candidate.name.endsWith(`-${daemon}`));
      expect(target, daemon).toBeDefined();
      expect(target?.entries.map((entry) => entry.to)).toContain(`apps/${daemon}/dist`);
    }
    // And no package carries another's program.
    expect(HUB.entries.map((entry) => entry.from)).not.toContain('apps/server/dist');
    expect(SERVER.entries.map((entry) => entry.from)).not.toContain('apps/hub/dist');
    expect(CLI.entries.map((entry) => entry.from)).not.toContain('apps/hub/dist');
  });

  /** The client goes in one package, and the hub's is not it. */
  it('ships the client on its own, and not inside the hub', () => {
    expect(WEB.entries.map((entry) => entry.from)).toContain('apps/web/dist');
    expect(HUB.entries.map((entry) => entry.from)).not.toContain('apps/web/dist');
  });

  /**
   * The one package laid out as its app rather than as the workspace, and the
   * reason: the hub asks for the build *beside* the client's manifest, which is
   * `apps/web/dist` beside `apps/web/package.json` in a checkout and `dist`
   * beside `package.json` at the published root. Staged at `apps/web/dist` the
   * two sit at different distances in the package and nowhere else, which is
   * how it resolved to an empty directory on an installed machine.
   */
  it('puts the client build beside the manifest that finds it', () => {
    expect(WEB.entries.find((entry) => entry.from === 'apps/web/dist')?.to).toBe('dist');
  });

  it('writes nothing outside a package root', () => {
    for (const target of PACKAGES) {
      for (const entry of target.entries) {
        expect(entry.to.startsWith('/'), `${target.name} ${entry.to}`).toBe(false);
        expect(entry.to.split('/')).not.toContain('..');
      }
    }
  });

  /** Four registry entries that all said the same thing would tell a reader nothing. */
  it('gives every package a page and a description of its own', () => {
    const readmes = PACKAGES.map(
      (target) => target.entries.find((entry) => entry.to === 'README.md')?.from,
    );
    expect(new Set(readmes).size).toBe(PACKAGES.length);
    expect(new Set(PACKAGES.map((target) => target.description)).size).toBe(PACKAGES.length);
  });

  /**
   * The postinstall repairs node-pty's spawn helper, so it travels with
   * node-pty and nowhere else: a package with no addon to repair that ran it
   * anyway would warn on every install about something that is correctly
   * absent.
   */
  it('carries the postinstall in exactly the packages that carry node-pty', () => {
    for (const target of PACKAGES) {
      const carriesPty = target.bundled.some((item) => item.name === '@agentplex/pty');
      expect(manifestFor(target)['scripts'], target.name).toEqual(
        carriesPty
          ? { postinstall: 'node packages/pty/scripts/node-pty-postinstall.js' }
          : undefined,
      );
    }
  });
});

describe('publishedManifest', () => {
  it('resolves every workspace package to an exact version and bundles it', () => {
    const manifest = manifestFor(CLI);

    expect(manifest['dependencies']).toEqual({
      '@agentplex/node-shared': '1.2.3',
      '@agentplex/protocol': '1.2.3',
      '@agentplex/providers': '1.2.3',
      '@agentplex/pty': '1.2.3',
      'node-pty': undefined,
      ws: '^8.21.3',
      zod: '^4.1.13',
    });
    expect(manifest['bundleDependencies']).toEqual([
      '@agentplex/node-shared',
      '@agentplex/protocol',
      '@agentplex/providers',
      '@agentplex/pty',
    ]);
  });

  /**
   * The hub depends on the client in the workspace, so that pnpm links it and
   * the hub's one specifier resolves from a checkout. In the published world
   * the client is a sibling package that `install.sh --role=hub` installs
   * beside the hub: bundling it would put the client back inside the hub and
   * undo the split, and declaring it would name a registry entry that does not
   * exist yet.
   */
  it('drops a workspace dependency on another published package rather than bundling it', () => {
    const manifest = manifestFor(HUB);

    expect(manifest['dependencies']).not.toHaveProperty('@softiesolutions/agentplex-web');
    expect(manifest['bundleDependencies']).toEqual([
      '@agentplex/node-shared',
      '@agentplex/protocol',
      '@agentplex/providers',
    ]);
  });

  /**
   * The client is a vite application, and none of that may reach the package.
   * Declaring it a dependency of the hub is what makes the resolution work in a
   * checkout; if that also dragged react into the hub's runtime set, the hub
   * would install a browser framework it never loads.
   */
  it('keeps the client build tree out of the hub and out of the client package', () => {
    expect(manifestFor(HUB)['dependencies']).not.toHaveProperty('react');
    expect(manifestFor(WEB)['dependencies']).toEqual({});
    expect(manifestFor(WEB)['bundleDependencies']).toEqual([]);
    expect(webManifest.dependencies['react']).toBeDefined();
  });

  it('refuses a workspace dependency nothing bundles, naming the package that would ship it', () => {
    expect(() =>
      publishedManifest({
        target: HUB,
        root: rootManifest,
        manifests: [hubManifest],
        bundled: [],
      }),
    ).toThrow('@agentplex/node-shared');
  });

  /**
   * The resolver walks up out of one bundled directory into the next, so a
   * bundled package's own workspace dependency has to be in the tarball too,
   * and the assembly is where that is checked -- a published package is the
   * wrong place to find out.
   */
  it('refuses a bundled package whose own workspace dependency nothing bundles', () => {
    const dependent: Manifest = {
      ...nodeSharedManifest,
      dependencies: { '@agentplex/unbundled': 'workspace:*' },
    };

    expect(() =>
      publishedManifest({
        target: CLI,
        root: rootManifest,
        manifests: [cliManifest],
        bundled: [protocolManifest, providersManifest, ptyManifest, dependent],
      }),
    ).toThrow('@agentplex/unbundled is a workspace dependency of @agentplex/node-shared');
  });

  /**
   * npm never fetches a bundled package's own dependencies, so one the tarball
   * does not satisfy installs as an empty directory and fails at the first
   * import. The published package declares them instead, at the range the
   * bundled package tested against.
   */
  it('declares what a bundled package needs, at the range it declares', () => {
    expect(manifestFor(CLI)['dependencies']).toMatchObject({ ws: '^8.21.3' });
  });

  it('refuses two ranges for one dependency', () => {
    const conflicting: Manifest = { ...nodeSharedManifest, dependencies: { zod: '^3.0.0' } };

    expect(() =>
      publishedManifest({
        target: CLI,
        root: rootManifest,
        manifests: [cliManifest],
        bundled: [protocolManifest, providersManifest, ptyManifest, conflicting],
      }),
    ).toThrow('zod');
  });

  it('accepts a bundled package that agrees with the app above it', () => {
    const agreeing: Manifest = { ...nodeSharedManifest, dependencies: { zod: '^4.1.13' } };

    expect(
      publishedManifest({
        target: CLI,
        root: rootManifest,
        manifests: [cliManifest],
        bundled: [protocolManifest, providersManifest, ptyManifest, agreeing],
      })['dependencies'],
    ).toMatchObject({ zod: '^4.1.13' });
  });

  it('declares node and not pnpm, because the target machine has only node', () => {
    for (const target of PACKAGES) {
      expect(manifestFor(target)['engines'], target.name).toEqual({ node: '>=24' });
    }
  });

  it('is publishable: no private flag, no dev dependencies', () => {
    for (const target of PACKAGES) {
      const manifest = manifestFor(target);
      expect(manifest['private'], target.name).toBeUndefined();
      expect(manifest['devDependencies'], target.name).toBeUndefined();
    }
    expect(manifestFor(CLI)['bin']).toEqual({ agentplex: './apps/cli/dist/main.js' });
  });

  /**
   * The unscoped `agentplex` on npm is somebody else's package, so everything
   * here publishes under the scope. A package name and a command name are
   * separate things -- `bin` maps one to a path -- so the registry entries are
   * scoped and the word an operator types is not.
   */
  it('publishes under the scope and still installs the `agentplex` command', () => {
    for (const target of PACKAGES) {
      expect(manifestFor(target)['name'], target.name).toMatch(/^@softiesolutions\//);
    }
    expect(Object.keys(manifestFor(CLI)['bin'] as Record<string, string>)).toEqual(['agentplex']);
  });

  /**
   * `--access public` is passed by the release workflow, which is the only
   * thing that publishes these packages, and the first publish is the only one
   * the flag decides anything for. A `publishConfig` here would be the same
   * fact written twice.
   */
  it('leaves access to the publishing command rather than restating it', () => {
    expect(manifestFor(CLI)['publishConfig']).toBeUndefined();
  });

  /**
   * Four packages need four descriptions, so they are stated per target rather
   * than taken from the workspace root, which has one. The licence and the
   * repository still come from the root, which is where they are true of
   * everything.
   */
  it('takes its description from the target and its repository from the root', () => {
    expect(manifestFor(HUB)['description']).toBe(HUB.description);
    expect(manifestFor(HUB)['description']).not.toBe(rootManifest.description);
    expect(manifestFor(HUB)['repository']).toEqual(rootManifest.repository);
    expect(manifestFor(HUB)['license']).toBe('Apache-2.0');
  });

  /**
   * Nothing in the workspace carries a version: every manifest is `0.0.0` and
   * the release workflow is what knows which version is being cut. The override
   * is the seam it writes through, so the manifest that gets published is built
   * with the version rather than edited after the fact -- and all four take the
   * same one, because this release is one build.
   */
  it('takes the version from the override when the release names one', () => {
    for (const target of PACKAGES) {
      expect(manifestFor(target, '2.0.1')['version'], target.name).toBe('2.0.1');
    }
  });

  it('falls back to the workspace when no release names a version', () => {
    expect(manifestFor(CLI)['version']).toBe('1.2.3');
    // The client declares no manifest of its own to the assembly, so its
    // fallback is the workspace root's rather than nothing at all.
    expect(manifestFor(WEB)['version']).toBe('1.2.3');
  });

  /**
   * A bundled package's version is what the published manifest depends on by
   * exact version, and the two are written from different sources. An override
   * that moved one and not the other would produce a manifest asking for a
   * version of itself that the tarball does not carry.
   */
  it('leaves the bundled versions where they are', () => {
    expect(manifestFor(CLI, '2.0.1')['dependencies']).toMatchObject({
      '@agentplex/protocol': '1.2.3',
    });
  });

  it('lists every copied path in files, and no bundled one', () => {
    expect(manifestFor(HUB)['files']).toEqual([
      'apps/hub/dist',
      'apps/hub/migrations',
      'LICENSE',
      'README.md',
    ]);
    expect(manifestFor(WEB)['files']).toEqual(['dist', 'LICENSE', 'README.md']);
    expect(manifestFor(CLI)['files']).not.toContain('node_modules/@agentplex/protocol/dist');
  });
});

describe('bundledManifest', () => {
  it('keeps the exports that make the bundled directory resolvable', () => {
    const kept = bundledManifest(
      'packages/protocol/package.json',
      JSON.stringify({
        name: '@agentplex/protocol',
        version: '1.2.3',
        license: 'Apache-2.0',
        private: true,
        type: 'module',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        dependencies: { zod: '^4.1.13' },
        devDependencies: { vitest: '^3.2.4' },
        scripts: { build: 'tsc' },
      }),
    );

    expect(kept.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    });
    expect(kept).not.toHaveProperty('private');
    expect(kept).not.toHaveProperty('devDependencies');
    expect(kept).not.toHaveProperty('scripts');
  });

  /**
   * A nested condition is the shape `exports` actually takes, and the bundled
   * copy is only resolvable if it arrives the same way it left.
   */
  it('carries a nested exports block across unchanged', () => {
    const exports = {
      '.': {
        import: { types: './dist/index.d.ts', default: './dist/index.js' },
        require: null,
      },
      './testing': ['./dist/testing.js'],
    };
    const kept = bundledManifest(
      'packages/node-shared/package.json',
      JSON.stringify({
        name: '@agentplex/node-shared',
        version: '1.2.3',
        license: 'Apache-2.0',
        type: 'module',
        exports,
      }),
    );

    expect(JSON.stringify(kept.exports)).toBe(JSON.stringify(exports));
  });

  /**
   * An optional field the source never declared has to be absent, not present
   * and undefined: the result is both written out as JSON and compared field by
   * field, and only one of those two notices the difference.
   */
  it('omits an optional field the source does not declare', () => {
    const kept = bundledManifest(
      'packages/protocol/package.json',
      JSON.stringify({
        name: '@agentplex/protocol',
        version: '1.2.3',
        license: 'Apache-2.0',
        type: 'module',
      }),
    );

    expect(Object.keys(kept)).toEqual(['name', 'version', 'license', 'type']);
    expect(kept).not.toHaveProperty('exports');
    expect(kept).not.toHaveProperty('sideEffects');
    expect(kept).not.toHaveProperty('main');
    expect(kept).not.toHaveProperty('types');
  });

  /** The assembly stops with the file named, the way `parseManifest` does. */
  it('names the source it could not read', () => {
    expect(() => bundledManifest('packages/pty/package.json', '{"name":"@agentplex/pty"}')).toThrow(
      'packages/pty/package.json',
    );
  });

  /**
   * The field npm reads as "the tarball carries these too". It does not, so
   * declaring them installs an empty directory per entry; the package that
   * bundles the protocol is what declares what the protocol needs.
   */
  it('declares no dependencies of its own', () => {
    const kept = bundledManifest(
      'packages/protocol/package.json',
      JSON.stringify({
        name: '@agentplex/protocol',
        version: '1.2.3',
        license: 'Apache-2.0',
        type: 'module',
        dependencies: { zod: '^4.1.13' },
      }),
    );

    expect(kept).not.toHaveProperty('dependencies');
  });
});

describe('versionFromTag', () => {
  it('takes the version out of a release tag', () => {
    expect(versionFromTag('v1.2.3')).toBe('1.2.3');
  });

  /**
   * A prerelease is the tag somebody reaches for first, because the first real
   * publish of a package nobody has installed is exactly where one wants a
   * version npm will not hand to `@latest`. Refusing it would make the
   * cautious path the unsupported one.
   */
  it('keeps a prerelease and its build metadata', () => {
    expect(versionFromTag('v1.2.3-rc.1')).toBe('1.2.3-rc.1');
    expect(versionFromTag('v1.2.3-rc.1+build.5')).toBe('1.2.3-rc.1+build.5');
  });

  /**
   * The workflow triggers on `v*`, so the `v` is what makes a tag a release
   * tag rather than a branch name somebody tagged. A bare `1.2.3` never
   * triggers the workflow at all; if it somehow arrives here it is not the
   * thing this publishes.
   */
  it('refuses a tag without the v, naming what it got', () => {
    expect(() => versionFromTag('1.2.3')).toThrow('1.2.3');
  });

  it('refuses a tag that is not a version', () => {
    expect(() => versionFromTag('vlatest')).toThrow('vlatest');
    expect(() => versionFromTag('v1.2')).toThrow('v1.2');
    expect(() => versionFromTag('v01.2.3')).toThrow('v01.2.3');
  });
});

describe('parseManifest', () => {
  it('says no to something that is not a manifest this can publish', () => {
    expect(() => parseManifest('package.json', '{"name":"x"}')).toThrow('package.json');
  });
});

describe('the assembled packages', () => {
  const temporary: string[] = [];

  afterEach(async () => {
    for (const directory of temporary.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function workspace(options: { readonly client: boolean }): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agentplex-package-'));
    temporary.push(root);

    const write = async (path: string, contents: string): Promise<void> => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), contents, 'utf8');
    };

    /**
     * What `tsc` leaves beside every emitted module: the map it points at, the
     * declaration, and the map for that. The fixture carries them because the
     * assembly is supposed to drop them, and a fixture that never held them
     * would pass whether it dropped them or not.
     */
    const compiled = async (directory: string, name: string, body: string): Promise<void> => {
      await write(`${directory}/${name}.js`, `${body}\n//# sourceMappingURL=${name}.js.map\n`);
      await write(`${directory}/${name}.js.map`, '{"sources":["../src/x.ts"]}\n');
      await write(`${directory}/${name}.d.ts`, 'export {};\n');
      await write(`${directory}/${name}.d.ts.map`, '{"sources":["../src/x.ts"]}\n');
    };

    await write('package.json', JSON.stringify(rootManifest));
    await write('LICENSE', 'Apache License, Version 2.0\n');
    await write('apps/cli/package.json', JSON.stringify(cliManifest));
    await write('apps/cli/README.md', '# agentplex\n');
    await compiled('apps/cli/dist', 'main', '#!/usr/bin/env node\nawait main();');
    await write('apps/hub/package.json', JSON.stringify(hubManifest));
    await write('apps/hub/README.md', '# agentplex-hub\n');
    await compiled('apps/hub/dist', 'main', '#!/usr/bin/env node\nawait main();');
    await write('apps/server/package.json', JSON.stringify(serverAppManifest));
    await write('apps/server/README.md', '# agentplex-server\n');
    await compiled('apps/server/dist', 'main', '#!/usr/bin/env node\nawait main();');
    await write('apps/hub/migrations/0001_hub_identity.sql', 'create table hub (id text);\n');
    await write('packages/protocol/package.json', JSON.stringify(protocolManifest));
    await compiled('packages/protocol/dist', 'index', 'export const version = 7;');
    await write('packages/node-shared/package.json', JSON.stringify(nodeSharedManifest));
    await compiled('packages/node-shared/dist', 'index', 'export const clock = 8;');
    await compiled('packages/node-shared/dist', 'testing', "export * from './fake-socket.js';");
    await compiled('packages/node-shared/dist', 'fake-socket', 'export const socket = 11;');
    await write('packages/providers/package.json', JSON.stringify(providersManifest));
    await compiled('packages/providers/dist', 'index', 'export const claude = 9;');
    await compiled('packages/providers/dist', 'testing', "export * from './fake-files.js';");
    await compiled('packages/providers/dist', 'fake-files', 'export const files = 12;');
    // A directory whose name an exclusion matches. `cp`'s filter prunes the
    // whole subtree under a `false`, so this is the shape that turns a dropped
    // file into a dropped program.
    await compiled('packages/providers/dist/fake-parent', 'kept', 'export const kept = 13;');
    await write('packages/pty/package.json', JSON.stringify(ptyManifest));
    await compiled('packages/pty/dist', 'index', 'export const pty = 10;');
    await write('packages/pty/scripts/node-pty-postinstall.js', 'main();\n');
    await write('apps/web/package.json', JSON.stringify(webManifest));
    await write('apps/web/README.md', '# agentplex-web\n');
    if (options.client) {
      // What vite leaves in `apps/web/dist`: the shell, the fingerprinted
      // bundle and the map it points at, the stylesheet, a font, and the three
      // unfingerprinted files the PWA is installed from. All of it but the map
      // ships, so the fixture holds all of it -- a client fixture that were
      // only a bundle and a map would pass under a filter that took the fonts
      // and the icons with it.
      await write('apps/web/dist/index.html', '<!doctype html>\n');
      await write(
        'apps/web/dist/assets/index-abc123.js',
        'export {};\n//# sourceMappingURL=index-abc123.js.map\n',
      );
      await write('apps/web/dist/assets/index-abc123.js.map', '{"sourcesContent":["x"]}\n');
      await write('apps/web/dist/assets/index-abc123.css', 'body{}\n');
      await write('apps/web/dist/assets/manrope-latin-400-normal-abc123.woff2', 'woff2\n');
      await write('apps/web/dist/manifest.webmanifest', '{"name":"agentplex"}\n');
      await write('apps/web/dist/sw.js', 'self.addEventListener();\n');
      await write('apps/web/dist/icons/icon-192.png', 'png\n');
    }
    return root;
  }

  /** Every file under `directory`, relative to it, in a stable order. */
  async function tree(directory: string): Promise<readonly string[]> {
    const found: string[] = [];
    const walk = async (at: string): Promise<void> => {
      for (const entry of await readdir(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) await walk(path);
        else found.push(relative(directory, path));
      }
    };
    await walk(directory);
    return found.sort();
  }

  /** All four, by published name, from one workspace. */
  async function assembleAll(root: string, version?: string): Promise<ReadonlyMap<string, string>> {
    const assembled = await assemblePackages({
      workspaceRoot: root,
      ...(version === undefined ? {} : { version }),
    });
    return new Map(assembled.map((item) => [item.target.name, item.directory]));
  }

  it('writes one tree per package, each into its own app', async () => {
    const root = await workspace({ client: true });

    const directories = await assembleAll(root);

    expect([...directories.values()].map((path) => relative(root, path)).sort()).toEqual([
      'apps/cli/release',
      'apps/hub/release',
      'apps/server/release',
      'apps/web/release',
    ]);
  });

  it('holds the compiled program, the bundled packages and what each reads off a disk', async () => {
    const root = await workspace({ client: true });

    const directories = await assembleAll(root);
    const held = async (target: PackageTarget, path: string): Promise<string> =>
      await readFile(join(directories.get(target.name) ?? '', path), 'utf8');

    await expect(held(CLI, 'apps/cli/dist/main.js')).resolves.toContain('main()');
    await expect(held(CLI, 'node_modules/@agentplex/pty/dist/index.js')).resolves.toContain('pty');
    await expect(held(HUB, 'apps/hub/dist/main.js')).resolves.toContain('main()');
    await expect(held(HUB, 'apps/hub/migrations/0001_hub_identity.sql')).resolves.toContain(
      'create table',
    );
    await expect(held(SERVER, 'apps/server/dist/main.js')).resolves.toContain('main()');
    await expect(held(WEB, 'dist/assets/index-abc123.js')).resolves.toContain('export');
    for (const target of PACKAGES) {
      await expect(held(target, 'LICENSE'), target.name).resolves.toContain('Apache');
      await expect(held(target, 'README.md'), target.name).resolves.toContain('agentplex');
    }
  });

  /**
   * The claim the whole split rests on, read off a real tree rather than off a
   * manifest: nothing anywhere under the hub package mentions node-pty, so
   * there is nothing for npm to compile and nothing for a toolchain to be
   * needed by.
   */
  it('puts no node-pty anywhere in the hub package', async () => {
    const root = await workspace({ client: true });

    const directories = await assembleAll(root);
    const hub = directories.get(HUB.name) ?? '';

    const files = await tree(hub);
    expect(files.filter((path) => path.includes('pty'))).toEqual([]);
    for (const path of files.filter((name) => name.endsWith('.json'))) {
      expect(await readFile(join(hub, path), 'utf8'), path).not.toContain('node-pty');
    }
  });

  /**
   * The reason a package keeps the workspace layout. `main.js` resolves the
   * migrations against its own URL and has no idea a package exists; if
   * packaging ever moves that directory, this fails here rather than on a
   * stranger's machine after an install.
   */
  it('puts the migrations where the hub main.js resolves them', async () => {
    const root = await workspace({ client: true });

    const directories = await assembleAll(root);
    const hub = directories.get(HUB.name) ?? '';

    const main = pathToFileURL(join(hub, 'apps/hub/dist/main.js'));
    expect(fileURLToPath(new URL('../migrations', main))).toBe(join(hub, 'apps/hub/migrations'));
  });

  /**
   * The client is what stopped being a relative path, and this is the shape of
   * why: `../../web/dist` from the hub's main.js now names a directory inside
   * the hub's own package that nothing puts anything in. The hub resolves the
   * client's package instead -- see `apps/hub/src/web/web-package.ts` -- and
   * the two trees below are the two packages that arrangement assumes.
   */
  it('leaves the client where the hub cannot reach it by counting directories', async () => {
    const root = await workspace({ client: true });

    const directories = await assembleAll(root);
    const hub = directories.get(HUB.name) ?? '';

    const main = pathToFileURL(join(hub, 'apps/hub/dist/main.js'));
    await expect(
      readFile(fileURLToPath(new URL('../../web/dist/index.html', main))),
    ).rejects.toThrow();
    // And the expression that replaced it, spelled the way the hub spells it:
    // the build beside the client package's manifest.
    const manifest = pathToFileURL(join(directories.get(WEB.name) ?? '', 'package.json'));
    await expect(
      readFile(fileURLToPath(new URL('./dist/index.html', manifest)), 'utf8'),
    ).resolves.toContain('doctype');
  });

  /**
   * The same question for the bin, which had the same answer and got it wrong.
   *
   * `--version` is read out of a manifest resolved against `main.js`'s own URL,
   * and there are two manifests it could mean. `apps/cli/package.json` is the
   * one `bin` is declared in, and it is a workspace file: no entry copies it
   * and `files` never names it, so in the package it is not there at all. The
   * manifest that exists in every home of the bin is the package root's -- the
   * one this module writes, carrying the version the release tag named, and the
   * workspace's own `0.0.0` in a checkout.
   *
   * That distinction is invisible from a checkout, which is how the one-level
   * expression shipped and turned `agentplex --version` into an ENOENT on every
   * installed machine. It is visible from here, because here the assembled tree
   * is the subject.
   */
  it('puts the manifest where main.js resolves the version it prints', async () => {
    const root = await workspace({ client: true });

    const directory = (await assembleAll(root, '4.5.6')).get(CLI.name) ?? '';

    const main = pathToFileURL(join(directory, ENTRYPOINT));
    const manifest = fileURLToPath(new URL('../../../package.json', main));
    expect(manifest).toBe(join(directory, 'package.json'));
    expect(JSON.parse(await readFile(manifest, 'utf8'))).toMatchObject({
      name: '@softiesolutions/agentplex',
      version: '4.5.6',
    });
    // And the file the old expression named is absent, rather than present and
    // stale: this is the whole of why that bug could only exist in the artifact.
    await expect(readFile(join(directory, BIN_APP, 'package.json'), 'utf8')).rejects.toThrow();
  });

  it('bundles every workspace package at the path Node resolves it from', async () => {
    const root = await workspace({ client: true });

    const directory = (await assembleAll(root)).get(CLI.name) ?? '';

    const manifestOf = async (name: string): Promise<unknown> =>
      JSON.parse(await readFile(join(directory, `node_modules/${name}/package.json`), 'utf8'));
    await expect(manifestOf('@agentplex/protocol')).resolves.toMatchObject({
      name: '@agentplex/protocol',
      version: '1.2.3',
    });
    await expect(
      readFile(join(directory, 'node_modules/@agentplex/node-shared/dist/index.js'), 'utf8'),
    ).resolves.toContain('clock');
  });

  /**
   * The three categories a compiled `dist` carries for the workspace and for
   * nothing on an installed machine. Asserted over every package's whole tree
   * rather than file by file, so a fifth package is covered the day it arrives
   * instead of the day somebody remembers this test.
   */
  it('leaves maps, declarations and the testing entries out of the compiled output', async () => {
    const root = await workspace({ client: true });

    const directories = await assembleAll(root);

    for (const target of [CLI, HUB, SERVER]) {
      const compiled = await tree(directories.get(target.name) ?? '');
      expect(
        compiled.filter((path) => path.endsWith('.map')),
        target.name,
      ).toEqual([]);
      expect(
        compiled.filter((path) => path.endsWith('.d.ts')),
        target.name,
      ).toEqual([]);
      // By file name: the fixture holds a `fake-parent` directory on purpose,
      // and a path test would call keeping it a failure.
      expect(
        compiled.filter((path) => /^(testing\.|fake-)/.test(basename(path))),
        target.name,
      ).toEqual([]);
    }
    // The same trees still hold what they are for.
    expect(await tree(directories.get(HUB.name) ?? '')).toContain(
      join('apps', 'hub', 'dist', 'main.js'),
    );
    expect(await tree(directories.get(SERVER.name) ?? '')).toContain(
      join('node_modules', '@agentplex', 'providers', 'dist', 'index.js'),
    );
  });

  /**
   * `cp`'s filter is asked about directories too and a `false` prunes
   * everything beneath one, so an exclusion that matched by name alone would
   * take `fake-parent/kept.js` with it and the failure would be an import that
   * cannot be resolved on a stranger's machine.
   */
  it('drops a file whose name is excluded, not a directory that shares it', async () => {
    const root = await workspace({ client: true });

    const directory = (await assembleAll(root)).get(SERVER.name) ?? '';

    await expect(
      readFile(
        join(directory, 'node_modules/@agentplex/providers/dist/fake-parent/kept.js'),
        'utf8',
      ),
    ).resolves.toContain('kept');
  });

  /**
   * The client's map is the largest file the build produces -- 3437 KB against
   * an 834 KB bundle -- and it resolves to nothing on a machine that installed
   * the package. It is emitted on purpose and kept in the build; it is left out
   * of the package here.
   */
  it('leaves the client source map out of the client package', async () => {
    const root = await workspace({ client: true });

    const directory = (await assembleAll(root)).get(WEB.name) ?? '';

    expect((await tree(directory)).filter((path) => path.endsWith('.map'))).toEqual([]);
  });

  /**
   * The other half of the exclusion, and the half a test of what is gone cannot
   * fail on: the filter is one name, so everything the browser actually loads
   * is still there. A client that installs without its fonts, its manifest or
   * its icons is a PWA nobody can install, and the symptom is on a stranger's
   * machine.
   */
  it('keeps every file of the client build the browser loads', async () => {
    const root = await workspace({ client: true });

    const directory = (await assembleAll(root)).get(WEB.name) ?? '';

    expect((await tree(directory)).filter((path) => path.startsWith('dist'))).toEqual([
      join('dist', 'assets', 'index-abc123.css'),
      join('dist', 'assets', 'index-abc123.js'),
      join('dist', 'assets', 'manrope-latin-400-normal-abc123.woff2'),
      join('dist', 'icons', 'icon-192.png'),
      join('dist', 'index.html'),
      join('dist', 'manifest.webmanifest'),
      join('dist', 'sw.js'),
    ]);
  });

  /**
   * The `sourceMappingURL` comment stays in the shipped bundle, and that is the
   * decision rather than an oversight. `sourcemap: 'hidden'` would drop it at
   * the build and take the map's association away from the development build
   * the map is kept for; the comment costs one request from a browser with
   * devtools open, and the hub answers a missing `.map` with a 404 -- see
   * `web-assets.test.ts`, which holds that at the origin.
   */
  it('leaves the bundle pointing at the map it no longer ships', async () => {
    const root = await workspace({ client: true });

    const directory = (await assembleAll(root)).get(WEB.name) ?? '';

    await expect(
      readFile(join(directory, 'dist/assets/index-abc123.js'), 'utf8'),
    ).resolves.toContain('sourceMappingURL=index-abc123.js.map');
  });

  it('carries the postinstall at the path the published manifest names', async () => {
    const root = await workspace({ client: true });

    const directories = await assembleAll(root);

    for (const target of [CLI, SERVER]) {
      await expect(
        readFile(
          join(directories.get(target.name) ?? '', 'packages/pty/scripts/node-pty-postinstall.js'),
          'utf8',
        ),
        target.name,
      ).resolves.toContain('main()');
    }
    for (const target of [HUB, WEB]) {
      await expect(
        readFile(
          join(directories.get(target.name) ?? '', 'packages/pty/scripts/node-pty-postinstall.js'),
          'utf8',
        ),
      ).rejects.toThrow();
    }
  });

  /**
   * `bin` links a path, and the kernel reads the first two bytes of what it
   * finds there. Without them the installed `agentplex` is handed to the shell
   * and answers `import: command not found` -- which is what the first install
   * of this package actually did.
   */
  it('refuses a compiled entrypoint the kernel cannot start', async () => {
    const root = await workspace({ client: true });
    await writeFile(join(root, 'apps/cli/dist/main.js'), 'await main();\n', 'utf8');

    await expect(assemblePackage({ target: CLI, workspaceRoot: root })).rejects.toThrow('shebang');
  });

  /**
   * The daemons have no `bin`, so nothing checks their entries for a shebang
   * and nothing needs to: a unit names an interpreter and a path, and the
   * kernel is never asked to start one of these files on its own.
   */
  it('does not ask a daemon package for a shebang it has no bin to link', async () => {
    const root = await workspace({ client: true });
    await writeFile(join(root, 'apps/hub/dist/main.js'), 'await main();\n', 'utf8');

    await expect(assemblePackage({ target: HUB, workspaceRoot: root })).resolves.toBeDefined();
  });

  it('refuses to package a client that was never built, naming the package', async () => {
    const root = await workspace({ client: false });

    await expect(assemblePackage({ target: WEB, workspaceRoot: root })).rejects.toThrow(
      '@softiesolutions/agentplex-web',
    );
    await expect(assemblePackage({ target: WEB, workspaceRoot: root })).rejects.toThrow(
      'apps/web/dist',
    );
  });

  /** A hub does not carry the client, so a client that was never built is not its problem. */
  it('assembles the hub from a workspace whose client was never built', async () => {
    const root = await workspace({ client: false });

    await expect(assemblePackage({ target: HUB, workspaceRoot: root })).resolves.toBeDefined();
  });

  it('names every missing input rather than the first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentplex-package-'));
    temporary.push(root);

    const missing = await missingInputs(root, CLI.entries);

    expect(missing.map((item) => item.path)).toEqual(CLI.entries.map((entry) => entry.from));
  });

  /**
   * The whole of what the release workflow does to the version: it assembles
   * with the version it parsed out of the tag, and the manifest on disk is the
   * one npm packs. Nothing edits the JSON afterwards, so nothing can disagree
   * with what was assembled -- and all four carry the same version, because
   * this release is one build.
   */
  it('writes the release version into every manifest it leaves on disk', async () => {
    const root = await workspace({ client: true });

    const directories = await assembleAll(root, '3.1.0-rc.2');

    for (const [name, directory] of directories) {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
      };
      expect(manifest.name).toBe(name);
      expect(manifest.version, name).toBe('3.1.0-rc.2');
    }
  });

  it('replaces what was there rather than merging into it', async () => {
    const root = await workspace({ client: true });
    const first = await assemblePackage({ target: CLI, workspaceRoot: root });
    await writeFile(join(first.directory, 'apps/cli/dist/stale.js'), 'gone\n', 'utf8');

    const second = await assemblePackage({ target: CLI, workspaceRoot: root });

    await expect(
      readFile(join(second.directory, 'apps/cli/dist/stale.js'), 'utf8'),
    ).rejects.toThrow();
  });
});
