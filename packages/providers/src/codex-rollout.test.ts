import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITY_TEXT_MAX_CHARS } from '@agentplex/protocol';
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
        model: 'gpt-5.6-terra',
        // This capture is a question answered and no tool run. Its only
        // completed items are a `UserMessage` and an `AgentMessage`, whose
        // text the capture redacts, so there is nothing to report.
        activity: null,
      },
    });
  });

  it('names the model the captured session was actually running', () => {
    // Captured, not chosen: the `turn_context` codex wrote for this turn says
    // `model: "gpt-5.6-terra"`, and that is the string that comes out. Nothing
    // here maps it, shortens it or checks it against a list of models this
    // repository knows -- a model that ships tomorrow has to arrive the way
    // this one does.
    const parsed = parseCodexRollout(COMPLETED_TURN);

    expect(parsed.ok && parsed.rollout.model).toBe('gpt-5.6-terra');
  });

  it('prefers the model of the newest turn context it saw', () => {
    // Last wins, exactly as the cwd above it does, and for the same reason:
    // `/model` mid-session is ordinary and the question is what the session is
    // running now rather than what it opened on.
    const switched = [
      '{"timestamp":"2026-09-12T03:00:00.000Z","type":"session_meta","payload":{"session_id":"s-1"}}',
      '{"timestamp":"2026-09-12T03:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t-1"}}',
      '{"timestamp":"2026-09-12T03:00:02.000Z","type":"turn_context","payload":{"turn_id":"t-1","model":"gpt-5.6-terra"}}',
      '{"timestamp":"2026-09-12T03:00:03.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t-1"}}',
      '{"timestamp":"2026-09-12T03:00:04.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t-2"}}',
      '{"timestamp":"2026-09-12T03:00:05.000Z","type":"turn_context","payload":{"turn_id":"t-2","model":"gpt-5.6-terra-mini"}}',
      '{"timestamp":"2026-09-12T03:00:06.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t-2"}}',
    ].join('\n');

    expect(parseCodexRollout(switched)).toMatchObject({
      ok: true,
      rollout: { model: 'gpt-5.6-terra-mini' },
    });
  });

  it('reads the model off a turn context only, never off what a session_meta mentions', () => {
    // The captured `session_meta` below is the whole of `codex-no-turns.jsonl`
    // and it holds two strings that look like an answer and are not: a
    // `model_provider` of `openai`, and a `base_instructions.provenance.model`
    // of `gpt-5.6-terra`, which says which model wrote the instruction text
    // codex shipped rather than which model is answering here. A parser that
    // searched for a `model` key would report the provenance of a file as the
    // session's model and be right by accident for as long as the two happened
    // to agree. Two `event_msg` lines are appended because the fixture as
    // captured holds no turn at all -- see the refusal below -- and a rollout
    // has to be a session before it can have a model.
    const started = [
      '{"timestamp":"2026-09-12T02:42:30.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t-1"}}',
      '{"timestamp":"2026-09-12T02:42:31.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t-1"}}',
    ].join('\n');
    const parsed = parseCodexRollout(`${NO_TURNS}${started}\n`);

    expect(parsed.ok && parsed.rollout.turns).toBe(1);
    expect(parsed.ok && parsed.rollout.model).toBeNull();
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

  it('reports the command a session ran, as codex itself parsed it', () => {
    // `codex-pending-tool-call.jsonl` holds one `CommandExecution` item, and
    // the text comes out of its `parsed_cmd` -- codex's own reading of the
    // command line, which the capture leaves verbatim. The `command` array
    // beside it is the argv, and the capture redacts every element of it;
    // nothing here reads that field, on this fixture or on any other.
    //
    // The exit status is codex's `exit_code`, carried because the item's
    // status says the command finished. This one failed: it is a
    // `printf > probe.txt` under a read-only sandbox.
    //
    // The capture completes a `Reasoning` item after that command, which is
    // the assertion that an item holding no activity leaves the last one
    // standing rather than clearing it.
    const parsed = parseCodexRollout(PENDING_TOOL_CALL);

    expect(parsed.ok && parsed.rollout.activity).toEqual({
      kind: 'command',
      text: "printf 'hello' > probe.txt",
      exitStatus: 1,
    });
  });

  it('reports no activity for a turn the user interrupted before any tool ran', () => {
    // `codex-aborted-turn.jsonl` completes one item, a `UserMessage`. No
    // command ran, so there is no activity and that is not a fault: the
    // session still has its date, its usage and its signal.
    const parsed = parseCodexRollout(ABORTED_TURN);

    expect(parsed.ok && parsed.rollout.activity).toBeNull();
    expect(parsed.ok && parsed.rollout.signal).toBe('quiet');
  });

  it('never puts the capture’s redaction marker on the wire as activity text', () => {
    // The guard is structural rather than a string comparison. The fields the
    // capture replaces -- the argv in `command`, stdout, stderr, the agent's
    // own message text -- are fields this parser does not read, and
    // `parsed_cmd[].cmd` is one it leaves alone. A parser that grew a reach
    // into a redacted field fails here rather than shipping REDACTED to a
    // card.
    for (const captured of [COMPLETED_TURN, PENDING_TOOL_CALL, ABORTED_TURN]) {
      const parsed = parseCodexRollout(captured);
      const activity = parsed.ok ? parsed.rollout.activity : null;

      expect(activity === null || !JSON.stringify(activity).includes('REDACTED')).toBe(true);
    }
  });

  it('leaves the exit status off a command codex has not finished running', () => {
    // A `CommandExecution` whose status is still `in_progress` has no ending
    // to report, and an absent `exitStatus` is what the protocol already
    // means by "still running". Reporting the field anyway would turn a
    // running command into a finished one on every card showing it.
    const running = PENDING_TOOL_CALL.replaceAll('"status":"failed"', '"status":"in_progress"');
    const parsed = parseCodexRollout(running);

    expect(parsed.ok && parsed.rollout.activity).toEqual({
      kind: 'command',
      text: "printf 'hello' > probe.txt",
    });
  });

  it('keeps the newest command a rollout records, not the first', () => {
    // Latest wins, like the model and the cwd beside it. A card says what the
    // session is doing now.
    const later = lineOf(PENDING_TOOL_CALL, 'CommandExecution').replaceAll(
      "printf 'hello' > probe.txt",
      'ls -la',
    );
    const parsed = parseCodexRollout(`${PENDING_TOOL_CALL}${later}\n`);

    expect(parsed.ok && parsed.rollout.activity).toEqual({
      kind: 'command',
      text: 'ls -la',
      exitStatus: 1,
    });
  });

  it('joins a command codex parsed into several parts, in the order it wrote them', () => {
    // `parsed_cmd` is a list because codex splits a pipeline or a `&&` chain
    // into the commands it recognises. All of them are what ran, so all of
    // them are shown, in order.
    const chained = lineOf(PENDING_TOOL_CALL, 'CommandExecution').replaceAll(
      '[{"type":"unknown","cmd":"printf \'hello\' > probe.txt"}]',
      '[{"type":"unknown","cmd":"cd /tmp"},{"type":"unknown","cmd":"ls"}]',
    );
    const parsed = parseCodexRollout(`${PENDING_TOOL_CALL}${chained}\n`);

    expect(parsed.ok && parsed.rollout.activity).toEqual({
      kind: 'command',
      text: 'cd /tmp ls',
      exitStatus: 1,
    });
  });

  it('truncates a command past the protocol’s bound rather than losing it', () => {
    // A command line has no length limit and this field rides every session in
    // every store report. Truncating keeps a prefix of the truth on the card;
    // refusing would drop the activity of the one session somebody is looking
    // at, and the schema would refuse the string whole.
    const long = 'x'.repeat(500);
    const overlong = lineOf(PENDING_TOOL_CALL, 'CommandExecution').replaceAll(
      "printf 'hello' > probe.txt",
      long,
    );
    const parsed = parseCodexRollout(`${PENDING_TOOL_CALL}${overlong}\n`);

    expect(parsed.ok && parsed.rollout.activity).toEqual({
      kind: 'command',
      text: 'x'.repeat(ACTIVITY_TEXT_MAX_CHARS),
      exitStatus: 1,
    });
  });

  it('costs the activity and not the session when a command is unusable', () => {
    // A `parsed_cmd` whose only entry is characters no screen can draw leaves
    // nothing to show, and the protocol's schema refuses it. The rollout
    // around it is still a session, with its date, its model and its usage.
    const blank = PENDING_TOOL_CALL.replaceAll("printf 'hello' > probe.txt", '\\u0007\\u0007');
    const parsed = parseCodexRollout(blank);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.rollout.activity).toBeNull();
    expect(parsed.ok && parsed.rollout.model).toBe('gpt-5.6-terra');
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
    //
    // It is also the honest outcome for this fixture's model: no turn means no
    // `turn_context`, so there is nothing that states one, and the answer is
    // no session at all rather than a session carrying a model scraped off the
    // instruction provenance in its `session_meta`.
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

/**
 * Reads back a captured line so a test bends real output instead of inventing
 * one, named by the item type its payload carries.
 */
function lineOf(rollout: string, item: string): string {
  const found = rollout
    .split('\n')
    .filter((line) => line.includes(`"type":"${item}"`))
    .at(-1);
  if (found === undefined) throw new Error(`the fixture holds no ${item} line`);
  return found;
}
