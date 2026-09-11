import { describe, expect, it } from 'vitest';
import { readUpdateFlags, updateUsage } from './update-flags.js';

/**
 * The grammar, which is `install.sh`'s words in the command that continues the
 * job it started.
 */

function read(...argv: readonly string[]) {
  return readUpdateFlags(argv);
}

describe('what was named', () => {
  it('takes nothing at all to mean everything installed', () => {
    const flags = read();

    expect(flags.ok && flags.asked).toEqual([]);
    expect(flags.ok && flags.runtime).toBe('ask');
  });

  it('takes components by the word their release tags carry', () => {
    const flags = read('hub', 'web');

    expect(flags.ok && flags.asked).toEqual([
      { component: 'hub', version: null },
      { component: 'web', version: null },
    ]);
  });

  it('takes a pin as an exact release', () => {
    expect(read('hub@1.3.0').ok && read('hub@1.3.0')).toMatchObject({
      asked: [{ component: 'hub', version: '1.3.0' }],
    });
  });

  /**
   * A pin names a release tag, and `versions.json` describes only what is
   * current -- so there is nothing here to resolve a range against. Refused at
   * the flag with the shape named, which is where `install.sh` refuses it too.
   * AGX-198 is the ticket that would make it resolvable.
   */
  it.each(['hub@1.3', 'hub@1', 'hub@latest', 'hub@v1.3.0', 'hub@'])('refuses %s', (argument) => {
    const flags = read(argument);

    expect(flags.ok).toBe(false);
    expect(flags.ok === false && flags.problems.join('')).toContain('1.3.0 rather than 1.3');
  });

  it('refuses a word that is not a component, listing the ones that are', () => {
    const flags = read('hubb');

    expect(flags.ok).toBe(false);
    expect(flags.ok === false && flags.problems.join('')).toContain('cli, hub, server, web');
  });

  /** Two versions of one component is a contradiction rather than last-one-wins. */
  it('refuses a component named twice', () => {
    const flags = read('hub@1.3.0', 'hub');

    expect(flags.ok).toBe(false);
    expect(flags.ok === false && flags.problems.join('')).toContain('named twice');
  });
});

describe('the flags', () => {
  it('reads --check and --dry-run', () => {
    expect(read('--check')).toMatchObject({ check: true, dryRun: false });
    expect(read('--dry-run')).toMatchObject({ check: false, dryRun: true });
  });

  it('refuses both at once, because they are two questions', () => {
    const flags = read('--check', '--dry-run');

    expect(flags.ok).toBe(false);
    expect(flags.ok === false && flags.problems.join('')).toContain('two questions');
  });

  it('takes the runtime answer in advance, in both directions', () => {
    expect(read('--node')).toMatchObject({ runtime: 'yes' });
    expect(read('--no-node')).toMatchObject({ runtime: 'no' });
  });

  /**
   * `--prefix` and `--system` are read by the one reader all the installation
   * commands share, which is what keeps "which machine is this about" one
   * answer rather than four.
   */
  it('hands --prefix and --system to the reader they belong to', () => {
    expect(read('--prefix', '/srv/agentplex', '--system')).toMatchObject({
      prefix: '/srv/agentplex',
      system: true,
    });
    expect(read('--prefix=/srv/agentplex')).toMatchObject({ prefix: '/srv/agentplex' });
  });

  it('does not read the value after --prefix as a component', () => {
    const flags = read('--prefix', '/srv/agentplex', 'hub');

    expect(flags.ok && flags.asked).toEqual([{ component: 'hub', version: null }]);
  });

  it('refuses a flag nobody knows rather than ignoring it', () => {
    const flags = read('--yolo');

    expect(flags.ok).toBe(false);
    expect(flags.ok === false && flags.problems.join('')).toContain('--yolo');
  });
});

describe('the usage', () => {
  it('names the grammar, the flags and why a pin is exact', () => {
    const usage = updateUsage();

    expect(usage).toContain('agentplex update [<component>[@<version>] ...]');
    expect(usage).toContain('--check');
    expect(usage).toContain('--no-node');
    expect(usage).toContain('hub@1.3 is refused');
  });
});
