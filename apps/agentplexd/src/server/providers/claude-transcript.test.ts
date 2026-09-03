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
 * `docs/` records nothing about the format on purpose: the fixtures are the
 * record, and re-capturing them is how a format change is noticed.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

const COMPLETED_TURN = fixture('claude-completed-turn.jsonl');
const PENDING_TOOL_USE = fixture('claude-pending-tool-use.jsonl');
const NO_TURNS = fixture('claude-no-turns.jsonl');

/** The last turn in `claude-completed-turn.jsonl`, as Claude Code dated it. */
const LAST_TURN_AT = Date.parse('2026-09-03T02:03:10.027Z');

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
