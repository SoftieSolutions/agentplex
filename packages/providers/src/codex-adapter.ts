import { join } from 'node:path';
import { sessionIdSchema, type SessionStatus, type StoreDescriptor } from '@agentplex/protocol';
import { CODEX_DEFAULT_STORE_DIRECTORY, planCodexLaunch } from './codex-launch.js';
import { createCodexProvisioning } from './codex-provisioning.js';
import { parseCodexRollout } from './codex-rollout.js';
import { CODEX_SESSION_INDEX_FILE, parseCodexSessionIndex } from './codex-session-index.js';
import type {
  DiscoveredSession,
  DiscoveryProblem,
  Launch,
  ProviderAdapter,
  ProviderDiscovery,
  ResumeRequest,
  SpawnRequest,
  StatusObservation,
} from './provider-adapter.js';
import type { ProviderFiles } from './provider-files.js';

/**
 * The codex adapter.
 *
 * codex keeps one JSONL rollout per session, filed under the date it started:
 *
 *     <store>/sessions/<year>/<month>/<day>/rollout-<timestamp>-<id>.jsonl
 *
 * and one line per named session in a single index at the store root:
 *
 *     <store>/session_index.jsonl
 *
 * The store path is configuration, as it is everywhere else. `sessions/`, the
 * date partitions, and that index are this adapter's knowledge and appear
 * nowhere else in the codebase.
 *
 * Three things about codex drive the code below, and each of them is a place
 * this adapter is shaped differently from the Claude Code one while the seam
 * between them is unchanged.
 *
 * **The file name is not the session id.** `rollout-2026-09-11T23-51-30-01a09386-
 * f378-7b23-83a7-6c263ed59701.jsonl` spells its timestamp with the same `-`
 * the uuid uses, so there is no separator to split on that is not a guess. The
 * id is read out of the `session_meta` line inside the file, which is codex's
 * own statement of it and the one `codex resume` answers to. This is the same
 * argument the Claude adapter makes for reading a cwd out of a transcript
 * rather than decoding its per-project directory name.
 *
 * **The title is not in the transcript.** Claude Code writes an `ai-title` line
 * into the session's own file; codex writes a `thread_name` into one index for
 * the whole store. So discovery reads that file once, first, and every session
 * resolves against the same snapshot — the shape the Claude adapter uses for
 * its process registry, arrived at from a different direction.
 *
 * **There is no process registry at all.** `DiscoveredSession.running` is
 * documented as a live process "the adapter itself verified", and for codex
 * 0.154.0 there is nothing to verify against: the only per-session file beside
 * a rollout is a zero-byte advisory lock under `thread-writer-locks/`, holding
 * no pid, no start time and no status, left behind after the process that took
 * it dies. So this adapter reports `false` and means it, and the server's own
 * knowledge of the sessions it started is the whole of the answer. The seam
 * already or-s the two, so nothing above had to learn that one provider can
 * answer the question and the other cannot.
 */

/** Where codex puts its date-partitioned rollouts inside a store. */
export const CODEX_SESSIONS_DIRECTORY = 'sessions';

/**
 * How far below `sessions/` a rollout may sit.
 *
 * Three, because codex files them under `<year>/<month>/<day>`. It is a bound
 * rather than an exact path on purpose: the walk takes `.jsonl` files wherever
 * it meets them, so a codex that flattened the layout or added a partition
 * would still be read, while a directory tree that is not what this adapter
 * expects cannot send discovery down it forever.
 */
const CODEX_PARTITION_DEPTH = 3;

const ROLLOUT_SUFFIX = '.jsonl';

export interface CodexAdapterDependencies {
  readonly files: ProviderFiles;
}

export function createCodexAdapter({ files }: CodexAdapterDependencies): ProviderAdapter {
  return {
    provider: 'codex',

    defaultStoreDirectory: CODEX_DEFAULT_STORE_DIRECTORY,

    async discover(store: StoreDescriptor): Promise<ProviderDiscovery> {
      // The index is read first and once, not per session: it is one file for
      // the whole store, and every session in the store is named against the
      // same snapshot of it.
      const names = await readSessionNames(join(store.path, CODEX_SESSION_INDEX_FILE), files);

      return await discoverSessions(join(store.path, CODEX_SESSIONS_DIRECTORY), files, names);
    },

    spawn(request: SpawnRequest): Launch {
      // No session id anywhere in here. codex mints its own and writes it into
      // the rollout's first line; discovery finds it moments later.
      return planCodexLaunch(
        request.store,
        request.cwd,
        request.prompt === null ? [] : [request.prompt],
      );
    },

    resume(request: ResumeRequest): Launch {
      // `resume <id>`, and nothing else. Confirmed against codex-cli 0.154.0:
      // it reopens the session and goes on appending to the same rollout.
      // Deliberately not `fork`, which codex offers beside it and which gives
      // the continued work a new id — the client would go on watching a file
      // nobody writes to any more while the session ran somewhere else.
      return planCodexLaunch(request.store, request.cwd, ['resume', request.session.sessionId]);
    },

    status(observation: StatusObservation): SessionStatus {
      return codexStatus(observation);
    },

    // Provisioning holds no store and no filesystem, so it is built once here
    // rather than taken as a dependency: what it answers about codex is true
    // of every codex, and an adapter that had to be handed one would be an
    // adapter a caller could hand the wrong one.
    provisioning: createCodexProvisioning(),
  };
}

/**
 * The names codex has given sessions in this store.
 *
 * A missing index is the normal state of a store where codex has never learned
 * a name for anything, and an unreadable one costs the store its titles and
 * nothing else: a `null` title is a thing the seam already has a meaning for,
 * and a session list that one file can empty is not.
 */
async function readSessionNames(
  index: string,
  files: ProviderFiles,
): Promise<ReadonlyMap<string, string>> {
  const read = await files.readFile(index);
  return read.kind === 'read' ? parseCodexSessionIndex(read.contents) : new Map();
}

async function discoverSessions(
  sessions: string,
  files: ProviderFiles,
  names: ReadonlyMap<string, string>,
): Promise<ProviderDiscovery> {
  const found: DiscoveredSession[] = [];
  const problems: DiscoveryProblem[] = [];

  await walk(sessions, CODEX_PARTITION_DEPTH, files, names, found, problems);

  return { sessions: found, problems };
}

/**
 * One directory of the partition tree, and the rollouts in it.
 *
 * Absent is the normal state at every level: a store no codex has touched has
 * no `sessions/`, and a store nobody used in October has no `10/`. Saying so
 * would put a permanent complaint in front of anyone using another agent.
 */
async function walk(
  directory: string,
  depth: number,
  files: ProviderFiles,
  names: ReadonlyMap<string, string>,
  found: DiscoveredSession[],
  problems: DiscoveryProblem[],
): Promise<void> {
  const listing = await files.listDirectory(directory);
  if (listing.kind === 'missing') return;
  if (listing.kind === 'failed') {
    problems.push({ subject: directory, problem: listing.reason });
    return;
  }

  for (const entry of listing.entries) {
    const path = join(directory, entry.name);

    if (entry.kind === 'directory') {
      if (depth > 0) await walk(path, depth - 1, files, names, found, problems);
      continue;
    }

    if (entry.kind !== 'file' || !entry.name.endsWith(ROLLOUT_SUFFIX)) continue;
    await readRollout(path, files, names, found, problems);
  }
}

async function readRollout(
  path: string,
  files: ProviderFiles,
  names: ReadonlyMap<string, string>,
  found: DiscoveredSession[],
  problems: DiscoveryProblem[],
): Promise<void> {
  const read = await files.readFile(path);
  if (read.kind === 'failed') {
    problems.push({ subject: path, problem: `cannot read rollout: ${read.reason}` });
    return;
  }
  // Removed while we were listing. A session that no longer exists is not a
  // session this server failed to report.
  if (read.kind === 'missing') return;

  const parsed = parseCodexRollout(read.contents);
  if (!parsed.ok) {
    if (parsed.reason === 'damaged') {
      problems.push({ subject: path, problem: `cannot read rollout: ${parsed.problem}` });
    }
    // `no-turns` falls through on purpose: codex creates the rollout and
    // writes `session_meta` into it the moment a session opens, before the
    // first turn exists. A file caught in that moment is not a session and is
    // not a fault either.
    return;
  }

  const sessionId = sessionIdSchema.safeParse(parsed.rollout.sessionId);
  if (!sessionId.success) {
    // There is no second place to get this from. The file name spells a
    // timestamp with the same separator the uuid uses, so a guess would file
    // the session under an id that nothing resumes.
    problems.push({ subject: path, problem: 'the rollout does not say which session it is' });
    return;
  }

  found.push({
    sessionId: sessionId.data,
    signal: parsed.rollout.signal,
    updatedAt: parsed.rollout.updatedAt,
    // Always. See the note at the top of this file: codex keeps nothing this
    // adapter could verify a process against, and a claim nothing backs is
    // worse than the caller's own answer on its own.
    running: false,
    cwd: parsed.rollout.cwd,
    title: names.get(sessionId.data) ?? null,
    usage: parsed.rollout.usage,
  });
}

/**
 * codex's vocabulary, reduced to the one every provider shares.
 *
 * The same shape as the Claude one, and it arrives there for a different
 * reason. Claude Code can reach `working` from a store alone because its
 * registry names a live process; codex cannot, so `running` here is whatever
 * the caller knew about the sessions it started itself. What both refuse to do
 * is turn elapsed time into a status: a recent write proves something wrote
 * recently, not that anything is running now, and the choice would be between
 * under-claiming `idle` and putting a spinner on sessions that died hours ago.
 *
 * `awaiting-permission` never arrives here for codex, because nothing in a
 * rollout can produce it — see `signalOf` in `codex-rollout.ts`. It is handled
 * anyway rather than special-cased away: this function's job is to reduce the
 * shared vocabulary, not to encode which members of it one provider happens to
 * be able to reach today.
 */
function codexStatus({ signal, running }: StatusObservation): SessionStatus {
  if (signal === 'awaiting-permission' || signal === 'awaiting-input') return signal;
  if (running) return 'working';
  if (signal === 'unknown') return 'unknown';
  return 'idle';
}
