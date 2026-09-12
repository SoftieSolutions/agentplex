import { describe, expect, it } from 'vitest';
import { printed } from '@agentplex/providers/testing';
import { HUB, SERVER, runOnMachine, show, state } from '../../installation/fake-units-machine.js';
import { STOP } from './stop-command.js';

/**
 * `agentplex stop`: the reverse of start, and the two places being the reverse
 * shows.
 *
 * It disables as well as stopping, and it reloads nothing. The shell underneath
 * -- the flags, the lookup, the report, the three exit codes -- is the one
 * `start` runs on and is covered there; what this file pins down is that `stop`
 * carries its own act and its own usage rather than inheriting either.
 */

function run(argv: readonly string[], machine?: Parameters<typeof runOnMachine>[2]) {
  return runOnMachine(STOP, argv, machine);
}

describe('agentplex stop', () => {
  it('disables as well as stops, because it is the reverse of start', async () => {
    const stopped = await run([], {
      units: [HUB, SERVER],
      outcomes: {
        [`systemctl --user disable --now ${HUB} ${SERVER}`]: printed(''),
        [show('user', HUB)]: state('inactive', 'disabled'),
        [show('user', SERVER)]: state('inactive', 'disabled'),
      },
    });

    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain(`stopped and disabled ${HUB}, ${SERVER}`);
    // No reload: nothing on the disk changed, and a stop that reloaded first
    // would be doing something the operator did not ask for.
    expect(stopped.runner.requests[0]?.args).toEqual(['--user', 'disable', '--now', HUB, SERVER]);
  });

  it('does not offer a foreground command to somebody trying to stop one', async () => {
    const stopped = await run([], { systemd: false });

    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain('There is no systemctl on this machine');
    expect(stopped.out).toContain('started by hand');
    expect(stopped.out).not.toContain('dist/main.js');
  });

  it('names itself, not start, when it refuses an argument', async () => {
    // The one thing the split could plausibly get wrong: two commands over one
    // shell, and the shell printing the other one's word. An operator who typed
    // `stop` must be told about `stop`.
    const stopped = await run(['--prefx=/srv/agentplex']);

    expect(stopped.code).toBe(2);
    expect(stopped.errors).toContain('agentplex stop:');
    expect(stopped.errors).toContain('Usage: agentplex stop');
    // Its prose names `agentplex start`, because being that command's reverse
    // is what it is; what it must never do is print start's usage line.
    expect(stopped.errors).not.toContain('Usage: agentplex start');
    expect(stopped.errors).not.toContain('agentplex start:');
  });
});
