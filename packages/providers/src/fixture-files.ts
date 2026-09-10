import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The captured provider output this package's tests run against, reachable by
 * a test in any app.
 *
 * `fixtures/` sits beside `src/` and `dist/`, so the same expression resolves
 * from source under vitest and from the build under an app's tests. Fixtures
 * are captured real output and are not copied: a test in setup that needs what
 * `claude --version` printed reads the one file the adapter's own test reads.
 */
const FIXTURES_DIRECTORY = new URL('../fixtures/', import.meta.url);

/** The absolute path of one captured fixture. */
export function providerFixturePath(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES_DIRECTORY));
}

/** One captured fixture, as the provider printed it. */
export async function readProviderFixture(name: string): Promise<string> {
  return await readFile(providerFixturePath(name), 'utf8');
}
