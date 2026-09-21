import type { SessionStatus } from './session.js';

/**
 * The needs-you rule: whether a session should be making a noise at somebody.
 *
 * It lives in the protocol because two programs now have to reach the same
 * verdict about one row. The client draws an accent border, a bell and a
 * document title from it; the hub sends a push from it, to a phone whose owner
 * is not looking at the client at all. Two copies of this rule would be two
 * answers about whether to interrupt a person, and the one that is wrong is
 * the one nobody is watching -- a notification that arrives for a prompt the
 * screen has already stopped showing, or a silence on a screen that is lit up.
 *
 * Here rather than in either of them, because `packages/protocol` is the seam
 * they share: it already owns `SessionStatus` and the wire row these read, it
 * is bundled into the browser as well as loaded by the hub, and it is the one
 * place neither side can claim as its own dialect.
 *
 * The original is `apps/web/src/sessions/session-list-model.ts`, where these
 * three rules were worked out and where they still run today. The web app
 * adopts these in a follow-up: that file is under a stack of changes in
 * flight, and moving it in the same change that introduces this would put a
 * conflict in front of every one of them for no reading anybody gains. Until
 * it does, the model there and this are two spellings of one rule, and this is
 * the one a change belongs in.
 */

/**
 * The two statuses that want a human.
 *
 * `unknown` is deliberately not among them, and that is the one judgement in
 * this function: an adapter that could not read a transcript has said so, and
 * treating that as a prompt would be a notification sent on the strength of a
 * failed read.
 */
export function wantsHuman(status: SessionStatus): boolean {
  return status === 'awaiting-permission' || status === 'awaiting-input';
}

/**
 * Whether an acknowledgement still holds.
 *
 * An acknowledgement is a timestamp, and it holds only while the session has
 * said nothing since. A boolean would go sticky through a second prompt --
 * dismiss the first, let the agent run on to a second, and a flag set once
 * claims that one has been seen too.
 *
 * Both numbers are `descriptor.updatedAt` values, off the one clock that wrote
 * the transcript: `acknowledgedThrough` is the reading the hub saw when
 * somebody said they had looked, and `updatedAt` is the reading now. Nothing
 * here touches a wall clock, which is the point. The hub's clock on one side
 * of this comparison would make the answer depend on how far the hub had
 * drifted from the machine running the agent, and a hub a few seconds ahead
 * would read a second prompt as already seen -- silently, which is the exact
 * failure a timestamp was chosen over a boolean to avoid.
 *
 * Equal is held, and that is not a tie-break: the two numbers are equal
 * precisely while the session has not been written to since the
 * acknowledgement, which is the common case and the whole of what an
 * acknowledgement claims.
 */
export function acknowledgementHolds(
  acknowledgedThrough: number | null,
  updatedAt: number,
): boolean {
  return acknowledgedThrough !== null && updatedAt <= acknowledgedThrough;
}

/**
 * The four fields the rule below reads, and nothing else.
 *
 * A wire `SessionRow` satisfies this as it stands, which is what the test
 * pins: the hub's reducer holds its attention pair in a little object beside
 * the row and the wire flattens it, so stating the four fields structurally
 * lets both shapes be asked the same question without either of them being
 * rebuilt into the other's form. Narrowing it to exactly what is read is also
 * what keeps a title, a directory and a branch out of reach of a rule that has
 * no business with them.
 */
export interface AttentionSubject {
  readonly descriptor: { readonly status: SessionStatus; readonly updatedAt: number };
  /**
   * Whether any server that reported this session is reachable right now.
   *
   * In the rule rather than beside it: a prompt on a machine nobody can reach
   * cannot be answered, and a badge you cannot clear by looking -- or a
   * notification you cannot act on -- is worse than none.
   */
  readonly reachable: boolean;
  readonly acknowledgedThrough: number | null;
  readonly mutedAt: number | null;
}

/**
 * Whether this session should be making a noise: it wants a human, somebody
 * can reach it, nobody has said they have seen it, and it is not muted.
 *
 * Deliberately narrower than the needs-you fact the list partitions and counts
 * on. Acknowledging and muting stop the noise and never the fact: the row
 * keeps its accent, keeps saying how long it has been waiting, and keeps
 * counting. This is the answer to the narrower question of whether to
 * interrupt somebody, which is why it is the one the push reads.
 */
export function wantsAttention(subject: AttentionSubject): boolean {
  return (
    wantsHuman(subject.descriptor.status) &&
    subject.reachable &&
    !acknowledgementHolds(subject.acknowledgedThrough, subject.descriptor.updatedAt) &&
    subject.mutedAt === null
  );
}
