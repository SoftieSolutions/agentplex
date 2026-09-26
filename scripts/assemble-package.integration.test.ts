import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assemblePackages, PACKAGES } from './assemble-package.js';
import { SHRINKWRAP_FILE } from './shrinkwrap.js';
import { writeWorkspace } from './test-workspace.js';

/**
 * What `npm pack` actually puts in each tarball, asked of npm itself.
 *
 * The assembly decides what the staging directory holds; npm decides what of
 * it reaches the tarball, and the two have disagreed before. npm/cli#6803:
 * with `files` in the manifest, `npm pack` leaves `npm-shrinkwrap.json` out
 * however plainly it sits at the package root. Reading the manifest cannot
 * catch that and reading the staging directory cannot either, so the question
 * goes to the program that answers it.
 *
 * `--dry-run` lists without writing a tarball, `--json` makes the list a
 * document rather than a log, and `--ignore-scripts` keeps the staged
 * `postinstall` from being anybody's business here.
 */

const packedSchema = z.array(
  z.object({
    name: z.string(),
    files: z.array(z.object({ path: z.string() })),
  }),
);

describe('the tarballs npm packs from the assembled packages', { timeout: 120_000 }, () => {
  let root = '';
  const directories = new Map<string, string>();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentplex-pack-'));
    await writeWorkspace(root, { client: true });
    for (const item of await assemblePackages({ workspaceRoot: root })) {
      directories.set(item.target.name, item.directory);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(PACKAGES.map((target) => [target.name] as const))(
    'puts the shrinkwrap in the %s tarball',
    (name) => {
      const run = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: directories.get(name) ?? '',
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);

      const packed = packedSchema.parse(JSON.parse(run.stdout));
      const paths = packed.flatMap((tarball) => tarball.files.map((file) => file.path));
      expect(packed.map((tarball) => tarball.name)).toEqual([name]);
      expect(paths).toContain(SHRINKWRAP_FILE);
      expect(paths).toContain('package.json');
    },
  );
});
