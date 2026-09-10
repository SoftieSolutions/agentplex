import type { Provider, ProviderReadiness } from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import type { ProcessRunner } from '../operations/process-runner.js';
import type { ProgramResolver } from '../program-resolver.js';
import type { OneShotPlan, OneShotRead, ProviderAdapter } from './provider-adapter.js';
import type { ProviderRegistry } from './provider-registry.js';

/**
 * What this machine can actually start, found out once, before anything asks.
 *
 * The install spec's opening problem is a binary that resolves in the
 * operator's shell and not in the service, surfacing as `ENOENT` at spawn time
 * reported as "the machine said no". AGX-68 fixed the resolution; this is the
 * half that makes the remaining failure legible, and on the seam that matters
 * it is the only thing that can. On a pty the fork succeeds and the program is
 * resolved on the far side of it, so a provider that is not there presents as a
 * session that appears and vanishes with no output and no exit code worth
 * reading. There is no way to turn that into a good error message at spawn
 * time, because at spawn time the information does not exist. It has to be
 * known beforehand, and this is where it is learned.
 *
 * Three questions per provider, in this order, and the order is the point:
 *
 *   1. Which directory does the program resolve from? Asked of the same search
 *      path a child will use, so the answer is where a spawn would find it.
 *   2. What version is it? The provider's own answer, verbatim.
 *   3. Is it logged in? Asked of the provider, never inferred from its files.
 *
 * A provider that fails the first is not asked the other two. Running a probe
 * against a program nothing holds would spend two timeouts to learn what the
 * search already established, and would report "the probe could not run" over
 * the top of the specific fact -- that it is not installed -- that a person can
 * act on.
 *
 * Every answer costs itself. One adapter that throws, one probe that hangs, one
 * provider that is missing: each becomes a word about that provider, and the
 * others are reported exactly as they were found. That is the same rule an
 * unreadable transcript follows in `discover`, applied one level up.
 *
 * On the spawn rule: these argv are constants of an adapter -- a bare program
 * name and a fixed list of arguments, chosen in the adapter's own file with
 * nothing from a frame, a plan file or a store anywhere in them. They run
 * through the same `ProcessRunner` every operation runs through, with the same
 * `shell: false` and the same fixed environment, and there is no name by which
 * anything could ask for one: nothing here is registered, so nothing over a
 * socket can reach it. That is the same argument the spec makes for setup's
 * separate registry, and it holds for the same reason.
 */

export interface ProviderPreflightDependencies {
  /** Where a bare program name resolves from, on this machine, right now. */
  readonly programs: ProgramResolver;
  /**
   * The one-shot runner the probes go through.
   *
   * The same one the operations use, injected rather than made, because the
   * environment a child inherits is decided where the runner is constructed and
   * `main` is the only place allowed to read this process's own environment. A
   * probe that ran with a different PATH from a session would answer a question
   * nobody asked.
   */
  readonly probes: ProcessRunner;
  readonly logger: Logger;
}

export interface ProviderPreflight {
  /**
   * Every registered provider's readiness, in registration order.
   *
   * Never rejects. A preflight that threw would take down a server over a
   * provider it could have simply reported as unusable, which is the opposite
   * of what it is for.
   */
  run(providers: ProviderRegistry): Promise<readonly ProviderReadiness[]>;
}

export function createProviderPreflight(
  dependencies: ProviderPreflightDependencies,
): ProviderPreflight {
  const { programs, probes } = dependencies;
  const logger = dependencies.logger.child({ part: 'preflight' });

  return {
    async run(providers: ProviderRegistry): Promise<readonly ProviderReadiness[]> {
      // Concurrent because providers are independent, and each of these is two
      // child processes with timeouts on them: asking three adapters in series
      // would put the sum of their probes in front of a server's first listen.
      return Promise.all(
        providers.adapters.map(async (adapter) => {
          try {
            const readiness = await inspect(adapter);
            logger.info('provider preflight', { ...readiness });
            return readiness;
          } catch (error) {
            // An adapter that threw is this build's own bug, and it still costs
            // only its own provider. Reported as `unknown` rather than
            // `missing`, because nothing here established that the program is
            // absent -- and saying "not installed" about a binary that may be
            // sitting right there is the over-claim this file exists to avoid.
            const problem = `agentplexd could not check ${adapter.provider}: ${String(error)}`;
            logger.error('provider preflight failed', { provider: adapter.provider, problem });
            return unusable(adapter.provider, 'unknown', problem, null);
          }
        }),
      );
    },
  };

  async function inspect(adapter: ProviderAdapter): Promise<ProviderReadiness> {
    const provider = adapter.provider;
    // The program name off the adapter's own version probe. It is the bare name
    // the provider answers to -- the same one its launch plans carry -- and
    // taking it from the plan rather than restating it here is what keeps this
    // file from holding a second copy of a fact only the adapter knows.
    const program = adapter.provisioning.version().argv.file;

    const directory = await programs.resolve(program);
    if (directory === null) {
      return unusable(
        provider,
        'missing',
        `no directory this server searches holds ${program}; ` +
          'install it, or record the directory it is in with --bin-path',
        null,
      );
    }

    const version = await probe(adapter.provisioning.version());
    if (!version.ok) {
      // Found and unreadable. Not refused by the hub: the binary resolves, so a
      // session will start something, and the honest report is that this server
      // could not get an answer out of it rather than that it is not there.
      return unusable(provider, 'unknown', version.problem, directory);
    }

    const auth = await probe(adapter.provisioning.authState());
    if (!auth.ok) {
      return {
        provider,
        state: 'unknown',
        version: version.result,
        directory,
        problem: auth.problem,
      };
    }

    if (auth.result === 'unauthenticated') {
      return {
        provider,
        state: 'unauthenticated',
        version: version.result,
        directory,
        problem: `${program} is installed and logged out; run its login on that machine`,
      };
    }

    return { provider, state: 'ready', version: version.result, directory, problem: null };
  }

  /**
   * Runs one plan and lets the adapter read what came back.
   *
   * The two halves stay apart exactly as they do for an operation: this owns
   * starting a child and the deadline it gets, and what an exit code means is
   * the adapter's, because the answer differs per program and per question --
   * `claude auth status` exits 1 while correctly reporting that it is logged
   * out, and a reader here that judged the code would lose that.
   */
  async function probe<Result>(plan: OneShotPlan<Result>): Promise<OneShotRead<Result>> {
    const outcome = await probes.run({
      file: plan.argv.file,
      args: plan.argv.args,
      timeoutMs: plan.timeoutMs,
    });
    // Nothing ran, or what ran was killed. The runner's own words: they name a
    // timeout or an errno, and both are things an operator acts on.
    if (outcome.kind === 'failed') return { ok: false, problem: outcome.problem };
    return plan.read(outcome);
  }
}

function unusable(
  provider: Provider,
  state: 'missing' | 'unknown',
  problem: string,
  directory: string | null,
): ProviderReadiness {
  return { provider, state, version: null, directory, problem };
}
