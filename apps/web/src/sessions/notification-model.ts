import type { GraphRunApproval } from '@agentplex/protocol';
import { graphHash } from '../graphs/graph-route.js';
import { sessionHash } from '../terminal/session-route.js';
import type { HubCommand } from '../store/hub-store.js';
import type { Tone } from '../ui/tokens.js';
import { acknowledgeCommand, offersAcknowledge } from './attention-model.js';
import {
  ageLabel,
  orderByActivity,
  statusWords,
  wantsAttention,
  type SessionListItem,
} from './session-list-model.js';

/**
 * What the bell opens, as pure functions: the sessions asking for somebody,
 * above the ones that already got somebody, each row a way into the session it
 * names.
 *
 * Two presentations render this -- the popover at desk widths and the sheet at
 * phone widths -- and they render the same rows from here. The breakpoint
 * decides the container, not the content: a list that said one thing on a
 * laptop and another on a phone would be two claims about one fleet.
 *
 * Every row is drawn from what the state actually carries. The mockup's
 * earlier rows say a pull request was opened, a benchmark finished and a
 * machine went offline three days ago; nothing this client is sent carries any
 * of that, so none of it is here. An event the app cannot observe is absent
 * rather than invented.
 */

/** What both presentations draw of a row, whatever it is about. */
interface RowWords {
  /** The stable render key: the session's, or the request's for a run. */
  readonly key: string;
  /** The tone dot: the subject's own, never one this list decides. */
  readonly tone: Tone;
  /** The first line. */
  readonly sentence: string;
  /** The second line: where it lives, which machine, how long ago. */
  readonly place: string;
  /** Where the row leads, which is where the card or the graph leads. */
  readonly href: string;
}

/** A session asking for somebody, with the item the commands a control sends are about. */
export interface SessionNotificationRow extends RowWords {
  readonly kind: 'session';
  readonly item: SessionListItem;
}

/**
 * A graph run waiting on a person. It is answered where its graph is drawn,
 * which is where the row leads; no command in this list is about it, since
 * an approval is answered and not acknowledged.
 */
export interface GraphRunNotificationRow extends RowWords {
  readonly kind: 'graphRun';
  readonly waiting: GraphRunApproval;
}

/**
 * One row, with everything both presentations draw already worked out.
 *
 * Two kinds and a discriminator, because the second thing that can want a
 * person is a graph run and it is not a session: it has no store, no machine
 * and no acknowledgement. A row that pretended otherwise would be a row with
 * a null item every consumer had to remember to check.
 */
export type NotificationRow = SessionNotificationRow | GraphRunNotificationRow;

/**
 * The two sections, in the order they are drawn.
 *
 * Two named fields rather than an array of sections, because the two are not
 * interchangeable: the first is what somebody opened the bell for and the
 * second is the receipt. A caller asking for "the section that can be marked
 * read" is asking for `needsYou` by name.
 */
export interface NotificationList {
  readonly needsYou: readonly NotificationRow[];
  readonly earlier: readonly NotificationRow[];
}

/**
 * The sentence a row leads with: the session's name and the state it is in.
 *
 * Deliberately thin. The row is allowed to say what its item carries and
 * nothing more, and an item carries a name and a status -- not the command a
 * session is asking to run, not what it did before it stopped. A sentence that
 * named a command would be a sentence the next state could contradict.
 */
export function sentenceFor(item: SessionListItem): string {
  return `${item.name} is ${statusWords(item.status)}`;
}

/**
 * The words for where a session lives, until there is a better answer.
 *
 * The store id, which is the truthful thing the state carries today. AGX-254
 * adds `placeLabel` to `session-list-model`, which names the project a store
 * belongs to and falls back to the store id; when it lands, this function goes
 * and the call below becomes `placeLabel(item)`. It is a local function rather
 * than an inline expression precisely so that replacement is one line.
 */
function placeWords(item: SessionListItem): string {
  return item.storeId;
}

/** The second line, as the mock reads it: where, which machine, how long. */
export function placeLine(item: SessionListItem, now: number): string {
  return `${placeWords(item)} · ${item.machine} · ${ageLabel(now, item.updatedAt)}`;
}

function rowFor(item: SessionListItem, now: number): SessionNotificationRow {
  return {
    kind: 'session',
    item,
    key: item.key,
    tone: item.tone,
    sentence: sentenceFor(item),
    place: placeLine(item, now),
    // The same helper the card's stretched link uses, so the two ways into a
    // session cannot address different ones.
    href: sessionHash(item.ref),
  };
}

/** The sentence a run's row leads with: the run number and the node it waits at, and nothing of the request. */
export function runSentenceFor(waiting: GraphRunApproval): string {
  return `run #${String(waiting.number)} is waiting at ${waiting.nodeLabel}`;
}

function runRowFor(waiting: GraphRunApproval, now: number): GraphRunNotificationRow {
  return {
    kind: 'graphRun',
    waiting,
    key: `graph-run:${waiting.approval.approvalId}`,
    // The tone of everything on the screen that wants somebody.
    tone: 'needs-you',
    sentence: runSentenceFor(waiting),
    place: `graph run · ${ageLabel(now, waiting.approval.requestedAt)}`,
    // The graph's own address, the same helper the tree uses, so the row and
    // the tree cannot open different graphs.
    href: graphHash(waiting.graph),
  };
}

/** When a row last moved: the session's activity, or the moment a run asked. */
function movedAt(row: NotificationRow): number {
  return row.kind === 'session' ? row.item.updatedAt : row.waiting.approval.requestedAt;
}

/**
 * The list, from whatever items the surface chose to speak for, and every
 * graph run waiting on a person.
 *
 * `wantsAttention` splits it, which is the same function the bell counts with:
 * the section under the bell holds exactly what the bell's number counted, or
 * opening it would answer the badge with a different list. What is left of the
 * needs-you rows -- the acknowledged ones -- is the second section, and a
 * muted session is in neither, because a mute is the standing answer "stop
 * making noise about this" and this list is the noise.
 *
 * A run waiting on a person is in the first section for as long as it waits:
 * there is no acknowledging one, because the thing to do about it is answer,
 * and the request leaves the state the moment somebody does.
 *
 * Activity order, newest first, inside each section. It narrows nothing
 * itself: whether the bell speaks for a fleet or for one machine is a question
 * about that surface, answered where the items are chosen.
 */
export function notificationList(
  items: readonly SessionListItem[],
  now: number,
  waiting: readonly GraphRunApproval[] = [],
): NotificationList {
  const ordered = orderByActivity(items);
  const needsYou: NotificationRow[] = [
    ...ordered.filter(wantsAttention).map((item) => rowFor(item, now)),
    ...waiting.map((run) => runRowFor(run, now)),
  ].sort((left, right) => movedAt(right) - movedAt(left));
  return {
    needsYou,
    earlier: ordered
      .filter((item) => item.needsYou && item.acknowledged && !item.muted)
      .map((item) => rowFor(item, now)),
  };
}

/**
 * What Mark all read sends: one acknowledgement per listed session, and
 * nothing else.
 *
 * Commands, not a send. The socket can be down and the queue can refuse, and
 * the component holding the popover is the thing that can say so on screen --
 * so this hands back the frames and lets the caller report what came of them.
 *
 * No mute is ever produced. Muting is a per-session decision and bulk
 * acknowledging is not a way to make one, in either direction: a muted session
 * is not in the list at all, so nothing here can reach it.
 *
 * `offersAcknowledge` filters, which for the needs-you section is every row by
 * construction and for any other section is none: acknowledging an
 * acknowledged session would restamp a moment to no effect.
 */
export function markAllRead(rows: readonly NotificationRow[]): readonly HubCommand[] {
  return rows
    .flatMap((row) => (row.kind === 'session' ? [row.item] : []))
    .filter(offersAcknowledge)
    .map(acknowledgeCommand);
}
