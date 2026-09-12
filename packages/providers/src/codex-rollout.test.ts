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
