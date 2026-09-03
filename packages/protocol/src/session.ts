import { z } from 'zod';
import { providerSchema, sessionRefSchema } from './identity.js';

/**
 * How a session is doing, in the one vocabulary every provider is reduced to.
 *
 * The set is closed and small because a client renders it as a tone and the
 * hub partitions on it: two of these values want a human, the rest do not.
 * Each provider says this in its own words — a permission prompt in a Claude
 * transcript looks nothing like one in codex's — and translating is the
 * adapter's job, so that nothing above the adapter learns a provider's
 * vocabulary.
 */
export const sessionStatusSchema = z.enum([
  /** A live process is doing something. */
  'working',
  /** Stopped on a tool the user has to approve. The loudest state there is. */
  'awaiting-permission',
  /** The provider asked, or finished its turn, and is waiting to be spoken to. */
  'awaiting-input',
  /** Nothing running and nothing pending. */
  'idle',
  /**
   * The adapter could not tell. A real value rather than a gap, because the
   * alternative is guessing `idle` at a session that may be waiting on someone.
   */
  'unknown',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * A session as a server reports it.
 *
 * `provider` is on here from day one, not added when the second adapter lands:
 * v2 drives only Claude Code, but a hub that meets a session it cannot drive
 * must still be able to say what it is, and a client that cannot say which
 * agent a row belongs to is wrong on a screen with two of them. The field is
 * cheap now and a protocol change later.
 */
export const sessionDescriptorSchema = sessionRefSchema.extend({
  provider: providerSchema,
  status: sessionStatusSchema,
  /**
   * Epoch ms of the last thing the provider wrote into this session, as the
   * provider dated it rather than as the filesystem did: a store copied to
   * another disk keeps its sessions, and mtime does not survive the copy.
   */
  updatedAt: z.int().nonnegative(),
});
export type SessionDescriptor = z.infer<typeof sessionDescriptorSchema>;
