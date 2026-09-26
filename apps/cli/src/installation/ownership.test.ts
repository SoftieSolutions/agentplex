import { runOperation } from '@agentplex/providers';
import { createFakeProcessRunner, printed, refused } from '@agentplex/providers/testing';
import { describe, expect, it } from 'vitest';
import { createFakeWriteMachine } from './fake-write-machine.js';
import { systemLayout } from './layout.js';
import {
  grantOwnershipOperation,
  grantServiceAccountOwnership,
  ownedPaths,
  serviceAccountOperation,
  settingsOwnershipOperation,
} from './ownership.js';

/**
 * What the service account is given on a `--system` machine, and the one
 * thing that makes it safe to hand a `chown -R` a path: the path can only be
 * one of the four the layout computes. A request is parsed before any argv is
 * built, so a path or an account that is not one of those never reaches a
 * program at all.
 */

const LAYOUT = systemLayout('/srv/agentplex');
const FOUR = [
  '/srv/agentplex/bin',
  '/srv/agentplex/lib/node_modules',
  '/srv/agentplex/share',
  '/var/lib/agentplex',
];

describe('the paths the account owns', () => {
  it('are the bin, the package root, share and the state directory, and nothing else', () => {
    expect(ownedPaths(LAYOUT)).toEqual(FOUR);
  });
});

describe('the chown operation', () => {
  it('runs chown -R <account>:<account> <path>, and never a shell', async () => {
    const runner = createFakeProcessRunner({ fallback: printed('') });

    const outcome = await runOperation(
      grantOwnershipOperation(LAYOUT),
      { account: 'agentplex', path: '/srv/agentplex/lib/node_modules' },
      runner,
    );

    expect(outcome).toEqual({ ok: true, result: null });
    expect(runner.requests).toEqual([
      {
        file: 'chown',
        args: ['-R', 'agentplex:agentplex', '/srv/agentplex/lib/node_modules'],
        timeoutMs: expect.any(Number),
      },
    ]);
    // There is nowhere on a request to put a shell, a cwd or an environment.
    expect(Object.keys(runner.requests[0] ?? {}).sort()).toEqual(['args', 'file', 'timeoutMs']);
  });

  it('refuses a path outside the four, and runs nothing', async () => {
    const runner = createFakeProcessRunner({ fallback: printed('') });

    for (const path of [
      '/srv/agentplex',
      '/srv/agentplex/node',
      '/etc/agentplex/agentplex.env',
      '/',
    ]) {
      const outcome = await runOperation(
        grantOwnershipOperation(LAYOUT),
        { account: 'agentplex', path },
        runner,
      );
      expect(outcome.ok ? 'ran' : outcome.refusal).toBe('invalid-request');
    }
    expect(runner.requests).toEqual([]);
  });

  it('refuses an account that looks like anything but a user name', async () => {
    const runner = createFakeProcessRunner({ fallback: printed('') });

    for (const account of ['agentplex; rm -rf /', '$(id)', 'root:root', '-R', '', 'a b']) {
      const outcome = await runOperation(
        grantOwnershipOperation(LAYOUT),
        { account, path: '/srv/agentplex/bin' },
        runner,
      );
      expect(outcome.ok ? 'ran' : outcome.refusal).toBe('invalid-request');
    }
    expect(runner.requests).toEqual([]);
  });

  it('says what chown said when it will not', async () => {
    const runner = createFakeProcessRunner({
      fallback: refused(1, "chown: invalid user: 'agentplex:agentplex'"),
    });

    const outcome = await runOperation(
      grantOwnershipOperation(LAYOUT),
      { account: 'agentplex', path: '/srv/agentplex/bin' },
      runner,
    );

    expect(outcome).toMatchObject({ ok: false, refusal: 'failed' });
    expect(outcome.ok ? '' : outcome.problem).toContain('invalid user');
  });
});

describe('the settings file owner', () => {
  it('is root:<account>, on the settings file alone and not recursively', async () => {
    const runner = createFakeProcessRunner({ fallback: printed('') });

    await runOperation(
      settingsOwnershipOperation(LAYOUT),
      { account: 'agentplex', path: '/etc/agentplex/agentplex.env' },
      runner,
    );
    const elsewhere = await runOperation(
      settingsOwnershipOperation(LAYOUT),
      { account: 'agentplex', path: '/srv/agentplex/bin' },
      runner,
    );

    expect(runner.requests.map((one) => [one.file, ...one.args])).toEqual([
      ['chown', 'root:agentplex', '/etc/agentplex/agentplex.env'],
    ]);
    expect(elsewhere.ok ? 'ran' : elsewhere.refusal).toBe('invalid-request');
  });
});

describe('whether the account exists', () => {
  it('asks id, and reads its exit as the answer', async () => {
    const runner = createFakeProcessRunner({
      outcomes: {
        'id -u agentplex': printed('998\n'),
        'id -u nobody-here': refused(1, "id: 'nobody-here': no such user"),
      },
    });

    expect(await runOperation(serviceAccountOperation, { account: 'agentplex' }, runner)).toEqual({
      ok: true,
      result: true,
    });
    expect(await runOperation(serviceAccountOperation, { account: 'nobody-here' }, runner)).toEqual(
      { ok: true, result: false },
    );
  });
});

describe('grantServiceAccountOwnership', () => {
  it('makes each of the four and gives it to the account, in order', async () => {
    const machine = createFakeWriteMachine();
    const runner = createFakeProcessRunner({ fallback: printed('') });

    const granted = await grantServiceAccountOwnership(LAYOUT, 'agentplex', { machine, runner });

    expect(granted).toEqual({ ok: true });
    expect(machine.acts).toEqual(FOUR.map((path) => `mkdir ${path}`));
    expect(runner.requests.map((one) => [one.file, ...one.args].join(' '))).toEqual(
      FOUR.map((path) => `chown -R agentplex:agentplex ${path}`),
    );
  });

  it('stops at the first chown that fails, naming the path', async () => {
    const machine = createFakeWriteMachine();
    const runner = createFakeProcessRunner({
      fallback: refused(1, 'chown: changing ownership: Operation not permitted'),
    });

    const granted = await grantServiceAccountOwnership(LAYOUT, 'agentplex', { machine, runner });

    expect(granted.ok).toBe(false);
    expect(granted.ok ? '' : granted.problem).toContain('/srv/agentplex/bin');
    expect(runner.requests).toHaveLength(1);
  });
});
