import { z } from 'zod';
import type { TranscriptSignal } from './provider-adapter.js';

/**
 * The parser for one Claude Code transcript.
 *
 * A transcript is JSONL: one JSON object per line, appended forever. Claude
 * Code writes two kinds of line into it and agentplex must not confuse them.
 * *Turns* — `user` and `assistant` — are the conversation, and they carry a
 * timestamp, a cwd and the session id. Everything else is bookkeeping the CLI
 * keeps for its own resume and cost screens (`mode`, `permission-mode`,
 * `ai-title`, `last-prompt`, `cost-state`, `attachment`, `file-history-*`), and
 * most of it carries no timestamp at all. That asymmetry is the whole reason
 * this file exists: a session's last activity is the last *turn*, and reading
 * it off the last line — or off the file's mtime — reports activity for
 * sessions nobody has spoken to.
 *
 * Everything below parses; nothing casts. A line that is not an object this
 * parser recognises contributes nothing rather than being trusted, which is
 * what lets the same code read a transcript from a Claude Code older or newer
 * than the one these fixtures came from.
 */

/**
 * The fields a turn must have to count as one.
 *
 * Non-strict on purpose: Claude Code adds fields between releases, and a
 * transcript from a newer CLI must still be readable by an older agentplex.
 * The rule is that a turn is recognised by what it *has*, never rejected for
 * what it also has.
 */
const turnSchema = z.object({
  type: z.enum(['user', 'assistant']),
  /** The only place a per-entry time is recorded. A turn without one is not datable. */
  timestamp: z.iso.datetime(),
  cwd: z.string().min(1).optional(),
  /**
   * A `Task` subagent's turns land in its parent's transcript flagged this
   * way. They are the session's work but not its conversation, and a subagent
   * still running when the main turn ended would otherwise make a finished
   * session look busy.
   */
  isSidechain: z.boolean().optional(),
  message: z
    .object({
      stop_reason: z.string().nullish(),
      content: z
        .union([
          z.string(),
          z.array(z.object({ type: z.string(), id: z.string().optional() }).loose()),
        ])
        .optional(),
    })
    .loose()
    .optional(),
});

/** Claude Code's own name for a session, written and rewritten as it learns one. */
const titleSchema = z.object({
  type: z.literal('ai-title'),
  aiTitle: z.string().min(1),
});

export interface ClaudeTranscript {
  /** Turns actually recognised. Zero of these means this file is not a session. */
  readonly turns: number;
  /** Epoch ms of the newest turn, as Claude Code dated it. */
  readonly updatedAt: number;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly signal: TranscriptSignal;
}

/**
 * Three answers, because a caller acts differently on each.
 *
 * `no-turns` is not a failure: Claude Code leaves behind files for sessions
 * that were opened and abandoned, and telling a user about them as if they
 * were sessions is worse than saying nothing. `damaged` is the one case that
 * earns a complaint — a file with no turn *and* no readable line is
 * indistinguishable from an abandoned session unless we say so out loud.
 */
export type ClaudeTranscriptParse =
  | { readonly ok: true; readonly transcript: ClaudeTranscript }
  | { readonly ok: false; readonly reason: 'no-turns' }
  | { readonly ok: false; readonly reason: 'damaged'; readonly problem: string };

export function parseClaudeTranscript(contents: string): ClaudeTranscriptParse {
  let lines = 0;
  let json = 0;
  let turns = 0;
  let updatedAt = 0;
  let cwd: string | null = null;
  let title: string | null = null;
  let last: z.infer<typeof turnSchema> | null = null;
  const pendingToolUse = new Set<string>();

  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;
    lines += 1;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // Dropped, not fatal. The newest line of a live transcript is routinely
      // a partial write: the provider is appending while we read. Failing the
      // file over that would drop a session from the listing precisely while
      // it was busy, which is when somebody is looking at it.
      continue;
    }
    json += 1;

    const named = titleSchema.safeParse(entry);
    if (named.success) {
      title = named.data.aiTitle;
      continue;
    }

    const turn = turnSchema.safeParse(entry);
    if (!turn.success) continue;
    if (turn.data.isSidechain === true) continue;

    turns += 1;
    last = turn.data;
    updatedAt = Math.max(updatedAt, Date.parse(turn.data.timestamp));
    if (turn.data.cwd !== undefined) cwd = turn.data.cwd;
    trackToolUse(turn.data, pendingToolUse);
  }

  if (turns === 0 || last === null) {
    return lines > 0 && json === 0
      ? { ok: false, reason: 'damaged', problem: `none of ${lines} lines is JSON` }
      : { ok: false, reason: 'no-turns' };
  }

  return {
    ok: true,
    transcript: { turns, updatedAt, cwd, title, signal: signalOf(last, pendingToolUse) },
  };
}

/**
 * Keeps the tool calls that have not been answered yet.
 *
 * An assistant turn announces `tool_use` blocks by id; the user turn that
 * follows carries a `tool_result` per id. What is left over is what Claude
 * Code is stopped on right now.
 */
function trackToolUse(turn: z.infer<typeof turnSchema>, pending: Set<string>): void {
  const content = turn.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'tool_use' && typeof block.id === 'string') pending.add(block.id);
    if (block.type === 'tool_result') {
      const answered: unknown = block.tool_use_id;
      if (typeof answered === 'string') pending.delete(answered);
    }
  }
}

/**
 * What the file alone claims, and no more.
 *
 * `awaiting-permission` is deliberately never returned. On disk, a session
 * stopped at a permission prompt and a session running a long tool are the
 * same thing: an assistant `tool_use` with no `tool_result` after it. The spec
 * settles this above the adapter — the provider's own registry entry declares a
 * pending permission, and transcript inference is only the fallback — so
 * guessing here would put the loudest state in the product behind a coin flip.
 * `progressing` is the honest reading of both.
 */
function signalOf(last: z.infer<typeof turnSchema>, pending: Set<string>): TranscriptSignal {
  if (last.type === 'user') return 'progressing';

  const stop = last.message?.stop_reason;
  // Absent, rather than null: this is not an assistant turn shaped as one.
  if (stop === undefined) return 'unknown';
  // Null is an interrupted stream — the user pressed escape, or the CLI died
  // mid-message. Nothing is pending and nobody is being waited on.
  if (stop === null) return 'quiet';
  if (stop === 'tool_use') return 'progressing';
  // `end_turn`, and every other way a turn can end — `max_tokens`,
  // `stop_sequence`, `refusal`. They differ in why Claude stopped and not in
  // what happens next, which is that the session is waiting to be spoken to.
  return pending.size > 0 ? 'progressing' : 'awaiting-input';
}
