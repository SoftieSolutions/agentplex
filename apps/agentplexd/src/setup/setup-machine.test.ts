import { describe, expect, it } from 'vitest';
import { createFakeSetupMachine } from './fake-setup-machine.js';
import { findProgram } from './setup-machine.js';

/**
 * Resolution, which is the mechanism the adoption rule is built on.
 *
 * The first directory in the answer is the binary the operator's shell runs, so
 * it is the one they authenticated and the one setup must record. Everything
 * else this asserts follows from that being worth getting exactly right.
 */

const HOMEBREW = '/opt/homebrew/bin';
const LOCAL = '/home/dev/.local/bin';
const OWNED = '/home/dev/.agentplex/bin';

describe('findProgram', () => {
  it('answers in PATH order, so the first entry is the one that runs', async () => {
    const machine = createFakeSetupMachine({
      pathDirectories: [HOMEBREW, LOCAL, OWNED],
      executables: [`${LOCAL}/claude`, `${HOMEBREW}/claude`],
    });

    expect(await findProgram('claude', machine)).toEqual([HOMEBREW, LOCAL]);
  });

  it('finds nothing on a machine that has never heard of the program', async () => {
    const machine = createFakeSetupMachine({ pathDirectories: [HOMEBREW, LOCAL] });

    expect(await findProgram('claude', machine)).toEqual([]);
  });

  it('names one directory once however many times the PATH does', async () => {
    const machine = createFakeSetupMachine({
      pathDirectories: [HOMEBREW, LOCAL, HOMEBREW],
      executables: [`${HOMEBREW}/claude`],
    });

    expect(await findProgram('claude', machine)).toEqual([HOMEBREW]);
  });

  it('refuses a name with a path in it rather than searching somewhere else', async () => {
    // The operation registry's rule that a path never appears where a program
    // name belongs, one layer up: joining `../../usr/bin/claude` onto a
    // directory searches a directory nobody asked about.
    const machine = createFakeSetupMachine({
      pathDirectories: [HOMEBREW],
      executables: [`${HOMEBREW}/claude`, '/usr/bin/claude'],
    });

    expect(await findProgram('../../usr/bin/claude', machine)).toEqual([]);
    expect(await findProgram('', machine)).toEqual([]);
  });

  it('finds nothing when the operator has no PATH at all', async () => {
    const machine = createFakeSetupMachine({ executables: [`${HOMEBREW}/claude`] });

    expect(await findProgram('claude', machine)).toEqual([]);
  });
});
