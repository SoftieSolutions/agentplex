import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCodexRollout } from './codex-rollout.js';

/**
 * The fixtures are captured codex output, not shapes written from memory.
 *
 * Every one of them was produced by driving codex-cli 0.154.0 on this machine
 * against a throwaway `CODEX_HOME`, through a real pty for the interactive
 * ones, and taking the rollout file it wrote. Only leaf strings that carry
 * content — prompt and answer text, the model's base instructions, reasoning
 * ciphertext, tool input and output, and the absolute working directory of the
 * machine they were captured on — were replaced with `REDACTED`, which is the
 * treatment the Claude Code fixtures beside them already had. Every key, every
 * nesting level and every field this parser reads is exactly as codex wrote it.
 *
 * How each was provoked, because that is the part prose cannot reconstruct:
 *
 * - `codex-completed-turn.jsonl` — a question answered, the turn ended.
 * - `codex-pending-tool-call.jsonl` — a `printf > probe.txt` under a read-only
 *   sandbox, which stops codex on an approval prompt. The process was killed
 *   while that prompt was on screen, so the file is what a session blocked on
 *   a human looks like on disk.
 * - `codex-aborted-turn.jsonl` — a long turn interrupted with escape.
 * - `codex-no-turns.jsonl` — a session killed in the moment between codex
 *   creating the rollout and the first turn reaching it.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8');
}

const COMPLETED_TURN = fixture('codex-completed-turn.jsonl');
const PENDING_TOOL_CALL = fixture('codex-pending-tool-call.jsonl');
const ABORTED_TURN = fixture('codex-aborted-turn.jsonl');
const NO_TURNS = fixture('codex-no-turns.jsonl');

describe('parseCodexRollout', () => {
  it('reads a real rollout down to its session id, cwd and last write', () => {
    const parsed = parseCodexRollout(COMPLETED_TURN);

    expect(parsed).toEqual({
      ok: true,
      rollout: {
        sessionId: '01a09386-f378-7b23-83a7-6c263ed59701',
        turns: 1,
        updatedAt: Date.parse('2026-09-12T02:51:35.024Z'),
        cwd: '/Users/dev/Code/agentplex',
        signal: 'awaiting-input',
        usage: { inputTokens: 3380, cacheReadTokens: 9984, cacheWriteTokens: 0, outputTokens: 6 },
      },
    });
  });

  it('takes the session id out of the rollout rather than off the file name', () => {
    // The file is named `rollout-<ISO-ish timestamp>-<uuid>.jsonl`, and the
    // timestamp in that name carries the same `-` the uuid does, so splitting
    // the name is guesswork. `session_meta` states the id codex itself uses,
    // and that is the one `codex resume` answers to.
    const parsed = parseCodexRollout(COMPLETED_TURN);

    expect(parsed.ok && parsed.rollout.sessionId).toBe('01a09386-f378-7b23-83a7-6c263ed59701');
  });

  it('calls a turn that started and never finished progressing', () => {
    // On disk this is a session stopped at an approval prompt. It is also
    // exactly what a session running a slow tool looks like: codex writes no
    // approval event of any kind, so the honest reading is the one that does
    // not claim to know which.
    const parsed = parseCodexRollout(PENDING_TOOL_CALL);

    expect(parsed.ok && parsed.rollout.signal).toBe('progressing');
  });

  it('calls an interrupted turn quiet rather than leaving it progressing', () => {
    // `turn_aborted` is codex saying the turn is over and nothing is pending.
    // A parser that only knew `task_complete` would report this session as
    // working for as long as it sat there.
    const parsed = parseCodexRollout(ABORTED_TURN);

    expect(parsed.ok && parsed.rollout.signal).toBe('quiet');
  });

  it('dates a session by the newest line codex wrote, not by the newest turn', () => {
    // Unlike a Claude Code transcript, every line here carries its own
    // timestamp, including the bookkeeping ones. `token_usage_record` after a
    // tool call is the session doing something, so the last line is the last
    // activity and there is nothing to correct for.
    const parsed = parseCodexRollout(PENDING_TOOL_CALL);

    expect(parsed.ok && parsed.rollout.updatedAt).toBe(Date.parse('2026-09-12T02:37:44.589Z'));
  });

  it('takes the thread total codex keeps rather than adding the records up', () => {
    // The difference from Claude Code that shapes both parsers. codex writes a
    // running `thread_token_usage` onto every `token_usage_record`, so the
    // last record is the session total and there is nothing to accumulate --
    // where the Claude transcript states no total anywhere and its parser has
    // to sum and deduplicate to get one. This fixture holds two records for
    // one turn: the first thread total is 13612 input, the second 27382, and
    // only the second is the answer. Summing the per-response `usage` lines
    // would reach it the long way and be wrong the moment codex compacts.
    const parsed = parseCodexRollout(PENDING_TOOL_CALL);

    expect(parsed.ok && parsed.rollout.usage).toEqual({
      inputTokens: 7414,
      cacheReadTokens: 19_968,
      cacheWriteTokens: 0,
      outputTokens: 259,
    });
  });

  it('takes the cached part out of the input total codex folds it into', () => {
    // codex's arithmetic is not Claude Code's. Its `input_tokens` is the whole
    // input with the cached part *inside* it -- the captured record reads
    // input 13364, cached 9984, output 6, total 13370, and 13364 + 6 is the
    // total, so the 9984 is a subset and not an addend. `SessionUsage`
    // means fresh input by `inputTokens`, because that is the bucket billed at
    // the full rate, so 13364 - 9984 = 3380 is what a price applies to. Adding
    // the two instead would price this session at roughly seven times its
    // cache-read cost, in the direction a spend figure must never fail.
    const parsed = parseCodexRollout(COMPLETED_TURN);
    const usage = parsed.ok ? parsed.rollout.usage : null;

    expect(usage).not.toBeNull();
    expect(usage === null ? 0 : usage.inputTokens + usage.cacheReadTokens).toBe(13_364);
    expect(usage?.cacheReadTokens).toBe(9984);
  });

  it('reports no usage rather than zero for a turn that recorded none', () => {
    // Captured, not contrived: a turn the user interrupted with escape closes
    // with `turn_aborted` and no `token_usage_record` reaches the file at all.
    // That session cost something or nothing and the rollout does not say
    // which, which is a different fact from a session that cost zero -- and
    // the surfaces above have to render it as absence, not as free.
    const parsed = parseCodexRollout(ABORTED_TURN);

    expect(parsed.ok && parsed.rollout.turns).toBe(1);
    expect(parsed.ok && parsed.rollout.usage).toBeNull();
  });

  it('never reports a negative count, whatever the record claims', () => {
    // These numbers are a claim read off disk like any other. A codex that
    // changed what `input_tokens` includes would otherwise hand a negative
    // count to whatever prices it, which is a negative bill produced by the
    // one component whose job was to refuse exactly this.
    const impossible = JSON.stringify({
      timestamp: '2026-09-12T02:51:36.000Z',
      type: 'token_usage_record',
      payload: {
        thread_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 400,
          cache_write_input_tokens: 0,
          output_tokens: 5,
        },
      },
    });
    const parsed = parseCodexRollout(`${COMPLETED_TURN}${impossible}\n`);

    expect(parsed.ok && parsed.rollout.usage).toEqual({
      inputTokens: 0,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      outputTokens: 5,
    });
  });

  it('refuses a rollout with no turn in it, without calling it broken', () => {
    // codex creates the file when the session opens and writes `session_meta`
    // into it before the first turn exists. A file caught in that moment is
    // not a session and is not a fault.
    const parsed = parseCodexRollout(NO_TURNS);

    expect(parsed).toEqual({ ok: false, reason: 'no-turns' });
  });

  it('refuses an empty file the same way', () => {
    expect(parseCodexRollout('')).toEqual({ ok: false, reason: 'no-turns' });
  });

  it('drops a half-written last line rather than the rollout holding it', () => {
    // codex appends while we read. A torn final line is the normal state of a
    // live session, and failing the file over one would drop a session from
    // the listing precisely while it was busy.
    const parsed = parseCodexRollout(`${COMPLETED_TURN}{"timestamp":"2026-09-12T02`);

    expect(parsed).toMatchObject({ ok: true, rollout: { signal: 'awaiting-input' } });
  });

  it('says so when nothing in the file is JSON at all', () => {
    const parsed = parseCodexRollout('not json\nstill not json\n');

    expect(parsed).toEqual({
      ok: false,
      reason: 'damaged',
      problem: 'none of 2 lines is JSON',
    });
  });

  it('ignores lines it does not recognise instead of refusing the file', () => {
    // A newer codex adding a line type has to leave an older agentplex able to
    // read the file. What a turn is, is decided by what the parser recognises,
    // never by rejecting what it does not.
    const parsed = parseCodexRollout(
      `{"timestamp":"2030-01-01T00:00:00.000Z","type":"a_line_type_from_the_future","payload":{"whatever":true}}\n${COMPLETED_TURN}`,
    );

    expect(parsed).toMatchObject({ ok: true, rollout: { turns: 1 } });
  });

  it('prefers the working directory of the newest turn context it saw', () => {
    // `session_meta` records where the session opened; a `turn_context` is
    // written per turn and is where a session that moved says so.
    const moved = [
      '{"timestamp":"2026-09-12T03:00:00.000Z","type":"session_meta","payload":{"session_id":"s-1","cwd":"/Users/dev/Code/one"}}',
      '{"timestamp":"2026-09-12T03:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t-1"}}',
      '{"timestamp":"2026-09-12T03:00:02.000Z","type":"turn_context","payload":{"turn_id":"t-1","cwd":"/Users/dev/Code/two"}}',
      '{"timestamp":"2026-09-12T03:00:03.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t-1"}}',
    ].join('\n');

    expect(parseCodexRollout(moved)).toMatchObject({
      ok: true,
      rollout: { cwd: '/Users/dev/Code/two' },
    });
  });

  it('reports no session id when no line in the rollout states one', () => {
    // A rollout whose `session_meta` was lost still parses; what it cannot do
    // is say which session it is, and the caller has to be told that rather
    // than handed a guess made out of a file name.
    const headless = [
      '{"timestamp":"2026-09-12T03:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t-1"}}',
      '{"timestamp":"2026-09-12T03:00:03.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t-1"}}',
    ].join('\n');

    expect(parseCodexRollout(headless)).toMatchObject({
      ok: true,
      rollout: { sessionId: null, cwd: null },
    });
  });

  it('keeps a session progressing while any of its turns is still open', () => {
    // Two turns, the second still running. Tracking a single "last event"
    // would call this finished the moment the first one completed.
    const overlapping = [
      '{"timestamp":"2026-09-12T03:00:00.000Z","type":"session_meta","payload":{"session_id":"s-1","cwd":"/Users/dev/Code/one"}}',
      '{"timestamp":"2026-09-12T03:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t-1"}}',
      '{"timestamp":"2026-09-12T03:00:02.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t-2"}}',
      '{"timestamp":"2026-09-12T03:00:03.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t-1"}}',
    ].join('\n');

    expect(parseCodexRollout(overlapping)).toMatchObject({
      ok: true,
      rollout: { turns: 2, signal: 'progressing' },
    });
  });
});
