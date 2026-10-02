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
    expect(resumeMemoryOf(memories, SPIKE)).toEqual({ ran: false, start: FIRST, lapsed: false });
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
    expect(resumeMemoryOf(held, SPIKE)).toEqual({ ran: true, start: null, lapsed: false });
  });

  it('keeps a start still owed its answer while the state shows nothing running it', () => {
    const asked = rememberCommand(NONE, startOf(SPIKE), FIRST);
    expect(rememberState(asked, stateFrom(hubFrames.machineStateResumable), NO_REPLIES)).toBe(
      asked,
    );
  });

  it('marks an answered start lapsed when a state after the answer shows nothing running it', () => {
    const asked = rememberCommand(NONE, startOf(SPIKE), FIRST);
    const replies = rememberAnswer(NO_REPLIES, replyFrom(hubFrames.sessionStartedResumed, FIRST));
    const lapsed = rememberState(asked, stateFrom(hubFrames.machineStateResumable), replies);
    expect(resumeMemoryOf(lapsed, SPIKE)).toEqual({ ran: false, start: FIRST, lapsed: true });

    // Asking again is a fresh start, owed its own answer.
    const again = rememberCommand(lapsed, startOf(SPIKE), frameIdSchema.parse(8));
    expect(resumeMemoryOf(again, SPIKE).lapsed).toBe(false);
  });

  it('records a run once, and hands back the same memories after', () => {
    const ran = rememberRan(NONE, SPIKE);
    expect(resumeMemoryOf(ran, SPIKE).ran).toBe(true);
    expect(rememberRan(ran, SPIKE)).toBe(ran);
  });
});
