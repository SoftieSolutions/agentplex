import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { workspaceManifests } from './check-dependency-ranges.js';

/** The checkout this suite is running inside: the manifests are the tree itself. */
const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every workspace member's manifest, by the same member list the range check
 * reads -- the globs in `pnpm-workspace.yaml` -- rather than a list spelled
 * here. The root manifest is not a member: `pnpm test` there is `pnpm -r test`,
 * which runs no suite of its own.
 */
const members = (await workspaceManifests(workspaceRoot)).filter(
  (manifest) => manifest !== 'package.json',
);

/**
 * The two scripts a member runs its suite by. A member missing either fails
 * here by name, rather than being skipped because a lookup came back
 * undefined.
 */
const testScriptsSchema = z.object({
  scripts: z.object({
    test: z.string(),
    'test:coverage': z.string(),
  }),
});

async function testScripts(
  manifest: string,
): Promise<z.infer<typeof testScriptsSchema>['scripts']> {
  const text = await readFile(join(workspaceRoot, manifest), 'utf8');
  return testScriptsSchema.parse(JSON.parse(text)).scripts;
}

describe('every member test script', () => {
  it('reads a member list at all', () => {
    // A glob that matched nothing would make every case below vacuous.
    expect(members.length).toBeGreaterThan(0);
  });

  describe.each(members.map((manifest) => dirname(manifest)))('%s', (member) => {
    const manifest = `${member}/package.json`;

    it('runs vitest once, not in watch mode', async () => {
      const scripts = await testScripts(manifest);
      expect(scripts.test.startsWith('vitest run'), scripts.test).toBe(true);
      expect(scripts['test:coverage'].startsWith('vitest run'), scripts['test:coverage']).toBe(
        true,
      );
      expect(scripts['test:coverage']).toContain('--coverage');
    });

    it('fails when it finds no tests', async () => {
      // A suite that went missing -- a moved directory, an include pattern that
      // stopped matching -- has to be a red run, not a green one reporting
      // nothing.
      const scripts = await testScripts(manifest);
      expect(scripts.test).not.toContain('--passWithNoTests');
      expect(scripts['test:coverage']).not.toContain('--passWithNoTests');
    });
  });
});
