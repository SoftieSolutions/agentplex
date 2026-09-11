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
    env: { PATH: process.env['PATH'] ?? '', ...environment },
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
   * A hub, or a hand-typed `npm install --global` on a machine nobody told.
   * Neither is a machine this package has any business stopping, and the two
   * programs that need a pty refuse on their own.
   */
  it('warns and lets the install finish when nothing asked for a pty', () => {
    const result = run(withoutNodePty());

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('node-pty');
    expect(result.stderr).toContain('agentplex server');
  });

  /**
   * The whole point of the variable. Optional in the manifest must not mean
   * optional in practice for a machine that runs sessions: npm exits 0 with the
   * package gone, and a non-zero exit here is the only thing left that can turn
   * that back into a failed install.
   */
  it('fails the install when the machine is one that runs a server', () => {
    const result = run(withoutNodePty(), { AGENTPLEX_REQUIRE_PTY: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node-pty');
    expect(result.stderr).toContain('pseudoterminal');
    // The reason alone is not something an operator can act on.
    expect(result.stderr).toContain('python3');
  });

  it('treats an empty value as unset, which is what an unset shell variable expands to', () => {
    expect(run(withoutNodePty(), { AGENTPLEX_REQUIRE_PTY: '' }).status).toBe(0);
  });
});
