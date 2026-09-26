import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SESSION_CWD_MAX_CHARS,
  SESSION_MODEL_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
} from '@agentplex/protocol';
import { claudeTranscriptActivities, parseClaudeTranscript } from './claude-transcript.js';

/**
 * The fixtures are captured Claude Code output, not shapes written from
 * memory. They were cut out of this repository's own transcripts under
 * `~/.claude/projects/-Users-robert-martinez-Code-agentplex/` (Claude Code
 * 2.1.259) by selecting whole lines and replacing only the payloads — prompt
 * text, assistant text, thinking blocks and their signatures, tool inputs,
 * tool results, the absolute cwd — with `REDACTED`. Every key, every nesting
 * level, every field this parser reads is exactly as Claude Code wrote it.
 * No prose records the format on purpose: the fixtures are the record, and
 * re-capturing them is how a format change is noticed.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8');
}

const COMPLETED_TURN = fixture('claude-completed-turn.jsonl');
const PENDING_TOOL_USE = fixture('claude-pending-tool-use.jsonl');
const NO_TURNS = fixture('claude-no-turns.jsonl');

/** The last turn in `claude-completed-turn.jsonl`, as Claude Code dated it. */
const LAST_TURN_AT = Date.parse('2026-09-03T02:03:10.027Z');

/**
 * The first turn in `claude-completed-turn.jsonl`: the opening `user` line.
 * The `last-prompt`, `mode` and `permission-mode` lines above it carry no
 * timestamp, and the `system` line after the last turn is not a turn.
 */
const FIRST_TURN_AT = Date.parse('2026-09-03T02:02:01.540Z');

/**
 * The two API responses in `claude-completed-turn.jsonl`, added up once each.
 *
 * Worked from the fixture by hand so the test states an answer rather than
 * restating the implementation's arithmetic. The file holds four `assistant`
 * lines and two `message.id`s: `msg_011CefgYDbysFQKShDzRPzGo` (input 2, cache
 * write 18438, cache read 24372, output 206) written across a `thinking` line
 * and a `tool_use` line, and `msg_011CefgcA32p8nbfPtSA8Dua` (input 2, cache
 * write 434, cache read 52820, output 1141) written across a `thinking` line
 * and a `text` line. Counting lines instead of responses gives exactly double
 * every number below.
 */
const COMPLETED_TURN_USAGE = {
  inputTokens: 4,
  cacheReadTokens: 77_192,
  cacheWriteTokens: 18_872,
  outputTokens: 1347,
};

describe('parseClaudeTranscript', () => {
  it('reads a real transcript down to its cwd, title and last turn', () => {
    const parsed = parseClaudeTranscript(COMPLETED_TURN);

    expect(parsed).toEqual({
      ok: true,
      transcript: {
        turns: 6,
        createdAt: FIRST_TURN_AT,
        updatedAt: LAST_TURN_AT,
        cwd: '/Users/dev/Code/agentplex',
        title: 'Docker compose without hub',
        signal: 'awaiting-input',
        usage: COMPLETED_TURN_USAGE,
        model: 'claude-opus-5',
        // The last turn of this capture ends in a `text` block, and the
        // capture redacts text. See the activity tests below.
        activity: null,
      },
    });
  });

  it('names the model the captured session was actually running', () => {
    // Captured, not chosen: every `assistant` line in this fixture carries
    // `message.model`, and this is the string Claude Code wrote there. Nothing
    // here maps it, shortens it or checks it against a list of models this
    // repository knows -- a model that ships tomorrow has to arrive the same
    // way this one does.
    const parsed = parseClaudeTranscript(COMPLETED_TURN);

    expect(parsed.ok && parsed.transcript.model).toBe('claude-opus-5');
  });

  it('keeps the model of the last assistant turn when a user turn follows it', () => {
    // The model is not read off the transcript's last turn, because the last
    // turn is routinely a user turn -- a prompt sent to a session that has not
    // answered yet -- and a user turn names no model. Reading it there would
    // blank the model of exactly the sessions that are busy.
    const user = JSON.stringify({
      ...(JSON.parse(lastLineOf(COMPLETED_TURN, 'user')) as Record<string, unknown>),
      timestamp: '2026-09-03T09:00:00.000Z',
    });
    const parsed = parseClaudeTranscript(`${COMPLETED_TURN}${user}\n`);

    expect(parsed.ok && parsed.transcript.model).toBe('claude-opus-5');
  });

  it('reports the model of the newest turn, not of the first', () => {
    // `/model` mid-session is ordinary, and the question this answers is what
    // the session is running now rather than what it started on. Last wins,
    // which is how the cwd is already read.
    const captured = JSON.parse(lastLineOf(COMPLETED_TURN, 'assistant')) as {
      message: Record<string, unknown>;
    };
    const switched = JSON.stringify({
      ...captured,
      timestamp: '2026-09-03T09:00:00.000Z',
      message: { ...captured.message, id: 'msg_switched', model: 'claude-haiku-4-5' },
    });
    const parsed = parseClaudeTranscript(`${COMPLETED_TURN}${switched}\n`);

    expect(parsed.ok && parsed.transcript.model).toBe('claude-haiku-4-5');
  });

  it('does not take the session’s model off a subagent sidechain', () => {
    // A `Task` subagent runs whatever model it was configured with, which is
    // routinely not the session's -- a cheap model doing a search inside a
    // session running an expensive one. Its tokens are this session's bill,
    // but its model is not this session's model.
    const captured = JSON.parse(lastLineOf(COMPLETED_TURN, 'assistant')) as {
      message: Record<string, unknown>;
    };
    const sidechain = JSON.stringify({
      ...captured,
      isSidechain: true,
      timestamp: '2026-09-03T09:00:00.000Z',
      message: { ...captured.message, id: 'msg_subagent', model: 'claude-haiku-4-5' },
    });
    const parsed = parseClaudeTranscript(`${COMPLETED_TURN}${sidechain}\n`);

    expect(parsed.ok && parsed.transcript.model).toBe('claude-opus-5');
  });

  it('reports no model rather than a likely one when no turn names one', () => {
    // A transcript from a Claude Code that did not record the model, and one
    // whose turns predate the field, must leave the model absent instead of
    // reaching for the provider's usual one. "Probably opus" beside a session
    // is a guess wearing a reading's clothes, and it is not an error either:
    // the transcript is otherwise perfectly readable.
    const stripped = COMPLETED_TURN.split('\n')
      .map((line) => line.replaceAll('"model":"claude-opus-5",', ''))
      .join('\n');
    const parsed = parseClaudeTranscript(stripped);

    expect(parsed.ok && parsed.transcript.turns).toBeGreaterThan(0);
    expect(parsed.ok && parsed.transcript.model).toBeNull();
  });

  it('clips a title longer than the descriptor carries, and keeps the session', () => {
    // An `ai-title` is written by a model, so its length is the model's to
    // choose. Past the bound it would fail the store report that carries every
    // session beside this one; clipped, it is still a fair name for the
    // session, and the session is still listed.
    const long = `${'Docker compose without hub '.repeat(20)}`;
    const parsed = parseClaudeTranscript(
      COMPLETED_TURN.replace('"aiTitle":"Docker compose without hub"', `"aiTitle":"${long}"`),
    );

    expect(parsed.ok).toBe(true);
    const title = parsed.ok ? parsed.transcript.title : null;
    expect(title?.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS);
    expect(title).toBe(title?.trim());
    expect(long.startsWith(title ?? '-')).toBe(true);
  });

  it('reports no title for one that is nothing but characters that cannot be drawn', () => {
    const parsed = parseClaudeTranscript(
      COMPLETED_TURN.replace(
        '"aiTitle":"Docker compose without hub"',
        '"aiTitle":"\\u202e\\u2066\\u200f"',
      ),
    );

    expect(parsed.ok && parsed.transcript.turns).toBeGreaterThan(0);
    expect(parsed.ok && parsed.transcript.title).toBeNull();
  });

  it('clips a model name longer than the descriptor carries', () => {
    const long = `claude-${'x'.repeat(SESSION_MODEL_MAX_CHARS * 2)}`;
    const parsed = parseClaudeTranscript(
      COMPLETED_TURN.replaceAll('"model":"claude-opus-5"', `"model":"${long}"`),
    );

    expect(parsed.ok && parsed.transcript.model).toBe(long.slice(0, SESSION_MODEL_MAX_CHARS));
  });

  it('reports no cwd rather than a prefix of one past the longest path there is', () => {
    // Not clipped, because a cwd is resumed in and read by git as well as
    // drawn, and a prefix of a path is a different directory.
    const long = `/${'d'.repeat(SESSION_CWD_MAX_CHARS)}`;
    const parsed = parseClaudeTranscript(
      COMPLETED_TURN.replaceAll('"cwd":"/Users/dev/Code/agentplex"', `"cwd":"${long}"`),
    );

    expect(parsed.ok && parsed.transcript.turns).toBeGreaterThan(0);
    expect(parsed.ok && parsed.transcript.cwd).toBeNull();
  });

  it('dates a session by its last turn, never by its last line', () => {
    // Claude Code appends bookkeeping lines — `cost-state`, `mode`,
    // `ai-title` — that carry no timestamp at all, and appends them after the
    // turn they describe. Anything that dated a session by "the last line" or
    // by the file's mtime would report activity for a session nobody has
    // spoken to, which is the one lie an attention list cannot afford.
    const parsed = parseClaudeTranscript(COMPLETED_TURN);

    expect(parsed.ok && parsed.transcript.updatedAt).toBe(LAST_TURN_AT);
  });

  it('dates the start of a session by its first turn', () => {
    // What a spawned terminal is joined to its session by. A session somebody
    // started an hour ago and wrote to a second ago is not the one a terminal
    // opened a moment ago created, and only the first write can tell them
    // apart: the last one moves every time anyone speaks.
    const parsed = parseClaudeTranscript(COMPLETED_TURN);

    expect(parsed.ok && parsed.transcript.createdAt).toBe(FIRST_TURN_AT);
  });

  it('ignores a subagent sidechain when dating the start of the session', () => {
    // A sidechain is the session's work but not its conversation, for the
    // start exactly as for the end.
    const sidechain = JSON.stringify({
      ...(JSON.parse(lastLineOf(COMPLETED_TURN, 'assistant')) as Record<string, unknown>),
      isSidechain: true,
      timestamp: '2026-09-03T01:00:00.000Z',
    });
    const parsed = parseClaudeTranscript(`${sidechain}\n${COMPLETED_TURN}`);

    expect(parsed.ok && parsed.transcript.createdAt).toBe(FIRST_TURN_AT);
  });

  it('calls a transcript that stops on an unanswered tool call progressing', () => {
    const parsed = parseClaudeTranscript(PENDING_TOOL_USE);

    expect(parsed.ok && parsed.transcript.signal).toBe('progressing');
  });

  it('reports the tool the last turn called as the session’s latest activity', () => {
    // `claude-pending-tool-use.jsonl` ends on an assistant turn whose last
    // block is a `tool_use` named `Bash`. The name is all there is: the
    // captured `input` is `{}`, because the capture redacts tool inputs, so
    // the activity says which tool and claims nothing about what it ran.
    const parsed = parseClaudeTranscript(PENDING_TOOL_USE);

    expect(parsed.ok && parsed.transcript.activity).toEqual({ kind: 'command', text: 'Bash' });
  });

  it('reports no activity for a turn that ended in text rather than inventing one', () => {
    // `claude-completed-turn.jsonl` ends on an assistant turn whose last block
    // is `text`, and every captured `text` payload is the string `REDACTED`.
    // A narration built out of that would be a line reading REDACTED on a
    // card. Absence is the honest answer, and it is also the answer a real
    // unredacted transcript gets today: this parser reads tool names and
    // nothing else. AGX-263 re-captures with inputs.
    const parsed = parseClaudeTranscript(COMPLETED_TURN);

    expect(parsed.ok && parsed.transcript.activity).toBeNull();
  });

  it('never puts the capture’s redaction marker on the wire as activity text', () => {
    // The guard is structural rather than a string comparison: the only field
    // this parser reads off a content block is `tool_use.name`, which the
    // capture leaves verbatim, and every payload the capture replaces --
    // prompts, assistant text, thinking, tool inputs, tool results -- is a
    // field it does not read. This asserts that across every captured
    // transcript, so a parser that grew a reach into a redacted field fails
    // here instead of shipping REDACTED to a card.
    for (const captured of [COMPLETED_TURN, PENDING_TOOL_USE]) {
      const parsed = parseClaudeTranscript(captured);
      const activity = parsed.ok ? parsed.transcript.activity : null;

      expect(activity === null || !JSON.stringify(activity).includes('REDACTED')).toBe(true);
    }
  });

  it('does not take the session’s activity off a subagent sidechain', () => {
    // The same rule the model and the date already follow. A `Task` subagent's
    // tool call is the session's work but not its conversation, and a subagent
    // still calling tools after the main turn ended would otherwise describe
    // the session by what something else is doing.
    const sidechain = JSON.parse(lastLineOf(PENDING_TOOL_USE, 'assistant')) as Record<
      string,
      unknown
    >;
    const parsed = parseClaudeTranscript(
      `${PENDING_TOOL_USE}${JSON.stringify({ ...sidechain, isSidechain: true })}\n`,
    );

    expect(parsed.ok && parsed.transcript.activity).toEqual({ kind: 'command', text: 'Bash' });
  });

  it('costs the activity and not the session when a tool name is unusable', () => {
    // A tool name long enough to blow the protocol's bound, or one that is
    // nothing but control characters, is refused by the activity schema. The
    // transcript around it is still a session, with its date, its model and
    // its usage intact.
    const captured = JSON.parse(lastLineOf(PENDING_TOOL_USE, 'assistant')) as Record<
      string,
      unknown
    > & { message: { content: { type: string }[] } };
    const blocks = captured.message.content.map((block) =>
      block.type === 'tool_use' ? { ...block, name: 'x'.repeat(400) } : block,
    );
    const overlong = JSON.stringify({
      ...captured,
      message: { ...captured.message, content: blocks },
    });
    const parsed = parseClaudeTranscript(`${PENDING_TOOL_USE}${overlong}\n`);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.transcript.activity).toBeNull();
    expect(parsed.ok && parsed.transcript.signal).toBe('progressing');
  });

  it('refuses a transcript with no turn in it, without calling it broken', () => {
    // Claude Code really does leave these behind: a session that was opened
    // and abandoned gets its `mode`, `permission-mode` and `ai-title` lines
    // and no turn. It is a file, not a session, and it is not a fault.
    const parsed = parseClaudeTranscript(NO_TURNS);

    expect(parsed).toEqual({ ok: false, reason: 'no-turns' });
  });

  it('drops a half-written last line rather than the transcript holding it', () => {
    // The newest line of a live transcript is routinely a partial write: the
    // provider is appending to it while we read. Failing the whole file over
    // that would make every session vanish from the listing exactly while it
    // was busy, which is when a user is looking at it.
    const parsed = parseClaudeTranscript(`${COMPLETED_TURN}{"type":"assistant","mess`);

    expect(parsed.ok && parsed.transcript.turns).toBe(6);
    expect(parsed.ok && parsed.transcript.updatedAt).toBe(LAST_TURN_AT);
  });

  it('names a file that holds no turn and no readable line as damaged', () => {
    // The one case worth a problem. A meta-only transcript and a corrupt one
    // both yield no session, and telling a user "nothing here" about a file
    // that is actually unreadable hides a real fault in their store.
    const parsed = parseClaudeTranscript('not json at all\nnor this\n');

    expect(parsed).toEqual({ ok: false, reason: 'damaged', problem: expect.any(String) });
  });

  it('treats an empty file as no turns rather than as damage', () => {
    expect(parseClaudeTranscript('')).toEqual({ ok: false, reason: 'no-turns' });
    expect(parseClaudeTranscript('\n\n')).toEqual({ ok: false, reason: 'no-turns' });
  });

  it('ignores a subagent sidechain when dating the session', () => {
    // A `Task` subagent's turns land in the parent's transcript with
    // `isSidechain: true`. They are the same session's work, but they are not
    // the conversation, and a sidechain that outlives the main turn would make
    // a finished session look like it was still going.
    const sidechain = JSON.stringify({
      ...(JSON.parse(lastLineOf(COMPLETED_TURN, 'assistant')) as Record<string, unknown>),
      isSidechain: true,
      timestamp: '2026-09-03T09:00:00.000Z',
    });
    const parsed = parseClaudeTranscript(`${COMPLETED_TURN}${sidechain}\n`);

    expect(parsed.ok && parsed.transcript.updatedAt).toBe(LAST_TURN_AT);
  });

  it('counts one API response once, however many lines Claude Code split it over', () => {
    // The finding this whole feature turns on, and it is captured rather than
    // assumed. Claude Code writes one line per *content block*, not per
    // response: a turn that thought and then called a tool is two `assistant`
    // lines carrying the same `message.id` and the same byte-identical `usage`
    // object. A sum over lines is not approximately right, it is exactly
    // double, and a cost figure built on it would bill every user twice.
    const parsed = parseClaudeTranscript(COMPLETED_TURN);

    expect(parsed.ok && parsed.transcript.usage).toEqual(COMPLETED_TURN_USAGE);
  });

  it('keeps cached input apart from fresh input', () => {
    // Not detail, and not a nicety. A cache read is billed around a tenth of
    // fresh input and a cache write above it, so one collapsed "input" number
    // does not lose precision -- it produces a figure several times the real
    // cost for exactly the long sessions anybody would look at. This fixture
    // is 99.99% cache: 2 fresh input tokens against 24372 read and 18438
    // written.
    const parsed = parseClaudeTranscript(PENDING_TOOL_USE);

    expect(parsed.ok && parsed.transcript.usage).toEqual({
      inputTokens: 2,
      cacheReadTokens: 24_372,
      cacheWriteTokens: 18_438,
      outputTokens: 206,
    });
  });

  it('reports no usage rather than zero when the transcript states none', () => {
    // The ticket's central rule, at the parser. A session that cost nothing
    // and a session whose file never said what it cost are different facts,
    // and only one of them is a number to put on a screen. Claude Code lines
    // with no `message.usage` at all -- every user turn, and every line from a
    // release that did not itemise -- must leave the total absent.
    const stripped = COMPLETED_TURN.split('\n')
      .filter((line) => !line.includes('"usage"'))
      .join('\n');
    const parsed = parseClaudeTranscript(stripped);

    expect(parsed.ok && parsed.transcript.turns).toBeGreaterThan(0);
    expect(parsed.ok && parsed.transcript.usage).toBeNull();
  });

  it('bills a subagent sidechain to the session that ran it', () => {
    // A sidechain is skipped for dating and for the signal -- it is not the
    // conversation -- but it is the session's bill. A `Task` subagent's tokens
    // are spent on this session's behalf and land on the same invoice, so
    // dropping them would under-report spend worst on the sessions that spend
    // most. Bent out of a captured line, given a message id of its own so it
    // is a second response rather than a duplicate of the one it came from.
    const captured = JSON.parse(lastLineOf(COMPLETED_TURN, 'assistant')) as {
      message: { id: string };
    };
    const sidechain = JSON.stringify({
      ...captured,
      isSidechain: true,
      requestId: 'req_subagent',
      message: { ...captured.message, id: 'msg_subagent' },
    });
    const parsed = parseClaudeTranscript(`${COMPLETED_TURN}${sidechain}\n`);

    expect(parsed.ok && parsed.transcript.usage).toEqual({
      inputTokens: COMPLETED_TURN_USAGE.inputTokens + 2,
      cacheReadTokens: COMPLETED_TURN_USAGE.cacheReadTokens + 52_820,
      cacheWriteTokens: COMPLETED_TURN_USAGE.cacheWriteTokens + 434,
      outputTokens: COMPLETED_TURN_USAGE.outputTokens + 1141,
    });
  });

  it('counts a response with no id of any kind rather than dropping it', () => {
    // An unkeyed line cannot be recognised as a duplicate of anything, so the
    // choice is between counting it once and dropping it. Under-reporting
    // spend is the direction that over-claims about a budget, so it counts.
    const captured = JSON.parse(lastLineOf(COMPLETED_TURN, 'assistant')) as Record<
      string,
      unknown
    > & { message: Record<string, unknown> };
    const { id: _id, ...message } = captured.message;
    const { requestId: _requestId, ...rest } = captured;
    const unkeyed = JSON.stringify({ ...rest, message });
    const parsed = parseClaudeTranscript(`${COMPLETED_TURN}${unkeyed}\n`);

    expect(parsed.ok && parsed.transcript.usage).toEqual({
      inputTokens: COMPLETED_TURN_USAGE.inputTokens + 2,
      cacheReadTokens: COMPLETED_TURN_USAGE.cacheReadTokens + 52_820,
      cacheWriteTokens: COMPLETED_TURN_USAGE.cacheWriteTokens + 434,
      outputTokens: COMPLETED_TURN_USAGE.outputTokens + 1141,
    });
  });

  it('has no opinion about a transcript whose entries it cannot recognise', () => {
    // Valid JSONL that is not Claude Code. Parsed, understood to hold no turn,
    // and reported as no session rather than guessed at.
    const parsed = parseClaudeTranscript('{"hello":"world"}\n{"type":"user"}\n');

    expect(parsed).toEqual({ ok: false, reason: 'no-turns' });
  });
});

describe('claudeTranscriptActivities', () => {
  it('reads every tool call the captured transcript records, oldest first', () => {
    // One tool call in `claude-completed-turn.jsonl`, and its name is the
    // whole of what the capture leaves readable: `input` is `{}`. The same
    // derivation the card's one line already makes, over every turn instead of
    // only the last one.
    const read = claudeTranscriptActivities(COMPLETED_TURN, 10);

    expect(read).toEqual({ activities: [{ kind: 'command', text: 'Bash' }], olderExist: false });
  });

  it('keeps the newest when there are more than the caller asked for', () => {
    // The request carries the bound, and what a reader wants is the end of the
    // conversation. Dropping from the front is what makes the answer the tail
    // rather than the beginning of a file nobody is looking at.
    const captured = JSON.parse(lastLineOf(PENDING_TOOL_USE, 'assistant')) as Record<
      string,
      unknown
    > & { message: { content: { type: string }[] } };
    const named = (name: string): string =>
      JSON.stringify({
        ...captured,
        message: {
          ...captured.message,
          content: captured.message.content.map((block) =>
            block.type === 'tool_use' ? { ...block, name } : block,
          ),
        },
      });
    const transcript = `${PENDING_TOOL_USE}${named('Edit')}\n${named('Read')}\n`;

    const read = claudeTranscriptActivities(transcript, 2);

    expect(read).toEqual({
      activities: [
        { kind: 'command', text: 'Edit' },
        { kind: 'command', text: 'Read' },
      ],
      olderExist: true,
    });
  });

  it('leaves a subagent’s tool calls out of the session’s transcript', () => {
    // The same rule the card's line already follows. A `Task` subagent's work
    // is the session's work and not its conversation, and a transcript view
    // interleaving both would show a session doing two things at once.
    const sidechain = JSON.parse(lastLineOf(PENDING_TOOL_USE, 'assistant')) as Record<
      string,
      unknown
    >;
    const read = claudeTranscriptActivities(
      `${PENDING_TOOL_USE}${JSON.stringify({ ...sidechain, isSidechain: true })}\n`,
      10,
    );

    expect(read.activities).toEqual([{ kind: 'command', text: 'Bash' }]);
  });

  it('costs one unusable tool name itself and keeps the rest of the transcript', () => {
    // An unreadable item in a listing costs itself, not the listing. A name
    // past the protocol's bound is refused by the activity schema, and the
    // tool calls either side of it are still what the session did.
    const captured = JSON.parse(lastLineOf(PENDING_TOOL_USE, 'assistant')) as Record<
      string,
      unknown
    > & { message: { content: { type: string }[] } };
    const overlong = JSON.stringify({
      ...captured,
      message: {
        ...captured.message,
        content: captured.message.content.map((block) =>
          block.type === 'tool_use' ? { ...block, name: 'x'.repeat(400) } : block,
        ),
      },
    });

    const read = claudeTranscriptActivities(`${PENDING_TOOL_USE}${overlong}\n`, 10);

    expect(read).toEqual({ activities: [{ kind: 'command', text: 'Bash' }], olderExist: false });
  });

  it('answers nothing for a transcript whose turns called no tool', () => {
    // Not a failure and not an empty file: a session that has only talked has
    // nothing this parser can honestly report, because every text payload the
    // capture holds is redacted.
    const read = claudeTranscriptActivities(NO_TURNS, 10);

    expect(read).toEqual({ activities: [], olderExist: false });
  });

  it('never puts the capture’s redaction marker into a transcript', () => {
    // The structural guard the card's line already has, applied to the whole
    // list: the only field read off a content block is `tool_use.name`, and
    // every payload the capture replaces is a field this parser does not read.
    for (const captured of [COMPLETED_TURN, PENDING_TOOL_USE]) {
      const read = claudeTranscriptActivities(captured, 200);

      expect(JSON.stringify(read.activities).includes('REDACTED')).toBe(false);
    }
  });
});

/** Reads back a captured line so a test bends real output instead of inventing it. */
function lastLineOf(transcript: string, type: string): string {
  const lines = transcript
    .split('\n')
    .filter((line) => line.includes(`"type":"${type}"`) && line.includes('"timestamp"'));
  const last = lines.at(-1);
  if (last === undefined) throw new Error(`the fixture holds no ${type} line`);
  return last;
}
