import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionRefSchema, type SessionRef } from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import { openMigratedSchema, type MigratedSchema } from '../../db/test-migrated-schema.js';
import { createAttention, UNATTENDED, type SessionAttention } from './attention.js';

/**
 * The attention rows, against a real database.
 *
 * Over a migrated schema rather than a fake, because the two things worth
 * asserting here are both SQL: that one verb writes one column and leaves the
 * other, and that the primary key makes a second row for one session
 * unrepresentable rather than merely unusual. A fake that answered whatever it
 * was handed would agree with any upsert at all.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
/**
 * The provider's clock, deliberately far from the hub's.
 *
 * Nothing here should ever produce a number from `clock` where a session's own
 * `updatedAt` belongs, and a test whose two clocks agreed could not tell.
 */
const WROTE_AT = START - 5 * 60_000;

const PROMPTED = sessionRefSchema.parse({
  storeId: 'store-work',
  sessionId: 'session-migrate-db',
});
const OTHER = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-fix-auth' });

let migrated: MigratedSchema | null = null;
let announced: { ref: SessionRef; attention: SessionAttention }[] = [];
let now = START;
/** What the reducer would say each session's `updatedAt` is, or nothing. */
let activity = new Map<string, number>();

function db(): MigratedSchema['database'] {
  if (migrated === null) throw new Error('no database: beforeEach did not run');
  return migrated.database;
}

function keyOf(ref: SessionRef): string {
  return `${ref.storeId}/${ref.sessionId}`;
}

function feature(): ReturnType<typeof createAttention> {
  return createAttention({
    database: db(),
    clock: { now: () => now },
    logger,
    onChanged: (ref, attention) => announced.push({ ref, attention }),
    sessionActivity: (ref) => activity.get(keyOf(ref)) ?? null,
  });
}

describe('the attention rows', () => {
  beforeEach(async () => {
    migrated = await openMigratedSchema('attention-probe');
    announced = [];
    now = START;
    activity = new Map([
      [keyOf(PROMPTED), WROTE_AT],
      [keyOf(OTHER), WROTE_AT],
    ]);
  });

  afterEach(async () => {
    await migrated?.close();
    migrated = null;
  });

  it("records the session's own last activity, never a reading of the hub's clock", async () => {
    const outcome = await feature().acknowledge(PROMPTED);
    // The number a provider wrote, not `clock.now()`. The two are five minutes
    // apart here on purpose: what this records is one side of a comparison
    // whose other side is the next thing that provider writes, and a hub clock
    // on either side makes the answer depend on whose watch is fast.
    expect(outcome).toEqual({
      ok: true,
      attention: { acknowledgedThrough: WROTE_AT, mutedAt: null },
    });
    expect(WROTE_AT).not.toBe(now);
  });

  it('moves with the session: a later acknowledgement records the later activity', async () => {
    const attention = feature();
    await attention.acknowledge(PROMPTED);

    // The agent ran on and stopped again, and somebody looked at that too.
    activity.set(keyOf(PROMPTED), WROTE_AT + 30_000);
    expect(await attention.acknowledge(PROMPTED)).toEqual({
      ok: true,
      attention: { acknowledgedThrough: WROTE_AT + 30_000, mutedAt: null },
    });
  });

  it('stamps a mute off the hub clock, which it may do because nothing compares it', async () => {
    const outcome = await feature().setMuted(PROMPTED, true);
    expect(outcome).toEqual({ ok: true, attention: { acknowledgedThrough: null, mutedAt: START } });
  });

  it('leaves the mute alone when it acknowledges, and the acknowledgement alone when it mutes', async () => {
    const attention = feature();
    await attention.setMuted(PROMPTED, true);
    const acknowledged = await attention.acknowledge(PROMPTED);

    // The whole reason each verb writes one column: a person who muted a
    // session and then said "seen" has said two things, and either of them
    // silently undoing the other is the bug the two columns exist to prevent.
    expect(acknowledged).toEqual({
      ok: true,
      attention: { acknowledgedThrough: WROTE_AT, mutedAt: START },
    });

    now = START + 2_000;
    const unmuted = await attention.setMuted(PROMPTED, false);
    expect(unmuted).toEqual({
      ok: true,
      attention: { acknowledgedThrough: WROTE_AT, mutedAt: null },
    });
  });

  it('keeps one row per session, however many times it is written', async () => {
    const attention = feature();
    await attention.acknowledge(PROMPTED);
    await attention.setMuted(PROMPTED, true);
    await attention.setMuted(PROMPTED, false);
    const rows = await db().query('SELECT count(*) AS n FROM session_attention');
    expect(rows.rows[0]).toEqual({ n: 1 });
  });

  it('refuses a session the hub cannot see, and writes nothing for it', async () => {
    const stranger = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-ghost' });
    expect(activity.has(keyOf(stranger))).toBe(false);
    const outcome = await feature().acknowledge(stranger);
    expect(outcome).toEqual({
      ok: false,
      code: 'refused',
      problem: 'this hub knows no session by that id',
    });
    const rows = await db().query('SELECT count(*) AS n FROM session_attention');
    expect(rows.rows[0]).toEqual({ n: 0 });
    expect(announced).toEqual([]);
  });

  it('announces every write, so the published state moves with the row', async () => {
    const attention = feature();
    await attention.acknowledge(PROMPTED);
    await attention.setMuted(OTHER, true);
    expect(announced).toEqual([
      { ref: PROMPTED, attention: { acknowledgedThrough: WROTE_AT, mutedAt: null } },
      { ref: OTHER, attention: { acknowledgedThrough: null, mutedAt: START } },
    ]);
  });

  it('reads its rows back at boot and announces each one', async () => {
    const written = feature();
    await written.acknowledge(PROMPTED);
    await written.setMuted(OTHER, true);

    // A second instance over the same file: this is the restart, and what it
    // has to produce is the mutes the user made before it, not a quiet hub
    // that starts nagging again.
    announced = [];
    await feature().load();
    expect(
      [...announced].sort((left, right) => (left.ref.sessionId < right.ref.sessionId ? -1 : 1)),
    ).toEqual([
      { ref: OTHER, attention: { acknowledgedThrough: null, mutedAt: START } },
      { ref: PROMPTED, attention: { acknowledgedThrough: WROTE_AT, mutedAt: null } },
    ]);
  });

  it('lets one unreadable row cost itself rather than every mute the hub holds', async () => {
    await feature().setMuted(OTHER, true);
    // A row nothing here wrote: the column holds text where a moment belongs,
    // which is what a hand-edited database or a later migration gone wrong
    // looks like from up here.
    await db().query(
      `INSERT INTO session_attention (store_id, session_id, acknowledged_through, muted_at)
       VALUES ('store-work', 'session-broken', 'yesterday', NULL)`,
    );

    announced = [];
    await feature().load();
    expect(announced).toEqual([
      { ref: OTHER, attention: { acknowledgedThrough: null, mutedAt: START } },
    ]);
  });

  it('says nothing at all about a session nobody has spoken about', async () => {
    await feature().load();
    expect(UNATTENDED).toEqual({ acknowledgedThrough: null, mutedAt: null });
    expect(announced).toEqual([]);
  });
});
