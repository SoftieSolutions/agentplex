import { z } from 'zod';
import { frameIdSchema } from './frames.js';
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
 * How many per-file rows a descriptor may carry.
 *
 * The rows ride on a frame that carries every session in a store and is sent
 * again on every scan, so an unbounded list would make one refactor in one
 * session cost the whole fleet's traffic. Twenty covers what an agent's working
 * tree looks like almost always, and the totals beside the list are over
 * everything, so a client with more files than this has the true count and a
 * prefix of the rows rather than a wrong count.
 */
export const UNCOMMITTED_FILES_LISTED = 20;

/**
 * One file, as git counted it.
 *
 * Both nullable fields are a refusal to invent a number, and they are different
 * refusals.
 *
 * `added` and `removed` are `null` together for a file git would not count — a
 * binary, or one a `.gitattributes` marks as such. Zero would say the bytes did
 * not move, which is the opposite of what git meant by declining.
 *
 * `path` is `null` when git printed a name in bytes that are not UTF-8. A file
 * name on Linux is bytes and not text, and the decoding this server does on the
 * way in cannot be undone. So the file still counts — it is in `files` and its
 * lines are in the totals — and only its name is missing, because dropping the
 * row would undercount and printing the replacement characters would put a name
 * on screen that opens nothing.
 */
export const changedFileSchema = z.object({
  path: z.string().min(1).nullable(),
  added: z.int().nonnegative().nullable(),
  removed: z.int().nonnegative().nullable(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

/**
 * Uncommitted work in a session's working tree: what is there now and is not in
 * `HEAD`.
 *
 * The name is the whole point of this type. "Changed" means two things about a
 * git repository — what is uncommitted, and what the branch has done since it
 * left its base — and the mockup this comes from shows both numbers without
 * saying which is which. They are nowhere near each other in value, and a
 * client that rendered one as the other would be confidently wrong, so the
 * field is named for the one it is; a branch diffstat, if it ever lands, gets a
 * field of its own rather than this one.
 *
 * Only this one is here, because only this one can be read without answering a
 * question nobody has answered. A branch diffstat is `git diff <base>...HEAD`,
 * and there is no honest `<base>` for an arbitrary checkout: `origin/HEAD` is
 * absent from a repository cloned `--single-branch` and from one that was never
 * cloned at all, the "default branch" is a hosting provider's idea that git does
 * not store, and a stack of dependent branches — how this repository is
 * actually worked in — has a base that is another branch rather than the trunk.
 * A number computed against the wrong ref looks exactly like one computed
 * against the right one. It needs a base the user configured per store, which is
 * its own ticket; until then the absence of the field is the honest answer.
 *
 * What is counted is every tracked file that differs from `HEAD`, staged and
 * unstaged alike, which is what somebody watching an agent edit their checkout
 * means by "files changed". Untracked files are not in it: git counts no lines
 * for a file it is not tracking, and walking one to count them here would mean
 * reading a directory nobody bounded. `git.status` already counts untracked
 * entries in its own total, and the two stay separate numbers because they
 * answer separate questions.
 */
export const uncommittedDiffSchema = z.object({
  /** Tracked files differing from HEAD. The true total, including unlisted ones. */
  files: z.int().nonnegative(),
  /** Lines added and removed over every file git counted. Binaries add nothing. */
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  /**
   * A bounded prefix of the per-file rows, in the order git printed them.
   *
   * `entries.length < files` is a list that was cut and not a disagreement: the
   * counts above are over all of `files`. A client draws the rows it has and
   * says how many it does not.
   */
  entries: z.array(changedFileSchema).max(UNCOMMITTED_FILES_LISTED),
});
export type UncommittedDiff = z.infer<typeof uncommittedDiffSchema>;

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
  /**
   * The uncommitted work in this session's working directory, or `null` when
   * this server did not read it.
   *
   * `null` is the whole of "did not read it", whatever the reason: the
   * directory is not a git repository, git is not installed, git took too long,
   * the repository has no commits to be different from, or the server did not
   * ask because it had already asked about enough directories for one scan. A
   * client draws nothing rather than a zero, because a zero here says a person
   * has nothing outstanding and every one of those cases says only that nobody
   * looked.
   *
   * Read by the server, on the server, from the directory the provider recorded
   * — never from anything on a frame. The hub relays this field and computes
   * none of it: the working tree is on one machine's disk and nowhere else.
   */
  uncommitted: uncommittedDiffSchema.nullable(),
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

/**
 * A session a server started, tagged with the start that asked for it.
 *
 * The provenance of a spawn, and the thing that makes rebinding exact rather
 * than heuristic. A `session-start` frame's own id is the start handle; the
 * server tags the terminal it forked with it, and reports the tag until the
 * provider has named the session. The reader gets two facts in one place --
 * "this start is running here" and, on the first report after discovery, "and
 * it turned out to be this session" -- which is what lets a pending pane
 * become the real session's pane without guessing by time.
 *
 * `sessionId` is `null` for exactly as long as the provider has not written
 * one. The tag stops being reported once it has been sent with an id: a
 * handle local to one connection is worth putting on the wire while it is the
 * only name a session has, and not one report longer.
 */
export const sessionStartTagSchema = z.object({
  /** The id of the `session-start` frame, on the connection that sent it. */
  startId: frameIdSchema,
  sessionId: sessionIdSchema.nullable(),
});
export type SessionStartTag = z.infer<typeof sessionStartTagSchema>;
