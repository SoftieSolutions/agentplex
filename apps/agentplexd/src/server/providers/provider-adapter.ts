import type {
  Provider,
  SessionId,
  SessionRef,
  SessionStatus,
  StoreDescriptor,
} from '@agentplex/protocol';

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
   * The text to open the session with, or `null` to leave the provider at its
   * own prompt. User content, never an option: the adapter places it as one
   * argv element and no shell ever sees it.
   */
  readonly prompt: string | null;
}

export interface ResumeRequest {
  readonly store: StoreDescriptor;
  readonly session: SessionRef;
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
