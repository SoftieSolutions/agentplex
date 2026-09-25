import { activitySchema, type Activity, type SessionUsage } from '@agentplex/protocol';
import { z } from 'zod';
import type { SessionTranscript, TranscriptSignal } from './provider-adapter.js';

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
 * What Claude Code records about one API response's token cost.
 *
 * Four disjoint counts, which is the happy case: `input_tokens` here is fresh
 * input only, with the cached part kept beside it rather than folded in, so
 * this maps onto `SessionUsage` without arithmetic. (codex does fold it in.
 * See `codex-rollout.ts`.) The cache fields are optional because a response
 * that neither read nor wrote the cache omits them, and absent means zero for
 * a count the provider is itemising -- unlike an absent `usage` object, which
 * means the line is not one that cost anything.
 *
 * Loose, and everything this parser does not price is left unread:
 * `output_tokens_details.thinking_tokens` and `server_tool_use` are real and
 * captured in the fixtures, and both are already inside a number above --
 * thinking tokens are output tokens, and a web search is billed per request
 * and not per token, which is a unit `SessionUsage` has nowhere to put and
 * would have to invent a second one for.
 */
const usageSchema = z
  .object({
    input_tokens: z.int().nonnegative(),
    cache_creation_input_tokens: z.int().nonnegative().optional(),
    cache_read_input_tokens: z.int().nonnegative().optional(),
    output_tokens: z.int().nonnegative(),
  })
  .loose();

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
   * Claude Code's id for the HTTP request the turn came out of. Read only as
   * the fallback key for counting a response once -- see `countUsageOnce`.
   */
  requestId: z.string().min(1).optional(),
  /**
   * A `Task` subagent's turns land in its parent's transcript flagged this
   * way. They are the session's work but not its conversation, and a subagent
   * still running when the main turn ended would otherwise make a finished
   * session look busy.
   */
  isSidechain: z.boolean().optional(),
  message: z
    .object({
      /**
       * The API's id for the response. One response is written across several
       * lines of this file and every one of them repeats the whole `usage`
       * object, so this is what makes it countable exactly once.
       */
      id: z.string().min(1).optional(),
      /**
       * The model that produced this response, as Claude Code names it --
       * `claude-opus-5` in the captured fixtures.
       *
       * Declared here rather than reached for through the `.loose()` below on
       * purpose: a field this parser reads is a field this parser parses, and
       * the alternative is casting an `unknown` off a loose object at the one
       * place this file exists to avoid casting. A line that states a `model`
       * of the wrong type costs itself, exactly as a line with a malformed
       * `usage` already does. Only assistant lines carry it at all, which is
       * why absence is ordinary here and not a fault.
       */
      model: z.string().min(1).optional(),
      usage: usageSchema.optional(),
      stop_reason: z.string().nullish(),
      content: z
        .union([
          z.string(),
          z.array(
            z
              .object({
                type: z.string(),
                id: z.string().optional(),
                /**
                 * Which tool a `tool_use` block calls -- `Bash`, `Edit`,
                 * `Read` -- as Claude Code names it.
                 *
                 * Declared here rather than reached for through the `.loose()`
                 * on purpose, the same argument `message.model` above makes: a
                 * field this parser reads is a field this parser parses. It is
                 * optional because every other block type omits it, which is
                 * ordinary and not a fault.
                 *
                 * The tool's `input` is deliberately still unread. It is where
                 * the command line, the file path and the diff live, and it is
                 * also the field the captured fixtures redact to `{}` -- so
                 * there is nothing here to write a test against and nothing to
                 * derive an `edit` or a `tests` activity from. AGX-263
                 * re-captures with inputs.
                 */
                name: z.string().optional(),
              })
              .loose(),
          ),
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
  /**
   * Epoch ms of the oldest turn, as Claude Code dated it: when the session
   * first said anything. Sidechains are left out for the reason they are left
   * out of `updatedAt`.
   */
  readonly createdAt: number;
  /** Epoch ms of the newest turn, as Claude Code dated it. */
  readonly updatedAt: number;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly signal: TranscriptSignal;
  /**
   * Every token this session has spent so far, or `null` when the file states
   * none.
   *
   * `null` and not a zeroed record. A transcript from a Claude Code that
   * stopped reporting usage, or one whose turns all predate it, has to be
   * distinguishable from a session that genuinely cost nothing, because the
   * surfaces above render the first as absence and the second as a number.
   */
  readonly usage: SessionUsage | null;
  /**
   * The model the newest turn of the conversation ran on, or `null` when no
   * turn names one.
   *
   * `null` is the honest answer for a transcript that never said, and it is
   * the only alternative to naming the model this provider usually runs --
   * which would be a guess printed on the one line whose job is to say what
   * is actually running. Nothing here interprets the string.
   */
  readonly model: string | null;
  /**
   * What this session was last seen doing, or `null` when the transcript says
   * nothing this parser can report honestly.
   *
   * `null` is the ordinary answer today rather than the exceptional one. See
   * `activityOf` for what a Claude Code transcript actually yields.
   */
  readonly activity: Activity | null;
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
  let createdAt = Number.POSITIVE_INFINITY;
  let updatedAt = 0;
  let cwd: string | null = null;
  let title: string | null = null;
  let model: string | null = null;
  let last: z.infer<typeof turnSchema> | null = null;
  let usage: SessionUsage | null = null;
  const pendingToolUse = new Set<string>();
  const counted = new Set<string>();

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

    // Before the sidechain filter, deliberately, and the only thing that is.
    // A `Task` subagent's turns are not the session's conversation -- which is
    // why they are skipped for dating and for the signal -- but they are the
    // session's bill. Tokens a subagent burned were spent on this session's
    // behalf and appear on the same invoice, and a count that dropped them
    // would under-report spend on exactly the sessions that spend most.
    usage = countUsageOnce(turn.data, usage, counted);

    if (turn.data.isSidechain === true) continue;

    turns += 1;
    last = turn.data;
    const at = Date.parse(turn.data.timestamp);
    // The minimum rather than the first turn's date, so the answer does not
    // rest on the order Claude Code appended its lines in.
    createdAt = Math.min(createdAt, at);
    updatedAt = Math.max(updatedAt, at);
    if (turn.data.cwd !== undefined) cwd = turn.data.cwd;
    // Last wins, like the cwd above it, and for the same reason: `/model`
    // mid-session is ordinary and the question is what this session is running
    // now, not what it started on. Below the sidechain filter deliberately --
    // a `Task` subagent runs whatever model it was configured with, routinely
    // a cheaper one than its parent, and its model is not this session's.
    // Read off every turn rather than off the last one, because the last turn
    // of a busy session is a user turn, which names no model and would blank
    // the field on exactly the sessions somebody is watching.
    if (turn.data.message?.model !== undefined) model = turn.data.message.model;
    trackToolUse(turn.data, pendingToolUse);
  }

  if (turns === 0 || last === null) {
    return lines > 0 && json === 0
      ? { ok: false, reason: 'damaged', problem: `none of ${lines} lines is JSON` }
      : { ok: false, reason: 'no-turns' };
  }

  return {
    ok: true,
    transcript: {
      turns,
      createdAt,
      updatedAt,
      cwd,
      title,
      signal: signalOf(last, pendingToolUse),
      usage,
      model,
      activity: activityOf(last),
    },
  };
}

/**
 * The one thing a captured Claude Code transcript says about what a session is
 * doing: which tool its last turn called.
 *
 * Read off the last non-sidechain turn, which is the same turn the date and
 * the signal come from, and for the same reason -- a `Task` subagent's tool
 * calls are the session's work but not its conversation, and describing a
 * session by what a subagent is doing is describing the wrong thing. Within
 * that turn the last block wins: Claude Code writes thinking, then text, then
 * the tool calls, in the order they happened, so the last one is the latest.
 *
 * What it can emit is `command`, and its `text` is the tool's *name*. That is
 * not a shorthand for the command line -- there is no command line here. The
 * tool's `input` is what holds one, and the captured fixtures redact it to
 * `{}`, so `Bash` is the whole of what this parser honestly knows. A card
 * saying `Bash` is true; a card saying anything more would be invented.
 *
 * What it can never emit today, and why:
 *
 * - `edit` and `tests` both need the tool's `input` -- the path, the counts,
 *   the command that ran the suite. Redacted in every captured fixture.
 * - `narration` needs the assistant's `text` block. Redacted in every
 *   captured fixture to the literal string `REDACTED`, and a narration
 *   reading REDACTED is worse than no narration at all. So a turn ending in
 *   text yields nothing, which is also why nothing here compares a string
 *   against the capture's marker: the redacted fields are simply not read.
 * - `approval` is not in the transcript at all. A session stopped at a
 *   permission prompt and one running a slow tool are the same bytes here --
 *   see `signalOf` -- and the registry one file over is what knows the
 *   difference.
 * - `plain` is the escape hatch for a line of text whose kind is unknown, and
 *   every line of text in a capture is redacted.
 *
 * AGX-263 re-captures the fixtures with tool inputs, and the variants above
 * become derivable there rather than guessed at here.
 */
function activityOf(last: z.infer<typeof turnSchema>): Activity | null {
  const content = last.message?.content;
  if (!Array.isArray(content)) return null;

  const block = content.at(-1);
  if (block?.type !== 'tool_use' || typeof block.name !== 'string') return null;

  // Parsed, not assembled. A tool name long enough to blow the protocol's
  // bound, or one that is nothing but characters a screen cannot draw, costs
  // this activity and nothing else: the session keeps its date, its model and
  // its usage, and the descriptor simply carries no activity.
  const activity = activitySchema.safeParse({ kind: 'command', text: block.name });
  return activity.success ? activity.data : null;
}

/**
 * The same transcript, read as everything it records rather than as the last
 * thing it records.
 *
 * A second pass over the file rather than a field on `ClaudeTranscript`,
 * because the two are asked at different times by different callers and cost
 * different amounts. Discovery runs `parseClaudeTranscript` over every session
 * in a store every couple of seconds and wants one line out of each; this runs
 * once, for one session, because somebody opened it — and it is handed the
 * *tail* of the file rather than the whole of it, so a parse that also tried to
 * total the tokens would be totalling a suffix and reporting it as a session's
 * spend.
 *
 * The derivation is the one the card's line already makes, applied to every
 * turn: a `tool_use` block becomes a `command` whose text is the tool's *name*.
 * That is not a shorthand for a command line — there is no command line here,
 * the tool's `input` is what holds one, and the captured fixtures redact it to
 * `{}`. The same five variants the card cannot reach are unreachable here for
 * the same reasons; `activityOf` below carries the list.
 *
 * Sidechains are skipped, exactly as they are for the date, the model and the
 * signal: a `Task` subagent's tool calls are the session's work but not its
 * conversation, and interleaving them would show one session doing two things
 * at once.
 *
 * Unlike `parseClaudeTranscript` this never refuses. A file with no turn in it
 * yields no activities, which is what a screen showing a transcript says out
 * loud; there is no reading of "this file is damaged" that a reader of a
 * *session's* activities would act on differently from "it did nothing yet".
 */
export function claudeTranscriptActivities(contents: string, limit: number): SessionTranscript {
  const activities: Activity[] = [];
  let dropped = false;

  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // The first line of a tail read is routinely half a line, and the last
      // line of a live transcript is routinely a partial write. Both cost
      // themselves, as they do in the parser above.
      continue;
    }

    const turn = turnSchema.safeParse(entry);
    if (!turn.success || turn.data.isSidechain === true) continue;

    for (const activity of turnActivities(turn.data)) {
      activities.push(activity);
      // Bounded as it goes rather than sliced at the end, so a transcript of
      // ten thousand tool calls is never ten thousand objects in memory on the
      // machine that has the file.
      if (activities.length > limit) {
        activities.shift();
        dropped = true;
      }
    }
  }

  return { activities, olderExist: dropped };
}

/**
 * Every tool call one turn made, in the order Claude Code wrote them.
 *
 * Every block rather than the last one, which is the one place this differs
 * from `activityOf`. The card's line answers "what is this session doing now",
 * so it takes the latest block and stops; a transcript answers "what did this
 * session do", and a turn that called three tools did three things.
 *
 * A block whose name the activity schema refuses — one past the protocol's
 * bound, or one that is nothing but characters a screen cannot draw — is
 * skipped. It costs itself and never the turn around it.
 */
function turnActivities(turn: z.infer<typeof turnSchema>): readonly Activity[] {
  const content = turn.message?.content;
  if (!Array.isArray(content)) return [];

  const found: Activity[] = [];
  for (const block of content) {
    if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
    const activity = activitySchema.safeParse({ kind: 'command', text: block.name });
    if (activity.success) found.push(activity.data);
  }
  return found;
}

/**
 * Adds one response's tokens to the running total, and refuses to add the same
 * response twice.
 *
 * This is the finding that makes the whole file necessary rather than a
 * one-line sum, and it was captured, not reasoned about. Claude Code writes
 * one *line* per content block, not per response: a turn that thought and then
 * called a tool is two `assistant` lines sharing one `message.id`, one
 * `requestId` and one byte-identical `usage` object. Summing per line is not
 * slightly high, it is a clean multiple -- both captured fixtures here double.
 *
 * So a response is keyed and counted once. `message.id` is the API's own name
 * for the response and is the right key; `requestId` is the fallback for a
 * line that omits it; a line with neither is counted on its own, because an
 * unkeyed line cannot be a duplicate of anything we could recognise and
 * dropping it would under-count. Under-counting spend is not the safe
 * direction here.
 *
 * Cumulative rather than per-turn, and cheap: the caller is already walking
 * every line for `updatedAt` and the signal, so this adds arithmetic to a pass
 * that was happening anyway and no second read of anything. codex hands its
 * adapter a running total and needs none of this -- see `codex-rollout.ts`.
 */
function countUsageOnce(
  turn: z.infer<typeof turnSchema>,
  total: SessionUsage | null,
  counted: Set<string>,
): SessionUsage | null {
  const reported = turn.message?.usage;
  // Absent, which is every user turn and every assistant line from a Claude
  // Code that did not itemise. Nothing to add, and nothing that turns a `null`
  // total into a zeroed one.
  if (reported === undefined) return total;

  const key = turn.message?.id ?? turn.requestId;
  if (key !== undefined) {
    if (counted.has(key)) return total;
    counted.add(key);
  }

  const base = total ?? {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  };
  return {
    inputTokens: base.inputTokens + reported.input_tokens,
    cacheReadTokens: base.cacheReadTokens + (reported.cache_read_input_tokens ?? 0),
    cacheWriteTokens: base.cacheWriteTokens + (reported.cache_creation_input_tokens ?? 0),
    outputTokens: base.outputTokens + reported.output_tokens,
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
