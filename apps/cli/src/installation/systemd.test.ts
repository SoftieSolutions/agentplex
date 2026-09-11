import { describe, expect, it } from 'vitest';
import type { ProgramResolver } from '@agentplex/providers';
import {
  createFakeProcessRunner,
  printed,
  refused,
  type FakeProcessRunner,
} from '@agentplex/providers/testing';
import { createSystemd, type Systemd } from './systemd.js';

/**
 * `systemctl`, driven through the real implementation with a process table a
 * test wrote down.
 *
 * No `systemctl` is run here and none could be: the seam is a `ProcessRunner`,
 * and what it is handed is a map from an argv to the output a real one printed.
 * That is what makes the two things worth asserting assertable -- the argv that
 * was built, which is where a scope or an unquoted unit name would show, and
 * what was made of the output, which is where `inactive` and "the manager could
 * not be asked" have to stay apart.
 */

/** A machine that has systemd, and one that has none. Nothing in between. */
function resolver(present: boolean): ProgramResolver {
  return { resolve: async (name) => (present && name === 'systemctl' ? '/usr/bin' : null) };
}

function systemd(
  outcomes: Readonly<Record<string, ReturnType<typeof printed>>> = {},
  present = true,
): { readonly systemd: Systemd; readonly runner: FakeProcessRunner } {
  const runner = createFakeProcessRunner({ outcomes });
  return { systemd: createSystemd({ runner, programs: resolver(present) }), runner };
}

/** What `systemctl show` really prints, which is `Key=Value` and nothing else. */
const RUNNING = printed(
  [
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=running',
    'UnitFileState=enabled',
    'ActiveEnterTimestamp=Thu 2026-09-11 09:12:03 UTC',
  ].join('\n'),
);

const SHOW_PROPERTIES =
  '--property=LoadState --property=ActiveState --property=SubState ' +
  '--property=UnitFileState --property=ActiveEnterTimestamp';

describe('which systemctl a scope reaches', () => {
  it('passes --user for a user unit and nothing for a system one', async () => {
    const user = systemd();
    await user.systemd.reload('user');
    const fleet = systemd();
    await fleet.systemd.reload('system');

    expect(user.runner.requests[0]).toEqual({
      file: 'systemctl',
      args: ['--user', 'daemon-reload'],
      timeoutMs: expect.any(Number),
    });
    expect(fleet.runner.requests[0]?.args).toEqual(['daemon-reload']);
  });

  it('never reaches a shell, and never names a path as the program', async () => {
    const { systemd: control, runner } = systemd();
    await control.enable('user', ['agentplex-hub.service']);

    // `file` is a program name that the spawn resolves, which is the rule the
    // whole operation registry is built on. There is nowhere on a
    // `ProcessRequest` to put a shell, a cwd or an env var.
    expect(runner.requests[0]?.file).toBe('systemctl');
    expect(Object.keys(runner.requests[0] ?? {}).sort()).toEqual(['args', 'file', 'timeoutMs']);
  });
});

describe('starting and stopping', () => {
  it('enables and starts every unit in one transaction', async () => {
    const { systemd: control, runner } = systemd({
      'systemctl --user enable --now agentplex-hub.service agentplex-server.service': printed(''),
    });

    const outcome = await control.enable('user', [
      'agentplex-hub.service',
      'agentplex-server.service',
    ]);

    expect(outcome).toEqual({ ok: true });
    // One call, not two: systemd starts them together, and two calls would be
    // two transactions with the machine half up in between.
    expect(runner.requests).toHaveLength(1);
  });

  it('disables as it enabled, which is what makes stop the reverse of start', async () => {
    const { systemd: control, runner } = systemd({
      'systemctl disable --now agentplex-hub.service': printed(''),
    });

    expect(await control.disable('system', ['agentplex-hub.service'])).toEqual({ ok: true });
    expect(runner.requests[0]?.args).toEqual(['disable', '--now', 'agentplex-hub.service']);
  });

  it("carries systemd's own refusal through rather than rewording it", async () => {
    // What an unprivileged `enable` of a system unit really looks like.
    const { systemd: control } = systemd({
      'systemctl enable --now agentplex-hub.service': refused(
        1,
        'Failed to enable unit: Interactive authentication required.',
      ),
    });

    expect(await control.enable('system', ['agentplex-hub.service'])).toEqual({
      ok: false,
      problem: 'Failed to enable unit: Interactive authentication required.',
    });
  });

  it('refuses a unit name that is not one of agentplex units', async () => {
    const { systemd: control, runner } = systemd();

    const outcome = await control.enable('user', ['sshd.service']);

    expect(outcome.ok).toBe(false);
    // The parser said no before the argv builder was reached, so nothing was
    // spawned at all -- which is the guarantee, not the message.
    expect(runner.requests).toEqual([]);
  });

  it('says the program is missing rather than pretending it ran', async () => {
    const { systemd: control } = systemd({}, false);

    expect(await control.present()).toBe(false);
  });
});

describe('what the manager says about a unit', () => {
  it('reads one show into every column the report has', async () => {
    const { systemd: control, runner } = systemd({
      [`systemctl --user show agentplex-hub.service ${SHOW_PROPERTIES}`]: RUNNING,
    });

    expect(await control.show('user', 'agentplex-hub.service')).toEqual({
      unit: 'agentplex-hub.service',
      load: 'loaded',
      active: 'active',
      sub: 'running',
      enabled: 'enabled',
      since: 'Thu 2026-09-11 09:12:03 UTC',
      problem: null,
    });
    // One call for five facts. Three calls would be three moments, and a unit
    // that stopped between them would be reported in a state it was never in.
    expect(runner.requests).toHaveLength(1);
  });

  it('reads a unit that has never run without inventing a timestamp', async () => {
    const { systemd: control } = systemd({
      [`systemctl --user show agentplex-server.service ${SHOW_PROPERTIES}`]: printed(
        [
          'LoadState=loaded',
          'ActiveState=inactive',
          'SubState=dead',
          'UnitFileState=enabled',
          'ActiveEnterTimestamp=',
        ].join('\n'),
      ),
    });

    const state = await control.show('user', 'agentplex-server.service');

    expect(state.active).toBe('inactive');
    expect(state.enabled).toBe('enabled');
    // systemd writes an empty value, and an empty string is not a time.
    expect(state.since).toBeNull();
  });

  it('reports a manager that would not answer as unknown, not as inactive', async () => {
    // The container case, and the laptop where no user manager was ever
    // started. Saying `inactive` here would be this command inventing a fact
    // about a service it never asked about.
    const { systemd: control } = systemd({
      [`systemctl --user show agentplex-hub.service ${SHOW_PROPERTIES}`]: refused(
        1,
        'Failed to connect to bus: No medium found',
      ),
    });

    expect(await control.show('user', 'agentplex-hub.service')).toEqual({
      unit: 'agentplex-hub.service',
      load: null,
      active: null,
      sub: null,
      enabled: null,
      since: null,
      problem: 'Failed to connect to bus: No medium found',
    });
  });

  it('carries a state word it has never seen rather than folding it into unknown', async () => {
    // systemd has six `ActiveState` values today and may name a seventh. A
    // reader that enumerated them would report a machine as unknowable at the
    // moment the manager had just told it something.
    const { systemd: control } = systemd({
      [`systemctl show agentplex-hub.service ${SHOW_PROPERTIES}`]: printed(
        'LoadState=loaded\nActiveState=refreshing\n',
      ),
    });

    expect((await control.show('system', 'agentplex-hub.service')).active).toBe('refreshing');
  });

  it('reports a unit file the manager has not loaded, which looks like stopped and is not', async () => {
    const { systemd: control } = systemd({
      [`systemctl --user show agentplex-hub.service ${SHOW_PROPERTIES}`]: printed(
        'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\n',
      ),
    });

    const state = await control.show('user', 'agentplex-hub.service');

    expect(state.load).toBe('not-found');
    expect(state.enabled).toBeNull();
  });
});
