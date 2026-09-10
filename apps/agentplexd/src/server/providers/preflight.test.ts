import { describe, expect, it } from 'vitest';
import { createLogger } from '../../shared/logger.js';
import { createFakeProcessRunner, printed, refused } from '../operations/fake-process-runner.js';
import type { ProcessOutcome } from '../operations/process-runner.js';
import type { ProgramResolver } from '../program-resolver.js';
import { createFakeProviderAdapter } from './fake-provider-adapter.js';
import { createProviderPreflight } from './preflight.js';
import { createProviderRegistry } from './provider-registry.js';
import type { ProviderAdapter } from './provider-adapter.js';

/**
 * The startup preflight, against a search path a test writes down and a process
 * table a test writes down.
 *
 * Both seams are real implementations rather than mocks, because what is being
 * checked is judgement and not call shape: which of four words a machine's
 * answers add up to, and what happens to the other providers when one of them
 * cannot answer at all.
 *
 * The adapter is the made-up one. Its version flag is not `--version` and its
 * login question is not `auth status --json`, which is the point -- nothing in
 * this file may depend on Claude Code's particular answers, or it would be
 * testing that adapter instead of this rule.
 */

const logger = createLogger('error', () => {});

/** A search path as a value: program name to the directory that holds it. */
function resolverHolding(directories: Readonly<Record<string, string>>): ProgramResolver {
  return { resolve: async (name: string) => directories[name] ?? null };
}

const BIN = '/home/robert/.agentplex/bin';

interface Machine {
  /** What the search path holds. Absent means nothing does. */
  readonly holds?: Readonly<Record<string, string>>;
  /** Answers keyed by argv, as the fake runner reads them. */
  readonly answers?: Readonly<Record<string, ProcessOutcome>>;
  readonly adapters?: readonly ProviderAdapter[];
}

async function preflight(machine: Machine) {
  const runner = createFakeProcessRunner({
    ...(machine.answers === undefined ? {} : { outcomes: machine.answers }),
  });
  const preflighting = createProviderPreflight({
    programs: resolverHolding(machine.holds ?? {}),
    probes: runner,
    logger,
  });
  const registry = createProviderRegistry(
    machine.adapters ?? [createFakeProviderAdapter({ provider: 'claude' })],
  );
  return { readiness: await preflighting.run(registry), runner };
}

describe('createProviderPreflight', () => {
  it('reports the directory, the version and the login state of a provider that is there', async () => {
    const { readiness } = await preflight({
      holds: { claude: BIN },
      answers: { 'claude version': printed('9.9.9\n'), 'claude whoami': printed('robert\n') },
    });

    expect(readiness).toEqual([
      { provider: 'claude', state: 'ready', version: '9.9.9', directory: BIN, problem: null },
    ]);
  });

  it('names a provider no directory holds as missing, and says which flag records one', async () => {
    // The case the ticket exists for. On a pty this would be a session that
    // starts and immediately dies; here it is a word before anybody taps start.
    const { readiness } = await preflight({ holds: {} });

    expect(readiness[0]).toMatchObject({
      provider: 'claude',
      state: 'missing',
      version: null,
      directory: null,
    });
    expect(readiness[0]?.problem).toContain('--bin-path');
  });

  it('does not run a probe against a program nothing holds', async () => {
    // Two timeouts to learn what the search already established, and the probe
    // failure would then be reported over the top of the fact worth having.
    const { runner } = await preflight({ holds: {} });

    expect(runner.requests).toEqual([]);
  });

  it('reports a provider that is installed and logged out, with its version', async () => {
    const { readiness } = await preflight({
      holds: { claude: BIN },
      answers: { 'claude version': printed('9.9.9\n'), 'claude whoami': refused(1, 'no session') },
    });

    expect(readiness[0]).toMatchObject({
      state: 'unauthenticated',
      version: '9.9.9',
      directory: BIN,
    });
  });

  it('reports a program it found but could not read a version out of as unknown', async () => {
    // Found, so not `missing`: saying "not installed" about a binary sitting in
    // a directory this just named would send an operator after the wrong thing.
    const { readiness } = await preflight({
      holds: { claude: BIN },
      answers: { 'claude version': refused(1, 'claude: command wrapper failed') },
    });

    expect(readiness[0]).toMatchObject({ state: 'unknown', version: null, directory: BIN });
    expect(readiness[0]?.problem).toContain('claude exited 1');
  });

  it('reports a version it read even when the login probe could not answer', async () => {
    const { readiness } = await preflight({
      holds: { claude: BIN },
      answers: {
        'claude version': printed('9.9.9\n'),
        // Nothing ran: the fake's default for an argv it has no answer for.
        'claude whoami': { kind: 'failed', problem: 'claude was killed after 5000ms' },
      },
    });

    expect(readiness[0]).toMatchObject({ state: 'unknown', version: '9.9.9', directory: BIN });
    expect(readiness[0]?.problem).toContain('killed');
  });

  it('gives each probe the timeout its own adapter chose', async () => {
    const { runner } = await preflight({
      holds: { claude: BIN },
      answers: { 'claude version': printed('9.9.9\n'), 'claude whoami': printed('robert\n') },
    });

    expect(runner.requests.map((request) => request.timeoutMs)).toEqual([5_000, 5_000]);
  });

  it('lets an adapter that throws cost its own provider and nothing else', async () => {
    const broken = createFakeProviderAdapter({ provider: 'codex' });
    const exploding: ProviderAdapter = {
      ...broken,
      provisioning: {
        ...broken.provisioning,
        version: () => {
          throw new Error('this adapter is broken');
        },
      },
    };

    const { readiness } = await preflight({
      holds: { claude: BIN },
      answers: { 'claude version': printed('9.9.9\n'), 'claude whoami': printed('robert\n') },
      adapters: [createFakeProviderAdapter({ provider: 'claude' }), exploding],
    });

    expect(readiness).toHaveLength(2);
    expect(readiness[0]).toMatchObject({ provider: 'claude', state: 'ready' });
    // Unknown and not missing: nothing established that codex is absent.
    expect(readiness[1]).toMatchObject({ provider: 'codex', state: 'unknown' });
  });

  it('reports one entry per registered provider, in registration order', async () => {
    const { readiness } = await preflight({
      holds: { claude: BIN, codex: '/usr/local/bin' },
      answers: {
        'claude version': printed('9.9.9\n'),
        'claude whoami': printed('robert\n'),
        'codex version': printed('1.2.3\n'),
        'codex whoami': printed('robert\n'),
      },
      adapters: [
        createFakeProviderAdapter({ provider: 'claude' }),
        createFakeProviderAdapter({ provider: 'codex' }),
      ],
    });

    expect(readiness.map((entry) => entry.provider)).toEqual(['claude', 'codex']);
    expect(readiness[1]).toMatchObject({ state: 'ready', directory: '/usr/local/bin' });
  });

  it('answers with nothing for a build that drives no providers', async () => {
    const { readiness } = await preflight({ adapters: [] });

    expect(readiness).toEqual([]);
  });
});
