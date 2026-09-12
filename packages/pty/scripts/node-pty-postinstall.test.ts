import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The postinstall, run as npm runs it: as a program, with an environment, whose
 * exit code is the whole of what npm reads.
 *
 * The machine without node-pty is arranged by moving the script rather than by
 * faking a module registry. `createRequire(import.meta.url)` resolves from
 * wherever the file sits, so a copy in an empty directory resolves nothing --
 * which is precisely the shape npm leaves behind when an optional dependency's
 * build fails and it removes the package.
 */

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'node-pty-postinstall.js');

const temporaries: string[] = [];

afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The script, somewhere nothing can be resolved from. */
function withoutNodePty(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentplex-postinstall-'));
  temporaries.push(root);
  // A `node_modules` that holds nothing, so the walk ends here rather than
  // continuing up into a real checkout's own.
  mkdirSync(join(root, 'node_modules'));
  const copy = join(root, 'node-pty-postinstall.js');
  cpSync(scriptPath, copy);
  return copy;
}

function run(script: string, environment: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    // The suite's throwaway `$HOME`, not the operator's: this child is a
    // postinstall script run under node, and an absent `$HOME` would send
    // anything asking for one to the passwd entry.
    env: { HOME: process.env['HOME'] ?? '', PATH: process.env['PATH'] ?? '', ...environment },
  });
  return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
}

describe('the node-pty postinstall', () => {
  it('finishes quietly where node-pty is installed, which is every checkout', () => {
    const result = run(scriptPath);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  /**
   * The command package, where node-pty is optional so that a hub-only machine
   * with no compiler still gets `setup` and `doctor`; or a hand-typed install
   * on such a machine. Neither is one this script has any business stopping.
   *
   * It used to be able to stop one, when AGENTPLEX_REQUIRE_PTY said the machine
   * was going to run a server. That is gone: node-pty is a required dependency
   * of the server package, so npm fails that install at the compile and there
   * is no longer a machine on which a skipped node-pty is a silent lie.
   */
  it('warns and lets the install finish, because no install here turns on this exit code', () => {
    const result = run(withoutNodePty());

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('node-pty');
    expect(result.stderr).toContain('agentplex server');
    // The reason alone is not something an operator can act on.
    expect(result.stderr).toContain('python3');
  });

  /**
   * There is no environment that makes this fail an install. Asserted rather
   * than described, because the variable that used to do it was read from the
   * environment and a re-introduced read would be invisible in a diff to
   * anything else.
   */
  it('exits 0 whatever it is told, including by the variable that used to fail it', () => {
    expect(run(withoutNodePty(), { AGENTPLEX_REQUIRE_PTY: '1' }).status).toBe(0);
    expect(run(withoutNodePty(), { AGENTPLEX_ROLE: 'server' }).status).toBe(0);
  });
});
