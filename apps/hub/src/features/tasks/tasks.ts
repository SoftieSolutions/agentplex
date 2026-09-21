import { z } from 'zod';
import {
  SESSION_TASK_MAX_CHARS,
  sessionRefSchema,
  type SessionId,
  type SessionRef,
  type SessionStartTag,
  type StartId,
  type StoreId,
} from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';

/**
 * Tasks: what a session was started to do, in the words somebody typed.
 *
 * ## Why this is a fact the hub has to keep, rather than one it could read
 *
 * Everything else the hub says about a session is a reading of a transcript,
 * rebuilt by the next scan. This is the one thing no scan can reach. The prompt
 * is placed by the adapter as one argv element on another machine, which keeps
 * no record of why it was started, and the transcript that results opens with
 * whatever the agent said back. The nearest available substitute -- the first
 * thing in the transcript -- is not the same fact: it is whatever anyone
 * happened to send first, and a panel headed TASK showing it would be wrong
 * often enough to mislead the person scanning for the session they meant.
 *
 * So the hub keeps what it was told, once, by the person who started the
 * session, and keeps nothing for a session it did not start. `null` is the
 * common answer and an honest one; a guess would not be.
 *
 * ## Why it is not part of `sessions`
 *
 * The sessions feature is two steps and nothing else -- decide, then instruct.
 * It holds no database and owns no rows, and every question it answers is
 * answered by reaching a machine. This owns a table and reaches no machine at
 * all. The argument is `attention.ts`'s, restated: folding it in would put a
 * write to this hub's own disk on the same seam as an instruction to somebody
 * else's. What joins them is one callback, wired in the composition root.
 *
 * It is not part of `fleet-state` either, for that file's own reason: nothing
 * in the reducer is persisted, because everything in it is a claim about now
 * that the next scan rebuilds. What the reducer holds is the current reading of
 * these rows, handed to it the way a connection report is.
 *
 * ## The two moments a start has, in either order
 *
 * A resume names its session, so its task has somewhere to go immediately. A
 * spawn does not: the provider mints the id and writes it, and the hub learns
 * the pair from the tag a server reports until it has. Nothing is ever filed
 * under a start handle on disk -- a start is not a session, and a row keyed by
 * one would need a second write to become keyed by the other -- so a spawn's
 * prompt waits in memory until the pair exists.
 *
 * Which of the two arrives first is not decided anywhere, and this feature does
 * not get to assume. The instruction is answered on one socket and the tag
 * comes back on another, and a server that has already scanned reports the pair
 * while the hub is still walking back up from the answer: in practice the tag
 * wins that race more often than not. So both halves are held -- the prompt by
 * start handle, the naming by start handle -- and whichever completes the pair
 * writes the row. A feature that only waited for the naming would silently lose
 * the task of every session started on a machine that scans quickly, which is
 * the failure that reads as "it works on my laptop".
 *
 * Each half is one short string per start. A start that is never named keeps
 * its prompt, and a naming nobody claims keeps a session ref -- a provider that
 * died before writing a transcript, a hub that was not the one that started it.
 * That is the same bargain the relay's own map of named starts makes, and the
 * alternative is a timeout that would have to guess how long a provider may
 * take to write its first line.
 */

/** A start this hub made, as this feature is told about it. */
export interface StartedSession {
  readonly startId: StartId;
  readonly storeId: StoreId;
  /** `null` for a spawn, whose id the provider has not written yet. */
  readonly sessionId: SessionId | null;
  /** What the person asked for, or `null` for a start made at the agent's own prompt. */
  readonly prompt: string | null;
}

export interface TasksDependencies {
  readonly database: Database;
  readonly logger: Logger;
  /**
   * Called with every task recorded, including each row read at boot.
   *
   * A callback rather than the reducer itself, so that nothing in this file
   * imports what it notifies: the composition root wires it to
   * `FleetState.applyTask`, and this feature stays a table with two verbs on
   * it. It is also what moves the state's version -- a published row carries
   * this field, and a change that did not move the version would be a broadcast
   * whose encode cache keeps handing out the row as it was.
   */
  readonly onChanged: (ref: SessionRef, task: string | null) => void;
}

export interface Tasks {
  /**
   * Reads every stored row and announces each one. Called once, at boot,
   * before the first client is served.
   *
   * Announced rather than returned, for the reason attention's load is: one
   * path by which a task reaches the reducer, and it is the path a freshly
   * started one takes.
   */
  load(): Promise<void>;
  /**
   * Takes a start this hub has just made, with the prompt it was made with.
   *
   * Records nothing for a start with no prompt, and nothing for a session that
   * already has a task: the first task a session is given is the one it keeps.
   */
  noteStart(started: StartedSession): Promise<void>;
  /**
   * Takes the start tags one server reported for one store, which is how the
   * session id of a spawn arrives.
   *
   * The whole list as reported, filtered here rather than by the caller, so
   * that this feature's rule about which tags mean something to it lives with
   * the rows it writes.
   */
  noteStarts(storeId: StoreId, starts: readonly SessionStartTag[]): Promise<void>;
}

/**
 * A row read back off disk, as a claim rather than as the shape we wrote.
 *
 * The bound is restated here and not trusted from the column: a row written by
 * an older build, or by a hand on the database, must not put a string on the
 * wire that the client's parser will refuse -- which would cost that client the
 * whole state frame rather than one label.
 */
const storedRowSchema = z.object({
  store_id: z.string().min(1),
  session_id: z.string().min(1),
  task: z.string().min(1).max(SESSION_TASK_MAX_CHARS),
});

/**
 * The key the in-memory map is filed under. JSON for the reason attention's is:
 * a store id and a session id are opaque, and two sessions colliding on one key
 * would put one session's task on another.
 */
function keyOf(ref: SessionRef): string {
  return JSON.stringify([ref.storeId, ref.sessionId]);
}

/**
 * The prompt as a task, or `null` when it is not one.
 *
 * Three things happen here and each is the parse rather than a convenience.
 * Whitespace is trimmed and a prompt that was nothing but whitespace becomes no
 * task at all, because the wire refuses an empty string -- there is one way to
 * say a session has no task, and it is the absence of one. The text is cut to
 * the wire's bound, since a prompt may be an essay and this string sits in
 * every attached client's copy of the whole state. And a cut that landed
 * between the halves of a surrogate pair takes the orphan with it, so what is
 * stored is text rather than a string with half a character at the end of it.
 */
export function taskFromPrompt(prompt: string | null): string | null {
  if (prompt === null) return null;
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= SESSION_TASK_MAX_CHARS) return trimmed;

  const cut = trimmed.slice(0, SESSION_TASK_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  const orphaned = last >= 0xd800 && last <= 0xdbff;
  return orphaned ? cut.slice(0, -1) : cut;
}

export function createTasks({ database, logger: parent, onChanged }: TasksDependencies): Tasks {
  const logger = parent.child({ part: 'tasks' });

  /**
   * The tasks as they stand, so that a second start on one session can be
   * answered without a read.
   *
   * Not a cache in front of the database: every write goes to disk first and
   * this is updated from what was written. It exists so the rule the table
   * states -- one task per session, the first one -- is decided here rather
   * than by reading back what an insert did or did not do.
   */
  const rows = new Map<string, string>();
  /**
   * What each spawn was started to do, until the provider names the session.
   *
   * Keyed by the start handle, which is the only name a spawn has in that
   * stretch, and holding the store the hub asked for so that a tag reported
   * under a different one can be refused rather than filed.
   */
  const awaitingId = new Map<StartId, { readonly storeId: StoreId; readonly task: string }>();
  /**
   * Which session each start turned out to be, for the starts named before
   * their prompt got here.
   *
   * The other half of the same pair, held for the same reason and in the same
   * shape. A server that has already scanned reports the naming while the hub
   * is still returning from the answer that made the start, so this arrives
   * first at least as often as it arrives second.
   */
  const named = new Map<StartId, SessionRef>();

  /**
   * Whether the store a start was made for is the store its naming came back
   * under.
   *
   * The row a client reads is filed under the store the report was about, so a
   * tag reported under another one has nowhere to go that would not be a task
   * shown on a session it is not about. A server disagreeing with the start it
   * was sent costs the label and nothing else.
   */
  const sameStore = (startId: StartId, asked: StoreId, named: SessionRef): boolean => {
    if (asked === named.storeId) return true;
    logger.warn('a start was reported under a store it was not made for', {
      startId,
      asked,
      reported: named.storeId,
    });
    return false;
  };

  const record = async (ref: SessionRef, task: string): Promise<void> => {
    if (rows.has(keyOf(ref))) {
      logger.debug('this session already has a task', ref);
      return;
    }
    try {
      // `DO NOTHING` states the same rule the map above applies, where the
      // write happens: the first task a session is given is the one it keeps,
      // and a row written by a previous process is not overwritten by this one.
      await database.query(
        `INSERT INTO session_task (store_id, session_id, task) VALUES (?, ?, ?)
         ON CONFLICT (store_id, session_id) DO NOTHING`,
        [ref.storeId, ref.sessionId, task],
      );
    } catch (error) {
      // Swallowed here so that neither verb can reject, which is what lets the
      // report path call one without holding on to a promise -- the shape
      // `catalogue.observe` has for the same reason. A label that cannot be
      // written costs the label; nothing in memory moves, so the next start on
      // that session tries again.
      logger.warn('a task could not be written', { ...ref, problem: String(error) });
      return;
    }
    rows.set(keyOf(ref), task);
    onChanged(ref, task);
  };

  return {
    async load(): Promise<void> {
      const result = await database.query('SELECT store_id, session_id, task FROM session_task');
      let loaded = 0;
      for (const row of result.rows) {
        // An unreadable row costs itself and not the load: one bad pair of
        // strings must not leave every session on the fleet unlabelled.
        const parsed = storedRowSchema.safeParse(row);
        if (!parsed.success) {
          logger.warn('a task row could not be read', { problem: parsed.error.message });
          continue;
        }
        const ref = sessionRefSchema.safeParse({
          storeId: parsed.data.store_id,
          sessionId: parsed.data.session_id,
        });
        if (!ref.success) {
          logger.warn('a task row names something that is not a session', {
            problem: ref.error.message,
          });
          continue;
        }
        rows.set(keyOf(ref.data), parsed.data.task);
        onChanged(ref.data, parsed.data.task);
        loaded += 1;
      }
      logger.info('tasks read back', { rows: loaded });
    },

    async noteStart(started: StartedSession): Promise<void> {
      const task = taskFromPrompt(started.prompt);
      if (task === null) return;

      if (started.sessionId !== null) {
        await record({ storeId: started.storeId, sessionId: started.sessionId }, task);
        return;
      }

      // A spawn, which may already have been named: the server reports the
      // pair as soon as it has scanned, and that frequently lands before the
      // answer this call is walking back from.
      const already = named.get(started.startId);
      if (already === undefined) {
        awaitingId.set(started.startId, { storeId: started.storeId, task });
        return;
      }
      if (!sameStore(started.startId, started.storeId, already)) return;

      named.delete(started.startId);
      await record(already, task);
    },

    async noteStarts(storeId: StoreId, starts: readonly SessionStartTag[]): Promise<void> {
      for (const tag of starts) {
        if (tag.sessionId === null) continue;
        const ref = { storeId, sessionId: tag.sessionId };
        const waiting = awaitingId.get(tag.startId);

        // Nothing waiting: either the prompt is still on its way here, or this
        // start was made with no prompt, or it was not this hub's start at all.
        // The naming is kept for the first of those, and costs a session ref
        // for the other two.
        if (waiting === undefined) {
          named.set(tag.startId, ref);
          continue;
        }

        if (!sameStore(tag.startId, waiting.storeId, ref)) continue;

        awaitingId.delete(tag.startId);
        await record(ref, waiting.task);
      }
    },
  };
}
