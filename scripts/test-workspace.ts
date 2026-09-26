import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from './assemble-package.js';
import { LOCKFILE, WORKSPACE_FILE } from './shrinkwrap.js';

/**
 * A workspace the assembly can run against, on a real disk: the manifests it
 * reads, the compiled output it copies, and the lockfile it derives each
 * shrinkwrap from.
 *
 * Shared by the assembly's unit suite and by the suite that hands the result
 * to a real `npm pack`, rather than copied into each: two copies of a fixture
 * are two fixtures, and the day they drift one of the suites is testing a
 * workspace nobody has.
 */

/** The captured lockfile, and the workspace file pnpm read to write it. */
export const SHRINKWRAP_FIXTURE = fileURLToPath(new URL('fixtures/shrinkwrap', import.meta.url));

// The workspace root, named so that a `--filter` cannot match it beside the
// app it would otherwise be a homonym of. Nothing publishes under this name.
export const rootManifest: Manifest = {
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
export const cliManifest: Manifest = {
  name: '@softiesolutions/agentplex',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/node-shared': 'workspace:*',
    '@agentplex/protocol': 'workspace:*',
    '@agentplex/providers': 'workspace:*',
    '@agentplex/pty': 'workspace:*',
    '@agentplex/release': 'workspace:*',
    zod: '>=4.5.4 <5.0.0',
  },
};

export const protocolManifest: Manifest = {
  name: '@agentplex/protocol',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: { zod: '>=4.5.4 <5.0.0' },
};

export const nodeSharedManifest: Manifest = {
  name: '@agentplex/node-shared',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: { ws: '>=8.21.3 <9.0.0' },
};

export const providersManifest: Manifest = {
  name: '@agentplex/providers',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/node-shared': 'workspace:*',
    '@agentplex/protocol': 'workspace:*',
    zod: '>=4.5.4 <5.0.0',
  },
};

/** The `versions.json` schema, which only the command has a reason to read. */
export const releaseManifest: Manifest = {
  name: '@agentplex/release',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: { zod: '>=4.5.4 <5.0.0' },
};

export const ptyManifest: Manifest = {
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
export const hubManifest: Manifest = {
  name: '@agentplex/hub',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/node-shared': 'workspace:*',
    '@agentplex/protocol': 'workspace:*',
    '@agentplex/providers': 'workspace:*',
    '@softiesolutions/agentplex-web': 'workspace:*',
    zod: '>=4.5.4 <5.0.0',
  },
};

export const serverAppManifest: Manifest = {
  name: '@agentplex/server',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/node-shared': 'workspace:*',
    '@agentplex/protocol': 'workspace:*',
    '@agentplex/providers': 'workspace:*',
    '@agentplex/pty': 'workspace:*',
    zod: '>=4.5.4 <5.0.0',
  },
};

/** The client: a vite app, whose build-time tree must reach no published manifest. */
export const webManifest: Manifest = {
  name: '@softiesolutions/agentplex-web',
  version: '1.2.3',
  license: 'Apache-2.0',
  type: 'module',
  dependencies: {
    '@agentplex/protocol': 'workspace:*',
    react: '>=19.2.8 <20.0.0',
  },
};

export async function writeWorkspace(
  root: string,
  options: { readonly client: boolean },
): Promise<void> {
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
  // Captured, not written: see `fixtures/shrinkwrap/CAPTURE.md`. Its importers
  // are the manifests above, so the shrinkwrap each package is assembled with
  // is derived the way the real one is.
  for (const file of [LOCKFILE, WORKSPACE_FILE]) {
    await write(file, await readFile(join(SHRINKWRAP_FIXTURE, file), 'utf8'));
  }
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
  await write('packages/release/package.json', JSON.stringify(releaseManifest));
  await compiled('packages/release/dist', 'index', 'export const versions = 14;');
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
}
