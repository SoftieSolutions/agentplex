import { join } from 'node:path';
import { sessionIdSchema, type SessionId } from '@agentplex/protocol';
import { z } from 'zod';
import type { ProcessProbe } from './process-probe.js';
import type { DiscoveryProblem, ProcessPhase, TranscriptSignal } from './provider-adapter.js';
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
 * How long before its entry's `startedAt` a process may have started and still
 * be the one that wrote the entry, for a caller about to signal it.
 *
 * Discovery bounds a start only from above (`PID_RECYCLE_TOLERANCE_MS`), which
 * is enough to refuse a recycled pid and not enough to refuse a process that
 * has held the same pid since *before* the entry was written: on a store two
 * machines share, the other machine's entries name pids this machine's own
 * unrelated processes may hold. Reading such a process as the session's costs
 * a status; signalling it would end somebody's editor. So a signal also needs
 * the process to have started in the beat before it registered.
 *
 * Measured rather than guessed. Claude Code 2.1.287, started nine times on a
 * developer's Mac, wrote `startedAt` 754 to 959 ms after its process was
 * forked, and `ps` dates a process to the whole second below, so a genuine
 * entry reads at most about two seconds after its process here (the captured
 * fixture reads 1669 ms). Ten seconds is five times that, for a start on a
 * loaded machine; it still refuses any process older than ten seconds before
 * the entry, which is where an unrelated holder of the pid would sit.
 *
 * Only `liveProcess` applies it, and deliberately not the scan in
 * `readClaudeRegistry`: there, a real claude that registered late reading as no
 * process would invite a resume onto a transcript it is still writing, which is
 * the unsafe direction for that caller.
 */
export const CLAUDE_REGISTRATION_WINDOW_MS = 10_000;

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
  /**
   * Where the process was started, verbatim. Read only to list a session no
   * transcript describes yet, and optional for the reason `status` is: an
   * entry that cannot say where still names a process and a session.
   */
  cwd: z.string().min(1).optional().catch(undefined),
  /** Epoch ms at which this entry was written, a beat after its process began. */
  startedAt: z.number().int().positive(),
  status: z.enum(CLAUDE_REGISTRY_STATUSES).optional().catch(undefined),
  /** Epoch ms of the last status change. Settles which of two entries is current. */
  statusUpdatedAt: z.number().int().nonnegative().optional().catch(undefined),
});

export interface ClaudeRegistryEntry {
  readonly pid: number;
  readonly sessionId: SessionId;
  readonly cwd?: string | undefined;
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
  /**
   * Sessions an entry names under a live pid this server could not date.
   *
   * Such a pid is as likely the session's own process as a recycled one, so it
   * proves neither that the session runs nor that it does not. Kept per
   * session because the entry was read and says which session it is about;
   * every other session in the store is still answered by the look.
   */
  readonly inDoubt: ReadonlySet<string>;
  readonly problems: readonly DiscoveryProblem[];
  /**
   * Whether this server saw every entry in the registry.
   *
   * `false` for a directory that is there and cannot be listed, and for one
   * holding an entry that would not read or would not parse. An absent
   * directory is a look that found no process, because Claude Code writes an
   * entry for every process it starts; an unlistable one is no look, and an
   * entry that cannot be read could name any session in the store. Either way
   * a session missing from `live` then says nothing about whether it runs.
   */
  readonly readable: boolean;
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
  const inDoubt = new Set<string>();

  const listing = await files.listDirectory(sessions);
  // Absent is the normal state of a store no Claude Code process has run in.
  if (listing.kind === 'missing') return { live, inDoubt, problems: [], readable: true };
  // Present and unreadable is not. The directory is mode 0700, so a daemon
  // running as another user sees none of it and every session silently loses
  // its permission prompts — a misconfiguration only the user can fix, and one
  // they will never find if this stays quiet.
  if (listing.kind === 'failed') {
    return {
      live,
      inDoubt,
      problems: [{ subject: sessions, problem: listing.reason }],
      readable: false,
    };
  }

  let sawEveryEntry = true;
  for (const dirent of listing.entries) {
    // Claude Code keeps `<pid>.<hash>.key` files in here too. The pid in the
    // name is not read: the entry states its own pid, and that is the one the
    // CLI itself acts on.
    if (dirent.kind !== 'file' || !dirent.name.endsWith(ENTRY_SUFFIX)) continue;

    const read = await files.readFile(join(sessions, dirent.name));
    // Removed since the listing: an entry that is no longer there names no
    // process, the same as one that was never written.
    if (read.kind === 'missing') continue;

    const entry = read.kind === 'read' ? parseClaudeRegistryEntry(read.contents) : null;
    // Silently. These files are rewritten on every status change, so a torn
    // read is routine and transient, and a problem that appears and vanishes
    // on its own teaches a user nothing. It still costs the look its
    // completeness: until the file is read, it could name any session here.
    if (entry === null) {
      sawEveryEntry = false;
      continue;
    }

    const verdict = await whichProcessItIs(entry, probe);
    if (verdict === 'registered') keepTheCurrentOne(live, entry);
    else if (verdict === 'undatable') inDoubt.add(entry.sessionId);
  }

  return { live, inDoubt, problems: [], readable: sawEveryEntry };
}

/**
 * Alive, and the same process — the two halves that are worthless apart.
 *
 * `gone` is a verified answer: the pid is dead, or it was issued again after
 * the entry was written. `undatable` is no answer at all.
 *
 * Liveness is asked first and the date second on purpose: a process that exits
 * between the two questions cannot be dated, so the race resolves to
 * `undatable`. It can cost a true claim and cannot manufacture a false one.
 */
async function whichProcessItIs(
  entry: ClaudeRegistryEntry,
  probe: ProcessProbe,
): Promise<'registered' | 'gone' | 'undatable'> {
  if (!(await probe.isAlive(entry.pid))) return 'gone';

  const startedAt = await probe.startedAt(entry.pid);
  // An undatable pid is precisely the pid a recycled one is indistinguishable
  // from, so it is refused as proof of a process, and as proof of none.
  if (startedAt === null) return 'undatable';

  return startedAt <= entry.startedAt + PID_RECYCLE_TOLERANCE_MS ? 'registered' : 'gone';
}

/**
 * Whether the process holding an entry's pid right now is the one that wrote
 * it, bounded from both sides: no later than the entry allows a genuine
 * process to have started, and no earlier than `CLAUDE_REGISTRATION_WINDOW_MS`
 * before it registered.
 *
 * Asked fresh, liveness first and date second for the reason
 * `whichProcessItIs` gives, so a process that exits between the two answers
 * `false`. Any doubt is `false`: this is the check a signal waits on.
 */
export async function registeredJustAfterStarting(
  entry: Pick<ClaudeRegistryEntry, 'pid' | 'startedAt'>,
  probe: ProcessProbe,
): Promise<boolean> {
  if (!(await probe.isAlive(entry.pid))) return false;
  const startedAt = await probe.startedAt(entry.pid);
  if (startedAt === null) return false;
  return (
    startedAt <= entry.startedAt + PID_RECYCLE_TOLERANCE_MS &&
    startedAt >= entry.startedAt - CLAUDE_REGISTRATION_WINDOW_MS
  );
}

/**
 * A registry status in the words a retake decides on.
 *
 * `shell` is a `!` command the human typed, still running, and it is
 * `working` here though `resolveWithRegistry` reads it as not running: status
 * follows Claude Code's own reduction of it to idle, and a retake must not,
 * because ending the process ends the command. Claude Code 2.1.287 was seen to
 * report such a command as `busy`, which reads the same. A status this build
 * does not know, or none, is `unknown`, which no caller may take as leave.
 */
export function phaseOf(status: ClaudeRegistryStatus | undefined): ProcessPhase {
  switch (status) {
    case 'busy':
    case 'shell':
      return 'working';
    case 'idle':
      return 'idle';
    case 'waiting':
      return 'waiting';
    case undefined:
      return 'unknown';
  }
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
