import { readFileSync } from 'node:fs';
import { storeIdSchema, type StoreDescriptor } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import {
  createFakeProcessProbe,
  createFakeProviderFiles,
  providerFixturePath,
} from '@agentplex/providers/testing';
import {
  describeProcessRequest,
  type ProcessOutcome,
  type ProcessRequest,
  type ProcessRunner,
  createClaudeAdapter,
  createProviderRegistry,
} from '@agentplex/providers';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { type Pty, type PtyFactory, type PtyRequest, createPtySupervisor } from '@agentplex/pty';
import { createFakeTerminal, type FakeTerminal } from './fake-terminal.js';
import { describeProviderLogin, offerProviderLogin, type ProviderLogin } from './provider-login.js';

/**
 * The login step: a provider's own sign-in, driven on a pty, and then asked
 * again whether it worked.
 *
 * The two things this file is about are the ones the ticket is about.
 *
 * **The pty is the mechanism and not an implementation detail.** These logins
 * are browser OAuth flows, so a person has to be in the loop; a TUI on a pipe
 * turns its prompt off and would sit forever on a question it never drew. So the
 * assertions are that the login went to the supervisor as a launch, that its
 * bytes reached the operator, and that the operator's keystrokes reached it.
 *
 * **The probe is the truth, and the exit code is not consulted.** What decides
 * whether this machine ends up logged in is the same `claude auth status --json`
 * the apply path ran before the login, run again afterwards. A login that exits
 * 0 having been cancelled at the browser and one that exits nonzero having
 * already written its credentials are both facts the probe gets right.
 */

function fixture(name: string): string {
  return readFileSync(providerFixturePath(name), 'utf8');
}

const HOME = '/home/dev';
const STORE: StoreDescriptor = {
  storeId: storeIdSchema.parse('store-under-test'),
  path: `${HOME}/.claude`,
};

const AUTH_ARGV = 'claude auth status --json';
const LOGGED_IN: ProcessOutcome = {
  kind: 'exited',
  exitCode: 0,
  stdout: fixture('claude-auth-status-logged-in.json'),
  stderr: '',
};
/**
 * Captured with the exit code it really comes with: 2.1.259 exits 1 while
 * printing the answer. A reader that refused on a nonzero exit would turn every
 * logged-out provider into "the probe could not run".
 */
const LOGGED_OUT: ProcessOutcome = {
  kind: 'exited',
  exitCode: 1,
  stdout: fixture('claude-auth-status-logged-out.json'),
  stderr: '',
};

/**
 * A machine a login changes.
 *
 * The same idea as `fake-machine.ts`'s installer: what has to be observable is
 * that the answer to "are you logged in" is different after the login ran than
 * before it, and that is only observable on a machine whose state can change.
 * Here the change is caused by the thing that really causes it — a child
 * starting on a pty — rather than by a sequence of answers a test wrote down,
 * so a login that is never launched never flips it.
 */
function machineWhoseLoginWorks(options: {
  readonly succeeds: boolean;
  /**
   * Whether the login ends on its own. It does not in the two cases where the
   * operator's terminal came back first, which is what makes those the cases
   * where a child would otherwise be left holding a pty nobody is at.
   */
  readonly ends: boolean;
}): {
  readonly runner: ProcessRunner;
  readonly pty: PtyFactory;
  readonly fake: FakePtyFactory;
  readonly requests: readonly ProcessRequest[];
} {
  const fake = createFakePtyFactory({
    child: {
      prints: 'Paste the code: ',
      ...(options.ends ? { exit: { exitCode: 0, signal: null } } : {}),
    },
  });
  const requests: ProcessRequest[] = [];
  let loggedIn = false;

  return {
    fake,
    requests,
    pty: {
      open(request: PtyRequest): Pty {
        const opened = fake.open(request);
        if (options.succeeds) loggedIn = true;
        return opened;
      },
    },
    runner: {
      async run(request: ProcessRequest): Promise<ProcessOutcome> {
        requests.push(request);
        if (describeProcessRequest(request) !== AUTH_ARGV) {
          return { kind: 'failed', problem: `no such program: ${request.file}` };
        }
        return loggedIn ? LOGGED_IN : LOGGED_OUT;
      },
    },
  };
}

function providerRegistry() {
  return createProviderRegistry([
    createClaudeAdapter({ files: createFakeProviderFiles(), probe: createFakeProcessProbe({}) }),
  ]);
}

interface Attempt {
  readonly login: ProviderLogin;
  readonly terminal: FakeTerminal;
  readonly fake: FakePtyFactory;
  readonly requests: readonly ProcessRequest[];
}

async function offer(
  options: {
    readonly succeeds?: boolean;
    readonly answers?: readonly string[];
    readonly keystrokes?: readonly string[];
    readonly notATerminal?: string;
    readonly abandons?: boolean;
    readonly store?: StoreDescriptor | null;
    readonly runner?: ProcessRunner;
    readonly pty?: PtyFactory;
  } = {},
): Promise<Attempt> {
  const machine = machineWhoseLoginWorks({
    succeeds: options.succeeds ?? true,
    // A login the operator's terminal came back from first is one still running.
    ends: options.abandons !== true && options.notATerminal === undefined,
  });
  const terminal = createFakeTerminal({
    // One empty line: the offer to log in, taken.
    answers: options.answers ?? [''],
    ...(options.keystrokes === undefined ? {} : { keystrokes: options.keystrokes }),
    ...(options.notATerminal === undefined ? {} : { notATerminal: options.notATerminal }),
    ...(options.abandons === undefined ? {} : { abandons: options.abandons }),
  });

  const login = await offerProviderLogin(
    {
      provider: 'claude',
      store: options.store === undefined ? STORE : options.store,
      cwd: HOME,
    },
    {
      terminal,
      supervisor: createPtySupervisor({
        pty: options.pty ?? machine.pty,
        clock: { now: () => 1_700_000_000_000 },
        ids: { newId: () => 'login-run' },
        environment: { PATH: '/opt/homebrew/bin' },
      }),
      providers: providerRegistry(),
      runner: options.runner ?? machine.runner,
    },
  );

  return { login, terminal, fake: machine.fake, requests: machine.requests };
}

describe('offerProviderLogin', () => {
  it('drives the provider own login on a pty and reports what the probe says afterwards', async () => {
    const attempt = await offer();

    expect(attempt.login).toEqual({ kind: 'logged-in' });
    // The argv is the adapter's, not a string this test or the wizard wrote.
    expect(attempt.fake.opened.map((request) => [request.command, ...request.args])).toEqual([
      ['claude', 'auth', 'login'],
    ]);
  });

  it('runs the login in the store the sessions will run against', async () => {
    // A login that writes into whichever home directory setup happens to run as
    // leaves the store exactly as logged out as it was, and nothing says so.
    const attempt = await offer();

    expect(attempt.fake.opened[0]?.env['CLAUDE_CONFIG_DIR']).toBe(STORE.path);
    // And the working directory is the home, never the store: a launch is
    // refused for a cwd inside the store it runs against.
    expect(attempt.fake.opened[0]?.cwd).toBe(HOME);
  });

  it('scrubs the nested-run markers out of the login, exactly as a session is', async () => {
    // A `claude` that inherits CLAUDECODE decides it is a nested run. Sharing
    // one launch builder with the session path is what makes this true for free.
    const attempt = await offer();

    expect(attempt.fake.opened[0]?.env).not.toHaveProperty('CLAUDECODE');
    expect(attempt.fake.opened[0]?.env['PATH']).toBe('/opt/homebrew/bin');
  });

  it('carries the login output to the operator and their keystrokes back to it', async () => {
    // The whole of what hosting the exchange means: a URL is printed somewhere
    // the operator can read it, and the code they paste reaches the child.
    const attempt = await offer({ keystrokes: ['a-code-from-the-browser\r'] });

    expect(attempt.terminal.attachedOutput.join('')).toContain('Paste the code: ');
    expect(attempt.fake.last?.written).toEqual(['a-code-from-the-browser\r']);
  });

  it('asks the provider again rather than believing the login exit code', async () => {
    // A login that exits 0 having been cancelled at the browser is the case
    // this is for. The pty says it ended cleanly; the probe says logged out, and
    // the probe is what the preflight, `doctor` and the first session read.
    const attempt = await offer({ succeeds: false });

    expect(attempt.login).toEqual({
      kind: 'not-logged-in',
      problem: null,
      command: 'claude auth login',
    });
    expect(attempt.requests.map(describeProcessRequest)).toEqual([AUTH_ARGV]);
  });

  it('reports a probe that would not answer as its own fact, never as a logout', async () => {
    // A wrapper in front of `claude`, a release that stopped printing what the
    // parser reads. Reporting that as "still logged out" would send an operator
    // through the login again for a problem that is something else entirely.
    const attempt = await offer({
      runner: {
        async run(): Promise<ProcessOutcome> {
          return { kind: 'exited', exitCode: 0, stdout: 'Corporate SSO required\n', stderr: '' };
        },
      },
    });

    expect(attempt.login.kind).toBe('not-logged-in');
    if (attempt.login.kind !== 'not-logged-in') return;
    expect(attempt.login.problem).toContain('did not report its authentication state');
  });

  it('leaves the provider alone when the operator says not now, and prints what to run', async () => {
    const attempt = await offer({ answers: ['n'] });

    expect(attempt.login).toEqual({ kind: 'not-now', command: 'claude auth login' });
    expect(attempt.fake.opened).toEqual([]);
    // Nothing was asked about the machine either: an offer declined runs nothing.
    expect(attempt.requests).toEqual([]);
  });

  it('takes the input ending as not now rather than driving a login nobody is at', async () => {
    const attempt = await offer({ answers: [] });

    expect(attempt.login).toEqual({ kind: 'not-now', command: 'claude auth login' });
    expect(attempt.fake.opened).toEqual([]);
  });

  it('refuses to drive a login with no store to write its credentials into', async () => {
    // Reported before anything is offered, because there is nothing to offer:
    // there is no such thing as a login that lands nowhere.
    const attempt = await offer({ store: null });

    expect(attempt.login.kind).toBe('not-driven');
    if (attempt.login.kind !== 'not-driven') return;
    expect(attempt.login.problem).toContain('no store on this server resolved');
    expect(attempt.login.command).toBeNull();
    expect(attempt.terminal.questions).toEqual([]);
  });

  it('reports a pty that will not open in the machine own words, and what to run instead', async () => {
    // `posix_spawnp failed.` out of a native addon, with no path and no errno.
    const attempt = await offer({
      pty: createFakePtyFactory({ failsToOpen: 'posix_spawnp failed.' }),
    });

    expect(attempt.login).toEqual({
      kind: 'not-driven',
      problem: 'cannot start claude: posix_spawnp failed.',
      command: 'claude auth login',
    });
  });

  it('says so rather than hanging a login on an input that is not a terminal', async () => {
    // `printf '\\n\\n' | agentplexd setup`. There is a wizard, because its
    // answers arrived on stdin, and there is nobody to answer an OAuth prompt.
    const attempt = await offer({ notATerminal: 'this input is not a terminal' });

    expect(attempt.login).toEqual({
      kind: 'not-driven',
      problem: 'this input is not a terminal',
      command: 'claude auth login',
    });
    // And the child it started is not left holding a pty nobody is at.
    expect(attempt.fake.last?.kills).toBe(1);
  });

  it('kills a login the operator walked away from, and still asks how it went', async () => {
    // An ssh session that dropped mid-flow. The flow may well have finished in
    // the browser, so the probe is still the question worth asking; what must
    // not happen is a `claude auth login` outliving the setup that started it.
    const attempt = await offer({ abandons: true });

    expect(attempt.login).toEqual({ kind: 'logged-in' });
    expect(attempt.fake.last?.kills).toBe(1);
  });
});

describe('describeProviderLogin', () => {
  it('says the provider is logged in and asks nothing more of anybody', () => {
    expect(describeProviderLogin('claude', { kind: 'logged-in' })).toEqual([
      'claude is logged in.',
    ]);
  });

  it('names the command for a provider the operator will log in later', () => {
    // AGX-73's sentence, kept: it was already true, and it is the one a person
    // can act on in a second.
    expect(
      describeProviderLogin('claude', { kind: 'not-now', command: 'claude auth login' }),
    ).toEqual(['claude is installed and not logged in. Run: claude auth login']);
  });

  it('separates a login that could not be run from one that ran and did not work', () => {
    const notDriven = describeProviderLogin('claude', {
      kind: 'not-driven',
      problem: 'this input is not a terminal',
      command: 'claude auth login',
    });
    const ranAndFailed = describeProviderLogin('claude', {
      kind: 'not-logged-in',
      problem: null,
      command: 'claude auth login',
    });

    expect(notDriven[0]).toContain('could not run the login here: this input is not a terminal');
    expect(ranAndFailed[0]).toContain('The login ran and it still reports itself logged out.');
    expect(notDriven.at(-1)).toBe('Run: claude auth login');
    expect(ranAndFailed.at(-1)).toBe('Run: claude auth login');
  });

  it('tells an operator with no command to run to log it in before starting a session', () => {
    // The store-less case: there is no honest command to print, because a login
    // with nowhere to land is not a command anybody should be told to type.
    expect(
      describeProviderLogin('claude', {
        kind: 'not-driven',
        problem: 'no store on this server resolved',
        command: null,
      }).at(-1),
    ).toBe('Log it in before starting a session.');
  });
});
