import type {
  Provider,
  SessionId,
  SessionRef,
  SessionStatus,
  StoreDescriptor,
} from '@agentplex/protocol';
import type { Argv } from '../operations/operation.js';
import type { CompletedProcess } from '../operations/process-runner.js';
import type { FileRead } from '../store-identity.js';

/**
 * The provider seam.
 *
 * A provider is a coding-agent CLI: Claude Code today, codex and opencode
 * later. Everything that differs between them lives behind this interface —
 * where transcripts sit under a store, what a transcript says, which argv
 * resumes a session, which environment variables must not reach the child.
 * Everything above it deals in `{ storeId, sessionId }`, a `Provider` name and
 * a `SessionStatus`, and learns nothing about any particular CLI.
 *
 * Two consequences are load-bearing:
 *
 * - The adapter knows its layout *within* the store; the store path is
 *   configuration. Callers hand over a `StoreDescriptor` and never build a
 *   path into a provider's directories themselves. That is what makes the
 *   second adapter a new file rather than an edit to the server.
 * - Nothing here returns a frame, and nothing here takes one. A launch plan is
 *   argv, and argv never crosses the wire: the operation registry turns a named
 *   operation into one of these, `shell: false` always.
 *
 * Adapters take their dependencies (a `ProviderFiles`, whatever else) at
 * construction rather than per call, so that a caller holding an adapter cannot
 * hand it a different store's filesystem by accident.
 */
export interface ProviderAdapter {
  /** The name this adapter answers to. The registry keys on it; nothing else may. */
  readonly provider: Provider;

  /**
   * Every session this provider has in the given store.
   *
   * Never throws for a session it cannot read: an unreadable transcript is a
   * problem in the answer, and the sessions either side of it are still
   * reported. A provider that is simply not present in this store discovers
   * nothing and complains about nothing.
   */
  discover(store: StoreDescriptor): Promise<ProviderDiscovery>;

  /**
   * How to start a new session in this store.
   *
   * There is no session id in the request. The provider mints its own id and
   * discovery finds it afterwards; agentplex naming the id up front would mean
   * `--session-id`, which is the flag family that forks sessions and silently
   * splits a history in two.
   */
  spawn(request: SpawnRequest): Launch;

  /** How to reattach to a session that already exists in this store. */
  resume(request: ResumeRequest): Launch;

  /**
   * What this session's state means right now.
   *
   * Pure, and given everything it needs: the adapter knows what its own
   * transcript signal means, the caller knows whether a process is alive and
   * what time it is. Neither reads the other's world, which is why this is a
   * function a test can call with four values and why it does not matter
   * whether it runs on the server or, later, anywhere else.
   */
  status(observation: StatusObservation): SessionStatus;

  /**
   * How this provider gets onto a machine, and how to tell what is already on
   * one.
   *
   * A property rather than four more methods, because provisioning is answered
   * once per adapter and never per store or per session: it is a constant of
   * the provider, and grouping it says so.
   */
  readonly provisioning: ProviderProvisioning;
}

export interface ProviderDiscovery {
  readonly sessions: readonly DiscoveredSession[];
  /**
   * What this adapter could not read. Present alongside the sessions rather
   * than replacing them: one corrupt transcript costs itself, never the
   * listing, and a store that reports nine of ten sessions must say so instead
   * of quietly reporting nine.
   */
  readonly problems: readonly DiscoveryProblem[];
}

export interface DiscoveredSession {
  /**
   * The provider's own id for the session, parsed out of the provider's own
   * files. There is no `storeId` here: the caller knows which store it asked
   * about and stamps it, so an adapter cannot file a session under the wrong
   * one.
   */
  readonly sessionId: SessionId;
  readonly signal: TranscriptSignal;
  /** Epoch ms, as the provider dated its own last write. */
  readonly updatedAt: number;
  /**
   * A live process for this session that the adapter itself verified.
   *
   * Providers keep their own process registries, and an adapter is the only
   * thing that knows where its provider's is and how to read it. Verified means
   * pid liveness *and* a start time consistent with what the entry recorded: a
   * registry entry is a claim, and these entries are never cleaned up.
   *
   * It is reported here rather than derived in `status` because finding out is
   * I/O — a directory to list and a kernel to ask — and `status` is pure. The
   * caller ors this with whatever it knows about processes it started itself,
   * and neither source has to know about the other.
   */
  readonly running: boolean;
  /**
   * Where the session was working, read out of the provider's own files.
   *
   * This is the adapter's answer and not the caller's, because the only place
   * the answer is reliable is inside the provider's format. Claude Code, for
   * one, names its per-project directory after an encoding of the cwd that
   * flattens `/` and `.` to the same character, so the directory name cannot be
   * decoded back into a path; the transcript records the cwd verbatim on every
   * entry. `null` when the provider does not say.
   */
  readonly cwd: string | null;
  /** What the provider calls this session, or `null` if it does not name it. */
  readonly title: string | null;
}

export interface DiscoveryProblem {
  /** What could not be read, in terms a person can act on: a path, an id. */
  readonly subject: string;
  readonly problem: string;
}

/**
 * What a provider's files alone claim, before liveness and elapsed time are
 * applied.
 *
 * This exists so `status` can be pure. Discovery reads the disk and can say
 * only what was written; whether that means "working" or "idle" additionally
 * depends on whether a process is alive and how long ago it was, which the
 * disk does not know. Splitting the two is what keeps every timing rule in one
 * testable function per provider.
 */
export type TranscriptSignal =
  /** The provider is stopped on a tool call the user has to approve. */
  | 'awaiting-permission'
  /** The provider asked the user something, or ended its turn. */
  | 'awaiting-input'
  /** The provider was mid-work as of the last thing it wrote. */
  | 'progressing'
  /** Nothing pending: the transcript just stops. */
  | 'quiet'
  /** The transcript parsed but says nothing this adapter recognises. */
  | 'unknown';

export interface StatusObservation {
  readonly signal: TranscriptSignal;
  /** Epoch ms of the provider's last write, from discovery. */
  readonly updatedAt: number;
  /**
   * Whether a process for this session is alive on this server, pid liveness
   * and spawn epoch already verified by the caller. A registry entry is not
   * evidence; a verified pid is.
   */
  readonly running: boolean;
  /** Epoch ms now, passed in rather than read, so elapsed time is a test's to set. */
  readonly now: number;
}

export interface SpawnRequest {
  readonly store: StoreDescriptor;
  /**
   * Where to run, resolved by the server from its own configuration.
   *
   * Not off the wire. No frame carries a cwd, because a `{ cwd }` field is a
   * remote code execution primitive wearing a path — whoever holds a client
   * token picks a directory and runs an agent with write access to it. A frame
   * names a store; the server turns that into a directory, and
   * `parseWorkingDirectory` is the gate the answer passes on the way in.
   */
  readonly cwd: string;
  /**
   * The text to open the session with, or `null` to leave the provider at its
   * own prompt. User content, never an option: the adapter places it as one
   * argv element and no shell ever sees it.
   */
  readonly prompt: string | null;
}

export interface ResumeRequest {
  readonly store: StoreDescriptor;
  readonly session: SessionRef;
  /**
   * Where this session already ran, as discovery read it out of the provider's
   * own files — `DiscoveredSession.cwd`, passed back in.
   *
   * Nobody gets to choose it. A session resumed in another directory is a
   * different session that happens to share a history: every relative path in
   * that history now points somewhere else, and the agent will act on the
   * difference without noticing it. `null` is what discovery reports when the
   * provider never recorded one, and an adapter refuses rather than guessing.
   */
  readonly cwd: string | null;
}

/**
 * Everything needed to open a PTY, and nothing that came off a socket.
 *
 * A refusal instead of a plan is a value, because "this session cannot be
 * resumed" is an answer the user has to be given, not an exception to unwind.
 */
export type Launch =
  | { readonly ok: true; readonly plan: LaunchPlan }
  | { readonly ok: false; readonly problem: string };

export interface LaunchPlan {
  /** The executable. Looked up on PATH by the supervisor; never a shell string. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Variables to set on the child, on top of the scrubbed inherited environment. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Variables to remove from the inherited environment before spawning, by
   * prefix. Provider knowledge: `CLAUDE_` means nothing to codex, and a
   * supervisor with a hardcoded list would have to be edited for every adapter.
   * The supervisor applies it, so an adapter never touches the process
   * environment and stays a pure function of its arguments.
   */
  readonly scrubEnvPrefixes: readonly string[];
}

/**
 * Getting a provider onto a machine, and finding out what is already on one.
 *
 * Installation, version probing, authentication state and login are as
 * provider-specific as a transcript format is, so they live where everything
 * provider-specific lives. `npm install --global` is Claude Code's answer and
 * nobody else's; a provider that ships a tarball or a distribution package
 * becomes a different implementation of this interface rather than a branch in
 * an installer nobody tests.
 *
 * Every method here returns a plan and runs nothing, exactly as `spawn` and
 * `resume` do. That is what keeps the whole surface pure functions a test calls
 * with a value and compares against a value, and it is what leaves the running
 * to the setup registry, so that the one place a child is started stays the one
 * place a child is started.
 *
 * Note what a plan cannot express, and that nothing had to be loosened to fit
 * it: an install is a bare argv with no working directory and no environment,
 * because `npm install --global --prefix <dir>` carries the prefix as an
 * argument the program parses rather than as state the kernel applies. The
 * process seam has nowhere to put a cwd or an env var, deliberately, and an
 * installer is exactly the operation that would otherwise have been the excuse
 * to add one.
 */
export interface ProviderProvisioning {
  /**
   * How to put this provider into a prefix agentplex owns.
   *
   * A refusal rather than a plan when the prefix is not a directory anything
   * can be installed into. The prefix reaches an adapter from a setup plan that
   * a person or a cloud-init file wrote, so it is a claim like any other, and
   * it is checked at the point where it becomes an argv element.
   */
  install(request: InstallRequest): InstallPlan;

  /**
   * How to ask the provider what version it is, and how to read the answer.
   *
   * Never refused, because the argv is a constant. This is the probe setup runs
   * against a binary it adopted off the operator's PATH, and it is the moment a
   * version-manager shim that cannot run outside its own environment gets
   * found: while a person is present, rather than at the first spawn of the
   * first session.
   */
  version(): VersionProbe;

  /**
   * How to tell whether this provider is logged in, by reading its own state.
   *
   * Reading, and never writing. agentplex writing into a provider's state
   * directory is the v1 mistake this seam was drawn to prevent, and setup
   * planting a credentials file would reintroduce it on day one: a format the
   * provider owns, written by something that does not own it, with no way
   * afterwards to tell a stale plant from a real login. So this says what to
   * read and how to read it, and the caller supplies the store.
   *
   * A read of one file rather than a spawn, on purpose. A provider's own `auth
   * status` subcommand would answer better, but answering "am I logged in" with
   * a child process means an exit code to interpret, an absent program to tell
   * from a refusing one, and a right to start children that the setup registry
   * would have to be given for a question that a file already answers.
   */
  authState(): AuthProbe;

  /**
   * How to run this provider's own login, in a terminal.
   *
   * A `Launch`, because a login is a TUI: these are browser OAuth flows, and on
   * a headless machine that means a URL opened somewhere else and a code pasted
   * back. Driving it through the same pty seam the product already has is not a
   * shortcut — it is the product's own mechanism, so the setup path exercises
   * the seam every session depends on.
   *
   * It takes a store because the credentials have to land in the store the
   * sessions will run against. A login that writes into whichever home
   * directory agentplexd happens to run as leaves that store exactly as logged
   * out as it was, and nothing says so.
   */
  login(request: LoginRequest): Launch;
}

export interface InstallRequest {
  /**
   * The directory to install into: the prefix agentplex owns, never one the
   * operator already keeps a binary in.
   *
   * Setup adopts an existing installation when it finds one and installs only
   * when it does not, so a request that reaches here has already established
   * that nothing working is being shadowed. The adapter's job is the narrow
   * one: put this version in this directory, and say no when the directory is
   * not something a path can be built from.
   */
  readonly prefix: string;
  /**
   * The version to pin, or `null` for whatever the provider calls current.
   *
   * A pin is what a plan should carry — the point of a replayable artifact is
   * that replaying it in a month produces the machine it described — but `null`
   * has to stay expressible, because the first install on a new machine has no
   * version to name yet.
   */
  readonly version: string | null;
}

/**
 * A one-shot install, or the reason there is not one.
 *
 * Shaped like `Launch` rather than simply returning a plan, for the same
 * reason: "this cannot be installed there" is an answer setup has to show the
 * operator, not an exception to unwind past the code that knows what it means.
 */
export type InstallPlan =
  | { readonly ok: true; readonly plan: OneShotPlan<InstalledProvider> }
  | { readonly ok: false; readonly problem: string };

export interface InstalledProvider {
  /** What the installer says it put there, in the installer's own spelling. */
  readonly package: string;
  /** The version that is on disk now, as the installer reported it. */
  readonly version: string;
}

/**
 * The version a provider reports about itself, verbatim once parsed out.
 *
 * A string and not a parsed semver: nothing here compares versions, and a
 * provider is free to print something a semver parser would reject. What an
 * operator is shown has to be what the program actually said.
 */
export type VersionProbe = OneShotPlan<string>;

/**
 * A program to run once, and how to read what it printed.
 *
 * The two halves stay separate for the reason the operation registry keeps them
 * separate: an argv is a value a test writes down, and reading output is where
 * an exit code gets a meaning that differs per program and per question.
 *
 * The timeout is here rather than at the caller because "how long may this
 * take" is provider knowledge — a version probe is milliseconds and an install
 * pulls a package across a network — and a caller picking one per provider is a
 * caller guessing on the provider's behalf.
 */
export interface OneShotPlan<Result> {
  readonly argv: Argv;
  readonly timeoutMs: number;
  readonly read: (completed: CompletedProcess) => OneShotRead<Result>;
}

export type OneShotRead<Result> =
  { readonly ok: true; readonly result: Result } | { readonly ok: false; readonly problem: string };

/**
 * Which file says whether this provider is logged in, and what it says.
 *
 * The path is relative to the store, exactly as `discover` treats its own
 * directories: the adapter knows the layout inside a store, the caller knows
 * where the store is, and no caller ever builds a path into a provider's
 * private directories itself.
 */
export interface AuthProbe {
  /** Relative to the store root. One file: this is a question, not a search. */
  readonly file: string;
  readonly read: (read: FileRead) => AuthState;
}

/**
 * Logged in, logged out, or a file that could not be read.
 *
 * The third case is not the second. A credentials file that is there and cannot
 * be read is a permissions problem an operator fixes in a second once somebody
 * names it, and calling that "logged out" sends them through a login that will
 * fail the same way for the same unnamed reason.
 */
export type AuthState =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unknown'; readonly problem: string };

export interface LoginRequest {
  readonly store: StoreDescriptor;
  /**
   * Where to run the login, resolved by the caller from its own configuration,
   * for the same reason a spawn's is: no directory arrives from outside.
   *
   * A login neither reads nor writes it — it talks to a browser and to the
   * provider's own state directory — but a pty has to open somewhere, and a
   * directory nobody checked is a directory nobody checked.
   */
  readonly cwd: string;
}
