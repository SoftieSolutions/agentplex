import { describe, expect, it } from 'vitest';
import { frameIdSchema, type FrameId } from '@agentplex/protocol';
import {
  MAX_REMEMBERED_ANSWERS,
  followUp,
  newestAnswer,
  refusalTo,
  refusalToLatest,
  rememberAnswer,
  type Reply,
} from './answers.js';
import { hubFrames } from './hub-frames.fixture.js';
import { answersOf, replyFrom, withOutstanding } from './replies.fixture.js';

/**
 * The one correlation every screen waiting on the hub shares, against captured
 * replies: a stop that landed, a pause, a refusal a real hub sent, and a
 * document it answered an open with.
 */

const stopped = replyFrom(hubFrames.sessionStopped, 'session-stopped');
const paused = replyFrom(hubFrames.sessionPaused, 'session-paused');
const resumed = replyFrom(hubFrames.sessionResumed, 'session-resumed');
const refusal = replyFrom(hubFrames.refusalHeldBusy, 'refusal');
const docContent = replyFrom(hubFrames.docContent, 'doc-content');

function id(value: number): FrameId {
  return frameIdSchema.parse(value);
}

describe('rememberAnswer', () => {
  it('keeps a reply under the id of the frame it answers', () => {
    const answers = rememberAnswer(new Map(), stopped);
    expect(answers.get(stopped.replyTo)).toBe(stopped);
    expect(answers.size).toBe(1);
  });

  it('keeps a refusal the same way, under the frame it refused', () => {
    const answers = rememberAnswer(new Map(), refusal);
    expect(answers.get(refusal.replyTo)).toBe(refusal);
  });

  it('never changes the map it was given', () => {
    const before = new Map<FrameId, Reply>();
    const after = rememberAnswer(before, stopped);
    expect(before.size).toBe(0);
    expect(after).not.toBe(before);
  });

  it('keeps an answer to one frame when another is answered', () => {
    // The behaviour the single slots could not have: a refusal to frame N
    // survives a yes to frame N + 1.
    const { replies } = answersOf(refusal, { ...stopped, replyTo: id(99) });
    expect(replies.get(refusal.replyTo)).toBe(refusal);
    expect(replies.get(id(99))?.type).toBe('session-stopped');
  });

  it(`forgets the oldest past ${String(MAX_REMEMBERED_ANSWERS)}`, () => {
    let answers: ReadonlyMap<FrameId, Reply> = new Map();
    for (let n = 1; n <= MAX_REMEMBERED_ANSWERS + 2; n += 1) {
      answers = rememberAnswer(answers, { ...stopped, replyTo: id(n) });
    }
    expect(answers.size).toBe(MAX_REMEMBERED_ANSWERS);
    expect(answers.has(id(1))).toBe(false);
    expect(answers.has(id(2))).toBe(false);
    expect(answers.has(id(3))).toBe(true);
    expect(answers.has(id(MAX_REMEMBERED_ANSWERS + 2))).toBe(true);
  });

  it('holds one document body at a time, whatever else it holds', () => {
    // A body is up to a quarter of a million characters; sixty-four of them
    // would be a memory bound nobody chose.
    const first = { ...docContent, replyTo: id(40) };
    const second = { ...docContent, replyTo: id(41) };
    const { replies } = answersOf(first, stopped, second);
    expect(replies.has(id(40))).toBe(false);
    expect(replies.get(id(41))).toBe(second);
    expect(replies.get(stopped.replyTo)).toBe(stopped);
  });
});

describe('followUp', () => {
  const answers = answersOf(stopped, paused, refusal);

  it('is idle while nothing is pending', () => {
    expect(followUp(null, answers, 'session-stopped')).toEqual({ kind: 'idle' });
  });

  it('waits while nothing has answered the pending frame and it is still owed one', () => {
    expect(followUp(id(99), withOutstanding(answers, id(99)), 'session-stopped')).toEqual({
      kind: 'waiting',
    });
  });

  it('is idle for a frame that is neither answered nor owed an answer', () => {
    // Its answer was pushed out by later ones, or the connection it went out
    // on dropped before one came: either way nothing is coming, and a control
    // that read this as waiting would stay disabled until it was remounted.
    expect(followUp(id(99), answers, 'session-stopped')).toEqual({ kind: 'idle' });
  });

  it(`is idle once ${String(MAX_REMEMBERED_ANSWERS)} later replies have pushed its answer out`, () => {
    const others = Array.from({ length: MAX_REMEMBERED_ANSWERS }, (_, n) => ({
      ...stopped,
      replyTo: id(100 + n),
    }));
    const later = answersOf(paused, ...others);
    expect(later.replies.has(paused.replyTo)).toBe(false);
    expect(followUp(paused.replyTo, later, 'session-paused', 'session-resumed')).toEqual({
      kind: 'idle',
    });
  });

  it("is refused, in the hub's own words, when a refusal names the pending frame", () => {
    expect(followUp(refusal.replyTo, answers, 'session-stopped')).toEqual({
      kind: 'refused',
      words: refusal.message,
      refusal,
    });
  });

  it('is answered with the typed frame when the matching type names it', () => {
    const answered = followUp(stopped.replyTo, answers, 'session-stopped');
    expect(answered).toEqual({ kind: 'answered', answer: stopped });
  });

  it('waits when only a different frame has been answered', () => {
    const other = withOutstanding(answersOf({ ...stopped, replyTo: id(98) }), stopped.replyTo);
    expect(followUp(stopped.replyTo, other, 'session-stopped')).toEqual({ kind: 'waiting' });
  });

  it('takes any of several answer types', () => {
    const both = answersOf(paused, resumed);
    expect(followUp(paused.replyTo, both, 'session-paused', 'session-resumed')).toEqual({
      kind: 'answered',
      answer: paused,
    });
    expect(followUp(resumed.replyTo, both, 'session-paused', 'session-resumed')).toEqual({
      kind: 'answered',
      answer: resumed,
    });
  });

  it('waits when the pending frame was answered with a type it did not ask about', () => {
    expect(followUp(paused.replyTo, answers, 'session-stopped')).toEqual({ kind: 'waiting' });
  });
});

describe('refusalTo', () => {
  it('is the refusal to that frame, or null', () => {
    const answers = answersOf(stopped, refusal);
    expect(refusalTo(answers, refusal.replyTo)).toBe(refusal);
    expect(refusalTo(answers, stopped.replyTo)).toBeNull();
    expect(refusalTo(answers, null)).toBeNull();
  });
});

describe('refusalToLatest', () => {
  it('is the refusal when the most recent reply was one', () => {
    expect(refusalToLatest(answersOf(stopped, refusal))).toBe(refusal);
  });

  it('is null once a later command has been answered yes', () => {
    // The connection line says what became of the last request; a refusal
    // with a yes after it is still held for its own screen, but it is not that.
    expect(refusalToLatest(answersOf(refusal, stopped))).toBeNull();
    expect(refusalToLatest(answersOf())).toBeNull();
  });
});

describe('newestAnswer', () => {
  it('is the most recent reply of one type, whoever asked', () => {
    const later = { ...stopped, replyTo: id(70) };
    expect(newestAnswer(answersOf(stopped, refusal, later), 'session-stopped')).toBe(later);
    expect(newestAnswer(answersOf(refusal, stopped), 'refusal')).toBe(refusal);
  });

  it('is null when nothing of that type is held', () => {
    expect(newestAnswer(answersOf(stopped), 'refusal')).toBeNull();
  });
});
