import { z } from 'zod';
import { sessionRefSchema, type RefusalCode, type SessionRef } from '@agentplex/protocol';
import type { Clock, Logger } from '@agentplex/node-shared';
import type { Database, Queryable } from '../../db/database.js';

/**
 * Attention: what a person has said about a session, as opposed to what a
 * machine reports about one.
 *
 * ## Why this is its own feature and not part of `sessions`
 *
 * The sessions feature is two steps and nothing else -- decide, then instruct.
 * It holds no database, it owns no rows, and every question it answers is
 * answered by reaching a machine. This owns a table, reaches no machine at
 * all, and the only thing it has in common with starting a session is the word
 * "session". Folding it in would give that feature a database it deliberately
 * does not have, and put a write to this hub's own disk on the same seam as an
 * instruction to somebody else's.
 *
 * It is also not `servers/attention.ts`, which shares the word and answers a
 * different question: that file decides which stores are reachable enough for
 * their sessions to be worth a badge at all, and this records what a person
 * said about one session. The first is a claim about now that no user makes;
 * the second is the only thing here a user does make.
 *
 * It is not part of `fleet-state` either, and that is the sharper line: the
 * reducer's whole argument is that nothing in it is persisted, because
 * everything in it is a claim about *now* that the next scan rebuilds. These
 * two moments are the one thing about a session that no scan can rebuild --
 * nothing on any server knows they exist. So the rows are here, and what the
 * reducer holds is the current reading of them, handed to it the way a
 * connection report is.
 *
 * ## The two facts, and why both are moments
 *
 * An acknowledgement is a timestamp, never a flag. A flag goes sticky: a
 * person answers a permission prompt, the agent runs on and stops at a second
 * one, and a boolean set once says the second prompt has been seen too. A
 * moment is spent by the session speaking again -- it is compared against the
 * `updatedAt` a provider wrote, and an acknowledgement older than that is no
 * longer an acknowledgement of anything.
 *
 * That comparison is not made here and is not made anywhere in the hub. Both
 * moments travel on the same session row, so every reader reaches the same
 * verdict from the same two numbers; a third field stating the verdict could
 * only ever disagree with the two it came from, and it would have to be
 * recomputed on every clock tick rather than on every change.
 *
 * A mute is a timestamp for the same reason it is not a deletion: it silences
 * the alert and never the fact. Nothing here removes a row, hides a status or
 * changes a count. What a muted session loses is the bell, the title and the
 * push, and all three of those are decided by whoever is about to make a
 * noise, out of a field that is right there on the row.
 *
 * ## Stamped by the hub
 *
 * Neither frame carries a moment. The hub stamps both off its own injected
 * clock, because the stamp exists to be compared against a moment a provider
 * wrote on a third machine -- and a comparison between a browser's clock and a
 * provider's is a question about whose watch is fast. One clock stamps, one
 * clock's readings are compared, and the remaining skew (hub against provider)
 * degrades in the direction that does not over-claim: an acknowledgement born
 * behind a provider's clock reads as already spent, which leaves the badge up
 * rather than clearing one nobody has looked at.
 */

/** What the hub records about one session's attention. */
export interface SessionAttention {
  /** When somebody last said they had seen this session's prompt. */
  readonly acknowledgedAt: number | null;
  /** When this session was muted, or `null` when it is not muted. */
  readonly mutedAt: number | null;
}

/** Nothing said about a session, which is what most sessions have. */
export const UNATTENDED: SessionAttention = { acknowledgedAt: null, mutedAt: null };

/**
 * What a write answered, in the terms a client is answered in.
 *
 * The same shape a start or a stop is refused with, minus the holder: there is
 * no machine to point a person at, because nothing about a mute happens on one.
 */
export type AttentionOutcome =
  | { readonly ok: true; readonly attention: SessionAttention }
  | { readonly ok: false; readonly code: RefusalCode; readonly problem: string };

/**
 * A row read back off disk, as a claim rather than as the shape we wrote.
 *
 * SQLite hands integers back as numbers and nulls back as null, and this says
 * so out loud: a column somebody widened to text later fails here, at the read,
 * rather than as a comparison that silently never holds.
 */
const storedRowSchema = z.object({
  store_id: z.string().min(1),
  session_id: z.string().min(1),
  acknowledged_at: z.int().nonnegative().nullable(),
  muted_at: z.int().nonnegative().nullable(),
});

/**
 * The key both the table and the in-memory map are filed under.
 *
 * JSON rather than a joined string, for the reason the web's render key is
 * JSON: a store id and a session id are opaque, either may contain whatever
 * separator was chosen, and two different sessions colliding on one key would
 * put one session's mute on another.
 */
function keyOf(ref: SessionRef): string {
  return JSON.stringify([ref.storeId, ref.sessionId]);
}

export interface AttentionDependencies {
  readonly database: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Called with every change, including each row read at boot.
   *
   * A callback rather than the reducer itself, so that nothing in this file
   * imports the thing it notifies: the composition root wires this to
   * `FleetState.applyAttention`, and this feature stays a table with two verbs
   * on it. It is also what moves the state's version -- the published rows
   * carry these fields, and a change that did not move the version would be a
   * broadcast whose encode cache keeps handing out the row as it was.
   */
  readonly onChanged: (ref: SessionRef, attention: SessionAttention) => void;
  /**
   * Whether the hub currently believes this session exists.
   *
   * A predicate rather than the reducer itself, so that nothing in this file
   * imports the thing that publishes what it writes -- the same one-way edge
   * `onChanged` keeps, stated on the read side.
   *
   * It is existence and not reachability: a session on a machine that went
   * away is still a row on screen, still says it wants a human, and is exactly
   * the session somebody reaches for the mute on.
   */
  readonly knowsSession: (ref: SessionRef) => boolean;
}

export interface Attention {
  /**
   * Reads every stored row and announces each one. Called once, at boot,
   * before the first client is served.
   *
   * Announced rather than returned, so that there is one path by which an
   * attention fact reaches the reducer and it is the same path a live
   * acknowledgement takes. A second "and also load these" entry point would be
   * a second chance for the two to disagree about what a row means.
   */
  load(): Promise<void>;
  /**
   * Records that this session's prompt has been seen, and answers the whole
   * row as it now stands.
   *
   * The mute beside it is left exactly as it was: acknowledging a session must
   * not unmute it, and the two columns are written by two verbs precisely so
   * that neither can silently carry the other.
   */
  acknowledge(ref: SessionRef): Promise<AttentionOutcome>;
  /** Mutes or unmutes, leaving the acknowledgement beside it alone. */
  setMuted(ref: SessionRef, muted: boolean): Promise<AttentionOutcome>;
}

export function createAttention({
  database,
  clock,
  logger: parent,
  onChanged,
  knowsSession,
}: AttentionDependencies): Attention {
  const logger = parent.child({ part: 'attention' });

  /**
   * The rows as they stand, so that a write can answer the whole row without a
   * second read.
   *
   * It is not a cache in front of the database: every write goes to disk first
   * and this is updated from what was written. It exists because both verbs
   * touch one column and answer two, and a read-modify-write across an await
   * would be two clients' edits interleaving on one row.
   */
  const rows = new Map<string, SessionAttention>();

  const readOf = (ref: SessionRef): SessionAttention => rows.get(keyOf(ref)) ?? UNATTENDED;

  const record = (ref: SessionRef, attention: SessionAttention): SessionAttention => {
    rows.set(keyOf(ref), attention);
    onChanged(ref, attention);
    return attention;
  };

  /**
   * Writes one column and leaves the other, by upserting the pair.
   *
   * One statement rather than a select and then an insert or an update: two
   * statements is a window in which the row this hub is about to answer with
   * is not the row on disk. `excluded` names only the column being written, so
   * an acknowledgement cannot reach `muted_at` and a mute cannot reach
   * `acknowledged_at` -- the rule the two verbs promise, stated where the
   * write happens rather than trusted to the caller.
   */
  const upsert = async (
    db: Queryable,
    ref: SessionRef,
    column: 'acknowledged_at' | 'muted_at',
    moment: number | null,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO session_attention (store_id, session_id, acknowledged_at, muted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (store_id, session_id) DO UPDATE SET ${column} = excluded.${column}`,
      [
        ref.storeId,
        ref.sessionId,
        column === 'acknowledged_at' ? moment : null,
        column === 'muted_at' ? moment : null,
      ],
    );
  };

  /**
   * The one rule either verb applies, or `null` when there is nothing to
   * refuse.
   *
   * Checked before the clock is read, so that a refused frame leaves no moment
   * in a log that nothing ever recorded.
   */
  const refuseUnknown = (ref: SessionRef): AttentionOutcome | null => {
    if (knowsSession(ref)) return null;
    logger.info('attention refused', { ...ref, problem: 'no such session' });
    return {
      ok: false,
      code: 'refused',
      problem: 'this hub knows no session by that id',
    };
  };

  return {
    async load(): Promise<void> {
      const result = await database.query(
        'SELECT store_id, session_id, acknowledged_at, muted_at FROM session_attention',
      );
      let loaded = 0;
      for (const row of result.rows) {
        // An unreadable row costs itself and not the load: one bad pair of
        // strings must not leave the hub with no mutes at all, which would be
        // the loudest possible failure of a feature whose whole job is to be
        // quiet.
        const parsed = storedRowSchema.safeParse(row);
        if (!parsed.success) {
          logger.warn('an attention row could not be read', { problem: parsed.error.message });
          continue;
        }
        const refParsed = sessionRefSchema.safeParse({
          storeId: parsed.data.store_id,
          sessionId: parsed.data.session_id,
        });
        if (!refParsed.success) {
          logger.warn('an attention row names something that is not a session', {
            problem: refParsed.error.message,
          });
          continue;
        }
        record(refParsed.data, {
          acknowledgedAt: parsed.data.acknowledged_at,
          mutedAt: parsed.data.muted_at,
        });
        loaded += 1;
      }
      logger.info('attention read back', { rows: loaded });
    },

    async acknowledge(ref: SessionRef): Promise<AttentionOutcome> {
      const known = refuseUnknown(ref);
      if (known !== null) return known;
      const acknowledgedAt = clock.now();
      await upsert(database, ref, 'acknowledged_at', acknowledgedAt);
      return { ok: true, attention: record(ref, { acknowledgedAt, mutedAt: readOf(ref).mutedAt }) };
    },

    async setMuted(ref: SessionRef, muted: boolean): Promise<AttentionOutcome> {
      const known = refuseUnknown(ref);
      if (known !== null) return known;
      const mutedAt = muted ? clock.now() : null;
      await upsert(database, ref, 'muted_at', mutedAt);
      return {
        ok: true,
        attention: record(ref, { acknowledgedAt: readOf(ref).acknowledgedAt, mutedAt }),
      };
    },
  };
}
