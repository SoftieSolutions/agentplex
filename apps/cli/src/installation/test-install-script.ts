import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

/**
 * `install.sh`'s own source text, for the suites that hold a constant here
 * against the one the script declares.
 *
 * This is the only tie there can be. The script is fetched over HTTPS and run
 * on a machine with nothing on it, so it imports nothing and nothing imports it;
 * what is left is reading it, the way `install.sh.integration.test.ts` reads the
 * assembler's table to hold the script against it.
 */
export const INSTALL_SCRIPT = readFileSync(
  fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url)),
  'utf8',
);

/**
 * The value of one `readonly NAME=value` line in the script.
 *
 * Single-quoted, double-quoted or bare, because the script declares all three:
 * a path is `readonly SYSTEM_PREFIX='/opt/agentplex'`, a URL built from another
 * constant is `readonly NODE_DIST_URL="https://.../latest-v${NODE_MAJOR}.x"`,
 * and a number is bare. A double-quoted value is expanded the one way the
 * script expands it here, `${NAME}` naming another `readonly` constant, and a
 * `$` left over after that is a shape this does not read, so it fails rather
 * than hand back text bash would have expanded differently. A constant that
 * stopped being `readonly` fails here rather than silently stop being checked.
 */
export function declared(name: string): string {
  const match = new RegExp(`^readonly ${name}=(?:'([^']*)'|"([^"]*)"|([^'"\\s]+))$`, 'm').exec(
    INSTALL_SCRIPT,
  );
  const quoted = match?.[2];
  const found =
    quoted === undefined
      ? (match?.[1] ?? match?.[3])
      : quoted.replaceAll(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, other: string) => declared(other));
  expect(found, `install.sh declares no ${name}`).toBeDefined();
  expect(found, `install.sh declares ${name} with an expansion this does not read`).not.toContain(
    '$',
  );
  return found ?? '';
}
