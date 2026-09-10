import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Provider, StoreDescriptor } from '@agentplex/protocol';
import { DEFAULT_HUB_PORT, DEFAULT_SERVER_PORT, ROLES, type Role } from '../config/config.js';
import type { ProcessRunner, ProviderRegistry, StoreFileSystem } from '@agentplex/providers';
import type { PtySupervisor } from '@agentplex/pty';
import type { Clock, IdGenerator, TokenMinter } from '@agentplex/node-shared';
import { applySetupPlan, type SetupOutcome } from './apply-setup-plan.js';
import { describeOutcome } from './describe-outcome.js';
import { LOCAL_SERVER_SETTINGS, SETTINGS_FILE_NAME, upsertSettings } from './settings-file.js';
import { describeProviderLogin, offerProviderLogin } from './provider-login.js';
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
/** The spelling of "do not pair this machine", for an operator who will do it themselves. */
const NO_SETTINGS_FILE = 'none';

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
  /**
   * The pty seam, built from the same directories the one-shot runner gets.
   *
   * A factory for the same reason `runnerFor` is one, and composed the same way
   * the server's own supervisor is composed in the entrypoint: the `claude` that
   * gets logged in has to be the `claude` that will run, or the login writes
   * credentials for a binary nothing starts. This is the only thing in setup
   * that opens a pty, and it is here because a login is a TUI.
   */
  readonly supervisorFor: (binPath: readonly string[]) => PtySupervisor;
  readonly providersFor: (runner: ProcessRunner) => ProviderRegistry;
  readonly files: StoreFileSystem;
  readonly ids: IdGenerator;
  readonly tokens: TokenMinter;
  readonly clock: Clock;
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

  // Everything from here on runs against the machine the plan describes rather
  // than the one the survey found: the binaries resolve in the directories the
  // plan named, which is what makes a login log in the copy that will run.
  const binPath = setupBinPath(plan.plan);
  const runner = dependencies.runnerFor(binPath);
  const provisioned = dependencies.providersFor(runner);
  const outcome = await applySetupPlan(plan.plan, {
    runner,
    providers: provisioned,
    files: dependencies.files,
    ids: dependencies.ids,
    tokens: dependencies.tokens,
  });

  terminal.write('');
  for (const line of describeOutcome(outcome)) terminal.write(line);
  for (const problem of outcome.problems) terminal.write(`problem: ${problem}`);

  // The one step that runs after the plan has been applied, because it can only
  // be taken against a provider that is on the machine — and the one step that
  // needs a person, which is what keeps it on this front end and out of a replay.
  const logins = await logInProviders(
    outcome,
    { runner, providers: provisioned, binPath },
    dependencies,
  );

  terminal.write('');
  for (const line of logins) terminal.write(line);

  // The other step that can only be taken after the plan has been applied: the
  // token to pair with is the one the apply path just wrote, and this reads it
  // back rather than minting a second.
  const recorded = await recordLocalServer(outcome, dependencies);
  if (recorded.kind === 'ended') return { kind: 'no-input' };

  terminal.write('');
  for (const line of [...recorded.value.lines, ...whatIsLeft(outcome)]) {
    terminal.write(line);
  }

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
 * The provisioned machine, as the login step needs to see it.
 *
 * The runner and the registry are the ones the apply path used, so the re-probe
 * after a login is the same question through the same seam that decided the
 * provider was logged out in the first place — and the answer is comparable
 * rather than merely similar. `binPath` is what the supervisor's environment is
 * composed from, so the `claude` that is driven is the `claude` that will run.
 */
interface Provisioned {
  readonly runner: ProcessRunner;
  readonly providers: ProviderRegistry;
  readonly binPath: readonly string[];
}

/**
 * Every provider the plan left logged out, offered its own login on a pty.
 *
 * This is where the wizard stops describing the machine and finishes it. A
 * provider that is installed and logged out is a session that will not start,
 * and the only thing that can fix it is the provider's own browser OAuth flow —
 * which needs a terminal, which setup is. Everything about *how* is in
 * `provider-login.ts`; what is here is which providers to offer it for, and the
 * store their credentials have to land in.
 *
 * A provider whose state could not be read is deliberately not offered a login.
 * `authState` is `null` when the probe would not answer — a wrapper in front of
 * `claude`, a release that stopped printing what the parser reads — and sending
 * an operator through a login for a binary whose problem is something else
 * entirely would be inventing a diagnosis. The apply path has already reported
 * that as a problem in its own words.
 */
async function logInProviders(
  outcome: SetupOutcome,
  provisioned: Provisioned,
  dependencies: SetupWizardDependencies,
): Promise<readonly string[]> {
  const server = outcome.server;
  if (server === null) return [];

  // The first store that resolved. A login writes its credentials into the store
  // the sessions will run against, so there has to be one to name; a server with
  // no store yet is told so rather than handed a command that would put the
  // credentials somewhere nothing reads.
  let store: StoreDescriptor | null = null;
  for (const identified of server.stores) {
    if (identified.ok && store === null) store = identified.store;
  }

  const lines: string[] = [];
  // One at a time, in the plan's order: two logins at once is two TUIs drawing
  // on one terminal, and there is one operator.
  for (const provider of server.providers) {
    if (provider.authState !== 'unauthenticated') continue;

    const login = await offerProviderLogin(
      { provider: provider.provider, store, cwd: dependencies.machine.home },
      {
        terminal: dependencies.terminal,
        supervisor: dependencies.supervisorFor(provisioned.binPath),
        providers: provisioned.providers,
        runner: provisioned.runner,
      },
    );
    lines.push(...describeProviderLogin(provider.provider, login));
  }

  return lines;
}

/** The recording step's own report, and whether this machine's server was recorded. */
interface LocalServerStep {
  readonly lines: readonly string[];
  readonly recorded: boolean;
}

/**
 * Recording the local server: the one pairing nobody types.
 *
 * In `--role=both` the hub dials its own server over the loopback, so a pairing
 * has to exist. Setup writes files and opens no database, so what it writes is
 * the two settings that tell the hub where the server's identity file is and
 * which port it binds; the hub reads the token off that file at its next boot
 * and writes its own end. It is a deliberate, narrow exception to "pairing is
 * always the user typing that server's token into the hub", and the hub's
 * `pairing/local-server.ts` carries the argument and every bound.
 *
 * Two things are decided here rather than there, because both are about a person
 * being present.
 *
 * **The operator names the hub.** The settings file is the one the installer
 * wrote, in the prefix setup already owns, so there is a location to offer;
 * confirming it is the operator saying which hub this machine belongs to, which
 * is the act the typed-token rule exists to require. `none` leaves the machine
 * unpaired and is a legitimate answer.
 *
 * **A failure costs itself.** A settings file that cannot be written is reported
 * and the run carries on: a machine that is provisioned and unpaired is one
 * somebody can finish by hand, and a run that exited over it would have thrown
 * away the providers it just installed.
 */
async function recordLocalServer(
  outcome: SetupOutcome,
  dependencies: SetupWizardDependencies,
): Promise<Asked<LocalServerStep>> {
  const { terminal, machine } = dependencies;
  const server = outcome.server;
  if (outcome.role !== 'both' || server === null) {
    return { kind: 'answered', value: { lines: [], recorded: false } };
  }

  const identity = server.identity;
  if (identity.problem !== null) {
    return {
      kind: 'answered',
      value: {
        lines: [`This machine was not recorded for the hub: ${identity.problem}`],
        recorded: false,
      },
    };
  }

  terminal.write('');
  terminal.write(
    'The hub on this machine dials the server on it over the loopback, so the two have to be ' +
      "paired. Setup can record the server in the hub's settings here, and the hub pairs it " +
      `from the token already in ${identity.path} when it starts, so that nobody has to ` +
      'hand-pair their own box.',
  );

  const path = await askForSettingsFile(machine.home, terminal);
  if (path.kind === 'ended') return path;
  if (path.value === null) {
    return { kind: 'answered', value: { lines: [notRecorded(identity.path)], recorded: false } };
  }

  // The directory the operator just named, because naming a file to write is
  // asking for the file to be there.
  await machine.makeDirectory(dirname(path.value));

  const existing = await machine.readFile(path.value);
  if (existing.kind === 'failed') {
    return {
      kind: 'answered',
      value: {
        lines: [`This machine was not recorded: cannot read ${path.value}: ${existing.reason}`],
        recorded: false,
      },
    };
  }

  const written = await machine.writeFile(
    path.value,
    upsertSettings(existing.kind === 'read' ? existing.contents : null, [
      { key: LOCAL_SERVER_SETTINGS.identityFile.env, value: identity.path },
      { key: LOCAL_SERVER_SETTINGS.port.env, value: String(server.port) },
    ]),
  );
  if (!written.ok) {
    return {
      kind: 'answered',
      value: {
        lines: [`This machine was not recorded: cannot write ${path.value}: ${written.problem}`],
        recorded: false,
      },
    };
  }

  return {
    kind: 'answered',
    value: {
      lines: describeLocalServer(path.value, identity.path, server.port),
      recorded: true,
    },
  };
}

/** The settings file to record the server in, or `null` for a machine to leave unpaired. */
async function askForSettingsFile(
  home: string,
  terminal: SetupTerminal,
): Promise<Asked<string | null>> {
  let offer = join(home, OWNED_PREFIX_DIRECTORY, SETTINGS_FILE_NAME);

  for (;;) {
    const answered = await askText(
      terminal,
      `Hub settings file (${NO_SETTINGS_FILE} to leave this machine unpaired)`,
      offer,
    );
    if (answered.kind === 'ended') return answered;
    if (answered.value === NO_SETTINGS_FILE) return { kind: 'answered', value: null };

    // Refused rather than resolved against wherever setup was started, for the
    // reason every other path in a setup run is: the hub is started by a unit
    // file from a directory nobody chose, and a settings file that moves with
    // the working directory is a hub that quietly comes up unpaired.
    if (isAbsolute(answered.value)) return { kind: 'answered', value: resolve(answered.value) };

    terminal.write(`The settings file has to be an absolute path: ${answered.value}`);
    offer = answered.value;
  }
}

/**
 * The recording step as lines a person reads.
 *
 * The file is named, the address is named, and the token is neither printed nor
 * asked for: what setup is allowed to say about a pairing is part of the same
 * argument as what it is allowed to do.
 */
function describeLocalServer(
  settingsPath: string,
  identityPath: string,
  port: number,
): readonly string[] {
  return [
    `Recorded the server on this machine in ${settingsPath}: a hub started from those ` +
      `settings pairs it at boot, dialling ws://127.0.0.1:${port} with the token in ` +
      `${identityPath}. No token was typed, and none was printed.`,
    // The one way this arrangement fails silently: a hub started without these
    // settings reads, from the hub, as a machine that is not there. Naming the
    // flags costs a line and is the whole of the fix.
    `Start the hub from that file (the unit reads it as its EnvironmentFile), or pass ` +
      `${LOCAL_SERVER_SETTINGS.identityFile.flag} ${identityPath} ` +
      `${LOCAL_SERVER_SETTINGS.port.flag} ${port}.`,
  ];
}

/** The sentence that was true before setup could record anything, kept for when it does not. */
function notRecorded(identityPath: string): string {
  return (
    'The hub dials its own server over the loopback, so this machine still has to be ' +
    `paired: the pairing token is in ${identityPath}.`
  );
}

/**
 * What this machine still needs, after the plan has been applied, the providers
 * have been offered their logins and the local server has been offered its
 * pairing.
 */
function whatIsLeft(outcome: SetupOutcome): readonly string[] {
  if (outcome.hub === null) return [];

  // Neither a client token nor a database file is in a plan, deliberately — a
  // client token is the one credential between the internet and every session on
  // every paired machine, and a plan is a file that travels. Saying so is better
  // than a machine that provisions cleanly and then will not start.
  return [
    'The hub needs a database file and a client token to start. Both are configuration ' +
      'with no default, and neither is carried in a plan.',
  ];
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
