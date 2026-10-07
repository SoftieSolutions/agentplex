import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  parseHubFrame,
  parseTextFrame,
  providerSchema,
  sessionRefSchema,
  type FrameId,
  type MachineState,
} from '@agentplex/protocol';
import { NO_ANSWERS, rememberAnswer, type Reply } from './answers.js';
import { hubFrames } from './hub-frames.fixture.js';
import {
  NO_RESUME_MEMORY,
  rememberCommand,
  rememberNamed,
  rememberRan,
  rememberState,
  resumeMemoryOf,
  type ResumeMemories,
} from './resume-memory.js';

const SPIKE = sessionRefSchema.parse({
  storeId: 'store-agentplex',
  sessionId: 'session-spike-wasm',
});
const OTHER = sessionRefSchema.parse({ storeId: 'store-agentplex', sessionId: 'session-cli-run' });
const FIRST = frameIdSchema.parse(7);
const CLAUDE = providerSchema.parse('claude');

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') throw new Error('not a machine state');
  return parsed.value.state;
}

const NONE: ResumeMemories = new Map();
const NO_REPLIES = NO_ANSWERS.replies;

function replyFrom(text: string, replyTo: FrameId): Reply {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'session-started') throw new Error('not a start answer');
  return { ...parsed.value, replyTo };
}

function startOf(ref: typeof SPIKE) {
  return {
    type: 'session-start' as const,
    storeId: ref.storeId,
    sessionId: ref.sessionId,
    provider: CLAUDE,
    prompt: null,
    server: null,
    project: null,
  };
}

describe('resume memory', () => {
  it('knows nothing about a session nothing was said about', () => {
    expect(resumeMemoryOf(NONE, SPIKE)).toEqual(NO_RESUME_MEMORY);
  });

  it('remembers the start this page sent for a session, by that session', () => {
    const memories = rememberCommand(NONE, startOf(SPIKE), FIRST);
    expect(resumeMemoryOf(memories, SPIKE)).toEqual({
      ran: false,
      start: FIRST,
      lapsed: false,
      retake: false,
    });
    expect(resumeMemoryOf(memories, OTHER)).toEqual(NO_RESUME_MEMORY);
  });

  it('counts a session stopped from this page as one that ran', () => {
    const stop = { type: 'session-stop' as const, ...SPIKE };
    expect(resumeMemoryOf(rememberCommand(NONE, stop, FIRST), SPIKE).ran).toBe(true);
  });

  it('remembers nothing for a start that names no session', () => {
    const fresh = { ...startOf(SPIKE), sessionId: null };
    expect(rememberCommand(NONE, fresh, FIRST)).toBe(NONE);
  });

  it('forgets a start once a state shows the session held, and keeps that it ran', () => {
    const asked = rememberCommand(NONE, startOf(SPIKE), FIRST);
    const held = rememberState(asked, stateFrom(hubFrames.machineStateResumed), NO_REPLIES);
    expect(resumeMemoryOf(held, SPIKE)).toEqual({
      ran: true,
      start: null,
      lapsed: false,
      retake: false,
    });
  });

  it('keeps a start still owed its answer while the state shows nothing running it', () => {
    const asked = rememberCommand(NONE, startOf(SPIKE), FIRST);
    const kept = rememberState(asked, stateFrom(hubFrames.machineStateResumable), NO_REPLIES);
    expect(resumeMemoryOf(kept, SPIKE)).toEqual(resumeMemoryOf(asked, SPIKE));
  });

  it('marks an answered start lapsed when a state after the answer shows nothing running it', () => {
    const asked = rememberCommand(NONE, startOf(SPIKE), FIRST);
    const replies = rememberAnswer(NO_REPLIES, replyFrom(hubFrames.sessionStartedResumed, FIRST));
    const lapsed = rememberState(asked, stateFrom(hubFrames.machineStateResumable), replies);
    expect(resumeMemoryOf(lapsed, SPIKE)).toEqual({
      ran: false,
      start: FIRST,
      lapsed: true,
      retake: false,
    });

    // Asking again is a fresh start, owed its own answer.
    const again = rememberCommand(lapsed, startOf(SPIKE), frameIdSchema.parse(8));
    expect(resumeMemoryOf(again, SPIKE).lapsed).toBe(false);
  });

  it('lapses an answered start on a row that cannot tell whether anything runs it', () => {
    // A shared store's row says `unknown`, not `none`: a resume that exits
    // before its hold is reported still leaves the row unheld, and a pane
    // waiting for the holder would wait for ever.
    const shared = sessionRefSchema.parse({
      storeId: 'store-shared',
      sessionId: 'session-shared-notes',
    });
    const asked = rememberCommand(NONE, startOf(shared), FIRST);
    const replies = rememberAnswer(NO_REPLIES, replyFrom(hubFrames.sessionStartedShared, FIRST));
    const lapsed = rememberState(asked, stateFrom(hubFrames.machineStateResumable), replies);
    expect(resumeMemoryOf(lapsed, shared)).toMatchObject({ start: FIRST, lapsed: true });
  });

  it('lapses an answered start on a row something outside agentplex runs', () => {
    const asked = rememberCommand(NONE, startOf(OTHER), FIRST);
    const replies = rememberAnswer(NO_REPLIES, replyFrom(hubFrames.sessionStartedResumed, FIRST));
    const lapsed = rememberState(asked, stateFrom(hubFrames.machineStateResumable), replies);
    expect(resumeMemoryOf(lapsed, OTHER)).toMatchObject({ start: FIRST, lapsed: true });
  });

  it("files a retake as that session's start, owed its hold and lapsing without one", () => {
    // A session run outside agentplex has been seen running, so it reads as
    // ran. A retake of it is a start of that session: it waits for the hold,
    // a state before the answer that still shows the outside process does not
    // lapse it, and the answer followed by no hold does.
    const seen = rememberState(NONE, stateFrom(hubFrames.machineStateResumable), NO_REPLIES);
    const retake = { type: 'session-retake' as const, ...OTHER };
    const asked = rememberCommand(seen, retake, FIRST);
    expect(resumeMemoryOf(asked, OTHER)).toEqual({
      ran: true,
      start: FIRST,
      lapsed: false,
      retake: true,
    });

    const owed = rememberState(asked, stateFrom(hubFrames.machineStateResumable), NO_REPLIES);
    expect(resumeMemoryOf(owed, OTHER)).toEqual({
      ran: true,
      start: FIRST,
      lapsed: false,
      retake: true,
    });

    const replies = rememberAnswer(NO_REPLIES, replyFrom(hubFrames.sessionStartedResumed, FIRST));
    const lapsed = rememberState(asked, stateFrom(hubFrames.machineStateResumable), replies);
    expect(resumeMemoryOf(lapsed, OTHER)).toEqual({
      ran: true,
      start: FIRST,
      lapsed: true,
      retake: true,
    });

    // A resume pressed after it is a start and no longer a retake: a refusal
    // of it is a resume's to try again, not a retake's.
    const resumed = rememberCommand(lapsed, startOf(OTHER), frameIdSchema.parse(8));
    expect(resumeMemoryOf(resumed, OTHER)).toMatchObject({ start: 8, retake: false });
  });

  it('counts every session any state shows held or running as one that ran, pane or no pane', () => {
    const seen = rememberState(NONE, stateFrom(hubFrames.machineStateResumable), NO_REPLIES);
    // Run outside agentplex.
    expect(resumeMemoryOf(seen, OTHER).ran).toBe(true);
    // Nothing runs it, and nothing here has ever seen anything run it.
    expect(resumeMemoryOf(seen, SPIKE)).toEqual(NO_RESUME_MEMORY);

    const held = rememberState(seen, stateFrom(hubFrames.machineStateResumed), NO_REPLIES);
    expect(resumeMemoryOf(held, SPIKE)).toEqual({
      ran: true,
      start: null,
      lapsed: false,
      retake: false,
    });
    // And it stays seen once the holder has gone.
    const stopped = rememberState(held, stateFrom(hubFrames.machineStateResumable), NO_REPLIES);
    expect(resumeMemoryOf(stopped, SPIKE).ran).toBe(true);
    expect(stopped).toBe(held);
  });

  it("files a spawn under the session a frame named it as, as this page's start", () => {
    const named = new Map([
      ['start', { target: { by: 'start' as const, startId: FIRST }, session: SPIKE }],
      [
        'pending',
        { target: { by: 'start' as const, startId: frameIdSchema.parse(9) }, session: null },
      ],
      ['session', { target: { by: 'session' as const, ...OTHER }, session: OTHER }],
    ]);
    const memories = rememberNamed(NONE, named, null);
    expect(resumeMemoryOf(memories, SPIKE)).toEqual({
      ran: false,
      start: FIRST,
      lapsed: false,
      retake: false,
    });
    expect(resumeMemoryOf(memories, OTHER)).toEqual(NO_RESUME_MEMORY);
    // Publishing the same views again changes nothing.
    expect(rememberNamed(memories, named, null)).toBe(memories);
  });

  it('lapses a spawn named after a state that, after its answer, showed it unheld', () => {
    const spawned = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-spawned' });
    const named = new Map([
      ['start', { target: { by: 'start' as const, startId: FIRST }, session: spawned }],
    ]);
    const exited = stateFrom(hubFrames.machineStateSpawnExited);
    const answered = rememberAnswer(NO_REPLIES, replyFrom(hubFrames.sessionStarted, FIRST));

    // The state came first and found no start to lapse; the name files one
    // and holds it to that state, as the state would have.
    const before = rememberState(NONE, exited, answered);
    const lapsed = rememberNamed(before, named, { state: exited, replies: answered });
    expect(resumeMemoryOf(lapsed, spawned)).toEqual({
      ran: false,
      start: FIRST,
      lapsed: true,
      retake: false,
    });

    // A state from before the answer says nothing about this start.
    const early = rememberNamed(NONE, named, { state: exited, replies: NO_REPLIES });
    expect(resumeMemoryOf(early, spawned)).toEqual({
      ran: false,
      start: FIRST,
      lapsed: false,
      retake: false,
    });
  });

  it('leaves a session it already saw run, or already has a start for, as it was', () => {
    const named = new Map([
      ['start', { target: { by: 'start' as const, startId: FIRST }, session: SPIKE }],
    ]);
    const ran = rememberRan(NONE, SPIKE);
    expect(rememberNamed(ran, named, null)).toBe(ran);
    const asked = rememberCommand(NONE, startOf(SPIKE), frameIdSchema.parse(8));
    expect(rememberNamed(asked, named, null)).toBe(asked);
  });

  it('records a run once, and hands back the same memories after', () => {
    const ran = rememberRan(NONE, SPIKE);
    expect(resumeMemoryOf(ran, SPIKE).ran).toBe(true);
    expect(rememberRan(ran, SPIKE)).toBe(ran);
  });
});
