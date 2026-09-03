import { z } from 'zod';
import { serverIdSchema, serverRegistrationIdSchema, storeIdSchema } from './identity.js';
import { sessionDescriptorSchema } from './session.js';

/**
 * The whole of what the hub believes, as a client reads it.
 *
 * This is the published view of the hub's reducer, and it is published whole.
 * There is no delta frame here and there is not going to be one: two clients
 * that applied different subsets of an edit stream disagree, and neither of
 * them nor the hub can say which is right. A client that has the newest
 * `version` has the whole state, because there is nothing else to have.
 *
 * The one rule that shapes what follows: nothing appears twice. A server is
 * described once, in `servers`, and a store names the servers attached to it by
 * id. Inlining the server objects under each store would let one frame
 * contradict itself -- the same machine `connected` in one place and `stale` in
 * another -- which is the disagreement this design exists to make impossible,
 * reintroduced inside a single message.
 */

/** Epoch milliseconds, or `null` for a moment that has not happened. */
const momentSchema = z.int().nonnegative().nullable();

/**
 * Where a connection is, as one word.
 *
 * `stopped` is here because the phase is one union and a wire enum missing a
 * member would be a cast at the boundary that projects it. In practice a client
 * does not see it: the reducer forgets a stopped server along with its rows,
 * because a revoked pairing's sessions are claims nothing stands behind.
 */
export const serverPhaseSchema = z.enum(['connecting', 'connected', 'stale', 'stopped']);
export type ServerPhase = z.infer<typeof serverPhaseSchema>;

/**
 * Why a server is unreachable, kept apart because they are different things for
 * a person to do: wait, re-pair, or look at the hub.
 *
 * `problem` beside it is the sentence to show. This is the part a client may
 * branch on -- whether to offer a re-pair button -- and a free-text reason
 * cannot be branched on without a client parsing English.
 */
export const staleReasonSchema = z.enum([
  /** The dial never reached anything. A laptop that is asleep. */
  'unreachable',
  /** It answered the dial and then said nothing in time. */
  'timeout',
  /** The token was not accepted. Only re-pairing fixes it. */
  'unauthorized',
  /** The two builds do not speak the same protocol. Only an upgrade fixes it. */
  'protocol-version',
  /** The server sent something the hub could not read. */
  'protocol-error',
  /** It closed during the handshake. */
  'closed',
  /** An established connection ended. */
  'dropped',
  /** The machine now calls itself something else than the pairing names. */
  'identity-changed',
  /** The hub failed on its own side. Not the server's fault, and it says so. */
  'hub-error',
]);
export type StaleReason = z.infer<typeof staleReasonSchema>;

/** One paired server's connectivity, as the hub publishes it. */
export const serverViewSchema = z.object({
  /** The stable key for this row, from the moment the pairing form was submitted. */
  registrationId: serverRegistrationIdSchema,
  label: z.string().min(1),
  /** What the machine calls itself, once a handshake has said so. */
  serverId: serverIdSchema.nullable(),
  phase: serverPhaseSchema,
  /**
   * What it had mounted when it was last connected.
   *
   * Kept while it is stale, because that is what "an unreachable server keeps
   * its rows, marked stale" means: the last thing known stays visible with its
   * age attached, rather than reading as a machine with nothing mounted.
   */
  stores: z.array(storeIdSchema),
  /** When the connection now held was established. `null` unless connected. */
  connectedSince: momentSchema,
  /** When this unreachable spell began -- the first failure, not the last retry. */
  staleSince: momentSchema,
  /** When the hub last held a connection to it, ever, including before a restart. */
  lastConnectedAt: momentSchema,
  staleReason: staleReasonSchema.nullable(),
  /** What went wrong, in words. Never a token, and never an address with one in it. */
  problem: z.string().nullable(),
});
export type ServerView = z.infer<typeof serverViewSchema>;

/**
 * One session, as the hub shows it.
 *
 * The descriptor is exactly what one server sent, whole. It is never assembled
 * out of two servers' readings: a row built field by field describes a session
 * that exists on no disk anywhere, and nothing downstream could tell that it
 * did. Which server's reading it is, and who else saw it, sit beside it as
 * their own facts.
 */
export const sessionRowSchema = z.object({
  descriptor: sessionDescriptorSchema,
  /** Whose reading this is. */
  source: serverRegistrationIdSchema,
  /** Every server that reported it. Usually one; two is a shared volume. */
  reportedBy: z.array(serverRegistrationIdSchema).min(1),
  reportedAt: z.int().nonnegative(),
  /**
   * Whether any server that reported it is reachable right now.
   *
   * False is a label, not a deletion. The row is still shown, and this is what
   * says it cannot presently be acted on -- and what takes it out of the
   * attention count, because a badge you cannot clear by looking is worse than
   * no badge.
   */
  reachable: z.boolean(),
});
export type SessionRow = z.infer<typeof sessionRowSchema>;

/** One store, however many servers have it mounted. */
export const storeViewSchema = z.object({
  storeId: storeIdSchema,
  /** The servers with this store mounted, by id. Their state is in `servers`. */
  servers: z.array(serverRegistrationIdSchema),
  reachable: z.boolean(),
  /** When the hub lost its last live route here. The age on the stale label. */
  unreachableSince: momentSchema,
  lastReachableAt: momentSchema,
  /** One list for the store, deduplicated across its servers. */
  sessions: z.array(sessionRowSchema),
});
export type StoreView = z.infer<typeof storeViewSchema>;

export const machineStateSchema = z.object({
  /**
   * Bumped once per change that actually changed something.
   *
   * A version on a whole state is not a sequence number a client has to keep up
   * with -- there is nothing to miss. It is how a client says "I already have
   * this", and how a log line says which state a screen was showing.
   */
  version: z.int().nonnegative(),
  stores: z.array(storeViewSchema),
  /** Every paired server the hub is supervising, sorted by label. */
  servers: z.array(serverViewSchema),
});
export type MachineState = z.infer<typeof machineStateSchema>;
