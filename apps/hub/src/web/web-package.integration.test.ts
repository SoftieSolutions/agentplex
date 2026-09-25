import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEB_PACKAGE } from './web-package.js';

/**
 * The one claim about the client package that no fake can make: that the
 * specifier really resolves, from the directory the hub really runs out of.
 *
 * It spawns Node because vitest cannot answer it. Under vite-node
 * `import.meta.resolve` is not a function at all -- verified, it throws
 * `__vite_ssr_import_meta__.resolve is not a function` -- so a test that called
 * it inside the suite would be testing the transform and not the resolver.
 *
 * `--eval` with a working directory is what makes the spawned process ask from
 * the right place: Node gives an evaluated module the URL `<cwd>/[eval1]`, so
 * with the cwd set to the hub's own `dist` the walk up through `node_modules`
 * starts exactly where it starts for `dist/main.js`. The suite already requires
 * a build, which is what puts that directory there.
 *
 * What this holds is the checkout home of the three in `web-package.ts`: pnpm
 * linked `apps/web` into `apps/hub/node_modules` because the hub declares it.
 * Drop that dependency and this fails here, rather than on a machine that
 * installed a hub with nothing to serve. The installed home is held by the
 * `install-check` stage in the Dockerfile, on a machine with two packages under
 * one global root and no workspace anywhere.
 */

const HUB_DIST = fileURLToPath(new URL('../../dist', import.meta.url));

describe('the client package, from the hub that has to find it', () => {
  it('resolves from the directory the built hub runs out of', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `process.stdout.write(import.meta.resolve(${JSON.stringify(`${WEB_PACKAGE}/package.json`)}))`,
      ],
      { cwd: HUB_DIST, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // The workspace's own client, reached through the link rather than through
    // a path: `apps/web` is what pnpm points that name at here.
    expect(result.stdout).toMatch(/\/apps\/web\/package\.json$/);
  });
});
