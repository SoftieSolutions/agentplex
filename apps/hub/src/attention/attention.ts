import { z } from 'zod';
import { sessionRefSchema, type RefusalCode, type SessionRef } from '@agentplex/protocol';
import type { Clock, Logger } from '@agentplex/node-shared';
import type { Database, Queryable } from '../db/database.js';

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
 * ## The two facts, and the two different clocks they belong to
 *
 * An acknowledgement is a timestamp, never a flag. A flag goes sticky: a
 * person answers a permission prompt, the agent runs on and stops at a second
 * one, and a boolean set once says the second prompt has been seen too. A
 * timestamp is spent by the session speaking again.
 *
 * Which timestamp is the whole of it. What is recorded is the session's own
 * `updatedAt` as this hub saw it at that moment -- a number a *provider* wrote
 * into a transcript on another machine -- and never a reading of this hub's
 * clock. The comparison downstream is against the next such number, so both
 * sides of it come off one clock and the answer does not depend on whose watch
 * is fast. A hub-stamped acknowledgement compared against a provider-written
 * `updatedAt` is two unsynchronised clocks: a hub five seconds ahead reads a
 * second prompt two seconds later as already seen, silently, which is the
 * failure a timestamp was chosen over a boolean to avoid in the first place.
 *
 * That comparison is not made here and is not made anywhere in the hub. The
 * recorded number travels on the same session row as the `updatedAt` it is
 * compared with, so every reader reaches the same verdict from the same two
 * numbers; a third field stating the verdict could only ever disagree with the
 * two it came from, and it would have to be recomputed on every clock tick
 * rather than on every change.
 *
 * The narrow race this leaves is one turn wide and deliberate: the hub records
 * what it can see, and a session that spoke between the click and the frame
 * arriving is acknowledged through a reading the person did not look at. The
 * alternative is a client sending the number, which puts a value this hub
 * cannot check back into the frame -- and the window it would close is the one
 * the round trip already bounds.
 *
 * A mute is a timestamp for the same reason it is not a deletion: it silences
 * the alert and never the fact. Nothing here removes a row, hides a status or
 * changes a count. What a muted session loses is the bell, the title and the
 * push, and all three of those are decided by whoever is about to make a
 * noise, out of a field that is right there on the row.
 *
 * `mutedAt` *is* this hub's own clock, and that is not an inconsistency: it is
 * compared with nothing. It answers "since when" for a person to read, and no
 * rule anywhere uses it as a threshold.
 *
 * Neither frame carries either number. A client that supplied one would be
 * making a claim about a clock nothing here can check.
 */

/** What the hub records about one session's attention. */
export interface SessionAttention {
  /**
   * The session's own `updatedAt`, as the hub saw it when somebody last said
   * they had seen this session's prompt, or `null` when nobody has.
   *
   * A provider's clock, not this hub's, and named for what it means rather
   * than for when it was written: everything that reads it compares it with
   * another `updatedAt`, and a name ending in `At` would invite somebody to
   * render it as a wall-clock time or compare it with one.
   */
  readonly acknowledgedThrough: number | null;
  /** When this session was muted, on this hub's clock, or `null` when it is not. */
  readonly mutedAt: number | null;
}

/** Nothing said about a session, which is what most sessions have. */
export const UNATTENDED: SessionAttention = { acknowledgedThrough: null, mutedAt: null };

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
  acknowledged_through: z.int().nonnegative().nullable(),
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
   * The session's `updatedAt` as the hub currently sees it, or `null` when the
   * hub believes there is no such session.
   *
   * One function answering both of this feature's questions, because they are
   * asked at the same instant and a second call could be answered out of a
   * different snapshot: whether there is a session to talk about at all, and
   * what the acknowledgement is an acknowledgement *through*.
   *
   * A function rather than the reducer itself, so that nothing in this file
   * imports the thing that publishes what it writes -- the same one-way edge
   * `onChanged` keeps, stated on the read side. The reducer imports this file,
   * for the shape it is handed and the value it uses for a session nobody has
   * spoken about; nothing here imports the reducer.
   *
   * `null` is existence and not reachability: a session on a machine that went
   * away is still a row on screen, still says it wants a human, and is exactly
   * the session somebody reaches for the mute on.
   */
  readonly sessionActivity: (ref: SessionRef) => number | null;
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
  sessionActivity,
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
   * `acknowledged_through` -- the rule the two verbs promise, stated where the
   * write happens rather than trusted to the caller.
   */
  const upsert = async (
    db: Queryable,
    ref: SessionRef,
    column: 'acknowledged_through' | 'muted_at',
    value: number | null,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO session_attention (store_id, session_id, acknowledged_through, muted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (store_id, session_id) DO UPDATE SET ${column} = excluded.${column}`,
      [
        ref.storeId,
        ref.sessionId,
        column === 'acknowledged_through' ? value : null,
        column === 'muted_at' ? value : null,
      ],
    );
  };

  /**
   * The one rule either verb applies: a session this hub cannot see is refused.
   *
   * It answers with the session's own last activity when it does not refuse,
   * because that is the number an acknowledgement records and reading it twice
   * would be reading two snapshots.
   */
  const refuseUnknown = (
    ref: SessionRef,
  ): { readonly refusal: AttentionOutcome } | { readonly updatedAt: number } => {
    const updatedAt = sessionActivity(ref);
    if (updatedAt !== null) return { updatedAt };
    logger.info('attention refused', { ...ref, problem: 'no such session' });
    return {
      refusal: {
        ok: false,
        code: 'refused',
        problem: 'this hub knows no session by that id',
      },
    };
  };

  return {
    async load(): Promise<void> {
      const result = await database.query(
        'SELECT store_id, session_id, acknowledged_through, muted_at FROM session_attention',
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
          acknowledgedThrough: parsed.data.acknowledged_through,
          mutedAt: parsed.data.muted_at,
        });
        loaded += 1;
      }
      logger.info('attention read back', { rows: loaded });
    },

    async acknowledge(ref: SessionRef): Promise<AttentionOutcome> {
      const seen = refuseUnknown(ref);
      if ('refusal' in seen) return seen.refusal;
      // The session's own last activity, not `clock.now()`. See the note at
      // the top: this number exists to be compared with the next one off the
      // same provider's clock.
      const acknowledgedThrough = seen.updatedAt;
      await upsert(database, ref, 'acknowledged_through', acknowledgedThrough);
      return {
        ok: true,
        attention: record(ref, { acknowledgedThrough, mutedAt: readOf(ref).mutedAt }),
      };
    },

    async setMuted(ref: SessionRef, muted: boolean): Promise<AttentionOutcome> {
      const seen = refuseUnknown(ref);
      if ('refusal' in seen) return seen.refusal;
      // This hub's clock, unlike the acknowledgement above, because nothing
      // compares it with anything: it says since when, for a person to read.
      const mutedAt = muted ? clock.now() : null;
      await upsert(database, ref, 'muted_at', mutedAt);
      return {
        ok: true,
        attention: record(ref, { acknowledgedThrough: readOf(ref).acknowledgedThrough, mutedAt }),
      };
    },
  };
}
