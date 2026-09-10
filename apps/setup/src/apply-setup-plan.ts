import type { Provider, ServerId } from '@agentplex/protocol';
import {
  runSetupOperation,
  providerAuthStateOperation,
  providerInstallOperation,
  providerVersionOperation,
  type ProcessRunner,
  type AuthState,
  type ProviderRegistry,
  ensureStores,
  type StoreFileSystem,
  type StoreIdentity,
} from '@agentplex/providers';
import { ensureServerIdentity } from '@agentplex/providers';
import { type IdGenerator, tokenMatches, type TokenMinter } from '@agentplex/node-shared';
import {
  setupBinPath,
  type PlannedHub,
  type PlannedProvider,
  type PlannedServer,
  type SetupPlan,
  type Role,
} from './setup-plan.js';

/**
 * Provisioning: what a plan does to a machine.
 *
 * The consuming half of the wizard. It is written against `SetupPlan` and knows
 * nothing about where one came from, so a plan the operator answered questions
 * to build and a plan that arrived in EC2 user-data take the same code path and
 * produce the same machine — which is the only way an interactive run and an
 * unattended one can be claimed to do the same thing.
 *
 * **It reconciles rather than duplicates.** Every step asks what is already
 * there before it does anything: a provider that satisfies the plan is adopted
 * and not installed, a store that has an id keeps it, an identity that exists is
 * never minted over. Replaying a plan therefore converges on the machine the
 * plan describes instead of producing a second of everything, which is what
 * makes a plan baked into an image safe to run on every boot.
 *
 * **Nothing here aborts on the first failure.** A provider that cannot be
 * installed costs itself; the stores are still identified, the other providers
 * are still provisioned, and every problem is reported together. A setup run is
 * a thing an operator reads once, and one that stops at the first bad news makes
 * them run it again to find the second.
 *
 * **Every spawn is a provisioning operation.** The three that exist are the ones
 * `ProviderProvisioning` defines, and they are reached through
 * `runSetupOperation` — the typed path `createSetupOperationRegistry` runs its
 * own lookups through, and the one AGX-71 documents for a caller that knows
 * which operation it wants. Same parser, same argv builder, same `ProcessRunner`
 * with nowhere to put a cwd, an env var or a shell; there is no second way to
 * start a child here.
 *
 * The name-keyed registry is deliberately not the way in from this file. A plan
 * does not learn operation names from outside the type system — it names
 * providers, and the three operations are written down here — so going through
 * the string lookup would buy a closed lookup this code cannot fail and cost the
 * result types, leaving `unknown` to be parsed back into the values these
 * operations already returned. The registry is what a wizard's transcript and
 * `doctor` need, and both of those really do arrive holding a name.
 */

export interface SetupPlanDependencies {
  /**
   * The one-shot process seam, already carrying the directories the plan named.
   *
   * It arrives built rather than being composed here because `binPath` becomes a
   * `PATH`, and the one place this process's own environment is read is the
   * entrypoint. What matters to this file is that the runner it is handed
   * resolves programs the way the plan says a server will — that is what makes
   * a second replay find what the first one installed.
   */
  readonly runner: ProcessRunner;
  /** The providers this build can drive. A plan may name one it cannot. */
  readonly providers: ProviderRegistry;
  /** Where the identity file and the store files are written. */
  readonly files: StoreFileSystem;
  readonly ids: IdGenerator;
  /** Mints a pairing token when the plan did not bring one. */
  readonly tokens: TokenMinter;
}

/**
 * What a run did about one planned provider.
 *
 * `action` is what this run *did*, not whether the plan was met: a provider that
 * could not be put there is `none` with the reason in `problems`, and one that
 * was installed but is being shadowed is `installed` with the shadowing named.
 * Collapsing those into a boolean would lose the difference between a machine
 * that has no provider and one that has the wrong one.
 */
export interface ProviderReport {
  readonly provider: Provider;
  readonly action: 'adopted' | 'installed' | 'none';
  /** What the provider says it is, as it says it, or `null` if it could not say. */
  readonly version: string | null;
  /** Logged in, logged out, or `null` when the question could not be put to it. */
  readonly authState: AuthState | null;
  readonly problems: readonly string[];
}

/**
 * The identity this machine will pair with, with the secret left out.
 *
 * Deliberately not a `ServerIdentity`: that carries the token, and this value is
 * printed to a terminal and, on a cloud instance, into a boot log. The operator
 * reads the token out of the file, which is the same place the server has always
 * kept it and the same reason the server logs the path and never the contents.
 */
export interface ServerIdentityReport {
  readonly path: string;
  readonly serverId: ServerId | null;
  /** True when this run created the file. The one honest difference between replays. */
  readonly minted: boolean;
  readonly problem: string | null;
}

export interface ServerSetupOutcome {
  readonly port: number;
  /**
   * The directories a `ServerConfig` should record, in search order.
   *
   * A pure function of the plan, so it is the same on the first replay and the
   * tenth. This is the value that ends the silent `ENOENT`: the server resolves
   * `claude` in exactly the directories setup probed rather than in whatever
   * PATH systemd handed it.
   */
  readonly binPath: readonly string[];
  readonly identity: ServerIdentityReport;
  /** Every configured store, in configured order, failures kept in the listing. */
  readonly stores: readonly StoreIdentity[];
  readonly providers: readonly ProviderReport[];
}

export interface SetupOutcome {
  readonly role: Role;
  readonly hub: PlannedHub | null;
  readonly server: ServerSetupOutcome | null;
  /**
   * Everything that did not go to plan, each line naming its subject.
   *
   * Flattened here rather than walked by every caller, because two of them — the
   * report a person reads and the exit code a cloud-init acts on — need exactly
   * this list and would otherwise each re-derive it.
   *
   * A provider that is installed and logged out is *not* in here. There is no
   * way to log in unattended, so an unattended run that reported that as a
   * failure would fail every boot it succeeded at.
   */
  readonly problems: readonly string[];
}

export async function applySetupPlan(
  plan: SetupPlan,
  dependencies: SetupPlanDependencies,
): Promise<SetupOutcome> {
  const hub = 'hub' in plan ? plan.hub : null;

  // A hub starts no agents, mounts no stores and has no identity to mint, so
  // there is nothing on this machine for it to reconcile. Its half of the plan
  // is a record of the machine somebody meant, which is what the whole artifact
  // is for.
  if (!('server' in plan)) return { role: plan.role, hub, server: null, problems: [] };

  const server = await provisionServer(plan.server, setupBinPath(plan), dependencies);
  return { role: plan.role, hub, server, problems: problemsOf(server) };
}

async function provisionServer(
  planned: PlannedServer,
  binPath: readonly string[],
  dependencies: SetupPlanDependencies,
): Promise<ServerSetupOutcome> {
  // Identity first, and the stores before the providers: they are local, they
  // are fast, and they are what an operator watching the output wants to see
  // before a five-minute install starts.
  const identity = await provisionIdentity(planned, dependencies);
  const stores = await ensureStores(planned.storePaths, dependencies);

  // One at a time, deliberately. Two installs into one prefix at once is a
  // package manager racing itself over the same directory tree, which is exactly
  // the "two of something" this path exists to avoid.
  const providers: ProviderReport[] = [];
  for (const provider of planned.providers) {
    providers.push(await provisionProvider(provider, planned.installPrefix, dependencies));
  }

  return { port: planned.port, binPath, identity, stores, providers };
}

/**
 * The server's identity, minted from the plan's token when it brought one.
 *
 * The plan's token is handed to `ensureServerIdentity` as its token source
 * rather than written by a second path, so the file is created exactly once and
 * exactly the way a first start creates it. An identity that already exists is
 * read, never replaced — including when the plan's token disagrees with it,
 * which is reported rather than resolved: the disagreement means the machine is
 * already paired under another token, and overwriting would break that pairing
 * silently.
 */
async function provisionIdentity(
  planned: PlannedServer,
  { files, ids, tokens }: SetupPlanDependencies,
): Promise<ServerIdentityReport> {
  const token = planned.pairingToken;
  const result = await ensureServerIdentity(planned.identityPath, {
    files,
    ids,
    tokens: token === null ? tokens : { newToken: () => token },
  });

  if (!result.ok) {
    return { path: result.path, serverId: null, minted: false, problem: result.problem };
  }

  // `tokenMatches` rather than `===`, though nothing is being authenticated
  // here. There is one way two secrets are compared in this codebase, and a
  // second spelling of it is how that stops being true.
  const disagrees = token !== null && !result.minted && !tokenMatches(result.identity.token, token);

  return {
    path: planned.identityPath,
    serverId: result.identity.serverId,
    minted: result.minted,
    problem: disagrees
      ? `${planned.identityPath} already holds an identity with a different pairing token, ` +
        'which was left alone: this machine is already paired under it. Delete the file to ' +
        'take the token in the plan, and re-pair the server afterwards.'
      : null,
  };
}

/**
 * One provider, reconciled: adopt what satisfies the plan, install what does not.
 *
 * The version probe is both halves of the decision. It answers "is this provider
 * here" and "is it the one the plan pinned" in one spawn, and it is the same
 * probe the spec wants run against an adopted binary anyway — the moment a
 * version-manager shim that cannot run outside its own environment gets found,
 * while a person is still present.
 */
async function provisionProvider(
  planned: PlannedProvider,
  prefix: string,
  dependencies: SetupPlanDependencies,
): Promise<ProviderReport> {
  const { provider } = planned;
  const probed = await probeVersion(provider, dependencies);

  if (probed.ok && satisfies(probed.result, planned.version)) {
    const auth = await probeAuthState(provider, dependencies);
    return {
      provider,
      action: 'adopted',
      version: probed.result,
      authState: auth.state,
      problems: auth.problems,
    };
  }

  const installed = await runSetupOperation(
    providerInstallOperation,
    { provider, prefix, version: planned.version },
    dependencies.runner,
    dependencies.providers,
  );
  if (!installed.ok) {
    // Nothing was put there. The version already on the machine, if there is
    // one, is reported alongside so that "the pin could not be installed" and
    // "there is no provider at all" read as the different facts they are.
    return {
      provider,
      action: 'none',
      version: probed.ok ? probed.result : null,
      authState: null,
      problems: [installed.problem],
    };
  }

  const problems: string[] = [];
  const confirmed = await probeVersion(provider, dependencies);
  if (!confirmed.ok) {
    // Installed, and it will not run. npm exits 0 on installs that produce a
    // binary that cannot start, so this probe is the safety net under the whole
    // install path, and it runs while somebody is still watching.
    return {
      provider,
      action: 'installed',
      version: null,
      authState: null,
      problems: [
        `${installed.result.package} ${installed.result.version} was installed into ${prefix} ` +
          `and could not be run afterwards: ${confirmed.problem}`,
      ],
    };
  }

  if (confirmed.result !== installed.result.version) {
    problems.push(
      `${installed.result.package} ${installed.result.version} was installed into ${prefix}, ` +
        `and the ${provider} that runs is ${confirmed.result}: a copy earlier in binPath is ` +
        'shadowing it.',
    );
  }

  const auth = await probeAuthState(provider, dependencies);
  return {
    provider,
    action: 'installed',
    version: confirmed.result,
    authState: auth.state,
    problems: [...problems, ...auth.problems],
  };
}

/** A pin is met only by itself; an unpinned provider is met by whatever is there. */
function satisfies(version: string, pinned: string | null): boolean {
  return pinned === null || version === pinned;
}

function probeVersion(provider: Provider, { runner, providers }: SetupPlanDependencies) {
  return runSetupOperation(providerVersionOperation, { provider }, runner, providers);
}

/**
 * Whether the provider says it is logged in.
 *
 * A probe that cannot answer is a problem and never a logout. A `claude` behind
 * a corporate wrapper and a release that stopped printing this are different
 * facts from a logged-out one, and reporting either as logged out sends an
 * operator through a login that will fail for a reason nobody named.
 */
async function probeAuthState(
  provider: Provider,
  { runner, providers }: SetupPlanDependencies,
): Promise<{ readonly state: AuthState | null; readonly problems: readonly string[] }> {
  const outcome = await runSetupOperation(
    providerAuthStateOperation,
    { provider },
    runner,
    providers,
  );
  return outcome.ok
    ? { state: outcome.result, problems: [] }
    : { state: null, problems: [outcome.problem] };
}

/** Every problem in the run, each line naming what it is about. */
function problemsOf(server: ServerSetupOutcome): readonly string[] {
  return [
    ...(server.identity.problem === null ? [] : [server.identity.problem]),
    ...server.stores.flatMap((store) => (store.ok ? [] : [`${store.path}: ${store.problem}`])),
    ...server.providers.flatMap((provider) =>
      provider.problems.map((problem) => `${provider.provider}: ${problem}`),
    ),
  ];
}
