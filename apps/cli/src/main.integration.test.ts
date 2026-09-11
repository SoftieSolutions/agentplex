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
 * uses. `pnpm -C apps/cli build` first, the same requirement
 * `setup-exit.integration.test.ts` already carries.
 *
 * Until this file existed the bin was covered only by the `RUN` lines in the
 * Dockerfile, so every check of it needed a container and none of them ran on a
 * contributor's machine.
 */

const BIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

/**
 * The manifest `--version` has to find, resolved the way the built bin resolves
 * it: three levels up from `dist/main.js`, which is the package root.
 *
 * The expression is written from `src/` and lands on the same file, because
 * `src` and `dist` sit at the same depth under the app. In a checkout that file
 * is the workspace manifest and says `0.0.0`; in the published package it is
 * the manifest `assemble-package.ts` wrote, carrying the released version. The
 * app's own `package.json`, one level up, is in the package neither.
 */
const MANIFEST = fileURLToPath(new URL('../../../package.json', import.meta.url));

/** A command that loads its module and refuses its configuration is still quick. */
const RUN_TIMEOUT_MS = 20_000;

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The environment minus everything a program under `AGENTPLEX_` could read.
 *
 * Nothing this bin runs starts a daemon any more, so the hub this used to guard
 * against cannot be reached from here at all. It stays because `setup` and
 * `doctor` both read the same variables, and a suite whose answers depend on
 * what the contributor happens to export is a suite about their shell.
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

/** The version the package really declares, at the manifest the bin resolves. */
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
    // The table is the words that do something, and `hub` and `server` are not
    // among them.
    for (const name of ['setup', 'doctor', 'help']) {
      expect(result.stdout).toMatch(new RegExp(`^ {2}${name} {2,}\\S`, 'm'));
    }
    for (const daemon of ['hub', 'server']) {
      expect(result.stdout).not.toMatch(new RegExp(`^ {2}${daemon} {2,}\\S`, 'm'));
    }
    // Named all the same, below the table and as what they are: leaving them
    // out entirely would make the one place an operator looks silent about the
    // word every unit file and every document still says.
    expect(result.stdout).toContain('hub and server are daemons rather than commands');
    expect(result.stdout).toContain('agentplex-hub.service');
    expect(result.stdout).toContain('agentplex-server.service');
    // A flag nothing lists is a flag nobody finds.
    expect(result.stdout).toContain('--version');
  });

  it('answers -h the same way', async () => {
    const [long, short] = await Promise.all([run('--help'), run('-h')]);

    expect(short).toEqual(long);
  });

  it('answers the help command the same way, and lists it among the commands', async () => {
    const [flag, word] = await Promise.all([run('--help'), run('help')]);

    expect(word).toEqual(flag);
    expect(word.code).toBe(0);
    // A command nothing lists is a command nobody finds, and `help` earns its
    // line in the table for exactly the same reason `--version` earns its own.
    // The line, not the word: `--help` is already in this output twice.
    expect(word.stdout).toMatch(/^ {2}help {2,}\S/m);
  });

  it('hands help <command> to that command, which answers for itself', async () => {
    const [viaWord, viaFlag] = await Promise.all([run('help', 'doctor'), run('doctor', '--help')]);

    // Identical because they are the same run: `help doctor` rewrites argv to
    // `doctor --help` and calls it, so there is one doctor usage text and this
    // bin holds no copy of it.
    expect(viaWord).toEqual(viaFlag);
    expect(viaWord.code).toBe(0);
    expect(viaWord.stderr).toBe('');
    expect(viaWord.stdout).toContain('Usage: agentplex doctor');
    expect(viaWord.stdout).not.toContain('Usage: agentplex <command>');
  });

  it('names an unknown subject of help on stderr and exits 2', async () => {
    const result = await run('help', 'bogus');

    // The same event as `agentplex bogus`: somebody named a command that is
    // not one, and being told so is a diagnostic rather than an answer.
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown command "bogus"');
    expect(result.stderr).toContain('Usage: agentplex <command> [options]');
  });

  it('answers help help with the only usage it has', async () => {
    const result = await run('help', 'help');

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: agentplex <command> [options]');
  });

  it('prints the version the package manifest declares, and nothing else', async () => {
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
    'runs a known command, which then refuses its own configuration',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const result = await run('doctor');

      // The doctor's refusal, not the bin's: proof the command word was
      // consumed and the module behind it was loaded and called.
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('agentplex doctor:');
      expect(result.stderr).toContain('Usage: agentplex doctor');
      expect(result.stderr).not.toContain('Usage: agentplex <command>');
    },
  );

  /**
   * The word every unit file, every document and every habit still says, at a
   * bin that no longer runs it.
   *
   * `unknown command "hub"` would be true and useless: it tells an operator the
   * word means nothing, when the word names the process the machine exists to
   * run. It is still a run that failed -- stderr, exit 2, exactly as an unknown
   * command is -- and the sentence is the whole of the difference.
   */
  it.each(['hub', 'server'])(
    'says what a %s is rather than shrugging at the word',
    async (daemon) => {
      const result = await run(daemon);

      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`the ${daemon} is a daemon, not a command`);
      expect(result.stderr).toContain(`agentplex-${daemon}.service`);
      expect(result.stderr).toContain('systemctl');
      // Not an unknown command, and not the usage either: the answer is complete,
      // and the usage is for when the next step is to pick a different word.
      expect(result.stderr).not.toContain('unknown command');
      expect(result.stderr).not.toContain('Usage: agentplex <command>');
    },
  );

  /** The same answer through the other word order, because it is the same question. */
  it('answers help hub the same way', async () => {
    const [viaWord, alone] = await Promise.all([run('help', 'hub'), run('hub')]);

    expect(viaWord).toEqual(alone);
  });
});
