import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assemblePackage,
  bundledManifest,
  missingInputs,
  packageEntries,
  parseManifest,
  publishedManifest,
  type Manifest,
} from './assemble-package.js';

const rootManifest: Manifest = {
  name: 'agentplex',
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
  name: 'agentplex',
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
      'node-pty': '1.1.0',
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
    expect(manifest['bin']).toEqual({ agentplex: './apps/install/dist/main.js' });
  });

  it('keeps the node-pty permission repair as its only install script', () => {
    expect(derived()['scripts']).toEqual({
      postinstall: 'node packages/pty/scripts/fix-node-pty-permissions.js',
    });
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

    expect(sources).toContain('apps/install/dist');
    expect(sources).toContain('apps/hub/dist');
    expect(sources).toContain('apps/server/dist');
    expect(sources).toContain('apps/setup/dist');
    expect(sources).toContain('apps/doctor/dist');
    expect(sources).toContain('apps/hub/migrations');
    expect(sources).toContain('packages/protocol/dist');
    expect(sources).toContain('packages/node-shared/dist');
    expect(sources).toContain('packages/providers/dist');
    expect(sources).toContain('packages/pty/dist');
    expect(sources).toContain('packages/pty/scripts/fix-node-pty-permissions.js');
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
    await write('apps/install/package.json', JSON.stringify(serviceManifest));
    await write('apps/install/README.md', '# agentplex\n');
    await compiled('apps/install/dist', 'main', '#!/usr/bin/env node\nawait main();');
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
    await write('packages/pty/scripts/fix-node-pty-permissions.js', 'main();\n');
    if (options.client) {
      await write('apps/web/dist/index.html', '<!doctype html>\n');
      await write('apps/web/dist/assets/index-abc123.js', 'export {};\n');
      await write('apps/web/dist/assets/index-abc123.js.map', '{"sourcesContent":["x"]}\n');
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
    await expect(held('apps/install/dist/main.js')).resolves.toContain('main()');
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
   * The one map in the package that resolves. Vite writes `sourcesContent` into
   * it, so it needs no checkout to be read and a browser is the thing that
   * fetches it; the compiled maps name `../src/*.ts` and carry no content, so
   * they resolve to nothing wherever the package is installed.
   */
  it('keeps the client build whole, source map included', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    await expect(
      readFile(join(assembled.directory, 'apps/web/dist/assets/index-abc123.js.map'), 'utf8'),
    ).resolves.toContain('sourcesContent');
  });

  it('carries the postinstall at the path the published manifest names', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    await expect(
      readFile(
        join(assembled.directory, 'packages/pty/scripts/fix-node-pty-permissions.js'),
        'utf8',
      ),
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
    await writeFile(join(root, 'apps/install/dist/main.js'), 'await main();\n', 'utf8');

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

  it('replaces what was there rather than merging into it', async () => {
    const root = await workspace({ client: true });
    const first = await assemblePackage({ workspaceRoot: root });
    await writeFile(join(first.directory, 'apps/install/dist/stale.js'), 'gone\n', 'utf8');

    const second = await assemblePackage({ workspaceRoot: root });

    await expect(
      readFile(join(second.directory, 'apps/install/dist/stale.js'), 'utf8'),
    ).rejects.toThrow();
  });
});
