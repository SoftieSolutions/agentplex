import { describe, expect, it } from 'vitest';
import {
  checkNodePty,
  loadNodePty,
  NODE_PTY_REMEDY,
  type NodePtyModule,
} from './node-pty-factory.js';

/**
 * `checkNodePty`, against the two shapes a machine without a usable node-pty
 * actually has.
 *
 * Both are arranged by injecting the loader rather than by mocking the module
 * registry, which is the difference between testing this function and testing
 * vitest. The errors are the real ones: npm removes an optional dependency
 * whose build failed, so `require` cannot find the package at all; an npm
 * running with `ignore-scripts` leaves the sources in place and no addon beside
 * them, so `require` finds the package and dies loading `pty.node`.
 */

const pruned = (): NodePtyModule => {
  throw Object.assign(new Error("Cannot find module 'node-pty'"), { code: 'MODULE_NOT_FOUND' });
};

const unbuilt = (): NodePtyModule => {
  throw new Error(
    "Cannot find module '/opt/agentplex/node_modules/node-pty/build/Release/pty.node'\n" +
      'Require stack:\n- /opt/agentplex/node_modules/node-pty/lib/index.js',
  );
};

describe('checkNodePty', () => {
  it('is usable when the module loads', () => {
    expect(checkNodePty(() => ({}) as NodePtyModule)).toEqual({ usable: true });
  });

  /**
   * The default loader, run for real. Everything else here injects, so without
   * this the one thing nothing would ever exercise is the resolution the
   * machine actually uses -- and the whole point of the lazy load is that a
   * broken one is invisible until something opens a session.
   */
  it('reaches the node-pty this package resolves, with no loader supplied', () => {
    expect(checkNodePty()).toEqual({ usable: true });
    expect(loadNodePty().spawn).toBeTypeOf('function');
  });

  it('names node-pty when npm removed it, rather than repeating a resolver stack', () => {
    const availability = checkNodePty(pruned);

    expect(availability.usable).toBe(false);
    expect(availability.usable === false && availability.problem).toContain('node-pty');
    expect(availability.usable === false && availability.problem).toContain(
      "Cannot find module 'node-pty'",
    );
  });

  /**
   * The one-line rule. A `require` failure carries its whole require stack in
   * the message, and pasting that into a startup refusal buries the sentence
   * the operator is supposed to act on.
   */
  it('keeps the first line of a multi-line load failure and drops the stack', () => {
    const availability = checkNodePty(unbuilt);

    expect(availability.usable === false && availability.problem).toContain('pty.node');
    expect(availability.usable === false && availability.problem).not.toContain('Require stack');
  });

  it('says what to install, because the reason on its own is not actionable', () => {
    for (const tool of ['python3', 'make', 'C++ compiler', 'ignore-scripts']) {
      expect(NODE_PTY_REMEDY).toContain(tool);
    }
  });
});
