import type { Provider, StoreDescriptor } from '@agentplex/protocol';
import {
  type ProcessRunner,
  providerAuthStateOperation,
  runSetupOperation,
  type Launch,
  type ProviderRegistry,
} from '@agentplex/providers';
import type { PtySupervisor } from '../server/pty-supervisor.js';
import { askYesNo, type SetupTerminal } from './setup-terminal.js';

/**
 * Logging a provider in, by running the provider's own login on a pty.
 *
 * **There is no way to avoid an interactive step.** These logins are browser
 * OAuth flows, and on a headless LXC that means a URL opened somewhere else and
 * a code pasted back. Setup is already a terminal program, so it can host that
 * exchange rather than ending with a machine that is provisioned and cannot
 * start a session.
 *
 * **It goes through the pty supervisor, which is the point rather than a
 * convenience.** Driving an agent's TUI over a pty is what agentplex does, so
 * this path exercises the seam every session depends on — the same supervisor,
 * the same environment scrub, the same launch the adapter builds for a session
 * with different argv. A login run through a pipe would look like it worked and
 * would sit forever on a prompt it never drew, because a TUI that asks `isTTY`
 * and gets no turns its prompt and half its output off.
 *
 * **The exit code is not the answer, and is deliberately not read.** What the
 * rest of the system acts on is the authentication probe: the preflight reads
 * it, `doctor` reports it, and a session that will not start fails on it. So
 * after the login ends this asks the provider the same question the apply path
 * asked before it, through the same operation and the same runner. A login that
 * exits 0 having been cancelled at the browser, and one that exits nonzero
 * having already written its credentials, are both facts the probe gets right
 * and an exit code gets wrong.
 *
 * **Everything that cannot be driven is reported and named.** A store that never
 * resolved, an adapter that refuses the launch, a pty that will not open, an
 * input that is a pipe rather than a person: each ends with the state as it
 * actually is and the command to run by hand. "Installed, not logged in" is a
 * worse outcome than logged in and a far better one than silence followed by a
 * session that will not start.
 */

export interface ProviderLoginRequest {
  readonly provider: Provider;
  /**
   * The store the credentials have to land in, or `null` when none resolved.
   *
   * Not optional and not defaulted. A login that writes into whichever home
   * directory setup happens to run as leaves the store the sessions will run
   * against exactly as logged out as it was, and nothing says so.
   */
  readonly store: StoreDescriptor | null;
  /**
   * Where the pty opens. The operator's home, never the store: a launch is
   * refused for a working directory inside the store it runs against, and a
   * login still has to open its terminal somewhere.
   */
  readonly cwd: string;
}

export interface ProviderLoginDependencies {
  readonly terminal: SetupTerminal;
  /**
   * The pty seam, already carrying the directories the plan named.
   *
   * The same composition the server's supervisor gets, so the `claude` that is
   * logged in is the `claude` that will run — which is the whole of the adoption
   * rule, applied to the one operation that changes a provider's state.
   */
  readonly supervisor: PtySupervisor;
  readonly providers: ProviderRegistry;
  /** The one-shot seam the re-probe runs through. The apply path's own runner. */
  readonly runner: ProcessRunner;
}

export type ProviderLogin =
  /** The login ran, and the provider now says it is logged in. */
  | { readonly kind: 'logged-in' }
  /**
   * The login ran, and the provider does not say it is logged in.
   *
   * `problem` is the probe's own words when it could not answer at all, and
   * `null` when it answered plainly that the provider is logged out. The two are
   * different facts: a `claude` behind a corporate wrapper that prints nothing a
   * parser recognises is not a `claude` somebody failed to log into.
   */
  | {
      readonly kind: 'not-logged-in';
      readonly problem: string | null;
      readonly command: string | null;
    }
  /** The login could not be driven here. `problem` says why. */
  | { readonly kind: 'not-driven'; readonly problem: string; readonly command: string | null }
  /** The operator said not now. Nothing was run. */
  | { readonly kind: 'not-now'; readonly command: string | null };

export async function offerProviderLogin(
  request: ProviderLoginRequest,
  dependencies: ProviderLoginDependencies,
): Promise<ProviderLogin> {
  const { terminal } = dependencies;
  const planned = planProviderLogin(request, dependencies.providers);
  if (!planned.ok) return { kind: 'not-driven', problem: planned.problem, command: null };

  const { command } = planned;

  terminal.write('');
  terminal.write(
    `${request.provider} is installed and not logged in. Setup can run its own login here: ` +
      `${command} takes this terminal until it ends.`,
  );

  // Offered rather than assumed. A login opens a browser flow and holds the
  // terminal, and an operator part-way through installing a fleet is entitled to
  // do it later; the answer is yes because a setup that finishes with the
  // providers logged in is what the whole run is for. An input that ended is
  // the same answer as "not now" — there is nobody to drive a login either way.
  const now = await askYesNo(terminal, `Log ${request.provider} in now?`, true);
  if (now.kind === 'ended' || !now.value) return { kind: 'not-now', command };

  const started = dependencies.supervisor.launch(planned.launch);
  if (!started.ok) return { kind: 'not-driven', problem: started.problem, command };

  terminal.write('');
  const attached = await terminal.attach(started.run);

  if (attached.kind !== 'ended') {
    // Killed rather than left running. A login nobody is at is a child holding a
    // pty on a prompt that will never be answered, and setup is about to exit
    // and stop being anybody's parent.
    started.run.kill();
    if (attached.kind === 'unavailable') {
      return { kind: 'not-driven', problem: attached.problem, command };
    }
  }

  terminal.write('');
  return await reprobe(request.provider, command, dependencies);
}

/**
 * What the provider says about itself now, which is the only answer that counts.
 *
 * Run even when the operator walked away from the login, because "did that work"
 * is not a question setup gets to guess at: a flow finished in a browser writes
 * its credentials whether or not anybody came back to the terminal.
 */
async function reprobe(
  provider: Provider,
  command: string | null,
  { runner, providers }: ProviderLoginDependencies,
): Promise<ProviderLogin> {
  const probed = await runSetupOperation(
    providerAuthStateOperation,
    { provider },
    runner,
    providers,
  );

  if (!probed.ok) return { kind: 'not-logged-in', problem: probed.problem, command };
  return probed.result === 'authenticated'
    ? { kind: 'logged-in' }
    : { kind: 'not-logged-in', problem: null, command };
}

type PlannedLogin =
  | { readonly ok: true; readonly launch: Launch; readonly command: string }
  | { readonly ok: false; readonly problem: string };

/**
 * The provider's own login, as the provider states it.
 *
 * The command that gets printed is never a sentence written here: it is the
 * argv of the launch that would have been run, so what setup drives and what it
 * tells an operator to type cannot drift, and neither of them changes when a
 * provider renames its subcommand.
 */
export function planProviderLogin(
  request: ProviderLoginRequest,
  providers: ProviderRegistry,
): PlannedLogin {
  const found = providers.lookup(request.provider);
  if (!found.ok) return { ok: false, problem: found.problem };

  if (request.store === null) {
    return {
      ok: false,
      problem:
        'no store on this server resolved, and a login has to write its credentials into ' +
        'the store the sessions will run against',
    };
  }

  const launch = found.adapter.provisioning.login({ store: request.store, cwd: request.cwd });
  if (!launch.ok) return { ok: false, problem: launch.problem };

  return { ok: true, launch, command: [launch.plan.command, ...launch.plan.args].join(' ') };
}

/**
 * What to tell the operator, in the state the machine is actually in.
 *
 * One line for what is true and, where there is one, the reason it is not
 * something better. The command is printed in every case that is not "logged
 * in", because a machine that ends "installed, not logged in" is one somebody
 * can finish by hand in a second — and the alternative is a session that will
 * not start with nothing pointing at why.
 */
export function describeProviderLogin(provider: Provider, login: ProviderLogin): readonly string[] {
  if (login.kind === 'logged-in') return [`${provider} is logged in.`];

  const notLoggedIn = `${provider} is installed and not logged in.`;
  const run =
    login.command === null ? 'Log it in before starting a session.' : `Run: ${login.command}`;

  if (login.kind === 'not-now') return [`${notLoggedIn} ${run}`];

  if (login.kind === 'not-driven') {
    return [`${notLoggedIn} Setup could not run the login here: ${login.problem}`, run];
  }

  return login.problem === null
    ? [`${notLoggedIn} The login ran and it still reports itself logged out.`, run]
    : [`${notLoggedIn} The login ran and it would not say: ${login.problem}`, run];
}
