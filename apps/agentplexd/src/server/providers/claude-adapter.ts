import { join } from 'node:path';
import { sessionIdSchema, type SessionStatus, type StoreDescriptor } from '@agentplex/protocol';
import type { ProcessProbe } from '../process-probe.js';
import {
  CLAUDE_SESSIONS_DIRECTORY,
  readClaudeRegistry,
  resolveWithRegistry,
  type ClaudeRegistry,
} from './claude-registry.js';
import { parseClaudeTranscript } from './claude-transcript.js';
import type {
  DiscoveredSession,
  DiscoveryProblem,
  Launch,
  ProviderAdapter,
  ProviderDiscovery,
  StatusObservation,
} from './provider-adapter.js';
import type { ProviderFiles } from './provider-files.js';

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
  return {
    provider: 'claude',

    async discover(store: StoreDescriptor): Promise<ProviderDiscovery> {
      // The registry is read first and once, not per session: it is one
      // directory listing for the whole store, and every session in the store
      // is resolved against the same snapshot of it.
      const registry = await readClaudeRegistry(
        join(store.path, CLAUDE_SESSIONS_DIRECTORY),
        files,
        probe,
      );
      const found = await discoverSessions(
        join(store.path, CLAUDE_PROJECTS_DIRECTORY),
        files,
        registry,
      );

      return { sessions: found.sessions, problems: [...registry.problems, ...found.problems] };
    },

    spawn(): Launch {
      return { ok: false, problem: NO_WORKING_DIRECTORY };
    },

    resume(): Launch {
      return { ok: false, problem: NO_WORKING_DIRECTORY };
    },

    status(observation: StatusObservation): SessionStatus {
      return claudeStatus(observation);
    },
  };
}

/**
 * Why there is no launch plan yet, said once.
 *
 * Claude Code inherits its working directory from the process that starts it,
 * and neither `SpawnRequest` nor `ResumeRequest` carries one. The store path is
 * not a substitute: for this provider the store is the config directory that
 * v1 hardwired as `~/.claude`, and starting an agent with that as its cwd
 * would point it at the provider's own state directory — the one place the
 * spec forbids agentplex to write into. A refusal that names the gap is a
 * better answer than argv invented to fill it, and `Launch` exists to carry
 * exactly this.
 */
const NO_WORKING_DIRECTORY =
  'the Claude adapter cannot build a launch plan yet: a request carries no working directory ' +
  'for the session, and a store path is a config directory rather than a place to run an agent';

async function discoverSessions(
  projects: string,
  files: ProviderFiles,
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
    await readProject(join(projects, entry.name), files, registry, sessions, problems);
  }

  return { sessions, problems };
}

async function readProject(
  project: string,
  files: ProviderFiles,
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

    const read = await files.readFile(path);
    if (read.kind === 'failed') {
      problems.push({ subject: path, problem: `cannot read transcript: ${read.reason}` });
      continue;
    }
    // Removed while we were listing. A session that no longer exists is not a
    // session this server failed to report.
    if (read.kind === 'missing') continue;

    const parsed = parseClaudeTranscript(read.contents);
    if (parsed.ok) {
      // Registry first, transcript as the fallback. The file says what was
      // written; the verified registry entry says what is happening, and only
      // it can tell an unanswered tool call that is waiting for a human from
      // one that is simply still running.
      const resolved = resolveWithRegistry(
        parsed.transcript.signal,
        registry.live.get(sessionId.data),
      );
      sessions.push({
        sessionId: sessionId.data,
        signal: resolved.signal,
        updatedAt: parsed.transcript.updatedAt,
        running: resolved.running,
        cwd: parsed.transcript.cwd,
        title: parsed.transcript.title,
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
