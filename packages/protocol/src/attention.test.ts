import { describe, expect, it } from 'vitest';
import type { SessionRow } from './machine-state.js';
import { sessionRowSchema } from './machine-state.js';
import { acknowledgementHolds, wantsAttention, wantsHuman } from './attention.js';

const UPDATED_AT = 1_756_000_000_000;

/**
 * A wire row, built through the schema rather than written as a literal.
 *
 * Which is the point of the test: the predicate has to hold over the row the
 * hub actually sends, so a field renamed on the schema fails here rather than
 * in whatever reads the predicate months later.
 */
function row(overrides: Partial<SessionRow> = {}): SessionRow {
  const parsed = sessionRowSchema.parse({
    descriptor: {
      storeId: 'store-a',
      sessionId: 'session-a',
      provider: 'claude',
      status: 'awaiting-permission',
      updatedAt: UPDATED_AT,
      cwd: '/home/dev/agentplex',
      branch: 'master',
      title: 'rename the widget',
      uncommitted: null,
    },
    source: 'registration-a',
    reportedBy: ['registration-a'],
    reportedAt: UPDATED_AT,
    reachable: true,
    holder: null,
    acknowledgedThrough: null,
    mutedAt: null,
    project: null,
    approvals: [],
    task: null,
  });
  return { ...parsed, ...overrides };
}

describe('wantsHuman', () => {
  it('is the two statuses a person has to answer', () => {
    expect(wantsHuman('awaiting-permission')).toBe(true);
    expect(wantsHuman('awaiting-input')).toBe(true);
  });

  it('is nothing else, including the status the adapter could not read', () => {
    expect(wantsHuman('working')).toBe(false);
    expect(wantsHuman('idle')).toBe(false);
    expect(wantsHuman('unknown')).toBe(false);
  });
});

describe('acknowledgementHolds', () => {
  it('does not hold when nobody has said they looked', () => {
    expect(acknowledgementHolds(null, UPDATED_AT)).toBe(false);
  });

  it('holds while the session has said nothing since', () => {
    expect(acknowledgementHolds(UPDATED_AT, UPDATED_AT)).toBe(true);
    expect(acknowledgementHolds(UPDATED_AT + 1, UPDATED_AT)).toBe(true);
  });

  it('stops holding the moment the provider writes again', () => {
    expect(acknowledgementHolds(UPDATED_AT, UPDATED_AT + 1)).toBe(false);
  });
});

describe('wantsAttention', () => {
  it('is true for an unacknowledged, unmuted, reachable prompt', () => {
    expect(wantsAttention(row())).toBe(true);
    expect(
      wantsAttention(row({ descriptor: { ...row().descriptor, status: 'awaiting-input' } })),
    ).toBe(true);
  });

  it('is false for a session that wants nobody', () => {
    expect(wantsAttention(row({ descriptor: { ...row().descriptor, status: 'working' } }))).toBe(
      false,
    );
  });

  it('is false while no server that reported it can be reached', () => {
    // A badge nobody can clear by looking is worse than no badge, and a push
    // nobody can act on is worse still.
    expect(wantsAttention(row({ reachable: false }))).toBe(false);
  });

  it('is false while an acknowledgement still holds, and true again on the next prompt', () => {
    expect(wantsAttention(row({ acknowledgedThrough: UPDATED_AT }))).toBe(false);
    expect(
      wantsAttention(
        row({
          acknowledgedThrough: UPDATED_AT,
          descriptor: { ...row().descriptor, updatedAt: UPDATED_AT + 1 },
        }),
      ),
    ).toBe(true);
  });

  it('is false while muted, however long ago the mute was', () => {
    expect(wantsAttention(row({ mutedAt: 1 }))).toBe(false);
  });
});
