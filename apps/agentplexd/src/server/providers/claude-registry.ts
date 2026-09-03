import { join } from 'node:path';
import { sessionIdSchema, type SessionId } from '@agentplex/protocol';
import { z } from 'zod';
import type { ProcessProbe } from '../process-probe.js';
import type { DiscoveryProblem, TranscriptSignal } from './provider-adapter.js';
import type { ProviderFiles } from './provider-files.js';

/**
 * Claude Code's session registry, and the reason status can be trusted at all.
 *
 * Beside its transcripts, Claude Code keeps one small JSON file per running
 * process:
 *
 *     <store>/sessions/<pid>.json
 *
 * It records the pid, the session it is running, when it registered, and what
 * that session is doing right now. That last field is the one thing a
 * transcript cannot supply: on disk a session stopped at a permission prompt
 * and a session running a long tool are byte-identical — an assistant
 * `tool_use` with no `tool_result` after it — so AGX-17 called both
 * `progressing` and left `awaiting-permission` unreachable. The registry is the
 * provider declaring which of the two it is, and reading it is the whole point
 * of this file.
 *
 * The catch, and the reason half of this file is verification: these entries
 * are never cleaned up. A file stays after its process exits, forever, so an
 * entry alone claims nothing. Pids recycle, so a *live* pid alone claims
 * nothing either. Only the pair does: the process must be alive, and it must
 * have started no later than the entry says it registered. A recycled pid was
 * necessarily issued after the entry was written, and that is what tells the
 * two apart.
 */

/** Where Claude Code puts its per-process registry inside a store. */
export const CLAUDE_SESSIONS_DIRECTORY = 'sessions';

const ENTRY_SUFFIX = '.json';

/**
 * The statuses Claude Code writes, as Claude Code defines them.
 *
 * Captured from the CLI rather than remembered: 2.1.259 carries
 * `var je=["busy","shell","idle","waiting"]` with the reader
 * `je.includes(e)?e:void 0`. The list and the way an unrecognised value is
 * handled both come from there, so a newer CLI adding a fifth status degrades
 * here exactly as it does in the CLI itself.
 */
export const CLAUDE_REGISTRY_STATUSES = ['busy', 'shell', 'idle', 'waiting'] as const;

export type ClaudeRegistryStatus = (typeof CLAUDE_REGISTRY_STATUSES)[number];

/**
 * How far a probe's idea of a process's start may fall after the entry's own
 * `startedAt` and still be the same process.
 *
 * It absorbs probe resolution and nothing else: `ps` reports whole seconds, and
 * a genuine entry is written a beat *after* the process it describes exists
 * (1669ms after, in the captured fixture). It is not slack for a recycled pid,
 * which would have to be re-issued within two seconds of the original entry to
 * slip through — tens of thousands of pids of churn in that window.
 */
export const PID_RECYCLE_TOLERANCE_MS = 2_000;

/**
 * Only the fields agentplex acts on.
 *
 * Unknown keys are dropped rather than rejected, because Claude Code adds
 * fields between releases and an entry from a newer CLI has to stay readable.
 * `procStart` is deliberately not among them: it holds the process's real start
 * time formatted in UTC with no zone marker, so reading it as a date lands
 * hours off wherever the machine is not on UTC. This code dates processes by
 * asking the kernel instead.
 */
const entrySchema = z.object({
  pid: z.number().int().positive(),
  sessionId: sessionIdSchema,
  /** Epoch ms at which this entry was written, a beat after its process began. */
  startedAt: z.number().int().positive(),
  status: z.enum(CLAUDE_REGISTRY_STATUSES).optional().catch(undefined),
  /** Epoch ms of the last status change. Settles which of two entries is current. */
  statusUpdatedAt: z.number().int().nonnegative().optional().catch(undefined),
});

export interface ClaudeRegistryEntry {
  readonly pid: number;
  readonly sessionId: SessionId;
  readonly startedAt: number;
  readonly status?: ClaudeRegistryStatus | undefined;
  readonly statusUpdatedAt?: number | undefined;
}

export interface ClaudeRegistry {
  /**
   * Entries whose process this server verified, by session id.
   *
   * Keyed by the plain id rather than the branded one: this is a lookup table
   * an adapter reaches into with an id it already parsed, not a place ids are
   * minted.
   */
  readonly live: ReadonlyMap<string, ClaudeRegistryEntry>;
  readonly problems: readonly DiscoveryProblem[];
}

export function parseClaudeRegistryEntry(contents: string): ClaudeRegistryEntry | null {
  let entry: unknown;
  try {
    entry = JSON.parse(contents);
  } catch {
    return null;
  }

  const parsed = entrySchema.safeParse(entry);
  return parsed.success ? parsed.data : null;
}

/**
 * Every registry entry this server can prove is a running session.
 *
 * Never throws and never fails as a whole: an entry that cannot be read costs
 * itself. The listing it feeds is the session list, and a session list that one
 * unreadable file can empty is worse than one that is occasionally less certain
 * about a status.
 */
export async function readClaudeRegistry(
  sessions: string,
  files: ProviderFiles,
  probe: ProcessProbe,
): Promise<ClaudeRegistry> {
  const live = new Map<string, ClaudeRegistryEntry>();

  const listing = await files.listDirectory(sessions);
  // Absent is the normal state of a store no Claude Code process has run in.
  if (listing.kind === 'missing') return { live, problems: [] };
  // Present and unreadable is not. The directory is mode 0700, so a daemon
  // running as another user sees none of it and every session silently loses
  // its permission prompts — a misconfiguration only the user can fix, and one
  // they will never find if this stays quiet.
  if (listing.kind === 'failed') {
    return { live, problems: [{ subject: sessions, problem: listing.reason }] };
  }

  for (const dirent of listing.entries) {
    // Claude Code keeps `<pid>.<hash>.key` files in here too. The pid in the
    // name is not read: the entry states its own pid, and that is the one the
    // CLI itself acts on.
    if (dirent.kind !== 'file' || !dirent.name.endsWith(ENTRY_SUFFIX)) continue;

    const read = await files.readFile(join(sessions, dirent.name));
    if (read.kind !== 'read') continue;

    const entry = parseClaudeRegistryEntry(read.contents);
    // Silently. These files are rewritten on every status change, so a torn
    // read is routine and transient, and a problem that appears and vanishes
    // on its own teaches a user nothing.
    if (entry === null) continue;

    if (!(await isTheProcessItRegistered(entry, probe))) continue;
    keepTheCurrentOne(live, entry);
  }

  return { live, problems: [] };
}

/**
 * Alive, and the same process — the two halves that are worthless apart.
 *
 * Liveness is asked first and the date second on purpose: a process that exits
 * between the two questions cannot be dated, so the race resolves to "not
 * verified". It can cost a true claim and cannot manufacture a false one.
 */
async function isTheProcessItRegistered(
  entry: ClaudeRegistryEntry,
  probe: ProcessProbe,
): Promise<boolean> {
  if (!(await probe.isAlive(entry.pid))) return false;

  const startedAt = await probe.startedAt(entry.pid);
  // An undatable pid is precisely the pid a recycled one is indistinguishable
  // from, so it is refused rather than assumed innocent.
  if (startedAt === null) return false;

  return startedAt <= entry.startedAt + PID_RECYCLE_TOLERANCE_MS;
}

/**
 * A resumed session registers again under a new pid and the old file stays
 * behind, so one session can have several verified entries. Claude Code settles
 * this itself by sorting holders on `statusUpdatedAt` and taking the first;
 * this is the same rule, applied one entry at a time.
 */
function keepTheCurrentOne(
  live: Map<string, ClaudeRegistryEntry>,
  entry: ClaudeRegistryEntry,
): void {
  const seen = live.get(entry.sessionId);
  if (seen === undefined || (entry.statusUpdatedAt ?? 0) > (seen.statusUpdatedAt ?? 0)) {
    live.set(entry.sessionId, entry);
  }
}

export interface ResolvedObservation {
  readonly signal: TranscriptSignal;
  /** A live process this server verified, rather than one an entry claimed. */
  readonly running: boolean;
}

/**
 * The registry-first rule, in one pure function.
 *
 * `waiting` is Claude Code's word for blocked on a human, and it covers being
 * asked a question as much as being asked for permission — the entry's
 * `waitingFor` field is free-form display text ("input needed", "dialog open"),
 * typed as nothing more than a string, so it cannot narrow the two. So the
 * promotion is deliberately confined to `progressing`, the one reading the
 * transcript genuinely cannot make: an unanswered tool call plus a session
 * blocked on a human is a permission prompt. A transcript that already says a
 * turn ended is left alone, because turning that into a permission prompt would
 * spend the loudest state in the product on a session that is merely waiting to
 * be spoken to.
 *
 * `busy` is what makes `working` reachable — a verified live process, which is
 * the evidence AGX-17 had no way to get. `idle` and `shell` are not: Claude
 * Code reduces its own statuses as
 * `busy -> active, waiting -> blocked, everything else -> idle`, and a live
 * process sitting at its prompt is not work in progress.
 */
export function resolveWithRegistry(
  signal: TranscriptSignal,
  entry: Pick<ClaudeRegistryEntry, 'status'> | undefined,
): ResolvedObservation {
  switch (entry?.status) {
    case 'waiting':
      return { signal: signal === 'progressing' ? 'awaiting-permission' : signal, running: false };
    case 'busy':
      return { signal, running: true };
    default:
      return { signal, running: false };
  }
}
