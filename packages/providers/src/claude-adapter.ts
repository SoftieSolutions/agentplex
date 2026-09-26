import { join } from 'node:path';
import { sessionIdSchema, type SessionStatus, type StoreDescriptor } from '@agentplex/protocol';
import type { ProcessProbe } from './process-probe.js';
import {
  claudePermissionHook,
  CLAUDE_DEFAULT_STORE_DIRECTORY,
  planClaudeLaunch,
} from './claude-launch.js';
import { createClaudeProvisioning } from './claude-provisioning.js';
import {
  CLAUDE_SESSIONS_DIRECTORY,
  readClaudeRegistry,
  resolveWithRegistry,
  type ClaudeRegistry,
} from './claude-registry.js';
import {
  claudeTranscriptActivities,
  parseClaudeTranscript,
  type ClaudeTranscriptParse,
} from './claude-transcript.js';
import {
  TRANSCRIPT_TAIL_MAX_BYTES,
  type DiscoveredSession,
  type DiscoveryProblem,
  type Launch,
  type ProviderAdapter,
  type ProviderDiscovery,
  type ResumeRequest,
  type SpawnRequest,
  type StatusObservation,
  type TranscriptRead,
  type TranscriptRequest,
} from './provider-adapter.js';
import type { ProviderFiles } from './provider-files.js';
import { createTranscriptCache, type TranscriptScan } from './scan-cache.js';

/**
 * The Claude Code adapter.
 *
 * Claude Code keeps one directory per working directory and one JSONL
 * transcript per session inside it:
 *
 *     <store>/projects/<encoded cwd>/<sessionId>.jsonl
 *
 * The store path is where v1 hardwired `~/.claude`; `projects/` and the file
 * layout under it are this adapter's knowledge and appear nowhere else.
 *
 * Two things about that layout drive the code below.
 *
 * The `<encoded cwd>` segment is not a path. Claude Code replaces `/`, `.` and
 * `_` with the same `-`, so `~/Code/x/.claude/y` and `~/Code/x/-claude/y` both
 * encode to `-Users-me-Code-x--claude-y` and neither can be recovered. So the
 * directory name is used for nothing at all: the cwd this adapter reports is
 * read out of the transcript, which records it verbatim on every turn. That is
 * the answer to the question the provider seam left open.
 *
 * A session that ran subagents also gets *directories* beside its transcript —
 * `<sessionId>/subagents/*.jsonl` and `<sessionId>/tool-results/`. The
 * subagent files are real transcripts and would parse. Discovery therefore
 * takes files and only files out of a project directory, and never recurses:
 * a subagent is part of a session, not another one.
 */

/** Where Claude Code puts its per-project directories inside a store. */
export const CLAUDE_PROJECTS_DIRECTORY = 'projects';

const TRANSCRIPT_SUFFIX = '.jsonl';

export interface ClaudeAdapterDependencies {
  readonly files: ProviderFiles;
  /**
   * How this adapter checks that a registry entry names a process that is
   * really there. Injected because a unit test cannot supply `/proc`, a
   * `sysctl` or a pid that recycles on cue.
   */
  readonly probe: ProcessProbe;
}

export function createClaudeAdapter({ files, probe }: ClaudeAdapterDependencies): ProviderAdapter {
  // Held for the life of the adapter, which is the life of the server: what a
  // transcript parsed to last scan is the answer this scan too, until its size
  // or mtime moves. The parse is what is kept and not the session built from
  // it, because the registry half of a session is re-read every scan and is
  // exactly the part that changes while the file stays still.
  const transcripts = createTranscriptCache({ files, parse: parseClaudeTranscript });

  return {
    provider: 'claude',

    defaultStoreDirectory: CLAUDE_DEFAULT_STORE_DIRECTORY,

    async discover(store: StoreDescriptor): Promise<ProviderDiscovery> {
      // The registry is read first and once, not per session: it is one
      // directory listing for the whole store, and every session in the store
      // is resolved against the same snapshot of it.
      const registry = await readClaudeRegistry(
        join(store.path, CLAUDE_SESSIONS_DIRECTORY),
        files,
        probe,
      );
      const scan = transcripts.scan(store.path);
      const found = await discoverSessions(
        join(store.path, CLAUDE_PROJECTS_DIRECTORY),
        files,
        scan,
        registry,
      );
      scan.finish();

      return { sessions: found.sessions, problems: [...registry.problems, ...found.problems] };
    },

    spawn(request: SpawnRequest): Launch {
      // No session id anywhere in here. Claude Code mints its own and writes
      // it to disk; discovery finds it moments later. Naming it up front would
      // mean `--session-id`, and agentplex would be deciding an identity the
      // provider is the authority on.
      return planClaudeLaunch(
        request.store,
        request.cwd,
        request.prompt === null ? [] : [request.prompt],
        request.approval,
      );
    },

    resume(request: ResumeRequest): Launch {
      // `--resume <id>`, and nothing else. Not `--fork-session`, which gives
      // the resumed session a new id: the client goes on watching the
      // transcript it knows while the work continues in a file nobody reads.
      return planClaudeLaunch(
        request.store,
        request.cwd,
        ['--resume', request.session.sessionId],
        request.approval,
      );
    },

    status(observation: StatusObservation): SessionStatus {
      return claudeStatus(observation);
    },

    async transcript(request: TranscriptRequest): Promise<TranscriptRead> {
      return await readSessionTranscript(
        join(request.store.path, CLAUDE_PROJECTS_DIRECTORY),
        request.session.sessionId,
        request.limit,
        files,
      );
    },

    // Provisioning holds no store and no filesystem, so it is built once here
    // rather than taken as a dependency: what it answers about Claude Code is
    // true of every Claude Code, and an adapter that had to be handed one would
    // be an adapter a caller could hand the wrong one.
    provisioning: createClaudeProvisioning(),

    // The one provider in this build that can be made to ask. What goes in the
    // file is this adapter's; writing it, and removing it when the launch ends,
    // is the server's.
    permissionHook: claudePermissionHook,
  };
}

async function discoverSessions(
  projects: string,
  files: ProviderFiles,
  scan: TranscriptScan<ClaudeTranscriptParse>,
  registry: ClaudeRegistry,
): Promise<ProviderDiscovery> {
  const listing = await files.listDirectory(projects);
  // Absent is the normal state of a store no Claude Code has touched. Saying
  // so would put a permanent complaint in front of anyone using another agent.
  if (listing.kind === 'missing') return { sessions: [], problems: [] };
  if (listing.kind === 'failed') {
    return { sessions: [], problems: [{ subject: projects, problem: listing.reason }] };
  }

  const sessions: DiscoveredSession[] = [];
  const problems: DiscoveryProblem[] = [];

  for (const entry of listing.entries) {
    if (entry.kind !== 'directory') continue;
    await readProject(join(projects, entry.name), files, scan, registry, sessions, problems);
  }

  return { sessions, problems };
}

async function readProject(
  project: string,
  files: ProviderFiles,
  scan: TranscriptScan<ClaudeTranscriptParse>,
  registry: ClaudeRegistry,
  sessions: DiscoveredSession[],
  problems: DiscoveryProblem[],
): Promise<void> {
  const listing = await files.listDirectory(project);
  // Gone between listing the parent and reading it. Nothing was lost that was
  // still there, so nothing is reported.
  if (listing.kind === 'missing') return;
  if (listing.kind === 'failed') {
    problems.push({ subject: project, problem: listing.reason });
    return;
  }

  for (const entry of listing.entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith(TRANSCRIPT_SUFFIX)) continue;

    const path = join(project, entry.name);
    const sessionId = sessionIdSchema.safeParse(entry.name.slice(0, -TRANSCRIPT_SUFFIX.length));
    if (!sessionId.success) {
      problems.push({ subject: path, problem: 'the file name is not a session id' });
      continue;
    }

    const read = await scan.read(path);
    if (read.kind === 'failed') {
      problems.push({ subject: path, problem: `cannot read transcript: ${read.reason}` });
      continue;
    }
    // Removed while we were listing. A session that no longer exists is not a
    // session this server failed to report.
    if (read.kind === 'missing') continue;

    const parsed = read.parse;
    if (parsed.ok) {
      // Registry first, transcript as the fallback. The file says what was
      // written; the verified registry entry says what is happening, and only
      // it can tell an unanswered tool call that is waiting for a human from
      // one that is simply still running.
      const entry = registry.live.get(sessionId.data);
      const resolved = resolveWithRegistry(parsed.transcript.signal, entry);
      sessions.push({
        sessionId: sessionId.data,
        signal: resolved.signal,
        createdAt: parsed.transcript.createdAt,
        updatedAt: parsed.transcript.updatedAt,
        running: resolved.running,
        // `live` holds only entries whose process was verified, so a pid read
        // off it is a process and not a registry's stale claim.
        pid: entry?.pid ?? null,
        cwd: parsed.transcript.cwd,
        title: parsed.transcript.title,
        usage: parsed.transcript.usage,
        model: parsed.transcript.model,
        // Off the last non-sidechain turn, and `null` for a turn that ended
        // in text: the transcript parser is the only thing that knows what a
        // Claude Code content block means, and it is also the only thing that
        // knows which of them the capture redacts.
        activity: parsed.transcript.activity,
      });
    } else if (parsed.reason === 'damaged') {
      problems.push({ subject: path, problem: `cannot read transcript: ${parsed.problem}` });
    }
    // `no-turns` falls through on purpose: a transcript with no turn in it is
    // not a session and is not a fault either. Claude Code writes one for
    // every session that was opened and abandoned, and a store that has been
    // used for a while has plenty.
  }
}

/**
 * One session's transcript, found and read as the activities it records.
 *
 * Finding it is a listing of `projects/` and a listing of each project
 * directory, looking for a file named after the session. That is the same walk
 * discovery does, minus the reads: Claude Code's per-project directory name is
 * a lossy encoding of a cwd -- `/`, `.` and `_` all become `-` -- so there is
 * no directory to compute from a session id and the only way to the file is to
 * look for it. Files only, and no recursion, exactly as discovery does it: a
 * session that ran subagents has a *directory* named after it holding their
 * transcripts, and a subagent is part of a session rather than another one.
 *
 * Reading it is bounded, and that is the part worth stating. A real transcript
 * is routinely several megabytes -- one JSON object per content block, appended
 * for the life of the session -- and `readFile` on this seam has no cap at all.
 * So the read is `readFileTail`, whole lines off the end of the file, and the
 * answer says out loud when the window cut something off.
 *
 * Two refusals, and they are different things for a person to do. A session no
 * project directory holds is one that was deleted, or one this store never had;
 * a transcript that is there and will not be read is a permission or a mount to
 * go and fix.
 */
async function readSessionTranscript(
  projects: string,
  sessionId: string,
  limit: number,
  files: ProviderFiles,
): Promise<TranscriptRead> {
  const listing = await files.listDirectory(projects);
  if (listing.kind === 'failed') {
    return { ok: false, problem: `cannot read this store's transcripts: ${listing.reason}` };
  }
  // A store no Claude Code has touched has no `projects/`, which is the same
  // answer as a session it does not hold: there is no transcript here.
  const projectDirectories = listing.kind === 'missing' ? [] : listing.entries;

  const wanted = `${sessionId}${TRANSCRIPT_SUFFIX}`;
  for (const entry of projectDirectories) {
    if (entry.kind !== 'directory') continue;

    const project = join(projects, entry.name);
    const inside = await files.listDirectory(project);
    // Gone, or unreadable, between listing the parent and reading it. Neither
    // costs the search: the session may well be in the next directory, and a
    // problem here would refuse a transcript that is perfectly readable.
    if (inside.kind !== 'read') continue;
    if (!inside.entries.some((file) => file.kind === 'file' && file.name === wanted)) continue;

    const path = join(project, wanted);
    const read = await files.readFileTail(path, TRANSCRIPT_TAIL_MAX_BYTES);
    if (read.kind === 'failed') {
      return { ok: false, problem: `cannot read transcript: ${read.reason}` };
    }
    // Deleted in the moment between the listing and the read. The session is
    // gone, which is the same answer as never having been here.
    if (read.kind === 'missing') break;

    const parsed = claudeTranscriptActivities(read.contents, limit);
    return {
      ok: true,
      // Either bound can be the reason there is more behind this: the count the
      // caller asked for, or the window the file was read through. A reader acts
      // the same way on both, so they are one boolean.
      transcript: { ...parsed, olderExist: parsed.olderExist || read.truncated },
    };
  }

  return { ok: false, problem: 'this store holds no claude transcript for that session' };
}

/**
 * Claude's vocabulary, reduced to the one every provider shares.
 *
 * `progressing` still does not become `working` on elapsed time alone. A recent
 * write proves something wrote recently, not that anything is running now, so
 * the choice would be between under-claiming `idle` and putting a spinner on
 * sessions that died hours ago. What changed is that `running` is now reachable
 * without the PTY supervisor: Claude Code's own registry names the process, and
 * discovery has verified it is alive and is the process the entry meant. A
 * session with no such entry keeps the quiet answer, which is the honest one.
 *
 * Note what is *not* here: no elapsed-time rule reads `now` behind the caller's
 * back, and the two arguments that could tempt one — `updatedAt` and `now` —
 * are supplied rather than read. Claude Code needs no such rule, because for
 * this provider a verified process is a better answer than a stopwatch.
 */
function claudeStatus({ signal, running }: StatusObservation): SessionStatus {
  if (signal === 'awaiting-permission' || signal === 'awaiting-input') return signal;
  if (running) return 'working';
  if (signal === 'unknown') return 'unknown';
  return 'idle';
}
