import type { CatalogueQuery, FrameId, HubFrame } from '@agentplex/protocol';
import { encodeClientFrame } from './commands.js';
import type { StoreSocket } from './connection.js';
import type { FrameIds } from './frame-ids.js';
import type { CataloguePageView, HubSnapshot } from './views.js';

/**
 * The catalogue channel: the one remembered question, the pages that answer
 * it, and the callers blocked on each.
 *
 * A page is a read, answered by a promise rather than by a snapshot field a
 * screen has to match, and it is never queued: a read of now replayed after a
 * reconnection is a cursor the hub has already decided is stale. The store
 * hands this file the two frames that answer a query -- the page, and a
 * refusal -- already narrowed by the one hub-frame switch.
 */

type Frame<T extends HubFrame['type']> = Extract<HubFrame, { type: T }>;

export interface CatalogueDependencies {
  /** The socket, while the connection is established; `null` otherwise. */
  live(): StoreSocket | null;
  readonly frameIds: FrameIds;
  /** The snapshot's problem, which is why a query cannot be sent. */
  problem(): string | null;
  update(changes: Partial<Pick<HubSnapshot, 'catalogue' | 'problem'>>): void;
}

export interface CatalogueChannel {
  /** Asks one page on the channel: the question is remembered and the page published. */
  query(query: CatalogueQuery): Promise<CataloguePageView>;
  /** Asks one page for the caller alone: nothing remembered, nothing published. */
  queryDetached(query: CatalogueQuery): Promise<CataloguePageView>;
  /** Standing interest, so a change re-issues the remembered question. */
  subscribe(): () => void;
  /** Asks the remembered question again from the first page, if anything is watching. */
  reissue(): void;
  /** The hub answered a query with a page. */
  answered(frame: Frame<'catalogue-page'>): void;
  /** The hub refused a frame; if it was a query, its caller is told. */
  refused(frame: Frame<'refusal'>): void;
  /** Tells every blocked caller the answer is not coming. */
  abandon(why: string): void;
  /** Nothing is looking any more: abandon, and forget the question too. */
  stop(): void;
}

export function createCatalogueChannel(dependencies: CatalogueDependencies): CatalogueChannel {
  const { frameIds, update } = dependencies;

  let catalogueWatchers = 0;
  /**
   * The last catalogue query this store sent, so a change can re-issue it.
   *
   * The query and not the page: what has to survive a change is the question,
   * and the answer to it is exactly what the change invalidated.
   */
  let lastQuery: CatalogueQuery | null = null;
  /**
   * Catalogue queries awaiting an answer, by the id the answer will name.
   *
   * Beside `pending` rather than in it, because the two are settled by
   * different things: a command's entry is deleted when the reply arrives and
   * the screen reads the outcome off the snapshot, and one of these has a
   * caller blocked on it that must be told either way -- including when the
   * connection drops with the question unanswered.
   */
  const pendingQueries = new Map<
    FrameId,
    {
      resolve(page: CataloguePageView): void;
      reject(error: Error): void;
      /**
       * Whether this one was asked off the channel, for the caller alone.
       *
       * Kept per question rather than read back off the query, because two
       * askers can send the identical question for different reasons -- the
       * panel drawing the catalogue and the palette searching it -- and what
       * tells them apart is who asked rather than what was asked.
       */
      readonly detached: boolean;
    }
  >();

  function abandon(why: string): void {
    for (const waiting of [...pendingQueries.values()]) waiting.reject(new Error(why));
    pendingQueries.clear();
  }

  /**
   * Asks the catalogue question again, if anything is watching it.
   *
   * From the first page, never from the last cursor: the cursor was minted at
   * the version that just moved, and the hub refuses one from before a change
   * by design. A rejection here has no caller to reach, so it is swallowed into
   * the snapshot's `problem` the way an unreadable frame is -- the degradation
   * is visible rather than silent, and a page nobody asked for must not become
   * an unhandled rejection.
   */
  function reissue(): void {
    const question = lastQuery;
    if (question === null || catalogueWatchers === 0) return;
    issueQuery({ ...question, cursor: null }).catch((error: unknown) => {
      update({ problem: `the catalogue could not be re-read: ${String(error)}` });
    });
  }

  /**
   * Sends one catalogue query and answers it, or rejects saying why not.
   *
   * The query is remembered before the send rather than after, so that a change
   * arriving while this one is in flight re-issues the question that was asked
   * rather than the one before it -- unless it is `'detached'`, which is a
   * caller's own question and not the channel's: remembering it would have the
   * next `catalogue-changed` re-ask what somebody typed into a dialog instead
   * of what a screen is drawing.
   */
  function issueQuery(
    query: CatalogueQuery,
    asked: 'channel' | 'detached' = 'channel',
  ): Promise<CataloguePageView> {
    const detached = asked === 'detached';
    if (!detached) lastQuery = query;
    const wire = dependencies.live();
    if (wire === null) {
      return Promise.reject(
        new Error(
          dependencies.problem() ??
            'the connection is down: a catalogue page is a read of now and is not queued',
        ),
      );
    }
    const id = frameIds.next();
    return new Promise<CataloguePageView>((resolve, reject) => {
      pendingQueries.set(id, { resolve, reject, detached });
      wire.send(encodeClientFrame({ ...query, type: 'catalogue-query', id }));
    });
  }

  return {
    query(query: CatalogueQuery): Promise<CataloguePageView> {
      return issueQuery(query);
    },

    queryDetached(query: CatalogueQuery): Promise<CataloguePageView> {
      return issueQuery(query, 'detached');
    },

    subscribe(): () => void {
      // Nothing is sent on the first subscriber, unlike the layout's. There is
      // no question yet: a catalogue query carries a view, a sort and a filter
      // that only the screen knows, and this store has nothing to ask for until
      // that screen asks once.
      catalogueWatchers += 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        catalogueWatchers -= 1;
      };
    },

    reissue,

    answered(frame: Frame<'catalogue-page'>): void {
      const waiting = pendingQueries.get(frame.replyTo);
      pendingQueries.delete(frame.replyTo);
      const page: CataloguePageView = {
        items: frame.items,
        nextCursor: frame.nextCursor,
        total: frame.total,
        version: frame.version,
      };
      // The snapshot carries it as well as the caller, because a re-issue on
      // `catalogue-changed` has no caller: nobody asked for it, and the page
      // has to land somewhere a screen is looking. A detached page is the one
      // exception and the reason that flag exists: it answers a caller who
      // asked for itself, and putting it here would replace the rows of a
      // screen that asked a different question.
      if (waiting?.detached !== true) update({ catalogue: page });
      waiting?.resolve(page);
    },

    refused(frame: Frame<'refusal'>): void {
      // A refused query has a caller blocked on it, and it is told: the one
      // refusal worth acting on here is a stale cursor, and what the caller
      // does about it is ask for the first page again. The snapshot still
      // carries the sentence, like every other no.
      const refused = pendingQueries.get(frame.replyTo);
      pendingQueries.delete(frame.replyTo);
      refused?.reject(new Error(frame.message));
    },

    abandon,

    stop(): void {
      abandon('nothing is looking at this store any more');
      lastQuery = null;
    },
  };
}
