import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  parseHubFrame,
  parseTextFrame,
  providerSchema,
  sessionRefSchema,
  type MachineState,
} from '@agentplex/protocol';
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
    expect(resumeMemoryOf(memories, SPIKE)).toEqual({ ran: false, start: FIRST });
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
    const held = rememberState(asked, stateFrom(hubFrames.machineStateResumed));
    expect(resumeMemoryOf(held, SPIKE)).toEqual({ ran: true, start: null });
  });

  it('keeps a start while the state shows nothing holding the session', () => {
    const asked = rememberCommand(NONE, startOf(SPIKE), FIRST);
    expect(rememberState(asked, stateFrom(hubFrames.machineStateResumable))).toBe(asked);
  });

  it('records a run once, and hands back the same memories after', () => {
    const ran = rememberRan(NONE, SPIKE);
    expect(resumeMemoryOf(ran, SPIKE).ran).toBe(true);
    expect(rememberRan(ran, SPIKE)).toBe(ran);
  });
});
