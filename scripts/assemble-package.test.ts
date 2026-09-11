import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assemblePackage,
  BIN_APP,
  bundledManifest,
  ENTRYPOINT,
  missingInputs,
  packageEntries,
  parseManifest,
  publishedManifest,
  versionFromTag,
  type Manifest,
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

/** The bin's own manifest: no runtime dependency, because it only dispatches. */
const serviceManifest: Manifest = {
  name: '@softiesolutions/agentplex',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {},
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

const hubManifest: Manifest = {
  name: '@agentplex/hub',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/node-shared': 'workspace:*',
    '@agentplex/protocol': 'workspace:*',
    '@agentplex/providers': 'workspace:*',
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

const setupAppManifest: Manifest = { ...serverAppManifest, name: '@agentplex/setup' };
const doctorAppManifest: Manifest = { ...hubManifest, name: '@agentplex/doctor' };

const bundledManifests = [protocolManifest, nodeSharedManifest, providersManifest, ptyManifest];

function derived(): Record<string, unknown> {
  return publishedManifest({
    root: rootManifest,
    service: serviceManifest,
    apps: [hubManifest, serverAppManifest, setupAppManifest, doctorAppManifest],
    bundled: bundledManifests,
  });
}

describe('publishedManifest', () => {
  it('resolves every workspace package to an exact version and bundles it', () => {
    const manifest = derived();

    expect(manifest['dependencies']).toEqual({
      '@agentplex/node-shared': '1.2.3',
      '@agentplex/protocol': '1.2.3',
      '@agentplex/providers': '1.2.3',
      '@agentplex/pty': '1.2.3',
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
   * node-pty is the one dependency npm is allowed to fail to install.
   *
   * It has no Linux prebuild, so npm compiles it from source, and that compile
   * is the likeliest step of the whole install to fail -- on a hub, which never
   * opens a pseudoterminal, for a program the hub does not run. It reaches this
   * manifest from the bundled `@agentplex/pty`, which the server and the wizard
   * depend on and the hub does not.
   */
  it('declares node-pty optional, so a hub installs without a C++ toolchain', () => {
    const manifest = derived();

    expect(manifest['optionalDependencies']).toEqual({ 'node-pty': '1.1.0' });
    // In one field, not both: npm reads `dependencies` first, and a name in
    // both is a required dependency wearing an optional label.
    expect(manifest['dependencies']).not.toHaveProperty('node-pty');
  });

  /**
   * The bundled packages are what Node's resolver walks into from the installed
   * tree, and that is decided by `workspace:` ranges rather than by this list.
   * Moving a name into `optionalDependencies` must not move it out of the
   * tarball, or the published package carries a hole where a compiled package
   * used to be.
   */
  it('leaves the bundled workspace packages exactly where they were', () => {
    const manifest = derived();

    expect(manifest['bundleDependencies']).toEqual([
      '@agentplex/node-shared',
      '@agentplex/protocol',
      '@agentplex/providers',
      '@agentplex/pty',
    ]);
    expect(manifest['dependencies']).toMatchObject({
      '@agentplex/node-shared': '1.2.3',
      '@agentplex/protocol': '1.2.3',
      '@agentplex/providers': '1.2.3',
      '@agentplex/pty': '1.2.3',
    });
    expect(manifest['optionalDependencies']).not.toHaveProperty('@agentplex/pty');
  });

  it('refuses a workspace dependency nothing bundles', () => {
    expect(() =>
      publishedManifest({
        root: rootManifest,
        service: serviceManifest,
        apps: [hubManifest],
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
        root: rootManifest,
        service: serviceManifest,
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
    expect(derived()['dependencies']).toMatchObject({ ws: '^8.21.3' });
  });

  it('refuses two ranges for one dependency', () => {
    const conflicting: Manifest = {
      ...nodeSharedManifest,
      dependencies: { zod: '^3.0.0' },
    };

    expect(() =>
      publishedManifest({
        root: rootManifest,
        service: serviceManifest,
        bundled: [protocolManifest, providersManifest, ptyManifest, conflicting],
      }),
    ).toThrow('zod');
  });

  it('accepts a bundled package that agrees with the service', () => {
    const agreeing: Manifest = {
      ...nodeSharedManifest,
      dependencies: { zod: '^4.1.13' },
    };

    expect(
      publishedManifest({
        root: rootManifest,
        service: serviceManifest,
        bundled: [protocolManifest, providersManifest, ptyManifest, agreeing],
      })['dependencies'],
    ).toMatchObject({ zod: '^4.1.13' });
  });

  it('declares node and not pnpm, because the target machine has only node', () => {
    expect(derived()['engines']).toEqual({ node: '>=24' });
  });

  it('is publishable: no private flag, no dev dependencies, one bin', () => {
    const manifest = derived();

    expect(manifest['private']).toBeUndefined();
    expect(manifest['devDependencies']).toBeUndefined();
    expect(manifest['bin']).toEqual({ agentplex: './apps/cli/dist/main.js' });
  });

  /**
   * The unscoped `agentplex` on npm is somebody else's package, so this
   * publishes under the scope. A package name and a command name are separate
   * things -- `bin` maps one to a path -- so the registry entry moves and the
   * word an operator types does not.
   */
  it('publishes under the scope and still installs the `agentplex` command', () => {
    const manifest = derived();

    expect(manifest['name']).toBe('@softiesolutions/agentplex');
    expect(Object.keys(manifest['bin'] as Record<string, string>)).toEqual(['agentplex']);
  });

  /**
   * `--access public` is passed by the release workflow, which is the only
   * thing that publishes this package, and the first publish is the only one
   * the flag decides anything for. A `publishConfig` here would be the same
   * fact written twice.
   */
  it('leaves access to the publishing command rather than restating it', () => {
    expect(derived()['publishConfig']).toBeUndefined();
  });

  /**
   * The published name is the service's and the description is the workspace
   * root's. The two manifests are named differently now, so which one each
   * field is taken from is observable rather than a coincidence of them
   * agreeing.
   */
  it('takes its description from the workspace root, not its name', () => {
    expect(derived()['description']).toBe(rootManifest.description);
    expect(derived()['name']).not.toBe(rootManifest.name);
  });

  it('keeps the node-pty postinstall as its only install script', () => {
    expect(derived()['scripts']).toEqual({
      postinstall: 'node packages/pty/scripts/node-pty-postinstall.js',
    });
  });

  /**
   * Nothing in the workspace carries a version: every manifest is `0.0.0` and
   * the release workflow is what knows which version is being cut. The
   * override is the seam it writes through, so the manifest that gets
   * published is built with the version rather than edited after the fact.
   */
  it('takes the version from the override when the release names one', () => {
    const manifest = publishedManifest({
      root: rootManifest,
      service: { ...serviceManifest, version: '0.0.0' },
      apps: [hubManifest],
      bundled: bundledManifests,
      version: '2.0.1',
    });

    expect(manifest['version']).toBe('2.0.1');
  });

  it('falls back to the service manifest when no release names one', () => {
    expect(derived()['version']).toBe('1.2.3');
  });

  /**
   * A bundled package's version is what the published manifest depends on by
   * exact version, and the two are written from different sources. An override
   * that moved one and not the other would produce a manifest asking for a
   * version of itself that the tarball does not carry.
   */
  it('leaves the bundled versions where they are', () => {
    const manifest = publishedManifest({
      root: rootManifest,
      service: serviceManifest,
      bundled: bundledManifests,
      version: '2.0.1',
    });

    expect(manifest['dependencies']).toMatchObject({ '@agentplex/protocol': '1.2.3' });
  });

  it('lists every copied path in files, and no bundled one', () => {
    const files = derived()['files'];

    expect(files).toContain('apps/web/dist');
    expect(files).toContain('apps/hub/dist');
    expect(files).toContain('apps/hub/migrations');
    expect(files).not.toContain('node_modules/@agentplex/protocol/dist');
  });
});

describe('packageEntries', () => {
  it('carries the five programs, the client and the migrations', () => {
    const sources = packageEntries().map((entry) => entry.from);

    expect(sources).toContain('apps/cli/dist');
    expect(sources).toContain('apps/hub/dist');
    expect(sources).toContain('apps/server/dist');
    expect(sources).toContain('apps/setup/dist');
    expect(sources).toContain('apps/doctor/dist');
    expect(sources).toContain('apps/hub/migrations');
    expect(sources).toContain('packages/protocol/dist');
    expect(sources).toContain('packages/node-shared/dist');
    expect(sources).toContain('packages/providers/dist');
    expect(sources).toContain('packages/pty/dist');
    expect(sources).toContain('packages/pty/scripts/node-pty-postinstall.js');
    expect(sources).toContain('apps/web/dist');
  });

  it('writes nothing outside the package root', () => {
    for (const entry of packageEntries()) {
      expect(entry.to.startsWith('/')).toBe(false);
      expect(entry.to.split('/')).not.toContain('..');
    }
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

describe('the assembled package', () => {
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
    await write('apps/cli/package.json', JSON.stringify(serviceManifest));
    await write('apps/cli/README.md', '# agentplex\n');
    await compiled('apps/cli/dist', 'main', '#!/usr/bin/env node\nawait main();');
    await write('apps/hub/package.json', JSON.stringify(hubManifest));
    await compiled('apps/hub/dist', 'main', '#!/usr/bin/env node\nawait main();');
    await write('apps/server/package.json', JSON.stringify(serverAppManifest));
    await compiled('apps/server/dist', 'main', '#!/usr/bin/env node\nawait main();');
    await write('apps/setup/package.json', JSON.stringify(setupAppManifest));
    await compiled('apps/setup/dist', 'main', '#!/usr/bin/env node\nawait main();');
    await write('apps/doctor/package.json', JSON.stringify(doctorAppManifest));
    await compiled('apps/doctor/dist', 'main', '#!/usr/bin/env node\nawait main();');
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

  it('holds the compiled service, the protocol, the client and the migrations', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    const held = async (path: string): Promise<string> =>
      await readFile(join(assembled.directory, path), 'utf8');
    await expect(held('apps/cli/dist/main.js')).resolves.toContain('main()');
    await expect(held('apps/hub/migrations/0001_hub_identity.sql')).resolves.toContain(
      'create table',
    );
    await expect(held('apps/hub/dist/main.js')).resolves.toContain('main()');
    await expect(held('apps/web/dist/assets/index-abc123.js')).resolves.toContain('export');
    await expect(held('node_modules/@agentplex/protocol/dist/index.js')).resolves.toContain(
      'version',
    );
    await expect(held('LICENSE')).resolves.toContain('Apache');
    await expect(held('README.md')).resolves.toContain('agentplex');
  });

  /**
   * The reason the package keeps the workspace layout. `main.ts` resolves both
   * of these against its own URL and has no idea a package exists; if packaging
   * ever moves a directory, this fails here rather than on a stranger's machine
   * after an install.
   */
  it('puts the migrations and the client where main.js resolves them', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    const main = pathToFileURL(join(assembled.directory, 'apps/hub/dist/main.js'));
    expect(fileURLToPath(new URL('../migrations', main))).toBe(
      join(assembled.directory, 'apps/hub/migrations'),
    );
    expect(fileURLToPath(new URL('../../web/dist', main))).toBe(
      join(assembled.directory, 'apps/web/dist'),
    );
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

    const assembled = await assemblePackage({ workspaceRoot: root, version: '4.5.6' });

    const main = pathToFileURL(join(assembled.directory, ENTRYPOINT));
    const manifest = fileURLToPath(new URL('../../../package.json', main));
    expect(manifest).toBe(join(assembled.directory, 'package.json'));
    expect(JSON.parse(await readFile(manifest, 'utf8'))).toMatchObject({
      name: '@softiesolutions/agentplex',
      version: '4.5.6',
    });
    // And the file the old expression named is absent, rather than present and
    // stale: this is the whole of why that bug could only exist in the artifact.
    await expect(
      readFile(join(assembled.directory, BIN_APP, 'package.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('bundles every workspace package at the path Node resolves it from', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    const manifestOf = async (name: string): Promise<unknown> =>
      JSON.parse(
        await readFile(join(assembled.directory, `node_modules/${name}/package.json`), 'utf8'),
      );
    await expect(manifestOf('@agentplex/protocol')).resolves.toMatchObject({
      name: '@agentplex/protocol',
      version: '1.2.3',
    });
    await expect(manifestOf('@agentplex/node-shared')).resolves.toMatchObject({
      name: '@agentplex/node-shared',
      version: '1.2.3',
    });
    await expect(
      readFile(
        join(assembled.directory, 'node_modules/@agentplex/node-shared/dist/index.js'),
        'utf8',
      ),
    ).resolves.toContain('clock');
    expect(assembled.manifest['bundleDependencies']).toEqual([
      '@agentplex/node-shared',
      '@agentplex/protocol',
      '@agentplex/providers',
      '@agentplex/pty',
    ]);
  });

  /**
   * The three categories a compiled `dist` carries for the workspace and for
   * nothing on an installed machine. Asserted over the whole tree rather than
   * file by file, so a fifth program added to the package is covered the day it
   * arrives instead of the day somebody remembers this test.
   */
  it('leaves maps, declarations and the testing entries out of the compiled output', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    const compiled = (await tree(assembled.directory)).filter(
      (path) => !path.startsWith(join('apps', 'web')),
    );
    expect(compiled.filter((path) => path.endsWith('.map'))).toEqual([]);
    expect(compiled.filter((path) => path.endsWith('.d.ts'))).toEqual([]);
    // By file name: the fixture holds a `fake-parent` directory on purpose, and
    // a path test would call keeping it a failure.
    expect(compiled.filter((path) => /^(testing\.|fake-)/.test(basename(path)))).toEqual([]);
    // The same tree still holds what it is for.
    expect(compiled).toContain(join('apps', 'hub', 'dist', 'main.js'));
    expect(compiled).toContain(join('node_modules', '@agentplex', 'providers', 'dist', 'index.js'));
  });

  /**
   * `cp`'s filter is asked about directories too and a `false` prunes
   * everything beneath one, so an exclusion that matched by name alone would
   * take `fake-parent/kept.js` with it and the failure would be an import that
   * cannot be resolved on a stranger's machine.
   */
  it('drops a file whose name is excluded, not a directory that shares it', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    await expect(
      readFile(
        join(assembled.directory, 'node_modules/@agentplex/providers/dist/fake-parent/kept.js'),
        'utf8',
      ),
    ).resolves.toContain('kept');
  });

  /**
   * The client's map is the largest file the build produces -- 3437 KB against
   * an 834 KB bundle, 57 percent of the unpacked package -- and every installed
   * machine carried it, a `--role=server` one that never serves a page
   * included. It is emitted on purpose and kept in the build; it is left out of
   * the package here.
   */
  it('leaves the client source map out of the package', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    const client = (await tree(assembled.directory)).filter((path) =>
      path.startsWith(join('apps', 'web')),
    );
    expect(client.filter((path) => path.endsWith('.map'))).toEqual([]);
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

    const assembled = await assemblePackage({ workspaceRoot: root });

    const client = (await tree(assembled.directory)).filter((path) =>
      path.startsWith(join('apps', 'web')),
    );
    expect(client).toEqual([
      join('apps', 'web', 'dist', 'assets', 'index-abc123.css'),
      join('apps', 'web', 'dist', 'assets', 'index-abc123.js'),
      join('apps', 'web', 'dist', 'assets', 'manrope-latin-400-normal-abc123.woff2'),
      join('apps', 'web', 'dist', 'icons', 'icon-192.png'),
      join('apps', 'web', 'dist', 'index.html'),
      join('apps', 'web', 'dist', 'manifest.webmanifest'),
      join('apps', 'web', 'dist', 'sw.js'),
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

    const assembled = await assemblePackage({ workspaceRoot: root });

    await expect(
      readFile(join(assembled.directory, 'apps/web/dist/assets/index-abc123.js'), 'utf8'),
    ).resolves.toContain('sourceMappingURL=index-abc123.js.map');
  });

  it('carries the postinstall at the path the published manifest names', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    await expect(
      readFile(join(assembled.directory, 'packages/pty/scripts/node-pty-postinstall.js'), 'utf8'),
    ).resolves.toContain('main()');
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

    await expect(assemblePackage({ workspaceRoot: root })).rejects.toThrow('shebang');
  });

  it('refuses to package a workspace whose client was never built', async () => {
    const root = await workspace({ client: false });

    await expect(assemblePackage({ workspaceRoot: root })).rejects.toThrow('apps/web/dist');
  });

  it('names every missing input rather than the first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentplex-package-'));
    temporary.push(root);

    const missing = await missingInputs(root, packageEntries());

    expect(missing.map((item) => item.path)).toEqual(packageEntries().map((entry) => entry.from));
  });

  /**
   * The whole of what the release workflow does to the version: it assembles
   * with the version it parsed out of the tag, and the manifest on disk is the
   * one npm packs. Nothing edits the JSON afterwards, so nothing can disagree
   * with what was assembled.
   */
  it('writes the release version into the manifest it leaves on disk', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root, version: '3.1.0-rc.2' });

    expect(assembled.manifest['version']).toBe('3.1.0-rc.2');
    await expect(
      readFile(join(assembled.directory, 'package.json'), 'utf8').then(
        (text) => (JSON.parse(text) as { version: string }).version,
      ),
    ).resolves.toBe('3.1.0-rc.2');
  });

  it('replaces what was there rather than merging into it', async () => {
    const root = await workspace({ client: true });
    const first = await assemblePackage({ workspaceRoot: root });
    await writeFile(join(first.directory, 'apps/cli/dist/stale.js'), 'gone\n', 'utf8');

    const second = await assemblePackage({ workspaceRoot: root });

    await expect(
      readFile(join(second.directory, 'apps/cli/dist/stale.js'), 'utf8'),
    ).rejects.toThrow();
  });
});
