import { z } from 'zod';
import type { TranscriptSignal } from './provider-adapter.js';

/**
 * The parser for one codex rollout.
 *
 * A rollout is JSONL, one JSON object per line, appended forever — the same
 * shape a Claude Code transcript has and almost nothing else in common. Every
 * line here is an envelope: a `timestamp`, a `type`, and a `payload` whose own
 * shape depends on the type. codex writes a dozen kinds into it — the
 * conversation (`response_item`), its own events (`event_msg`), and bookkeeping
 * (`world_state`, `turn_context`, `token_usage_record`) — and this parser reads
 * three facts out of the lot.
 *
 * Two differences from the Claude Code transcript drive everything below.
 *
 * **Every line is timestamped, including the bookkeeping.** The Claude parser
 * exists largely because Claude Code appends undated lines after the turn they
 * describe, so "the last line" is not "the last activity". Here it is: a
 * `token_usage_record` written after a tool call is the session doing
 * something. So `updatedAt` is simply the newest timestamp in the file, and
 * there is no correction to make.
 *
 * **A turn has an explicit beginning and end.** `task_started` opens one and
 * carries a `turn_id`; `task_complete` or `turn_aborted` closes it. That is a
 * far better signal than inferring from the shape of the last message, and it
 * is why this file does not look at message content at all. What it costs is
 * that the signal is coarse — see `signalOf`.
 *
 * Everything below parses; nothing casts. A line this parser does not
 * recognise contributes nothing rather than being trusted, which is what lets
 * the same code read a rollout from a codex older or newer than the one these
 * fixtures came from.
 */

/**
 * The envelope every line shares.
 *
 * Non-strict on purpose, and `payload` deliberately left `unknown`: the
 * envelope is the stable part and the payloads are where codex adds fields
 * between releases. A rollout from a newer CLI has to stay readable.
 */
const lineSchema = z.object({
  timestamp: z.iso.datetime(),
  type: z.string().min(1),
  payload: z.unknown(),
});

/**
 * The line codex opens a rollout with, and the only one that names the
 * session.
 *
 * The id is read here rather than off the file name. The name is
 * `rollout-<ISO-ish timestamp>-<uuid>.jsonl`, and the timestamp in it is
 * spelled with the same `-` the uuid uses, so recovering the id from the name
 * means counting separators and hoping. This is the same lesson Claude Code's
 * lossy per-project directory name taught one file over: the provider's own
 * statement of a fact beats an encoding of it in a path.
 */
const sessionMetaSchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

/** Written once per turn. Where a session that moved between turns says so. */
const turnContextSchema = z.object({ cwd: z.string().min(1).optional() });

/**
 * The three events that open and close a turn.
 *
 * `turn_aborted` is as load-bearing as `task_complete`. It is what codex
 * writes when the user presses escape, and a parser that knew only the happy
 * ending would report an interrupted session as working until somebody
 * touched it again.
 */
const turnEventSchema = z.object({
  type: z.enum(['task_started', 'task_complete', 'turn_aborted']),
  turn_id: z.string().min(1),
});

export interface CodexRollout {
  /**
   * codex's own id for this session, or `null` when no line in the file states
   * one. Unbranded: this is a parser, not a place ids are minted, and the
   * adapter is what turns it into a `SessionId` or refuses to.
   */
  readonly sessionId: string | null;
  /** Turns actually started. Zero of these means this file is not a session. */
  readonly turns: number;
  /** Epoch ms of the newest line, as codex dated it. */
  readonly updatedAt: number;
  readonly cwd: string | null;
  readonly signal: TranscriptSignal;
}

/**
 * Three answers, because a caller acts differently on each — the same split the
 * Claude transcript parser makes, for the same reason.
 *
 * `no-turns` is not a failure. codex creates a rollout when a session opens and
 * writes `session_meta` into it before the first turn exists, so a file caught
 * in that moment, or one whose session was abandoned there, holds no session.
 * `damaged` is the one case that earns a complaint.
 */
export type CodexRolloutParse =
  | { readonly ok: true; readonly rollout: CodexRollout }
  | { readonly ok: false; readonly reason: 'no-turns' }
  | { readonly ok: false; readonly reason: 'damaged'; readonly problem: string };

export function parseCodexRollout(contents: string): CodexRolloutParse {
  let lines = 0;
  let json = 0;
  let turns = 0;
  let updatedAt = 0;
  let sessionId: string | null = null;
  let cwd: string | null = null;
  const open = new Set<string>();
  let lastClose: 'task_complete' | 'turn_aborted' | null = null;

  for (const raw of contents.split('\n')) {
    if (raw.trim() === '') continue;
    lines += 1;

    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      // Dropped, not fatal. The newest line of a live rollout is routinely a
      // partial write: codex is appending while we read. Failing the file over
      // that would drop a session from the listing precisely while it was
      // busy, which is when somebody is looking at it.
      continue;
    }
    json += 1;

    const line = lineSchema.safeParse(entry);
    if (!line.success) continue;

    updatedAt = Math.max(updatedAt, Date.parse(line.data.timestamp));

    if (line.data.type === 'session_meta') {
      const meta = sessionMetaSchema.safeParse(line.data.payload);
      if (meta.success) {
        sessionId = meta.data.session_id;
        if (meta.data.cwd !== undefined) cwd = meta.data.cwd;
      }
      continue;
    }

    if (line.data.type === 'turn_context') {
      const context = turnContextSchema.safeParse(line.data.payload);
      if (context.success && context.data.cwd !== undefined) cwd = context.data.cwd;
      continue;
    }

    if (line.data.type !== 'event_msg') continue;

    const event = turnEventSchema.safeParse(line.data.payload);
    if (!event.success) continue;

    if (event.data.type === 'task_started') {
      turns += 1;
      open.add(event.data.turn_id);
      continue;
    }

    open.delete(event.data.turn_id);
    lastClose = event.data.type;
  }

  if (turns === 0) {
    return lines > 0 && json === 0
      ? { ok: false, reason: 'damaged', problem: `none of ${lines} lines is JSON` }
      : { ok: false, reason: 'no-turns' };
  }

  return {
    ok: true,
    rollout: { sessionId, turns, updatedAt, cwd, signal: signalOf(open, lastClose) },
  };
}

/**
 * What the file alone claims, and no more.
 *
 * `awaiting-permission` is unreachable here, and unlike the Claude adapter
 * there is nothing one file over that makes it reachable. codex writes no
 * approval event into the rollout at all: a session stopped at "Would you like
 * to run the following command?" and a session running a slow tool are the
 * same bytes on disk — a `task_started` with nothing that closes it. This was
 * captured rather than assumed; `codex-pending-tool-call.jsonl` is a rollout
 * taken with that prompt on screen. Claude Code escapes the same ambiguity
 * through a per-process registry that declares `waiting`, and codex 0.154.0
 * keeps no equivalent: the only per-session file beside the rollouts is a
 * zero-byte advisory lock under `thread-writer-locks/`, which holds no pid, no
 * start time and no status, and stays behind after the process that took it
 * dies. So `progressing` is the honest reading of both, and the product's
 * loudest state is simply not available for this provider.
 *
 * `unknown` is likewise never returned. For Claude Code it means "an assistant
 * turn that is not shaped like one"; here a turn is open or it is closed, and
 * there is no third shape to be confused by.
 */
function signalOf(
  open: ReadonlySet<string>,
  lastClose: 'task_complete' | 'turn_aborted' | null,
): TranscriptSignal {
  if (open.size > 0) return 'progressing';
  // Interrupted: the turn ended because the user stopped it, so nothing is
  // pending and nobody is being waited on. `quiet` is the same answer the
  // Claude parser gives an interrupted stream.
  if (lastClose === 'turn_aborted') return 'quiet';
  return 'awaiting-input';
}
