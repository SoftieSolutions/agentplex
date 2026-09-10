import { join } from 'node:path';
import type { Provider } from '@agentplex/protocol';
import {
  providerAuthStateOperation,
  providerVersionOperation,
} from '../server/operations/provider-provisioning-operations.js';
import type { ProcessRunner } from '../server/operations/process-runner.js';
import { runSetupOperation } from '../server/operations/setup-operation.js';
import type { AuthState, ProviderAdapter } from '../server/providers/provider-adapter.js';
import type { ProviderRegistry } from '../server/providers/provider-registry.js';
import { findProgram, type SetupMachine } from './setup-machine.js';

/**
 * What setup can find out for itself, before it asks anybody anything.
 *
 * A wizard that asked which providers are installed, where they are, and which
 * stores exist would be a flag wall with a friendlier prompt: the machine
 * already knows, and every question whose answer is on disk is a question an
 * operator can get wrong. So this runs first, and the questions that follow are
 * confirmations of what was found.
 *
 * **The adoption rule is what this exists for.** Setup resolves each provider
 * once, against the operator's own PATH, and records the directory it was found
 * in. Only when nothing is found does setup install into the prefix agentplex
 * owns. That is not a nicety: an operator's existing `claude` is the one they
 * authenticated, and a second copy installed into an owned prefix and put ahead
 * of it would shadow a working, logged-in binary with a fresh one that is not —
 * a failure that presents as an authentication bug with nothing pointing at the
 * cause.
 *
 * **The version probe is run here, on purpose, while a person is present.** A
 * version-manager shim that needs its own environment to work resolves like any
 * other program and then cannot run, and so does an npm install whose postinstall
 * did not. Both are found by asking the binary what it is. Doing it now means an
 * operator who can act on it; doing it at the first spawn of the first session
 * means an `ENOENT`-shaped mystery on a machine nobody is looking at.
 *
 * Nothing here decides anything. It reports what is on the machine, and the
 * wizard turns that into a plan with the operator's answers.
 */

export interface SurveyDependencies {
  readonly machine: SetupMachine;
  /** The providers this build can drive. What is not in here is not looked for. */
  readonly providers: ProviderRegistry;
  /**
   * The one-shot process seam, built from the directories to resolve in.
   *
   * A factory rather than a runner, for the reason the setup command takes one:
   * the whole point of a probe here is that it ran against the copy in the
   * directory about to be recorded, and that is a different environment per
   * provider.
   */
  readonly runnerFor: (binPath: readonly string[]) => ProcessRunner;
}

export interface ProviderSurvey {
  readonly provider: Provider;
  /** The program this provider runs, as the provider's own version probe names it. */
  readonly program: string;
  /**
   * Every directory on the operator's PATH holding it, in search order.
   *
   * The first is the one that runs, and therefore the one adoption records.
   * Empty means there is nothing on this machine to adopt.
   */
  readonly foundIn: readonly string[];
  /** What it says it is, or `null` when it could not say. */
  readonly version: string | null;
  /**
   * Why it could not say, or `null`.
   *
   * Non-null alongside a non-empty `foundIn` is the case the whole probe exists
   * for: something resolves under that name and cannot be run.
   */
  readonly versionProblem: string | null;
  /** Logged in, logged out, or `null` when the question was not put or not answered. */
  readonly authState: AuthState | null;
  readonly authProblem: string | null;
}

export interface MachineSurvey {
  /**
   * Store directories that are on this machine already, in registration order.
   *
   * Offered, never assumed: a store is where a deployment says it is, and this
   * is only the answer for the common case — an operator installing agentplex
   * beside the sessions they have already been running.
   */
  readonly stores: readonly string[];
  readonly providers: readonly ProviderSurvey[];
}

export async function surveyMachine(dependencies: SurveyDependencies): Promise<MachineSurvey> {
  const adapters = dependencies.providers.adapters;

  const stores: string[] = [];
  for (const adapter of adapters) {
    const candidate = join(dependencies.machine.home, adapter.defaultStoreDirectory);
    // A directory that is not there is not offered. Two providers sharing one
    // store directory is one store, which is the same rule a plan's parser
    // applies to the list it ends up in.
    if (!stores.includes(candidate) && (await dependencies.machine.isDirectory(candidate))) {
      stores.push(candidate);
    }
  }

  // One at a time. These are child processes, and the ordering is what makes the
  // wizard's output read in the order it asks its questions.
  const providers: ProviderSurvey[] = [];
  for (const adapter of adapters) providers.push(await surveyProvider(adapter, dependencies));

  return { stores, providers };
}

/**
 * The whole of what setup knows about one provider before it asks anything.
 *
 * The program name comes from the adapter's own version probe rather than from a
 * table here, which keeps "what is this provider called on a PATH" in the file
 * that knows it. It is the same argv the probe will run, so what is looked for
 * and what is run cannot drift apart.
 */
async function surveyProvider(
  adapter: ProviderAdapter,
  dependencies: SurveyDependencies,
): Promise<ProviderSurvey> {
  const provider = adapter.provider;
  const program = adapter.provisioning.version().argv.file;
  const foundIn = await findProgram(program, dependencies.machine);

  const directory = foundIn[0];
  if (directory === undefined) {
    // Nothing to ask. Probing a program that is not installed produces an
    // ENOENT that carries no fact and reads, in a report, as a failure.
    return {
      provider,
      program,
      foundIn,
      version: null,
      versionProblem: null,
      authState: null,
      authProblem: null,
    };
  }

  // Resolved in the directory about to be recorded, rather than through whatever
  // else is on this process's PATH: the version reported has to be the version
  // of the binary the server will run.
  const runner = dependencies.runnerFor([directory]);
  const probed = await runSetupOperation(
    providerVersionOperation,
    { provider },
    runner,
    dependencies.providers,
  );

  if (!probed.ok) {
    // A binary that cannot say what it is is not a binary to ask about a login.
    // The second probe would fail for the same reason, carrying no new fact, and
    // an unanswerable auth probe reads as a logout.
    return {
      provider,
      program,
      foundIn,
      version: null,
      versionProblem: probed.problem,
      authState: null,
      authProblem: null,
    };
  }

  const auth = await runSetupOperation(
    providerAuthStateOperation,
    { provider },
    dependencies.runnerFor([directory]),
    dependencies.providers,
  );

  return {
    provider,
    program,
    foundIn,
    version: probed.result,
    versionProblem: null,
    authState: auth.ok ? auth.result : null,
    authProblem: auth.ok ? null : auth.problem,
  };
}

/**
 * Whether this provider is one setup would adopt rather than install.
 *
 * Both halves, and the second is the one that is easy to forget: a copy that
 * resolves and cannot report a version is not an adoption, it is a directory
 * that would be recorded ahead of the one setup installs into and would shadow
 * it. Named here rather than spelled out at each caller so that "adopted" means
 * one thing in the wizard, in its report and in the plan it builds.
 */
export function isAdoptable(survey: ProviderSurvey): boolean {
  return survey.foundIn.length > 0 && survey.version !== null;
}
