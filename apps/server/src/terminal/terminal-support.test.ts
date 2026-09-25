import { describe, expect, it } from 'vitest';
import { EXIT_UNUSABLE_INSTALLATION, refuseWithoutTerminals } from './terminal-support.js';

/**
 * What the server does about a node-pty that will not load.
 *
 * The availability is injected, which is the same seam `checkNodePty` takes: a
 * machine whose addon never compiled is not something a test can arrange, and
 * the value it would produce is the value handed in here.
 */

describe('refuseWithoutTerminals', () => {
  it('lets a server with a working pty start, saying nothing at all', () => {
    expect(refuseWithoutTerminals({ usable: true })).toBeNull();
  });

  it('names node-pty, says what the server needs it for, and says what to install', () => {
    const refusal = refuseWithoutTerminals({
      usable: false,
      problem: "node-pty could not be loaded: Cannot find module 'node-pty'",
    });

    const message = refusal?.lines.join('\n') ?? '';
    // The three questions an operator has, in order: what is broken, why this
    // program cares, and what to do about it.
    expect(message).toContain('node-pty');
    expect(message).toContain('pseudoterminal');
    expect(message).toContain('python3');
    // Every line is addressed to a log, so every line says who is speaking.
    for (const line of refusal?.lines ?? [])
      expect(line.startsWith('agentplex server: ')).toBe(true);
  });

  /**
   * Exit 2 rather than 1, and that is the unit file's contract rather than a
   * preference. `install.sh` writes `RestartPreventExitStatus=2`, so 1 would
   * put systemd into a five-second restart loop against a machine where
   * restarting cannot possibly help -- a missing native addon is not a
   * condition that passes.
   */
  it('exits with the code the unit file will not restart', () => {
    expect(refuseWithoutTerminals({ usable: false, problem: 'gone' })?.exitCode).toBe(2);
    expect(EXIT_UNUSABLE_INSTALLATION).toBe(2);
  });
});
