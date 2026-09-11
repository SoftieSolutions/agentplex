import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The `agentplex` bin, run the way an operator runs it.
 *
 * Nothing below the process level can answer what this asks. `main.ts`
 * dispatches at module top level -- importing it *is* running it -- and the
 * three things worth asserting are which stream a line landed on, what the exit
 * code was, and whether the command word reached the program it names. All
 * three are process facts, so the subject here is a child process and not a
 * function.
 *
 * It runs the built entrypoint, which is also the only honest way to ask the
 * question: `dist/main.js` resolves its siblings and its own manifest relative
 * to `import.meta.url`, and those distances are different from `src/`'s. A
 * suite that loaded the source would confirm paths the published bin never
 * uses. `pnpm -C apps/install build` first, the same requirement
 * `setup-exit.integration.test.ts` already carries.
 *
 * Until this file existed the bin was covered only by the `RUN` lines in the
 * Dockerfile, so every check of it needed a container and none of them ran on a
 * contributor's machine.
 */

const BIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

/** The manifest `--version` has to find, at the path this app really keeps it. */
const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url));

/** A dispatch into a program that refuses its configuration is still quick. */
const RUN_TIMEOUT_MS = 20_000;

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The environment minus everything a program under `AGENTPLEX_` could read.
 *
 * The dispatch case asserts that `hub` refused its configuration, and a machine
 * that happens to export `AGENTPLEX_DATABASE_FILE` would otherwise start a hub
 * from a test suite.
 */
function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTPLEX_')),
  );
}

async function run(...argv: readonly string[]): Promise<Run> {
  const child = spawn(process.execPath, [BIN, ...argv], {
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

/** The version the package really declares, read the way packaging reads it. */
async function declaredVersion(): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const version =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['version']
      : undefined;
  if (typeof version !== 'string') throw new Error(`${MANIFEST} declares no version`);
  return version;
}

describe('the agentplex bin', () => {
  it('asks for a command on stderr when it was given none', async () => {
    const result = await run();

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: agentplex <command> [options]');
  });

  it('answers --help on stdout, because a help request is a successful answer', async () => {
    const result = await run('--help');

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: agentplex <command> [options]');
    for (const name of ['hub', 'server', 'setup', 'doctor']) {
      expect(result.stdout).toContain(name);
    }
    // A flag nothing lists is a flag nobody finds.
    expect(result.stdout).toContain('--version');
  });

  it('answers -h the same way', async () => {
    const [long, short] = await Promise.all([run('--help'), run('-h')]);

    expect(short).toEqual(long);
  });

  it('prints the version its own manifest declares, and nothing else', async () => {
    const [result, version] = await Promise.all([run('--version'), declaredVersion()]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${version}\n`);
  });

  it('names the unknown command on stderr and exits 2', async () => {
    const result = await run('bogus');

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown command "bogus"');
    expect(result.stderr).toContain('Usage: agentplex <command> [options]');
  });

  it(
    'dispatches a known command, which then refuses its own configuration',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const result = await run('hub');

      // The hub's refusal, not the bin's: proof the command word was consumed
      // and the program at the far end of the path was loaded and ran.
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('agentplex hub:');
      expect(result.stderr).toContain('Usage: agentplex hub');
      expect(result.stderr).not.toContain('Usage: agentplex <command>');
    },
  );
});
