import type { ProviderRegistry } from '../provider-registry.js';
import type { OperationOutcome, OperationSummary } from './operation.js';
import type { ProcessRunner } from './process-runner.js';
import {
  providerAuthStateOperation,
  providerInstallOperation,
  providerVersionOperation,
} from './provider-provisioning-operations.js';
import { runSetupOperation, type SetupOperation } from './setup-operation.js';

/**
 * The setup registry: every program `agentplex setup` can run, by name, and no
 * way to run one that is not here.
 *
 * A second registry, not a wider one. The spec states the rule and the reason
 * together: "a long-running daemon that can be asked over a socket to fetch and
 * execute an installer is precisely the failure mode the registry exists to
 * prevent". So `provider.install` is not on the wire-facing registry behind a
 * flag, not there behind a caller check, and not there at all. The two lists are
 * module constants in two files, and disjointness is a property of the code
 * rather than of anybody's care — which matters because a flag saying
 * `allowInstall: false` is a thing a future reader flips while debugging, and a
 * list that does not contain the operation is not.
 *
 * Everything else is shared on purpose, and the sharing is what makes the split
 * cost nothing. The same `ProcessRunner`, so `shell: false` and the inherited
 * environment are decided in one place for both. The same `OperationOutcome` and
 * the same refusal vocabulary, so a caller reads one shape. The same closed
 * lookup, so a name nobody registered is a word that failed a lookup and never a
 * program. Setup gets more than the wire does; it gets it under the same rules.
 *
 * The existing guarantee — MCP gains no capability the UI lacks, because both
 * arrive at `OperationRegistry.execute` — therefore extends to "and neither
 * gains what setup has", because there is no method on this object that either
 * of them can reach.
 */

/**
 * Every operation the setup path can run.
 *
 * Exactly the one-shot spawns `ProviderProvisioning` defines, which is why the
 * list is three and not one. Installing a provider without being able to ask
 * what version landed, or whether the operator is logged into it, is not a setup
 * path — it is an install that ends in silence, and the spec is explicit that
 * "installed, not logged in" reported honestly beats silence followed by a
 * session that will not start. The fourth method, `login`, is a pty launch
 * rather than a one-shot and could not be here.
 */
const SETUP_OPERATIONS: readonly RegisteredSetupOperation[] = [
  register(providerInstallOperation),
  register(providerVersionOperation),
  register(providerAuthStateOperation),
];

/**
 * One setup operation with its two type parameters closed over rather than cast
 * away, exactly as `RegisteredOperation` does it for the wire-facing list, and
 * for the same reason: the list has to be heterogeneous, and a cast to some
 * widest type is the move this codebase does not make.
 */
interface RegisteredSetupOperation {
  readonly name: string;
  readonly summary: string;
  run(
    request: unknown,
    runner: ProcessRunner,
    providers: ProviderRegistry,
  ): Promise<OperationOutcome<unknown>>;
}

function register<Request, Result>(
  operation: SetupOperation<Request, Result>,
): RegisteredSetupOperation {
  return {
    name: operation.name,
    summary: operation.summary,
    run: (request, runner, providers) => runSetupOperation(operation, request, runner, providers),
  };
}

export interface SetupOperationRegistry {
  /**
   * What setup can run, for a wizard's transcript and for `doctor` to report.
   *
   * `OperationSummary` is the shape the wire-facing registry lists too, and
   * sharing the shape of "a name and a sentence" is sharing a vocabulary rather
   * than a list. The lists are the thing that must not be shared, and they are
   * two module constants in two files with nothing in common.
   */
  readonly operations: readonly OperationSummary[];
  /**
   * Runs a setup operation by name.
   *
   * `unknown` on the way out for the reason the wire-facing registry gives: a
   * caller that reached the registry by name learned the name from outside the
   * type system and cannot be handed a typed result honestly. A caller that
   * knows which operation it wants calls `runSetupOperation` with the operation
   * itself and keeps its types; both paths run the same parser, plan the same
   * argv and start the same child.
   */
  execute(name: string, request: unknown): Promise<OperationOutcome<unknown>>;
}

export interface SetupOperationRegistryDependencies {
  /**
   * The same seam the wire-facing registry is given. Sharing it is the point:
   * one place bakes in `shell: false` and decides what a child inherits, and
   * setup does not get a second one with different rules.
   */
  readonly runner: ProcessRunner;
  /**
   * The providers this build can drive. Provisioning is the adapter's answer,
   * so the registry that turns a name into an adapter is a dependency rather
   * than something this file knows.
   */
  readonly providers: ProviderRegistry;
}

/**
 * Constructed on the setup path and nowhere else.
 *
 * `main.ts` never calls this: a serving `agentplex` has no setup registry to
 * be asked for, which is the difference between "the daemon refuses to install
 * things" and "the daemon has nothing to refuse with".
 */
export function createSetupOperationRegistry({
  runner,
  providers,
}: SetupOperationRegistryDependencies): SetupOperationRegistry {
  const byName = new Map(SETUP_OPERATIONS.map((operation) => [operation.name, operation]));

  return {
    operations: SETUP_OPERATIONS.map(({ name, summary }) => ({ name, summary })),

    async execute(name: string, request: unknown): Promise<OperationOutcome<unknown>> {
      const operation = byName.get(name);
      if (operation === undefined) {
        // Not echoed into anything that runs and not treated as a program. It
        // is a word that failed a lookup — including every name the other
        // registry has, because two registries sharing a runner do not share an
        // operation list in either direction.
        return {
          ok: false,
          refusal: 'unknown-operation',
          problem: `setup has no operation called ${JSON.stringify(name)}`,
        };
      }

      return operation.run(request, runner, providers);
    },
  };
}
