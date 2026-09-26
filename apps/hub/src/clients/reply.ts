import type { FrameId, HubFrame, RefusalCode, SessionHolder } from '@agentplex/protocol';
import type { LogFields, Logger } from '@agentplex/node-shared';

/**
 * What an answer may do with the connection it answers on, and no more.
 *
 * Four things, and the missing ones are the reason it is not the connection:
 * an answer cannot close the socket, cannot read the frame that is not its
 * own, and cannot mark a graph watched. It replies to one frame id or it says
 * nothing.
 */
export interface ReplyContext {
  send(frame: HubFrame): void;
  refuse(replyTo: FrameId, code: RefusalCode, message: string, holder?: SessionHolder | null): void;
  /** Read after every await: the socket may have closed while the work ran. */
  isEstablished(): boolean;
  readonly logger: Logger;
}

/**
 * The one refusal frame, built in one place.
 *
 * `holder` is `null` unless the refusal is about a live process, which is
 * every refusal but a session's and a tree edit's: it is the field that means
 * "it is running over here", and a directory or a document has nothing to
 * name.
 */
export function refusal(
  replyTo: FrameId,
  code: RefusalCode,
  message: string,
  holder: SessionHolder | null = null,
): HubFrame {
  return { type: 'refusal', replyTo, code, message, holder };
}

/** The two sentences an answer is logged and refused with when its work throws. */
export interface ReplyWords {
  /** The log line, which stays on the hub. */
  readonly doing: string;
  /** The refusal the client reads. It names the act and never the cause. */
  readonly failure: string;
  /** Fields the log line carries beside `problem`. */
  readonly fields?: LogFields;
}

/**
 * Does one frame's work and answers the client that sent it.
 *
 * The shape every answer on this direction has, written once. The work is
 * not awaited by the switch that starts it, because a database round trip or
 * another machine must not stall every later frame on the socket; so the
 * state is read again once it settles, and a socket that closed meanwhile is
 * sent nothing. What the work did still stands -- only the receipt is dropped.
 *
 * `answer` turns the value into the frame to send, which may be a refusal in
 * the feature's own words. It may instead be a further answer that sends for
 * itself, which is what a policy edit is: it ends in the policy as it now
 * stands, read by the one function that answers a list.
 *
 * A throw is logged first and unconditionally, then refused as `internal` if
 * anybody is left to tell. The order matters: a failure after the client went
 * away is still a failure the operator should see. `internal` rather than
 * `refused` because the hub broke and retrying may work; the problem itself
 * is logged and not sent, because what broke inside the hub is not a client's
 * to render.
 */
export async function reply<T>(
  ctx: ReplyContext,
  replyTo: FrameId,
  { doing, failure, fields }: ReplyWords,
  work: () => Promise<T>,
  answer: (value: T) => HubFrame | Promise<void>,
): Promise<void> {
  try {
    const value = await work();
    if (!ctx.isEstablished()) return;
    const next = answer(value);
    if (next instanceof Promise) {
      await next;
      return;
    }
    ctx.send(next);
  } catch (error) {
    ctx.logger.error(doing, { ...fields, problem: String(error) });
    if (!ctx.isEstablished()) return;
    ctx.refuse(replyTo, 'internal', failure);
  }
}
