import type {
  Activity,
  Provider,
  SessionId,
  SessionRef,
  SessionStatus,
  SessionUsage,
  StoreDescriptor,
} from '@agentplex/protocol';
import type { Argv } from './operations/operation.js';
import type { CompletedProcess } from './operations/process-runner.js';

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
   * Where this provider keeps its state when nobody has told it otherwise,
   * relative to a home directory.
   *
   * A store's location is configuration everywhere else in this codebase, and
   * this does not change that: it is the one directory setup can *offer*, so
   * that an operator installing on their own laptop presses return instead of
   * typing a path they would have had to look up. Nothing reads it at runtime.
   *
   * It sits on the adapter because it is provider knowledge — `.claude` is
   * Claude Code's answer and nobody else's — and the alternative was the wizard
   * carrying a list of directories keyed by provider name, which is the shape
   * that makes a second provider an edit to the setup path instead of a new
   * file. Relative to a home directory rather than absolute for the reason a
   * plan's `installPrefix` is absolute and this is not: this is a fact about the
   * provider, and the home directory it is resolved against is a fact about the
   * machine setup is running on.
   */
  readonly defaultStoreDirectory: string;

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
   * One session's transcript, read as the activities it records.
   *
   * Required and explicit for every adapter, like `usage`, `model` and
   * `activity` on a discovered session, and for the same reason: only the
   * adapter can read a provider's own record of its work, so it is the one
   * place that has to answer out loud. An adapter that inherited a default
   * would be a provider silently reporting that its sessions do nothing, which
   * is indistinguishable from a quiet session.
   *
   * It reads *one* session and not a store, which is the whole difference
   * between this and `discover`. Discovery walks every transcript in a store
   * every couple of seconds and reduces each to one line; this is asked for by
   * somebody looking at one session, and it answers with the tail of what that
   * session did.
   *
   * Two bounds, and both are the adapter's to apply. The count is on the
   * request and is capped by the protocol's own `TRANSCRIPT_ACTIVITIES_MAX`,
   * so the answer fits the socket by construction. The bytes are bounded by
   * `readFileTail` on the `ProviderFiles` seam: a real transcript is routinely
   * several megabytes, and reading one whole to show the last twenty lines of
   * it would put the file in memory on the machine that can least afford it.
   * An adapter that reads a whole file here is a bug, not a style.
   *
   * Never throws for a transcript it cannot read: an unreadable session is a
   * refusal in words, and a single activity that will not parse costs itself
   * rather than the listing around it.
   */
  transcript(request: TranscriptRequest): Promise<TranscriptRead>;

  /**
   * How this provider gets onto a machine, and how to tell what is already on
   * one.
   *
   * A property rather than four more methods, because provisioning is answered
   * once per adapter and never per store or per session: it is a constant of
   * the provider, and grouping it says so.
   */
  readonly provisioning: ProviderProvisioning;

  /**
   * How this provider can be made to ask before it runs a tool, or `null` when
   * it cannot be made to.
   *
   * A property for the reason `provisioning` is one: it is a constant of the
   * provider rather than something answered per store or per session, and a
   * caller holding an adapter is asking "can this one ask at all" before it has
   * a launch to plan. A server reads it, writes whatever it is given, and hands
   * the path back on the next `spawn` or `resume`; it learns no provider's
   * settings grammar on the way, which is what keeps the second provider with a
   * hook a new file rather than a branch in the session controller.
   */
  readonly permissionHook: PermissionHook | null;
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
  /**
   * What this session has spent, in tokens the provider itself counted, or
   * `null` when its files state none.
   *
   * Required and nullable, where the wire field is optional. An adapter is the
   * only thing that can read a provider's own counts, so it is the one place
   * that has to answer the question out loud -- a new adapter that simply
   * omitted this would be a provider silently reporting no spend, and the type
   * is what stops that being possible by accident. `null` is a real answer and
   * the one an adapter gives when it looked.
   *
   * Never a zeroed record standing in for `null`. Zero is what a provider that
   * counted and found nothing reports, and the surfaces above render the two
   * differently on purpose.
   */
  readonly usage: SessionUsage | null;
  /**
   * The model this session is running, named as the provider's own record
   * names it, or `null` when that record does not name one.
   *
   * A string, never a value this package enumerates: the set of models is the
   * providers' and moves on their release schedule, so a model released this
   * morning has to reach a screen without a release here. Nothing downstream
   * switches on it.
   *
   * Required and nullable for the reason `usage` above is. An adapter is the
   * only thing that can read a provider's own record, so it is the one place
   * that has to answer out loud, and `null` is a real answer: it means the
   * adapter looked and the record named no model. What it must never mean is
   * the model this provider usually runs -- a guess is worse than a missing
   * segment on the one line that claims to say what is running.
   */
  readonly model: string | null;
  /**
   * What this session was last seen doing, in the one vocabulary every
   * provider is reduced to, or `null` when the provider's own files say
   * nothing this adapter can report honestly.
   *
   * Required and nullable for the reason `usage` and `model` above are, and
   * the reason bites harder here. An adapter is the only thing that can read
   * a provider's own record of its work, so it is the one place that has to
   * answer out loud -- and a new adapter that simply omitted this would be a
   * provider silently reporting that nothing ever happens, which is
   * indistinguishable from a quiet fleet. The type is what stops that being
   * possible by accident.
   *
   * `null` is a real and common answer: it means the adapter looked and the
   * record held nothing it could name. What it must never mean is a guess --
   * an activity is a claim about what an agent did, and the surfaces above
   * draw it as one.
   *
   * Already parsed by the protocol's own schema by the time it gets here. An
   * adapter that could not get a derivation past that schema reports `null`,
   * because a refused activity costs itself and never the session it belongs
   * to.
   */
  readonly activity: Activity | null;
}

/**
 * How much of a transcript file an adapter reads to answer a transcript
 * request.
 *
 * Two megabytes, read off the end. It is a bound on memory rather than on
 * meaning: the answer is bounded by the count on the request, and this is what
 * stops a multi-megabyte file becoming a multi-megabyte string on the machine
 * that has it. A transcript line is a JSON object of a turn or an event, a few
 * hundred bytes to a few kilobytes, so this window holds hundreds to thousands
 * of them -- comfortably more than `TRANSCRIPT_ACTIVITIES_MAX` activities'
 * worth in any session anyone has captured.
 *
 * A window that falls short is not a lie: `SessionTranscript.olderExist` is
 * true whenever the read was cut, so a screen says there is more behind it
 * rather than presenting a tail as the whole. That is why this is a tail read
 * and not a refusal above a size, which was the other way to bound it: a
 * refusal would go off on exactly the long-running sessions somebody opens the
 * transcript of.
 */
export const TRANSCRIPT_TAIL_MAX_BYTES = 2 * 1024 * 1024;

export interface TranscriptRequest {
  readonly store: StoreDescriptor;
  /**
   * Which session, in the pair everything above the adapter deals in. The
   * store half is carried on `store` above; this is the provider's own id, and
   * the adapter is what knows where a file with that name sits in its own
   * layout.
   */
  readonly session: SessionRef;
  /**
   * How many activities to answer with, at most, counting from the newest.
   *
   * On the request rather than a constant of the adapter, because the party
   * that has to fit the answer in a frame is the one that asked. The adapter
   * does not police it against the protocol's ceiling -- that is done where
   * the number comes off the wire, by the schema that parses it -- but it does
   * honour it exactly: an adapter that answered with more than it was asked
   * for would be an adapter that can overrun a frame nobody else sized.
   */
  readonly limit: number;
}

/**
 * The tail of one session's work, or the reason there is none.
 *
 * A refusal instead of a throw, for the reason `Launch` is one: "this
 * transcript cannot be read" is an answer somebody has to be shown, in words,
 * next to the session it is about.
 */
export type TranscriptRead =
  | { readonly ok: true; readonly transcript: SessionTranscript }
  | { readonly ok: false; readonly problem: string };

export interface SessionTranscript {
  /**
   * What the session did, oldest first, at most `limit` of them.
   *
   * Oldest first because that is the order it happened in and the order a
   * screen draws it in, and reversing at the edge would put the one place the
   * order is decided furthest from the one place it is known.
   *
   * Already parsed by the protocol's own schema by the time it is here, which
   * is what keeps the vocabulary read in exactly one place. An activity the
   * schema refused is dropped: it costs itself, and the session keeps the rest
   * of its transcript.
   */
  readonly activities: readonly Activity[];
  /**
   * Whether the session did more than this before the oldest of these.
   *
   * Reported rather than left to be inferred from a full page, because the two
   * bounds that can produce it are different and neither is visible to the
   * caller: the count it asked for, and the bytes the adapter was willing to
   * read off the end of the file. A screen that said "showing the last 200"
   * when the file held exactly 200 would be claiming something it cannot know,
   * and one that said nothing when it had cut a transcript in half would be
   * presenting a tail as the whole.
   */
  readonly olderExist: boolean;
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

/**
 * How a provider is pointed at the program that asks this machine before a tool
 * call runs, or `null` for one that cannot be.
 *
 * Two halves, and they are deliberately on opposite sides of this seam. What
 * goes *in* the file -- which event, which key, how a command is spelled -- is
 * provider knowledge and lives here. *Writing* it is the server's: it is a file
 * on a disk with a lifetime, owner-only permissions and a removal when the
 * launch ends, none of which belongs in a pure function that builds argv.
 *
 * `null` is a whole answer and not a gap. codex has no hook equivalent at all,
 * and a provider that cannot ask is one whose sessions simply never produce an
 * approval -- which is different from producing one nobody can answer.
 */
export interface PermissionHook {
  /**
   * What the per-launch settings file is called. The provider's vocabulary: a
   * server writes the name it is given and reads nothing in it.
   */
  readonly settingsFileName: string;
  /**
   * The document to write in that file, pointing the provider's hook at one
   * program.
   *
   * The timeout is the caller's because the machine holding the blocked process
   * is the one that has to give up first: the number here and the deadline the
   * gate expires on are one decision, and two files stating it separately
   * eventually state it differently.
   */
  settings(hook: PermissionHookCommand): string;
}

export interface PermissionHookCommand {
  /** The program the provider runs, absolute. Never a shell string this side. */
  readonly command: string;
  readonly args: readonly string[];
  /** How long the provider waits for an answer before giving up, in seconds. */
  readonly timeoutSeconds: number;
}

/**
 * One launch's way of asking, as the launch plan needs it.
 *
 * The file is named on argv and everything secret rides in the environment,
 * which is the split the security of this path rests on: argv is world-readable
 * through `ps` on every machine agentplex runs on, and a child's environment is
 * not. Neither half crosses a wire -- a launch is planned on the machine that
 * will run it, out of a socket that machine opened and a secret it minted.
 */
export interface LaunchApproval {
  /** The per-launch settings file the server wrote, absolute. */
  readonly settingsFile: string;
  /**
   * What the hook needs to find its way back, as variables the provider's child
   * passes down to it: where to connect, and what to present when it does.
   *
   * Opaque here on purpose. The names belong to the program on the other end of
   * them, which is the server's own hook, and an adapter that knew them would be
   * a second place they are spelled.
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface SpawnRequest {
  readonly store: StoreDescriptor;
  /**
   * Where to run, as the server decided it.
   *
   * One of two things, and never anything else: the store's own path, resolved
   * by that server at boot, or a project's directory that the server has
   * already refused unless its real path sits under a browse root that
   * machine's own operator configured. A `{ cwd }` field taken as read off a
   * frame would be a remote code execution primitive wearing a path — whoever
   * held a client token would pick any directory and run an agent with write
   * access to it — and the difference is not that the second case skips the
   * wire but that nothing crosses it unchecked: the value is parsed by one
   * schema, bounded by a list no frame can add to, and reaches this field and
   * no other. `CONTRIBUTING.md` carries the amendment and the argument for it.
   *
   * `parseWorkingDirectory` is the gate the answer passes on the way in, and it
   * is the adapter's own rather than the server's: a directory inside the
   * provider's store is one no agent may be started in, whichever of the two
   * roads it arrived by.
   */
  readonly cwd: string;
  /**
   * The text to open the session with, or `null` to leave the provider at its
   * own prompt. User content, never an option: the adapter places it as one
   * argv element and no shell ever sees it.
   */
  readonly prompt: string | null;
  /**
   * How this launch asks before a tool call, or `null` for one that does not.
   *
   * Required rather than optional, and that is the point of it: a Claude
   * session started without one is a session that will never ask anybody
   * anything, and the person watching it in agentplex is shown no approval and
   * told no reason. A field a caller can forget is a feature that stops working
   * silently, so the compiler is the thing that remembers.
   */
  readonly approval: LaunchApproval | null;
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
  /** As on a spawn: this launch's way of asking, or `null` for none. */
  readonly approval: LaunchApproval | null;
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
   * How to ask the provider whether it is logged in.
   *
   * Asked, and never inferred from the provider's files. A credentials file is
   * an undocumented format inside a directory the provider owns, and it can be
   * renamed, restructured or moved into an OS keychain in any release — at
   * which point an adapter reading it reports "not logged in" for a provider
   * that is perfectly logged in, silently, and in the direction that invents a
   * problem. A supported `auth status` subcommand is the provider's own answer
   * to exactly this question and survives its own format changes. This is the
   * same rule that keeps agentplex from *writing* into a state directory,
   * applied one step earlier.
   *
   * Nothing in this file writes anything anywhere, so the v1 guarantee is
   * unchanged: setup cannot plant a credentials file because there is no shape
   * here in which it could.
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
   * directory agentplex happens to run as leaves that store exactly as logged
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
 * What to run to find out whether this provider is logged in, and how to read
 * the answer.
 *
 * The same shape as `VersionProbe`, which is the point: both are one-shot
 * questions put to the provider about itself, and there is no reason for the
 * one that could have been answered by snooping a file to have a different
 * shape from the one that never could.
 */
export type AuthProbe = OneShotPlan<AuthState>;

/**
 * Logged in, or logged out.
 *
 * There is no third member for "could not tell", because `OneShotRead` already
 * has one: a probe that could not be run, or whose output did not answer the
 * question, is `{ ok: false }` with a problem that names why. A provider that
 * is not installed and a provider that is logged out are different facts, and
 * flattening them into one enum is how an operator ends up sent through a login
 * for a binary that is not there.
 */
export type AuthState = 'authenticated' | 'unauthenticated';

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
