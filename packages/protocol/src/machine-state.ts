import { z } from 'zod';
import { serverIdSchema, serverRegistrationIdSchema, storeIdSchema } from './identity.js';
import { providerReadinessSchema } from './readiness.js';
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

/**
 * A busy share, and the interval it is a share of.
 *
 * The two fields are one object rather than two nullable fields beside each
 * other because they are one fact. A percentage is a rate, and a rate without
 * its window is a number nobody can check: "31%" could be the last second or
 * the last hour, and those are different claims about a machine. Split, a
 * reading with a percentage and no window would be representable, which is
 * precisely the over-claim this type exists to prevent.
 */
export const cpuSampleSchema = z.object({
  /** Non-idle time as a share of all cpus over `windowMs`, 0 to 100. */
  percent: z.number().min(0).max(100),
  /** How wide the interval was. Never zero: a rate over no time is not a rate. */
  windowMs: z.int().positive(),
});
export type CpuSample = z.infer<typeof cpuSampleSchema>;

/**
 * What a machine is doing to itself, as of the last time it was asked.
 *
 * The panel this feeds draws four facts about one machine together -- which
 * machine, how far away it is, which directory, which branch -- and they are
 * not equally knowable. A panel that showed all four with one confidence would
 * claim more than anybody knows the moment a server goes quiet, so where each
 * one comes from is the design rather than a detail of it:
 *
 * - The working directory and the branch are per-session facts about a checkout
 *   on one disk. They ride the session descriptor, read by the server that has
 *   the disk, and they change rarely.
 * - Latency is not on this type, and it is not a server's to report. It is a
 *   property of a connection, and only the end that dialled can time one. A
 *   server putting a millisecond figure on the wire would be reporting a number
 *   it cannot observe -- the round trip it would have to be measured over is
 *   the very frame carrying it. The hub times its own `ping` against the `pong`
 *   that answers, which is the measurement that exists, and it belongs to the
 *   hub for the same reason `connectedSince` does.
 * - This is the rest: what this machine's cpus are doing. It is the one fact
 *   here that goes stale in seconds.
 *
 * There is no timestamp on it, for the reason `store-report` carries none and
 * `server-draining` sends a duration rather than a deadline: two machines'
 * clocks disagree, and a hub comparing readings dated by the machines that made
 * them is comparing different times. The hub stamps what it receives with its
 * own clock, so how long ago a reading arrived is already the hub's to say, and
 * a date here could only be a second copy of that free to contradict it.
 *
 * What a receipt time cannot recover, and what is therefore on this type, is
 * the width of the interval the reading summarises. That is the age a reading
 * carries about itself: not when it was taken, which the receiver knows better,
 * but what span it is true of, which only the machine that took it knows.
 */
export const machineLoadSchema = z.object({
  /**
   * How many cpus the share below is averaged over, and the divisor that makes
   * a load average mean anything: 4 is a busy pair of cores and an idle
   * sixteen.
   */
  cpuCount: z.int().positive(),
  /**
   * The busy share since this machine was last asked, or `null` when there is
   * no interval to have measured one over.
   *
   * `null` is the answer before there are two counter readings to difference,
   * and whenever they cannot be differenced -- a cpu that came or went, a clock
   * that stepped backwards, two questions inside one tick of the OS's own
   * accounting. Zero would say the machine was idle, and every one of those
   * cases says only that nobody can tell.
   */
  cpu: cpuSampleSchema.nullable(),
  /**
   * The 1, 5 and 15 minute load averages, or `null` on a platform that keeps
   * none.
   *
   * Beside the percentage rather than instead of it, because it is the reading
   * that needs no window: it is there on the first answer, where `cpu` is still
   * `null`, so a machine that has only just connected still says something true
   * about itself.
   *
   * Whether a platform has one is decided by the platform and never by the
   * value. `os.loadavg()` answers `[0, 0, 0]` where the counter does not exist,
   * and an idle machine answers nearly that, so a reader inferring absence from
   * zeros would call a quiet machine unsupported and an unsupported platform
   * quiet.
   */
  loadAverage: z.tuple([z.number(), z.number(), z.number()]).nullable(),
});
export type MachineLoad = z.infer<typeof machineLoadSchema>;

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
  /**
   * What that machine said it can start, as its handshake reported it.
   *
   * Kept while it is stale for the same reason the store list is: the last
   * thing known stays visible, and a row that emptied out would read as a
   * machine with no providers rather than as one nobody can presently ask.
   *
   * This is the half of the fix a refusal cannot deliver. A refused start says
   * why at the moment somebody taps start; this says it beforehand, on the
   * screen a person goes to when something is not working, which is where "that
   * box has no claude" stops being a mystery and becomes a line to act on.
   */
  providers: z.array(providerReadinessSchema),
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
 * Which server is running a session, as everything client-facing names it.
 *
 * The server is named by `registrationId` and described nowhere here, which is
 * the same rule that keeps a store from inlining its servers: a machine is
 * described once, in `servers`, and everything else points at that row. A
 * holder carrying a label or a phase of its own would be a second copy of a
 * server's state inside one frame, free to contradict the first.
 *
 * `stoppable` rides along because it is not a property of the server: it is
 * this session's, on this machine, right now, and it is what a client reads to
 * decide whether to offer a stop. A busy holder is a holder with
 * `stoppable: false`, and that is the whole of what "a busy holder gets no
 * button" is on the wire. The hub publishes the fact; nothing here draws it.
 */
export const sessionHolderSchema = z.object({
  server: serverRegistrationIdSchema,
  stoppable: z.boolean(),
});
export type SessionHolder = z.infer<typeof sessionHolderSchema>;

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
  /**
   * The server running this session right now, or `null` when nobody is.
   *
   * Not the same fact as `status`, and the difference is what a client draws.
   * A status is derived from a transcript and describes the session; this is a
   * live process somewhere, and it is what says a start would be refused and
   * what a stop is aimed at. A session can be `idle` and held — an agent at its
   * own prompt with nobody typing — and it can be `working` and unheld, which
   * is a session somebody started outside agentplex.
   */
  holder: sessionHolderSchema.nullable(),
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

/**
 * A machine the hub has heard announce itself, and has no relationship with.
 *
 * Its own type, in its own collection, on purpose. A candidate and a paired
 * server are not two states of one thing: a server row is a pairing the user
 * made, backed by a token in the hub's database and a supervisor dialling it,
 * and this is a datagram somebody's network delivered. Merging them into one
 * list with a flag would put an unauthenticated stranger's claim one boolean
 * away from being drawn as a machine of yours, and every reader of the list
 * would have to remember to check that boolean. Two lists, and there is nothing
 * to remember.
 *
 * There is no `registrationId` here and no label, because both are things the
 * hub knows about a pairing and nobody knows about a candidate. There is no
 * token field either, which is the same rule the beacon schema enforces
 * inbound, restated outbound: a beacon never carries one, so a hub has none to
 * forward.
 *
 * Everything here is a claim by whoever sent the datagram. What the client does
 * with it is fill in one line of the pairing form.
 */
export const serverCandidateSchema = z.object({
  /** What the machine calls itself. Also the key: one candidate per server id. */
  serverId: serverIdSchema,
  /** Where it says it is. Not checked, and not reachable until somebody tries. */
  address: z.string().min(1),
  /** The port it says the hub would dial. Never the beacon port it was heard on. */
  port: z.int().min(1).max(65535),
  /**
   * The protocol the beacon claimed, carried rather than judged.
   *
   * The verdict is not a second field, because a second field is a second copy
   * of one fact free to disagree with the first. `checkProtocolVersion` is the
   * verdict and every reader of this frame can reach it: a client is only
   * reading a machine state at all because its own `hello` was accepted, and a
   * hello is checked with `===`, so the client's `PROTOCOL_VERSION` and the
   * hub's are already known to be the same number.
   */
  protocolVersion: z.int().positive(),
});
export type ServerCandidate = z.infer<typeof serverCandidateSchema>;

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
  /**
   * Every machine the hub can currently hear on the network and is paired with
   * none of, sorted by server id.
   *
   * Required and usually empty, rather than optional. A hub always has an
   * answer to "what have you heard", and an absent property would let two
   * clients draw different screens off the same fact -- one showing nothing
   * because the field was missing, one showing nothing because the list was
   * empty, and no way to tell a hub that hears nothing from a hub too old to
   * listen.
   *
   * Ephemeral by construction: nothing here is in the hub's database, and a
   * claim that stops being repeated leaves this list after six missed
   * announcements. A candidate the user acts on becomes a pairing the ordinary
   * way -- they type that server's token -- and appears in `servers` because of
   * that, never because it was heard.
   */
  candidates: z.array(serverCandidateSchema),
});
export type MachineState = z.infer<typeof machineStateSchema>;
