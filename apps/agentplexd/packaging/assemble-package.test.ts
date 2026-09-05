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
    '@agentplex/protocol': 'workspace:*',
    'node-pty': '1.1.0',
    ws: '^8.21.3',
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

function derived(): Record<string, unknown> {
  return publishedManifest({
    root: rootManifest,
    service: serviceManifest,
    bundled: [protocolManifest],
  });
}

describe('publishedManifest', () => {
  it('resolves the workspace protocol to an exact version and bundles it', () => {
    const manifest = derived();

    expect(manifest['dependencies']).toEqual({
      '@agentplex/protocol': '1.2.3',
      'node-pty': '1.1.0',
      ws: '^8.21.3',
      zod: '^4.1.13',
    });
    expect(manifest['bundleDependencies']).toEqual(['@agentplex/protocol']);
  });

  it('refuses a workspace dependency nothing bundles', () => {
    expect(() =>
      publishedManifest({ root: rootManifest, service: serviceManifest, bundled: [] }),
    ).toThrow('@agentplex/protocol');
  });

  /**
   * npm never fetches a bundled package's own dependencies, so one the tarball
   * does not satisfy installs as an empty directory and fails at the first
   * import. The host has to declare them, and the assembly is where that is
   * checked -- a published package is the wrong place to find out.
   */
  it('refuses to bundle a package whose dependencies the host does not declare', () => {
    const service: Manifest = {
      ...serviceManifest,
      dependencies: { '@agentplex/protocol': 'workspace:*' },
    };

    expect(() =>
      publishedManifest({ root: rootManifest, service, bundled: [protocolManifest] }),
    ).toThrow('zod');
  });

  it('accepts a bundled dependency the host declares at the same range', () => {
    expect(derived()['dependencies']).toMatchObject({ zod: '^4.1.13' });
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
      postinstall: 'node apps/agentplexd/scripts/fix-node-pty-permissions.js',
    });
  });

  it('lists every copied path in files, and no bundled one', () => {
    const files = derived()['files'];

    expect(files).toContain('apps/web/dist');
    expect(files).toContain('apps/agentplexd/migrations');
    expect(files).not.toContain('node_modules/@agentplex/protocol/dist');
  });
});

describe('packageEntries', () => {
  it('carries the four halves the ticket names', () => {
    const sources = packageEntries().map((entry) => entry.from);

    expect(sources).toContain('apps/agentplexd/dist');
    expect(sources).toContain('packages/protocol/dist');
    expect(sources).toContain('apps/web/dist');
    expect(sources).toContain('apps/agentplexd/migrations');
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
    await write(
      'apps/agentplexd/migrations/0001_hub_identity.sql',
      'create table hub (id text);\n',
    );
    await write('apps/agentplexd/scripts/fix-node-pty-permissions.js', 'main();\n');
    await write('packages/protocol/package.json', JSON.stringify(protocolManifest));
    await write('packages/protocol/dist/index.js', 'export const version = 7;\n');
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
    await expect(held('apps/agentplexd/migrations/0001_hub_identity.sql')).resolves.toContain(
      'create table',
    );
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

    const main = pathToFileURL(join(assembled.directory, 'apps/agentplexd/dist/main.js'));
    expect(fileURLToPath(new URL('../migrations', main))).toBe(
      join(assembled.directory, 'apps/agentplexd/migrations'),
    );
    expect(fileURLToPath(new URL('../../web/dist', main))).toBe(
      join(assembled.directory, 'apps/web/dist'),
    );
  });

  it('bundles the protocol at the path Node resolves it from', async () => {
    const root = await workspace({ client: true });

    const assembled = await assemblePackage({ workspaceRoot: root });

    const bundled: unknown = JSON.parse(
      await readFile(
        join(assembled.directory, 'node_modules/@agentplex/protocol/package.json'),
        'utf8',
      ),
    );
    expect(bundled).toMatchObject({ name: '@agentplex/protocol', version: '1.2.3' });
    expect(assembled.manifest['bundleDependencies']).toEqual(['@agentplex/protocol']);
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
