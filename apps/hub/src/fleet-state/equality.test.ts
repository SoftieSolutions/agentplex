import { describe, expect, it } from 'vitest';
import { sessionIdSchema, type SessionHold } from '@agentplex/protocol';
import { sameHolds } from './equality.js';

const hold = (overrides: Partial<SessionHold> = {}): SessionHold => ({
  sessionId: sessionIdSchema.parse('session-1'),
  stoppable: true,
  pause: 'none',
  ...overrides,
});

describe('sameHolds', () => {
  it('calls two identical lists the same', () => {
    expect(sameHolds([hold()], [hold()])).toBe(true);
    expect(sameHolds([], [])).toBe(true);
  });

  it('sees a session that changed hands or count', () => {
    expect(sameHolds([hold()], [])).toBe(false);
    expect(sameHolds([hold()], [hold({ sessionId: sessionIdSchema.parse('session-2') })])).toBe(
      false,
    );
  });

  it('sees a stop that became offerable', () => {
    expect(sameHolds([hold({ stoppable: false })], [hold({ stoppable: true })])).toBe(false);
  });

  it('sees a change that is only the pause: otherwise no client ever learns of one', () => {
    // This comparison is what decides whether a machine-state is published at
    // all. A pause changes nothing on disk and nothing about the stop, so
    // without this line a session could be paused, resumed and paused again
    // and every client would go on drawing it as running.
    expect(sameHolds([hold({ pause: 'none' })], [hold({ pause: 'requested' })])).toBe(false);
    expect(sameHolds([hold({ pause: 'requested' })], [hold({ pause: 'paused' })])).toBe(false);
    expect(sameHolds([hold({ pause: 'paused' })], [hold({ pause: 'none' })])).toBe(false);
  });
});
