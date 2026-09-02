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
  /** The frame did not parse, or named something the peer does not implement. */
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
