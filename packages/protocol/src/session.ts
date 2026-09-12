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
 * What one session has spent, in tokens, as the provider itself counted it.
 *
 * Tokens and not money. A token count is a number the provider states about
 * its own work; a dollar figure is a conversion through a price table that
 * agentplex does not control, cannot verify, and would be shipping at its own
 * release cadence rather than at the vendor's pricing cadence. So this carries
 * the fact, and whatever converts it owns the estimate and the caveat that has
 * to be rendered with it.
 *
 * The four buckets are disjoint and they stay disjoint, because they are not
 * four ways of saying "input". Cached input is billed at a fraction of fresh
 * input -- an order of magnitude, for the providers here -- and a cache write
 * is billed above it. Collapsing them into one number does not lose precision,
 * it produces a wrong answer: a long session is mostly cache reads, so a
 * flattened figure over-states its cost several-fold. A provider that reports
 * a total it cannot break down this way is not represented by zeroes in three
 * of these fields; it reports no usage at all.
 *
 * Every adapter normalises into this shape, and no two of them arrive from the
 * same arithmetic. Claude Code states four disjoint counts directly. codex
 * states an input total with the cached part *inside* it, so its adapter
 * subtracts. Anything above an adapter reads these four and never learns which
 * of those a session came from.
 */
export const sessionUsageSchema = z.object({
  /** Fresh input: prompt tokens the provider billed at its full input rate. */
  inputTokens: z.int().nonnegative(),
  /** Input served out of the prompt cache, billed far below fresh input. */
  cacheReadTokens: z.int().nonnegative(),
  /** Input written into the prompt cache, billed above fresh input. */
  cacheWriteTokens: z.int().nonnegative(),
  /** Everything generated, reasoning and visible text alike -- they are billed alike. */
  outputTokens: z.int().nonnegative(),
});
export type SessionUsage = z.infer<typeof sessionUsageSchema>;

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
  /**
   * What this session has spent, or nothing at all.
   *
   * Optional, and alone among this descriptor's fields in that -- `cwd` and
   * `title` are nullable because "the provider was asked and does not record
   * one" is a different fact from "nobody filled this in", and for a working
   * directory it is a difference a reader acts on. Here it is not. A session
   * whose transcript carries no usage and a report from something that does not
   * count tokens are the same fact to everything downstream: there is no number
   * to show, and the surface has to render that as absence.
   *
   * What is never allowed is the third possibility. An absent field is not
   * zero. Zero appears here only when a provider counted and said zero, and a
   * consumer that defaults this to a zeroed record has turned "unknown" into
   * "free" -- which is the direction that over-claims, on the one screen where
   * over-claiming is a number somebody budgets against.
   */
  usage: sessionUsageSchema.optional(),
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
