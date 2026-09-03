import { z } from 'zod';

/**
 * Correlates a request with its reply.
 *
 * Ids come from a per-connection counter rather than `crypto.randomUUID`: that
 * API exists only in a secure context, and a client served over plain HTTP on a
 * LAN is not one. A counter needs no such context and is enough, because the
 * only thing an id has to be is unique within one connection.
 */
export const frameIdSchema = z.int().positive();
export type FrameId = z.infer<typeof frameIdSchema>;

/** Why a request was refused. The set is closed so a client can react to a case. */
export const refusalCodeSchema = z.enum([
  /** The frame parsed but named something the peer does not implement. */
  'bad-request',
  /** The credential was missing, wrong, or already spent. */
  'unauthorized',
  /** The peers do not speak the same protocol version. */
  'protocol-version',
  /** The request was well-formed but the state of the world says no. */
  'refused',
  /** The peer failed while handling it; retrying may work. */
  'internal',
]);
export type RefusalCode = z.infer<typeof refusalCodeSchema>;

/**
 * Says that a frame could not be read at all.
 *
 * A refusal names the frame it answers, and that is the whole point of it: it
 * goes back to the peer that asked and to nobody else. A frame that did not
 * parse has no id to name — the id is one of the things that failed to parse —
 * so a refusal cannot carry the case its own `bad-request` code describes, and
 * the only thing left to do with an unreadable frame was to close the socket.
 *
 * Making `replyTo` optional on `refusal` was the alternative. It was rejected:
 * it would spend the guarantee that a refusal is a reply, everywhere, to
 * describe the one situation where there is nothing to reply to. Every consumer
 * would have to branch on whether the refusal it just read is correlated with
 * anything, forever. A separate frame keeps "I read it and said no" and "I
 * could not read it" as two facts rather than one fact with a hole in it.
 *
 * It is unsolicited, so it appears on every direction: each one is read by
 * somebody, and every reader needs a way to say what it could not read.
 */
export const protocolErrorFrameSchema = z.object({
  type: z.literal('protocol-error'),
  /** Only the two reasons a frame can be unreadable, not the whole refusal set. */
  code: z.enum(['bad-request', 'protocol-version']),
  /** What the parser objected to. Never the offending frame echoed back. */
  message: z.string(),
});
export type ProtocolErrorFrame = z.infer<typeof protocolErrorFrameSchema>;
