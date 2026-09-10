import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeProcessProbe } from '../fake-process-probe.js';
import { createClaudeAdapter } from '../claude-adapter.js';
import { CLAUDE_PACKAGE } from '../claude-provisioning.js';
import { createFakeProviderAdapter } from '../fake-provider-adapter.js';
import { createFakeProviderFiles } from '../fake-provider-files.js';
import { createProviderRegistry, type ProviderRegistry } from '../provider-registry.js';
import { createFakeProcessRunner, printed } from './fake-process-runner.js';
import { createSetupOperationRegistry } from './setup-operation-registry.js';

/**
 * The setup registry, and the sweep that keeps it honest.
 *
 * It is the same shape of test file as `operation-registry.test.ts` on purpose:
 * the rule this registry is held to is the wire-facing registry's rule, and the
 * whole point of a second registry rather than a wider one is that it gives up
 * nothing to get what setup needs. The sweep at the bottom therefore asserts the
 * same things -- a bare argv, no cwd, no environment, no child before a request
 * has parsed -- over whatever this registry holds, now and in a year.
 *
 * What is *not* asserted here is the disjointness. That assertion belongs to the
 * registry it protects, so it lives in `operation-registry.test.ts`.
 */

const PREFIX = '/Users/dev/.agentplex';
const VERSION = '2.1.259';
const INSTALL = `npm install --global --prefix ${PREFIX} --json --no-ignore-scripts ${CLAUDE_PACKAGE}@${VERSION}`;

/**
 * npm's own output, borrowed from the adapter's fixtures rather than invented
 * here. What this file tests is the plumbing, but the plumbing carries whatever
 * npm actually prints, and a summarised version of it would be a test that only
 * passes on a shape nobody has seen.
 */
const NPM_ADDED = readFileSync(
  join(import.meta.dirname, '..', '..', 'fixtures', 'npm-install-added.json'),
  'utf8',
);

/** The providers a real setup run would have: this build's own adapters. */
function claudeOnly(): ProviderRegistry {
  return createProviderRegistry([
    createClaudeAdapter({ files: createFakeProviderFiles(), probe: createFakeProcessProbe({}) }),
  ]);
}

describe('the setup operation registry', () => {
  it('installs a provider through the adapter that knows how', async () => {
    const runner = createFakeProcessRunner({ outcomes: { [INSTALL]: printed(NPM_ADDED) } });
    const registry = createSetupOperationRegistry({ runner, providers: claudeOnly() });

    const outcome = await registry.execute('provider.install', {
      provider: 'claude',
      prefix: PREFIX,
      version: VERSION,
    });

    expect(outcome).toEqual({
      ok: true,
      result: { package: CLAUDE_PACKAGE, version: VERSION },
    });
  });

  it('probes a version and an authentication state through the same adapter', async () => {
    const runner = createFakeProcessRunner({
      outcomes: {
        'claude --version': printed('2.1.259 (Claude Code)\n'),
        // Exit 1 with a real answer in it. Claude Code reports a logout that
        // way, and the case survives only because the registry never decides
        // what a nonzero exit means -- the adapter that knows the program does.
        'claude auth status --json': {
          kind: 'exited',
          exitCode: 1,
          stdout: '{"loggedIn":false}',
          stderr: '',
        },
      },
    });
    const registry = createSetupOperationRegistry({ runner, providers: claudeOnly() });

    expect(await registry.execute('provider.version', { provider: 'claude' })).toEqual({
      ok: true,
      result: VERSION,
    });
    expect(await registry.execute('provider.auth-state', { provider: 'claude' })).toEqual({
      ok: true,
      result: 'unauthenticated',
    });
  });

  it('refuses a name it does not have, and starts nothing', async () => {
    const runner = createFakeProcessRunner();
    const registry = createSetupOperationRegistry({ runner, providers: claudeOnly() });

    // Including the two the wire-facing registry does have. Sharing a
    // `ProcessRunner` is not sharing an operation list, in either direction.
    for (const name of ['npm', 'install', 'git.status', 'process.start-time', '']) {
      expect(await registry.execute(name, { provider: 'claude' })).toMatchObject({
        ok: false,
        refusal: 'unknown-operation',
      });
    }

    expect(runner.requests).toEqual([]);
  });

  it('refuses a provider name nobody implements, and starts nothing', async () => {
    const runner = createFakeProcessRunner();
    const registry = createSetupOperationRegistry({ runner, providers: claudeOnly() });

    // Two different refusals, because they are two different facts. `codex` is
    // a provider agentplex knows and this build cannot drive, which is the
    // machine's limit; `sh` is not a provider at all, which is a bad request.
    expect(await registry.execute('provider.version', { provider: 'codex' })).toMatchObject({
      ok: false,
      refusal: 'unavailable',
    });
    expect(await registry.execute('provider.version', { provider: 'sh' })).toMatchObject({
      ok: false,
      refusal: 'invalid-request',
    });

    expect(runner.requests).toEqual([]);
  });

  it('refuses when the adapter will not build a plan out of the request, and starts nothing', async () => {
    const runner = createFakeProcessRunner();
    const registry = createSetupOperationRegistry({ runner, providers: claudeOnly() });

    // A relative prefix. The adapter is what says no, because what a prefix has
    // to be is the installer's business, and there is one place that answer
    // lives rather than a copy of it in every caller.
    const outcome = await registry.execute('provider.install', {
      provider: 'claude',
      prefix: '.agentplex',
      version: null,
    });

    expect(outcome).toMatchObject({ ok: false, refusal: 'invalid-request' });
    expect(runner.requests).toEqual([]);
  });

  it('asks each adapter rather than knowing any installer itself', async () => {
    // The seam doing its job: a provider whose installer is not npm, whose
    // version flag is not `--version`, and which is not Claude Code at all runs
    // through this registry without a line here changing.
    const runner = createFakeProcessRunner({
      outcomes: { [`fakepkg add --into ${PREFIX} claude`]: printed('9.9.9\n') },
    });
    const registry = createSetupOperationRegistry({
      runner,
      providers: createProviderRegistry([createFakeProviderAdapter()]),
    });

    const outcome = await registry.execute('provider.install', {
      provider: 'claude',
      prefix: PREFIX,
      version: null,
    });

    expect(outcome).toEqual({ ok: true, result: { package: 'claude', version: '9.9.9' } });
  });

  it('lists what setup can run', () => {
    const registry = createSetupOperationRegistry({
      runner: createFakeProcessRunner(),
      providers: claudeOnly(),
    });

    // The one-shot spawns `ProviderProvisioning` defines, and only those.
    // `login` is missing because it is a pty launch and not a one-shot: it has
    // no shape this registry could hold even if somebody wanted it here.
    expect(registry.operations.map(({ name }) => name)).toEqual([
      'provider.install',
      'provider.version',
      'provider.auth-state',
    ]);
    for (const { summary } of registry.operations) expect(summary).not.toBe('');
  });

  it('gives every operation a name that is a name and not a command', () => {
    const registry = createSetupOperationRegistry({
      runner: createFakeProcessRunner(),
      providers: claudeOnly(),
    });

    for (const { name } of registry.operations) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/);
    }
  });

  it('builds every spawn as a bare argv, with no cwd and no environment', async () => {
    const runner = createFakeProcessRunner();
    const registry = createSetupOperationRegistry({ runner, providers: claudeOnly() });

    // One valid request per operation, listed rather than derived, so that
    // adding an operation forces someone to write down what a valid request to
    // it looks like -- and brings it under every assertion below.
    const requests: Readonly<Record<string, unknown>> = {
      'provider.install': { provider: 'claude', prefix: PREFIX, version: VERSION },
      'provider.version': { provider: 'claude' },
      'provider.auth-state': { provider: 'claude' },
    };
    expect(Object.keys(requests).sort()).toEqual(
      registry.operations.map(({ name }) => name).sort(),
    );

    for (const [name, request] of Object.entries(requests)) await registry.execute(name, request);

    expect(runner.requests).toHaveLength(registry.operations.length);
    for (const request of runner.requests) {
      // The assertion the whole ticket turns on. An installer is the operation
      // that would otherwise have been the excuse to add a cwd or an env var to
      // the process seam, and none of the three needed one.
      expect(Object.keys(request).sort()).toEqual(['args', 'file', 'timeoutMs']);
      expect(request.file).toMatch(/^[a-z][a-z0-9-]*$/);
      for (const argument of request.args) expect(typeof argument).toBe('string');
      expect(request.timeoutMs).toBeGreaterThan(0);
    }

    // And the prefix really did reach npm as an argument npm parses.
    expect(runner.requests[0]?.args).toContain('--prefix');
    expect(runner.requests[0]?.args).toContain(PREFIX);
  });

  it('starts no child for any operation until its request has parsed', async () => {
    const runner = createFakeProcessRunner();
    const registry = createSetupOperationRegistry({ runner, providers: claudeOnly() });

    for (const { name } of registry.operations) {
      // Including the shapes a caller would reach for to smuggle argv past the
      // parser. Extra fields are rejected outright rather than carried along,
      // and a request that does not parse never reaches an adapter at all.
      for (const request of [
        undefined,
        'npm install anything',
        { provider: 'claude', args: ['--registry=http://attacker'] },
        { provider: ['claude'] },
      ]) {
        expect(await registry.execute(name, request)).toMatchObject({
          ok: false,
          refusal: 'invalid-request',
        });
      }
    }

    expect(runner.requests).toEqual([]);
  });
});
