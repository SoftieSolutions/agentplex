import type { FrameId, HubFrame } from '@agentplex/protocol';

/**
 * What the hub has answered this client's commands with, by the id of the
 * frame each answer names.
 *
 * Every command reply carries `replyTo`, and so does a refusal, so one map
 * keyed by it -- beside the frames still owed one, `Answers` -- is the whole
 * of the correlation: a screen holds the id it sent and reads its own answer,
 * and another screen's answer is an entry it never looks at. The alternative
 * this replaces was one slot per reply type plus one for the newest refusal,
 * which every screen then matched by hand -- and a later yes to anybody
 * cleared a refusal somebody was still showing.
 *
 * Not every frame with a `replyTo` is kept. The ones a screen never waits on
 * through this map stay out, because each would cost a place in a bounded map
 * that real answers need: `pong` arrives every thirty seconds, the layout and
 * the subscription answers are standing interest with fields of their own on
 * the snapshot, a catalogue page and a pairing answer settle a promise, a
 * transcript is large and already bounded in `transcripts`, a graph document
 * is filed by its node in `graphDocuments` because a screen reads it by node,
 * and a pane-layout save is waited on by nobody.
 */
export type AnswerType =
  | 'session-started'
  | 'session-stopped'
  | 'session-paused'
  | 'session-resumed'
  | 'session-attention'
  | 'approval-decided'
  | 'approval-policy'
  | 'push-subscribed'
  | 'push-unsubscribed'
  | 'directory-listing'
  | 'project-created'
  | 'node-created'
  | 'node-renamed'
  | 'node-moved'
  | 'node-removed'
  | 'node-removal-forgotten'
  | 'doc-created'
  | 'doc-saved'
  | 'doc-content'
  | 'graph-created'
  | 'graph-saved'
  | 'graph-published'
  | 'graph-run-started'
  | 'graph-run-cancelled'
  | 'graph-run-latest'
  | 'graph-run-history'
  | 'graph-simulated';

/** One yes, of one or more of the types above. */
export type Answer<T extends AnswerType = AnswerType> = Extract<HubFrame, { type: T }>;

/** The hub's no, whole: the words, the code, and the holder when there is one. */
export type Refusal = Extract<HubFrame, { type: 'refusal' }>;

/** Anything this map keeps: an answer, or a refusal that is not about a terminal. */
export type Reply = Answer | Refusal;

/**
 * What a screen reads its own answer out of: the replies, and which frames are
 * still owed one.
 *
 * The second half is what lets a bounded map forget. An id with no reply in
 * `replies` is either a frame the hub has not answered yet or one whose answer
 * has gone -- pushed out by later ones, or never coming because the connection
 * it went out on dropped. Only the first is worth waiting on, and only the
 * store knows which is which, so it says: `outstanding` is every frame it has
 * sent and not had answered on the connection it went out on, and every frame
 * queued to go out on the next one.
 */
export interface Answers {
  /** The replies, by the id of the frame each answers; bounded and ordered oldest first. */
  readonly replies: ReadonlyMap<FrameId, Reply>;
  /** The frames still owed an answer: sent on this connection, or queued for the next. */
  readonly outstanding: ReadonlySet<FrameId>;
}

/** Nothing answered and nothing owed: a store before its first command, and after it stops. */
export const NO_ANSWERS: Answers = { replies: new Map(), outstanding: new Set() };

/**
 * How many replies a connection remembers, oldest first.
 *
 * The number `starts` is bounded by, and for the same reason: far above any
 * screen's worth of controls waiting at once, and small enough that a tab left
 * open all day cannot grow it without bound.
 *
 * What forgetting costs is the answer and nothing else. A control that keeps
 * its pending id after the answer arrived and stays mounted -- a pause button
 * that now offers Resume, an Unmute beside a row that is still drawn -- reads
 * `idle` once sixty-four later replies have pushed its answer out, because the
 * id is not `outstanding` either: it is enabled and wears its resting label,
 * and what it draws is decided by the state the hub publishes. A document
 * saving itself every second and a half makes sixty-four replies in minutes,
 * so a control that went on reading `waiting` would be disabled for good.
 */
export const MAX_REMEMBERED_ANSWERS = 64;

/**
 * The map with `reply` filed under the frame it answers, the oldest dropped
 * past the bound.
 *
 * A new map every time, because the snapshot hands this one to React and a
 * map changed in place is a map React cannot see change.
 *
 * At most one document body is held: a `doc-content` answer drops any earlier
 * one. A body may be a quarter of a million characters, and the editor that
 * asked has taken it by the time the next one arrives.
 */
export function rememberAnswer(
  answers: ReadonlyMap<FrameId, Reply>,
  reply: Reply,
): ReadonlyMap<FrameId, Reply> {
  const next = new Map(answers);
  if (reply.type === 'doc-content') {
    for (const [held, answer] of next) {
      if (answer.type === 'doc-content') next.delete(held);
    }
  }
  // Deleted first so a second answer to one id counts as the newest.
  next.delete(reply.replyTo);
  next.set(reply.replyTo, reply);
  while (next.size > MAX_REMEMBERED_ANSWERS) {
    const oldest = next.keys().next();
    if (oldest.done === true) break;
    next.delete(oldest.value);
  }
  return next;
}

/**
 * Where one frame a screen sent has got to.
 *
 * `idle` is nothing to wait for: nothing sent, or a frame whose answer has been
 * forgotten or will never come (see `Answers`). `waiting` is a frame still
 * owed an answer; the other two are the hub's answer to exactly that frame. A
 * refusal carries the whole frame as well as its words, because some screens
 * act on its code or its holder.
 */
export type FollowUp<A extends Answer> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'refused'; readonly words: string; readonly refusal: Refusal }
  | { readonly kind: 'answered'; readonly answer: A };

function isAnswerOf<T extends AnswerType>(reply: Reply, types: readonly T[]): reply is Answer<T> {
  return types.some((type) => type === reply.type);
}

/**
 * What the hub said about `pending`, read as one of `types`.
 *
 * An answer of a type the caller did not name is not an answer to it: an id is
 * spent on one frame, so that is a screen holding somebody else's id, and it
 * waits rather than reading a yes it did not ask for.
 */
export function followUp<T extends AnswerType>(
  pending: FrameId | null,
  answers: Answers,
  ...types: readonly [T, ...T[]]
): FollowUp<Answer<T>> {
  if (pending === null) return { kind: 'idle' };
  const reply = answers.replies.get(pending);
  if (reply === undefined) {
    return answers.outstanding.has(pending) ? { kind: 'waiting' } : { kind: 'idle' };
  }
  if (reply.type === 'refusal') return { kind: 'refused', words: reply.message, refusal: reply };
  if (isAnswerOf(reply, types)) return { kind: 'answered', answer: reply };
  return { kind: 'waiting' };
}

/** The refusal to `pending`, or `null` when there is none -- or nothing is pending. */
export function refusalTo(answers: Answers, pending: FrameId | null): Refusal | null {
  if (pending === null) return null;
  const reply = answers.replies.get(pending);
  return reply?.type === 'refusal' ? reply : null;
}

/**
 * The refusal the most recent reply was, or `null` when that reply was a yes.
 *
 * What "the hub refused the last request" means on the connection line. A
 * refusal with a later yes after it is still held for the screen that asked,
 * but it is no longer what became of the last request, and saying it was
 * would be the line over-claiming a failure that has since been answered.
 */
export function refusalToLatest(answers: Answers): Refusal | null {
  const held = [...answers.replies.values()];
  const latest = held[held.length - 1];
  return latest?.type === 'refusal' ? latest : null;
}

/**
 * The most recent reply of one type, whoever asked for it, or `null`.
 *
 * For the one reader that is about the connection rather than one control:
 * the list's line about a stop that landed, whoever asked for it. Every other
 * reader asks by its own id through `followUp`.
 */
export function newestAnswer<T extends Reply['type']>(
  answers: Answers,
  type: T,
): Extract<Reply, { type: T }> | null {
  const held = [...answers.replies.values()];
  for (let index = held.length - 1; index >= 0; index -= 1) {
    const reply = held[index];
    if (reply !== undefined && isOfType(reply, type)) return reply;
  }
  return null;
}

function isOfType<T extends Reply['type']>(
  reply: Reply,
  type: T,
): reply is Extract<Reply, { type: T }> {
  return reply.type === type;
}
