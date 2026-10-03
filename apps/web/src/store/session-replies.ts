import type { FrameId, HubFrame } from '@agentplex/protocol';
import type { HubCommand } from './commands.js';
import type { HubSnapshot, StartView, TranscriptView } from './views.js';

/**
 * What the hub says about sessions that a pane reads by its own frame id but
 * that `answers` cannot hold: a start's answer, which a pane has to be able
 * to read before any answer exists, and a transcript, which is too large to
 * spend a place in `answers` on.
 *
 * The store hands this file the frames already narrowed by the one hub-frame
 * switch, and settles `pending` and `answers` itself.
 */

type Frame<T extends HubFrame['type']> = Extract<HubFrame, { type: T }>;

/**
 * How many starts a connection remembers the hub's answer to.
 *
 * Far above any arrangement of panes -- a screen of twelve panes is twelve
 * starts -- and small enough that a tab left open all day starting sessions
 * cannot grow this without bound. The oldest *answered* entry goes first, so
 * what is dropped is an answer rather than a pane's expectation of one; see
 * `evictOldestStarts` for what happens in the corner where nothing has been
 * answered at all.
 */
const MAX_REMEMBERED_STARTS = 64;

/**
 * How many transcript answers a connection remembers.
 *
 * Far smaller than the number of starts, because these are not two fields and
 * a boolean: one answer is up to two hundred activities, which the protocol's
 * own arithmetic sizes at a quarter of a megabyte. The cap is still well above
 * any arrangement of panes -- a screen of twelve panes all on Transcript is
 * twelve entries -- so what falls off is an answer an earlier read left behind
 * rather than one somebody is looking at.
 *
 * Oldest first, and plainly so: every entry here is an answer that has already
 * arrived, and the oldest of them is the one a pane is least likely to still be
 * drawing. A pane that refreshes keeps a pointer at its own previous answer
 * (`TranscriptAsks`), and that pointer is the newest of its entries, so
 * evicting from the old end takes the stale ones first.
 */
export const MAX_REMEMBERED_TRANSCRIPTS = 16;

export interface SessionRepliesDependencies {
  update(changes: Partial<Pick<HubSnapshot, 'starts' | 'transcripts'>>): void;
}

export interface SessionReplies {
  /** A command was accepted, sent or queued; a start gets an entry now. */
  asked(command: HubCommand, id: FrameId): void;
  /** The hub's yes to a start. */
  started(frame: Frame<'session-started'>): void;
  /** The hub's no to a frame; filed against the start it answers, if it answers one. */
  refused(frame: Frame<'refusal'>): void;
  /** The session a spawn became; filed against the start it names, beside its answer. */
  named(frame: Frame<'session-named'>): void;
  /** The hub's answer to a transcript read. */
  transcript(frame: Frame<'session-transcript-read'>): void;
  /** Nothing is looking any more: forgets the transcripts. */
  forget(): void;
}

export function createSessionReplies({ update }: SessionRepliesDependencies): SessionReplies {
  /**
   * What the hub has said about each start, by the frame that asked.
   *
   * Written when a start is accepted rather than when one is answered, so that
   * a pane opened in the same click as the start finds an entry to read and
   * can say it is asking rather than say nothing at all.
   *
   * Bounded, oldest first, because a tab that starts sessions all day would
   * otherwise accumulate one entry per start for as long as it is open. The
   * cap is far above any arrangement of panes, so nothing a pane is still
   * waiting on is ever the entry that goes.
   */
  const starts = new Map<FrameId, StartView>();
  /**
   * What each transcript read was answered with, by the frame that asked.
   *
   * Written only when an answer arrives, unlike `starts`: a pane already knows
   * the id it asked with and says "reading" off that, so there is nothing an
   * empty entry would tell it that it does not hold itself.
   */
  const transcripts = new Map<FrameId, TranscriptView>();

  /**
   * Brings the remembered starts back under the cap, answered ones first.
   *
   * A start the hub has not answered is the one a pane may still be waiting to
   * read, so it is passed over while there is any settled entry left to drop --
   * a pane that lost its entry would go back to saying it was asking, which is
   * the over-claim this map exists to prevent. The bound is still hard: with
   * nothing settled to drop, the oldest goes anyway, because a map that could
   * refuse to shrink is not a bound.
   */
  function evictOldestStarts(): void {
    while (starts.size > MAX_REMEMBERED_STARTS) {
      const settled = [...starts].find(
        ([, view]) => view.started !== null || view.refusal !== null || view.named !== null,
      );
      const [oldest] = settled ?? [...starts][0] ?? [];
      if (oldest === undefined) return;
      starts.delete(oldest);
    }
  }

  /**
   * Brings the remembered transcripts back under the cap, oldest first.
   *
   * No passing over, unlike `evictOldestStarts`: every entry here is already an
   * answer, so there is no unsettled one to protect and the insertion order is
   * the order they arrived in.
   */
  function evictOldestTranscripts(): void {
    while (transcripts.size > MAX_REMEMBERED_TRANSCRIPTS) {
      const [oldest] = [...transcripts.keys()];
      if (oldest === undefined) return;
      transcripts.delete(oldest);
    }
  }

  /**
   * Files what the hub said against the start it is about, and publishes it.
   *
   * A patch over the entry rather than a replacement, because a naming and the
   * yes it follows can arrive in either order and neither may erase the other.
   */
  function noteStartAnswer(replyTo: FrameId, patch: Partial<StartView>): void {
    const entry = starts.get(replyTo);
    if (entry === undefined) return;
    starts.set(replyTo, { ...entry, ...patch });
    update({ starts: new Map(starts) });
  }

  return {
    /**
     * Opens an entry for a start the moment it is accepted, sent or queued.
     *
     * Not when the hub answers, because a pane is opened in the same click that
     * sends the start and has to be able to say something before any answer
     * exists. An entry with two nulls on it is that something: asked, and not
     * yet answered.
     */
    asked(command: HubCommand, id: FrameId): void {
      if (command.type !== 'session-start') return;
      const asked = {
        storeId: command.storeId,
        provider: command.provider,
        project: command.project,
      };
      starts.set(id, { asked, started: null, refusal: null, named: null });
      evictOldestStarts();
      update({ starts: new Map(starts) });
    },

    started(frame: Frame<'session-started'>): void {
      const started = {
        replyTo: frame.replyTo,
        storeId: frame.storeId,
        sessionId: frame.sessionId,
        server: frame.server,
      };
      noteStartAnswer(frame.replyTo, { started });
    },

    refused(frame: Frame<'refusal'>): void {
      const refusal = {
        replyTo: frame.replyTo,
        code: frame.code,
        message: frame.message,
        holder: frame.holder,
      };
      noteStartAnswer(frame.replyTo, { refusal });
    },

    named(frame: Frame<'session-named'>): void {
      noteStartAnswer(frame.replyTo, {
        named: { storeId: frame.storeId, sessionId: frame.sessionId },
      });
    },

    transcript(frame: Frame<'session-transcript-read'>): void {
      // Filed under the frame that asked, and whole: a transcript is one read
      // of a file at one moment, and two answers stitched together would be a
      // history that never existed on any disk. It replaces nothing but what
      // was filed under this same id, so the pane that asked something else
      // still has its own answer to draw.
      transcripts.set(frame.replyTo, {
        replyTo: frame.replyTo,
        activities: frame.activities,
        olderExist: frame.olderExist,
      });
      evictOldestTranscripts();
      update({ transcripts: new Map(transcripts) });
    },

    forget(): void {
      transcripts.clear();
    },
  };
}
