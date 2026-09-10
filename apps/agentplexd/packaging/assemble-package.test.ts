import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const serviceManifest: Manifest = {
  name: 'agentplexd',
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

const bundledManifests = [protocolManifest, nodeSharedManifest, providersManifest, ptyManifest];

function derived(): Record<string, unknown> {
  return publishedManifest({
    root: rootManifest,
    service: serviceManifest,
    apps: [hubManifest, serverAppManifest, setupAppManifest],
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
      publishedManifest({ root: rootManifest, service: serviceManifest, bundled: [] }),
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

  it('lets the service win over a bundled package that asks for the same thing', () => {
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
    expect(manifest['bin']).toEqual({ agentplexd: './apps/agentplexd/dist/main.js' });
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
  it('carries the four halves the ticket names', () => {
    const sources = packageEntries().map((entry) => entry.from);

    expect(sources).toContain('apps/agentplexd/dist');
    expect(sources).toContain('apps/hub/dist');
    expect(sources).toContain('apps/server/dist');
    expect(sources).toContain('apps/setup/dist');
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

    expect(kept['exports']).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    });
    expect(kept['private']).toBeUndefined();
    expect(kept['devDependencies']).toBeUndefined();
    expect(kept['scripts']).toBeUndefined();
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

    expect(kept['dependencies']).toBeUndefined();
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
    const root = await mkdtemp(join(tmpdir(), 'agentplexd-package-'));
    temporary.push(root);

    const write = async (path: string, contents: string): Promise<void> => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), contents, 'utf8');
    };

    await write('package.json', JSON.stringify(rootManifest));
    await write('LICENSE', 'Apache License, Version 2.0\n');
    await write('apps/agentplexd/package.json', JSON.stringify(serviceManifest));
    await write('apps/agentplexd/README.md', '# agentplexd\n');
    await write('apps/agentplexd/dist/main.js', '#!/usr/bin/env node\nawait main();\n');
    await write('apps/hub/package.json', JSON.stringify(hubManifest));
    await write('apps/hub/dist/main.js', '#!/usr/bin/env node\nawait main();\n');
    await write('apps/server/package.json', JSON.stringify(serverAppManifest));
    await write('apps/server/dist/main.js', '#!/usr/bin/env node\nawait main();\n');
    await write('apps/setup/package.json', JSON.stringify(setupAppManifest));
    await write('apps/setup/dist/main.js', '#!/usr/bin/env node\nawait main();\n');
    await write('apps/hub/migrations/0001_hub_identity.sql', 'create table hub (id text);\n');
    await write('packages/protocol/package.json', JSON.stringify(protocolManifest));
    await write('packages/protocol/dist/index.js', 'export const version = 7;\n');
    await write('packages/node-shared/package.json', JSON.stringify(nodeSharedManifest));
    await write('packages/node-shared/dist/index.js', 'export const clock = 8;\n');
    await write('packages/providers/package.json', JSON.stringify(providersManifest));
    await write('packages/providers/dist/index.js', 'export const claude = 9;\n');
    await write('packages/pty/package.json', JSON.stringify(ptyManifest));
    await write('packages/pty/dist/index.js', 'export const pty = 10;\n');
    await write('packages/pty/scripts/fix-node-pty-permissions.js', 'main();\n');
    if (options.client) {
      await write('apps/web/dist/index.html', '<!doctype html>\n');
      await write('apps/web/dist/assets/index-abc123.js', 'export {};\n');
    }
    return root;
  }

  it('holds the compiled service, the protocol, the client and the migrations', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    const held = async (path: string): Promise<string> =>
      await readFile(join(assembled.directory, path), 'utf8');
    await expect(held('apps/agentplexd/dist/main.js')).resolves.toContain('main()');
    await expect(held('apps/hub/migrations/0001_hub_identity.sql')).resolves.toContain(
      'create table',
    );
    await expect(held('apps/hub/dist/main.js')).resolves.toContain('main()');
    await expect(held('apps/web/dist/assets/index-abc123.js')).resolves.toContain('export');
    await expect(held('node_modules/@agentplex/protocol/dist/index.js')).resolves.toContain(
      'version',
    );
    await expect(held('LICENSE')).resolves.toContain('Apache');
    await expect(held('README.md')).resolves.toContain('agentplexd');
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
   * finds there. Without them the installed `agentplexd` is handed to the shell
   * and answers `import: command not found` -- which is what the first install
   * of this package actually did.
   */
  it('refuses a compiled entrypoint the kernel cannot start', async () => {
    const root = await workspace({ client: true });
    await writeFile(join(root, 'apps/agentplexd/dist/main.js'), 'await main();\n', 'utf8');

    await expect(assemblePackage({ workspaceRoot: root })).rejects.toThrow('shebang');
  });

  it('refuses to package a workspace whose client was never built', async () => {
    const root = await workspace({ client: false });

    await expect(assemblePackage({ workspaceRoot: root })).rejects.toThrow('apps/web/dist');
  });

  it('names every missing input rather than the first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentplexd-package-'));
    temporary.push(root);

    const missing = await missingInputs(root, packageEntries());

    expect(missing.map((item) => item.path)).toEqual(packageEntries().map((entry) => entry.from));
  });

  it('replaces what was there rather than merging into it', async () => {
    const root = await workspace({ client: true });
    const first = await assemblePackage({ workspaceRoot: root });
    await writeFile(join(first.directory, 'apps/agentplexd/dist/stale.js'), 'gone\n', 'utf8');

    const second = await assemblePackage({ workspaceRoot: root });

    await expect(
      readFile(join(second.directory, 'apps/agentplexd/dist/stale.js'), 'utf8'),
    ).rejects.toThrow();
  });
});
