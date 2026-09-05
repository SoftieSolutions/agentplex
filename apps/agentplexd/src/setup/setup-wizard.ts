import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Provider, StoreDescriptor } from '@agentplex/protocol';
import { DEFAULT_HUB_PORT, DEFAULT_SERVER_PORT, ROLES, type Role } from '../config/config.js';
import type { ProcessRunner } from '../server/operations/process-runner.js';
import type { ProviderAdapter } from '../server/providers/provider-adapter.js';
import type { ProviderRegistry } from '../server/providers/provider-registry.js';
import type { StoreFileSystem } from '../server/store-identity.js';
import type { IdGenerator } from '../shared/ids.js';
import type { TokenMinter } from '../shared/tokens.js';
import { applySetupPlan, type SetupOutcome } from './apply-setup-plan.js';
import { describeOutcome } from './describe-outcome.js';
import type { SetupMachine } from './setup-machine.js';
import {
  parseSetupPlan,
  serializeSetupPlan,
  setupBinPath,
  type PlannedHub,
  type PlannedProvider,
  type SetupPlan,
  SETUP_PLAN_VERSION,
} from './setup-plan.js';
import {
  askChoice,
  askFor,
  askText,
  askYesNo,
  type Asked,
  type Choice,
  type SetupTerminal,
} from './setup-terminal.js';
import { isAdoptable, surveyMachine, type ProviderSurvey } from './survey-machine.js';

/**
 * `agentplexd setup`: the interactive front end.
 *
 * It is not the setup. It produces a `SetupPlan` and hands it to the same
 * provisioning `setup --plan` runs, so an operator answering questions and a
 * cloud-init file replaying an artifact take one code path and produce one
 * machine. Nothing in this file installs anything, mints anything or writes a
 * store file; if it did, there would be two definitions of what a provisioned
 * machine is and the one nobody replays would be the one that rots.
 *
 * **It asks only what it cannot discover.** Which providers are installed, which
 * directory each is in, whether they are logged in, and which store directories
 * exist are all facts about the machine, and `surveyMachine` establishes them
 * before the first question. What is left is genuinely a decision: which role
 * this machine plays, which ports, which stores to mount, and what to do about a
 * provider that is not where setup would want it.
 *
 * **The role is offered rather than deduced, and that is honest.** Nothing on
 * this machine distinguishes a box that should be a hub from one that should be
 * a server: the fact that would — whether a hub already runs elsewhere on this
 * network — is not on this machine, and guessing it would be the wizard
 * inventing an answer. `--role` pre-seeds the question for an installer that was
 * told, which is what the spec asks for, and the summaries say what each choice
 * means so the operator is deciding rather than agreeing.
 *
 * **Terminal I/O is injected**, so the whole flow is testable with a scripted
 * operator: the answers go in, and a plan and a provisioned machine come out.
 */

/** Where agentplex owns a prefix, under the operator's home. Never anywhere else. */
const OWNED_PREFIX_DIRECTORY = '.agentplex';
/** The server's identity file inside that prefix, and the plan's default name for it. */
const IDENTITY_FILE_NAME = 'server.json';
/** What the wizard offers to save its plan as, in the prefix it already owns. */
const PLAN_FILE_NAME = 'setup-plan.json';

/** The spelling of "no stores", so an empty answer is expressible in a prompt. */
const NO_STORES = 'none';

export interface SetupWizardDependencies {
  readonly terminal: SetupTerminal;
  readonly machine: SetupMachine;
  /**
   * The one-shot process seam, built from the directories to resolve in.
   *
   * The same factory the unattended command takes, for the same reason: the
   * entrypoint is the only reader of this process's environment, and what a
   * child of setup resolves is a fact about the directories in hand rather than
   * about what agentplexd was started with.
   */
  readonly runnerFor: (binPath: readonly string[]) => ProcessRunner;
  readonly providersFor: (runner: ProcessRunner) => ProviderRegistry;
  readonly files: StoreFileSystem;
  readonly ids: IdGenerator;
  readonly tokens: TokenMinter;
}

export interface SetupWizardSeed {
  /**
   * `--role`, from an installer that was told which machine this is.
   *
   * It pre-seeds the question rather than replacing it, which is the spec's
   * word: `curl | bash -s -- --role=server` is somebody stating an intention,
   * not somebody waiving the chance to see what setup found.
   */
  readonly role: Role | null;
}

export type WizardOutcome =
  /** A plan was built and applied. `problems` is the apply path's own list. */
  | { readonly kind: 'applied'; readonly problems: readonly string[] }
  /** The operator declined the plan. Nothing on this machine was changed. */
  | { readonly kind: 'abandoned' }
  /** There was nobody to ask. Nothing was changed, and nothing was assumed. */
  | { readonly kind: 'no-input' }
  /**
   * The answers did not add up to a plan the parser accepts.
   *
   * A machine problem rather than a typo, in practice: a setup started with no
   * `$HOME` has nowhere to own a prefix. Running it again will not help, which
   * is what makes it the same kind of answer as a plan file that does not parse.
   */
  | { readonly kind: 'unusable'; readonly problems: readonly string[] };

/** What the operator decided to do about one provider. */
type ProviderDecision = 'adopt' | 'install' | 'skip';

interface PlannedProviderChoice {
  readonly provider: Provider;
  readonly decision: ProviderDecision;
  /** The directory to record, when the decision was to adopt one. */
  readonly directory: string | null;
}

export async function runSetupWizard(
  seed: SetupWizardSeed,
  dependencies: SetupWizardDependencies,
): Promise<WizardOutcome> {
  const { terminal, machine } = dependencies;

  terminal.write('agentplexd setup');
  terminal.write('');
  terminal.write('Looking at this machine.');

  // Everything the machine can answer for itself, answered before anybody is
  // asked anything. The registry is built with a runner that resolves the way
  // the operator's own shell does, because that is the PATH adoption is decided
  // against.
  const providers = dependencies.providersFor(dependencies.runnerFor([]));
  const survey = await surveyMachine({ machine, providers, runnerFor: dependencies.runnerFor });

  for (const line of describeSurvey(survey.stores, survey.providers)) terminal.write(line);
  terminal.write('');

  const answered = await askForPlan(seed, survey.stores, survey.providers, dependencies);
  if (answered.kind === 'ended') return { kind: 'no-input' };

  // The answers, through the parser a plan file goes through.
  //
  // Everything in the value above came from outside this program — an operator's
  // typing, and this machine's `$HOME` — so it is a claim like any other, and
  // "the wizard built it, so it must be well-formed" is exactly the reasoning
  // that lets a setup started with no home directory provision `/.agentplex`.
  // Round-tripping it also settles the other half: what the last screen offers to
  // save is byte-for-byte what was applied, normalised the same way a replay
  // normalises it, so an artifact and the machine it came from cannot disagree.
  const written = serializeSetupPlan(answered.value);
  const plan = parseSetupPlan(written);
  if (!plan.ok) {
    terminal.write('');
    terminal.write('These answers do not make a usable plan:');
    for (const problem of plan.problems) terminal.write(`  ${problem}`);
    return { kind: 'unusable', problems: plan.problems };
  }

  terminal.write('');
  terminal.write('This is the plan:');
  for (const line of describePlan(plan.plan)) terminal.write(`  ${line}`);
  terminal.write('');

  const apply = await askYesNo(terminal, 'Apply it to this machine?', true);
  if (apply.kind === 'ended') return { kind: 'no-input' };

  if (!apply.value) {
    terminal.write('Nothing on this machine was changed.');
    // The plan is still worth keeping: an operator who answered every question
    // and then decided to provision somewhere else has built exactly the
    // artifact the other front end takes.
    await offerToSave(written, dependencies);
    return { kind: 'abandoned' };
  }

  // The prefix agentplex owns, before anything is asked to write into it.
  //
  // Nothing downstream can do this: the store filesystem's `createFile` is
  // exclusive in the kernel and creates no parents, so on a machine that has
  // never run setup the identity file lands as an `ENOENT` in a report rather
  // than as a file. It is one directory, in a location this wizard chose, and it
  // is made here rather than in the apply path because the apply path is handed
  // a plan and has no standing to decide that a directory in it should exist.
  await makeOwnedPrefix(plan.plan, dependencies);

  const runner = dependencies.runnerFor(setupBinPath(plan.plan));
  const outcome = await applySetupPlan(plan.plan, {
    runner,
    providers: dependencies.providersFor(runner),
    files: dependencies.files,
    ids: dependencies.ids,
    tokens: dependencies.tokens,
  });

  terminal.write('');
  for (const line of describeOutcome(outcome)) terminal.write(line);
  for (const problem of outcome.problems) terminal.write(`problem: ${problem}`);

  terminal.write('');
  for (const line of whatIsLeft(outcome, providers, machine)) terminal.write(line);

  terminal.write('');
  await offerToSave(written, dependencies);

  return { kind: 'applied', problems: outcome.problems };
}

/**
 * The questions, in the order a person would ask them, and the plan they build.
 *
 * Every one of them has an offer in it that the machine's own state produced,
 * and pressing return through the whole wizard on a laptop with Claude Code
 * already on it is a correct plan. That is the difference between a wizard and a
 * flag wall with prompts.
 */
async function askForPlan(
  seed: SetupWizardSeed,
  stores: readonly string[],
  surveyed: readonly ProviderSurvey[],
  { terminal, machine }: SetupWizardDependencies,
): Promise<Asked<SetupPlan>> {
  const role = await askRole(seed, terminal);
  if (role.kind === 'ended') return role;

  if (role.value === 'hub') {
    // A hub runs no sessions, so none of the questions below are its. Asking
    // them anyway would be asking an operator to describe a half of a machine
    // this plan will not carry.
    const hubPort = await askHubPort(terminal);
    return hubPort.kind === 'ended'
      ? hubPort
      : {
          kind: 'answered',
          value: { version: SETUP_PLAN_VERSION, role: 'hub', hub: { port: hubPort.value } },
        };
  }

  let hub: PlannedHub | null = null;
  if (role.value === 'both') {
    const hubPort = await askHubPort(terminal);
    if (hubPort.kind === 'ended') return hubPort;
    hub = { port: hubPort.value };
  }

  const port = await askFor(
    terminal,
    `Server port [${DEFAULT_SERVER_PORT}] `,
    DEFAULT_SERVER_PORT,
    parsePort,
  );
  if (port.kind === 'ended') return port;

  const storePaths = await askStores(stores, terminal);
  if (storePaths.kind === 'ended') return storePaths;

  const chosen = await askProviders(surveyed, terminal);
  if (chosen.kind === 'ended') return chosen;

  const prefix = join(machine.home, OWNED_PREFIX_DIRECTORY);
  // Copied into arrays the plan type owns: a `SetupPlan` is the shape the parser
  // produces, and the parser produces one nobody else is holding a view onto.
  const server = {
    port: port.value,
    storePaths: [...storePaths.value],
    binPath: [...adoptedDirectories(chosen.value, machine)],
    identityPath: join(prefix, IDENTITY_FILE_NAME),
    installPrefix: prefix,
    // Never a token. A wizard has no reason to bake a secret into a file it is
    // about to offer to write somewhere: the token this machine pairs with is
    // minted into the identity file by the apply path, where the server has
    // always kept it. The plan's field is for the fleet tier, where somebody
    // decided a token before the machine existed.
    pairingToken: null,
    providers: chosen.value.flatMap((one): PlannedProvider[] =>
      // A pin of the version that happens to be installed today is a version
      // the operator never chose, and replaying it in a month would turn their
      // upgrade into a downgrade. `null` is "whatever the provider calls
      // current", which is what an interactive run actually means.
      one.decision === 'skip' ? [] : [{ provider: one.provider, version: null }],
    ),
  };

  return {
    kind: 'answered',
    value:
      hub === null
        ? { version: SETUP_PLAN_VERSION, role: 'server', server }
        : { version: SETUP_PLAN_VERSION, role: 'both', hub, server },
  };
}

/**
 * Makes the prefix, and reports a failure rather than stopping on one.
 *
 * A prefix that cannot be made is a machine that is about to say so twice —
 * once here, and once as the identity file that could not be written — and the
 * second of those is the apply path's own honest answer. Stopping would cost the
 * stores and the providers, which have nothing to do with this directory.
 */
async function makeOwnedPrefix(
  plan: SetupPlan,
  { terminal, machine }: SetupWizardDependencies,
): Promise<void> {
  if (!('server' in plan)) return;

  const made = await machine.makeDirectory(plan.server.installPrefix);
  if (!made.ok)
    terminal.write(`problem: cannot make ${plan.server.installPrefix}: ${made.problem}`);
}

function askHubPort(terminal: SetupTerminal): Promise<Asked<number>> {
  return askFor(terminal, `Hub port [${DEFAULT_HUB_PORT}] `, DEFAULT_HUB_PORT, parsePort);
}

const ROLE_SUMMARIES: Readonly<Record<Role, string>> = {
  hub: 'the database, the web app, and the machine that dials the servers',
  server: 'runs sessions on this machine; a hub elsewhere dials it',
  both: 'one process doing both, on one machine. The common case',
};

function askRole(seed: SetupWizardSeed, terminal: SetupTerminal): Promise<Asked<Role>> {
  const choices: readonly Choice<Role>[] = ROLES.map((role) => ({
    value: role,
    name: role,
    summary: ROLE_SUMMARIES[role],
  }));
  const seeded = choices.find((choice) => choice.value === seed.role);

  terminal.write('What should this machine be?');
  return askChoice(terminal, 'Role', choices, seeded ?? choices[2]!);
}

/**
 * The stores this server mounts, offered as the ones already on the machine.
 *
 * A list on one line rather than a question per store, because the answer is
 * usually the offer and because the number of stores is not something the wizard
 * can know to ask about the right number of times. Empty is legal — a server
 * whose volume is not mounted yet reports no stores rather than refusing to
 * start — so it needs a spelling, and `none` is it.
 */
async function askStores(
  discovered: readonly string[],
  terminal: SetupTerminal,
): Promise<Asked<readonly string[]>> {
  const offer = discovered.length === 0 ? NO_STORES : discovered.join(', ');

  terminal.write('Which stores should this server watch? Absolute paths, separated by commas.');
  const answered = await askText(terminal, 'Stores', offer);
  if (answered.kind === 'ended') return answered;

  if (answered.value === NO_STORES) return { kind: 'answered', value: [] };

  const paths = answered.value
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  // Refused rather than resolved against wherever setup was started, for the
  // reason the plan parser refuses one: a relative path in an artifact names a
  // different directory on every boot. Asking again is cheaper than a plan that
  // will not parse.
  const relative = paths.filter((path) => !isAbsolute(path));
  if (relative.length > 0) {
    terminal.write(`A store path has to be absolute: ${relative.join(', ')}`);
    return askStores(discovered, terminal);
  }

  return { kind: 'answered', value: paths.map((path) => resolve(path)) };
}

/**
 * One question per provider, and the whole of the adoption rule.
 *
 * What is offered is decided by what the survey found, and the three cases are
 * genuinely different:
 *
 * - **Found, and it answered a version probe.** Adoption is the offer. That
 *   binary is the one the operator authenticated, and installing a second copy
 *   into an owned prefix ahead of it would shadow a working, logged-in `claude`
 *   with a fresh one that is not.
 * - **Found, and it could not say what it is.** The version-manager shim that
 *   needs its own environment, and the install whose postinstall did not run.
 *   Adoption is *not* offered here, and that is the substantive decision: the
 *   recorded directory becomes the service's own PATH, where there is no login
 *   shell and no shim environment, so a copy that cannot answer a probe now will
 *   not answer a spawn later. Recording it anyway would also put it ahead of the
 *   prefix agentplex installs into and shadow the copy that does work. The
 *   operator sees the program's own words and decides between letting setup
 *   install its own copy and leaving the provider alone until they have fixed
 *   the shim.
 * - **Not found.** Install into the owned prefix, which is what the prefix is
 *   for.
 *
 * `skip` stays available in every case, because a machine that should not run a
 * provider at all is a legitimate machine, and the honest way to express it is a
 * plan that does not name the provider rather than one that does and fails.
 */
async function askProviders(
  surveyed: readonly ProviderSurvey[],
  terminal: SetupTerminal,
): Promise<Asked<readonly PlannedProviderChoice[]>> {
  const chosen: PlannedProviderChoice[] = [];

  for (const survey of surveyed) {
    const directory = survey.foundIn[0] ?? null;
    const choices = choicesFor(survey);

    terminal.write('');
    terminal.write(`${survey.provider}: ${describeFinding(survey)}`);

    const decision = await askChoice(terminal, survey.provider, choices, choices[0]!);
    if (decision.kind === 'ended') return decision;

    chosen.push({
      provider: survey.provider,
      decision: decision.value,
      directory: decision.value === 'adopt' ? directory : null,
    });
  }

  return { kind: 'answered', value: chosen };
}

/** The first choice is the offer, so the order here is the recommendation. */
function choicesFor(survey: ProviderSurvey): readonly Choice<ProviderDecision>[] {
  const install: Choice<ProviderDecision> = {
    value: 'install',
    name: 'install',
    summary: 'let agentplex install its own copy into the prefix it owns',
  };
  const skip: Choice<ProviderDecision> = {
    value: 'skip',
    name: 'skip',
    summary: 'leave this provider out of the plan entirely',
  };

  if (!isAdoptable(survey)) return [install, skip];

  return [
    {
      value: 'adopt',
      name: 'adopt',
      summary: `use the ${survey.program} in ${survey.foundIn[0]}, which is the one you have logged in`,
    },
    install,
    skip,
  ];
}

/** What the survey found about one provider, in one line, in its own words. */
function describeFinding(survey: ProviderSurvey): string {
  if (survey.foundIn.length === 0) return 'not on this machine';

  const where = survey.foundIn.join(', ');
  if (survey.version === null) {
    return (
      `found in ${where}, and it could not report a version: ${survey.versionProblem ?? 'it said nothing'}. ` +
      'A version manager shim that needs its own environment behaves exactly like this, ' +
      'and the service will have no such environment'
    );
  }

  const state =
    survey.authState === null
      ? `login state unknown: ${survey.authProblem ?? 'it did not say'}`
      : survey.authState === 'authenticated'
        ? 'logged in'
        : 'not logged in';

  return `${survey.version} in ${where} - ${state}`;
}

/** The survey as lines, before any decision has been taken about it. */
function describeSurvey(
  stores: readonly string[],
  surveyed: readonly ProviderSurvey[],
): readonly string[] {
  const lines = surveyed.map((survey) => `  ${survey.provider}: ${describeFinding(survey)}`);
  lines.push(
    stores.length === 0
      ? '  stores: none of the providers this build drives has state here yet'
      : `  stores: ${stores.join(', ')}`,
  );
  return lines;
}

/**
 * The directories to record, in the operator's own search order.
 *
 * Only the adopted ones. A directory that holds a provider setup did not adopt
 * would be recorded ahead of the prefix agentplex installs into, and would
 * shadow the copy setup is about to put there — which is the failure the shim
 * case exists to avoid, arriving by another road.
 *
 * PATH order rather than the order the questions were asked in, because this
 * list *is* a search order: two providers answering out of two directories
 * should resolve on the server the way they resolve in the operator's shell.
 */
function adoptedDirectories(
  chosen: readonly PlannedProviderChoice[],
  machine: SetupMachine,
): readonly string[] {
  const directories = chosen
    .map((one) => one.directory)
    .filter((directory): directory is string => directory !== null);

  return [...new Set(directories)].sort(
    (left, right) => machine.pathDirectories.indexOf(left) - machine.pathDirectories.indexOf(right),
  );
}

/** A port as somebody types one. Not coerced from anything else; there is nothing else. */
function parsePort(text: string): { ok: true; value: number } | { ok: false; problem: string } {
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? { ok: true, value: port }
    : { ok: false, problem: `${text} is not a port between 1 and 65535` };
}

/** The plan as facts, in the order the questions produced them. */
function describePlan(plan: SetupPlan): readonly string[] {
  const lines = [`role: ${plan.role}`];
  if ('hub' in plan) lines.push(`hub port: ${plan.hub.port}`);
  if (!('server' in plan)) return lines;

  const server = plan.server;
  lines.push(
    `server port: ${server.port}`,
    `stores: ${server.storePaths.length === 0 ? NO_STORES : server.storePaths.join(', ')}`,
    `resolve programs in: ${setupBinPath(plan).join(', ')}`,
    `install into: ${server.installPrefix}`,
    `identity: ${server.identityPath}`,
    `providers: ${
      server.providers.length === 0
        ? 'none'
        : server.providers.map((one) => one.provider).join(', ')
    }`,
  );
  return lines;
}

/**
 * What this machine still needs, after the plan has been applied.
 *
 * Two of these are the seams the next two tickets land on, and both are printed
 * as facts rather than stubbed as questions, because a wizard that offers to do
 * something this build cannot do is worse than one that says what is left.
 *
 * - **Logging a provider in (AGX-74).** The command printed is not a string
 *   written here: it is the adapter's own `login` launch, the same value the pty
 *   supervisor will be handed when setup drives the login itself. Reading it out
 *   of the seam is what keeps the sentence true when a provider changes its
 *   subcommand, and it is the exact place the login step slots in.
 * - **Pairing the local server (AGX-75).** In `--role=both` the hub still dials
 *   its own server over the loopback, so a pairing has to exist. The token is in
 *   the identity file, named and not printed, which is where it stays until
 *   setup writes both ends itself.
 */
function whatIsLeft(
  outcome: SetupOutcome,
  providers: ProviderRegistry,
  machine: SetupMachine,
): readonly string[] {
  const lines: string[] = [];
  const server = outcome.server;

  // The first store that resolved. A login writes its credentials into the store
  // the sessions will run against, so there has to be one to name; a server with
  // no store yet gets the sentence without the command rather than a command
  // that would put the credentials somewhere nothing reads.
  let store: StoreDescriptor | null = null;
  for (const identified of server?.stores ?? []) {
    if (identified.ok && store === null) store = identified.store;
  }

  for (const provider of server?.providers ?? []) {
    if (provider.authState !== 'unauthenticated') continue;

    const found = providers.lookup(provider.provider);
    const command = found.ok && store !== null ? loginCommand(found.adapter, store, machine) : null;

    lines.push(
      command === null
        ? `${provider.provider} is installed and not logged in. Log it in before starting a session.`
        : `${provider.provider} is installed and not logged in. Run: ${command}`,
    );
  }

  if (outcome.role === 'both') {
    lines.push(
      'The hub dials its own server over the loopback, so this machine still has to be ' +
        `paired: the pairing token is in ${server?.identity.path ?? 'the identity file'}.`,
    );
  }

  if (outcome.hub !== null) {
    // Neither is in a plan, deliberately — a client token is the one credential
    // between the internet and every session on every paired machine, and a plan
    // is a file that travels. Saying so is better than a machine that provisions
    // cleanly and then will not start.
    lines.push(
      'The hub needs a database file and a client token to start. Both are configuration ' +
        'with no default, and neither is carried in a plan.',
    );
  }

  return lines;
}

/** The provider's own login, as the provider states it. Never a sentence written here. */
function loginCommand(
  adapter: ProviderAdapter,
  store: StoreDescriptor,
  machine: SetupMachine,
): string | null {
  // The home directory and not the store: a launch is refused for a working
  // directory inside the store it is run against, and a login still has to open
  // its pty somewhere.
  const launch = adapter.provisioning.login({ store, cwd: machine.home });
  return launch.ok ? [launch.plan.command, ...launch.plan.args].join(' ') : null;
}

/**
 * The last screen: the plan, as a file, if the operator wants one.
 *
 * Offered rather than assumed, and never over an existing file. A plan may carry
 * a pre-minted pairing token, so a file at that path is somebody's artifact
 * until they say otherwise; `createFile` is exclusive in the kernel and this
 * asks for another path rather than clobbering. The wizard's own plan carries no
 * token, which is why saving it is a safe thing to offer at all.
 */
async function offerToSave(
  plan: string,
  { terminal, machine, files }: SetupWizardDependencies,
): Promise<void> {
  terminal.write(
    'A saved plan replays this machine unattended: agentplexd setup --plan <file>, in ' +
      'cloud-init or an image.',
  );

  const wanted = await askYesNo(terminal, 'Save this plan to a file?', false);
  if (wanted.kind === 'ended' || !wanted.value) return;

  let offer = join(machine.home, OWNED_PREFIX_DIRECTORY, PLAN_FILE_NAME);
  for (;;) {
    const path = await askText(terminal, 'Save it as', offer);
    if (path.kind === 'ended') return;

    // The directory the operator just named, because naming a file to save is
    // asking for the file to be there. A failure to make it is reported by the
    // write that follows, in the words of the write that failed.
    await machine.makeDirectory(dirname(path.value));

    const created = await files.createFile(path.value, plan);
    if (created.kind === 'created') {
      terminal.write(`Saved ${path.value}`);
      return;
    }

    terminal.write(
      created.kind === 'exists'
        ? `There is already a file at ${path.value}, and it was left alone.`
        : `Cannot write ${path.value}: ${created.reason}`,
    );

    const again = await askYesNo(terminal, 'Try another path?', true);
    if (again.kind === 'ended' || !again.value) return;
    offer = path.value;
  }
}
