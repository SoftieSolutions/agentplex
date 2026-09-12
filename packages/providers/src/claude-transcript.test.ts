import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeTranscript } from './claude-transcript.js';

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
        updatedAt: LAST_TURN_AT,
        cwd: '/Users/dev/Code/agentplex',
        title: 'Docker compose without hub',
        signal: 'awaiting-input',
        usage: COMPLETED_TURN_USAGE,
      },
    });
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

  it('calls a transcript that stops on an unanswered tool call progressing', () => {
    const parsed = parseClaudeTranscript(PENDING_TOOL_USE);

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

/** Reads back a captured line so a test bends real output instead of inventing it. */
function lastLineOf(transcript: string, type: string): string {
  const lines = transcript
    .split('\n')
    .filter((line) => line.includes(`"type":"${type}"`) && line.includes('"timestamp"'));
  const last = lines.at(-1);
  if (last === undefined) throw new Error(`the fixture holds no ${type} line`);
  return last;
}
