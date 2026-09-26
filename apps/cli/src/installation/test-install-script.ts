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
 * Quoted or bare, because the script declares both: a path is
 * `readonly SYSTEM_PREFIX='/opt/agentplex'` and a number is
 * `readonly STOP_TIMEOUT_SECONDS=20`. A constant that stopped being `readonly`
 * fails here rather than silently stop being checked.
 */
export function declared(name: string): string {
  const match = new RegExp(`^readonly ${name}=(?:'([^']*)'|([^'\\s]+))$`, 'm').exec(INSTALL_SCRIPT);
  const found = match?.[1] ?? match?.[2];
  expect(found, `install.sh declares no ${name}`).toBeDefined();
  return found ?? '';
}
