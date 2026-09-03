import { z } from 'zod';
import { providerSchema, sessionIdSchema, sessionRefSchema } from './identity.js';

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
  /**
   * The directory the session was working in, as its own transcript recorded
   * it, or `null` when the provider does not say.
   *
   * Nullable rather than optional, and on the wire rather than derived later,
   * for the reason `provider` is: a list of sessions with nothing but ids on it
   * is unreadable, and every provider that keeps transcripts records a working
   * directory in them. `null` is the adapter saying it looked and found none,
   * which is a different fact from a field nobody filled in.
   *
   * It is a label, never an argument. Nothing sends it back, and no spawn
   * takes a cwd off a frame: that is the operation registry's job.
   */
  cwd: z.string().min(1).nullable(),
  /** What the provider calls this session, if it names its sessions at all. */
  title: z.string().min(1).nullable(),
});
export type SessionDescriptor = z.infer<typeof sessionDescriptorSchema>;

/**
 * A session one server is running right now, as that server says so.
 *
 * This is the one-live-process-per-session rule made into a fact the hub can
 * read. A session is held by whichever server has a live process on it, and
 * only the server can know that; the hub is the authority on the rule across
 * servers, and it can only be that if the servers say which sessions they hold.
 *
 * What is deliberately not here is the pid and the terminal id. Both are the
 * server's own bookkeeping, and neither survives the trip usefully: a pid is
 * meaningless on any other machine and a terminal id is a handle nothing off
 * that server may hold. A stop names `{ storeId, sessionId }` and the server
 * resolves it back to its own terminal, which is what keeps the process handle
 * on the machine that owns the process.
 *
 * `stoppable` is on the wire rather than derived from `status`, because it is
 * the server's answer and not a rule anybody else may restate. The one live
 * meaning today is that a working agent is not offered a stop — interrupting a
 * turn mid-tool is how a half-applied edit is left on disk — and a client that
 * re-derived that from a status would be a second copy of the rule to keep in
 * step with the first.
 */
export const sessionHoldSchema = z.object({
  sessionId: sessionIdSchema,
  /** Whether a stop may be offered. False while the agent is mid-turn. */
  stoppable: z.boolean(),
});
export type SessionHold = z.infer<typeof sessionHoldSchema>;
