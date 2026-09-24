import { z } from 'zod';
import { approvalSubjectSchema, pendingApprovalSchema } from './approval.js';
import {
  nodeIdSchema,
  serverIdSchema,
  serverRegistrationIdSchema,
  sessionRefSchema,
  storeIdSchema,
} from './identity.js';
import { pairedServerAddressSchema } from './pairing.js';
import { providerReadinessSchema } from './readiness.js';
import { sessionDescriptorSchema, sessionPauseSchema } from './session.js';

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
 * How much of a session's task crosses the wire.
 *
 * Decided here rather than at the hub's table, for the reason the approval
 * proposal's bound is decided at the wire: a bound owned by one edge is a
 * number every other reader has to trust, and a wire bound below the edge's
 * would refuse exactly the text that edge worked to fit. The size is the point
 * -- a prompt can be an essay, and this string sits in every attached client's
 * copy of the whole machine state, so what is carried is as much of it as a
 * person reads in a panel and not the whole of what was typed.
 */
export const SESSION_TASK_MAX_CHARS = 2_000;

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
  /**
   * It said it was shutting down, and then the connection ended.
   *
   * Set only when the close follows the notice, never when the notice arrives:
   * a draining server answers instructions and goes on sending output right up
   * to the moment it closes, so calling it unreachable while it is still
   * talking would be the over-claim in the wrong direction. What a person does
   * about this one is wait -- which is why it is worth telling apart from
   * `dropped`, where waiting may be all anybody can do but nobody said so.
   */
  'draining',
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

/**
 * A shutdown a server announced, as the hub holds it.
 *
 * The hub's reading of one `server-draining` frame, stamped with the hub's own
 * clock. `since` is not on the wire the server sends and could not be: two
 * machines' clocks disagree, so the server sends a duration and the receiver
 * dates it, which is the same rule `store-report` and `pong` are shaped by.
 *
 * It is a field of its own rather than a phase, because the connection is
 * genuinely up: the socket stays open through the drain on purpose, so the hub
 * can still ask, still be answered, and still relay whatever the last of an
 * agent's output turns out to be. A phase saying otherwise would take a live
 * connection off every screen to describe something that has not happened yet.
 *
 * The sessions are named rather than left to be inferred from the last report,
 * because a report can be older than this frame and these are exactly the rows
 * somebody is watching. They are named here and nowhere else: a `draining` flag
 * on a session row would be a second copy of this list, free to contradict it,
 * which is the same rule that keeps a store from inlining its servers.
 */
export const serverDrainingSchema = z.object({
  /** When the hub was told, by the hub's clock. */
  since: z.int().nonnegative(),
  /** How long the server said it would wait for a turn to end before killing it. */
  graceMs: z.int().nonnegative(),
  /**
   * What it was holding as the drain began. Empty is a server with nothing
   * running, which is a drain nobody has to watch.
   */
  sessions: z.array(sessionRefSchema),
});
export type ServerDraining = z.infer<typeof serverDrainingSchema>;

/** One paired server's connectivity, as the hub publishes it. */
export const serverViewSchema = z.object({
  /** The stable key for this row, from the moment the pairing form was submitted. */
  registrationId: serverRegistrationIdSchema,
  label: z.string().min(1),
  /**
   * Where this hub dials that machine, exactly as the pairing holds it.
   *
   * Published, after a release in which it was not. The argument for keeping it
   * back was that an address is a routing detail of the hub's deployment; what
   * changed is that a client can now pair and unpair, so the screen showing
   * these rows is the pairing screen and the address is the fact a person
   * checks a row against. Two boxes a user labelled `gpu-box` are one row twice
   * without it, and `Unpair` on the wrong one is not undoable -- it destroys
   * the token that pairing was made with.
   *
   * It is safe to publish for a reason the parser guarantees rather than a
   * reason anybody has to remember: `addressProblem` refuses a URL carrying a
   * username, a password, a query or a fragment, so there is nowhere in a
   * stored address for a secret to be. The credential is the token, it travels
   * once, inbound, and it is on no frame the hub sends.
   *
   * Parsed with the loopback allowance, because a `--role=both` hub's own
   * pairing is `ws://127.0.0.1:<port>` and a client that refused to read that
   * row would refuse the whole state frame over the one pairing nobody typed.
   */
  address: pairedServerAddressSchema,
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
  /**
   * The shutdown this machine announced, or `null` for one that has announced
   * none.
   *
   * Set while the phase is still `connected`, which is the pair a client reads
   * as "shutting down, N sessions finishing" rather than as either "fine" or
   * "unreachable". It survives the close that follows, beside
   * `staleReason: 'draining'`, for the reason the store list survives it: the
   * last thing the machine actually said stays visible with its age attached,
   * rather than a row that empties out and reads as a machine that simply went.
   * A handshake clears it, because a server that has answered again is not the
   * server that was going down.
   */
  draining: serverDrainingSchema.nullable(),
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
  /** How paused the session is, as the server that holds it says. See `session.ts`. */
  pause: sessionPauseSchema,
});
export type SessionHolder = z.infer<typeof sessionHolderSchema>;

/**
 * Which project of the user's tree a session sits in.
 *
 * Two fields where the rest of this frame would carry one id, and the exception
 * is deliberate. The no-duplication rule exists so that one frame cannot
 * contradict itself about a thing it describes; this describes nothing. A
 * project is described in the catalogue, which is a different frame on a
 * different cadence, so a row carrying only a `nodeId` would leave every screen
 * that draws a session joining two answers taken at two different moments --
 * and drawing nothing, or a stale word, whenever it held only one of them.
 *
 * The name is the word a client draws and the id is what it navigates by. They
 * travel together because a label with no destination is a dead end and a
 * destination with no label is not something a person can read.
 *
 * `min(1)` on the name because an empty one reaches the screen as a separator
 * with nothing before it. A project with no name is not a project a session can
 * usefully be said to be in, and refusing it here is the one place that
 * judgement has to be made -- rather than in each of the components that draw
 * it, each free to forget.
 */
export const sessionProjectSchema = z.object({
  nodeId: nodeIdSchema,
  name: z.string().min(1),
});
export type SessionProject = z.infer<typeof sessionProjectSchema>;

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
  /**
   * How far through this session's history somebody has said they have looked,
   * as a `descriptor.updatedAt` value, or `null` when nobody has.
   *
   * A timestamp and not a boolean, because a boolean goes sticky: acknowledge
   * a permission prompt, let the agent run on and stop at a second one, and a
   * flag set once says the second prompt has been seen too. This cannot do
   * that -- it is compared with `descriptor.updatedAt` on this same row, and a
   * session whose provider has written since is no longer acknowledged.
   *
   * It is `updatedAt` as the hub saw it at the moment of the acknowledgement,
   * and deliberately *not* a reading of the hub's clock -- which is why it is
   * named for what it means rather than for when it was written. Both sides of
   * the comparison are then numbers off the same provider's clock. A
   * hub-stamped moment compared against a provider-written `updatedAt` is two
   * unsynchronised clocks, and a hub a few seconds ahead would silently read a
   * second prompt as already seen.
   *
   * The comparison is left to the reader rather than made here, for the reason
   * `protocolVersion` on a candidate is carried rather than judged: the two
   * fields are on the same row of the same frame, so every reader reaches the
   * same verdict, and a third field stating it could only ever disagree with
   * the two it was derived from.
   */
  acknowledgedThrough: momentSchema,
  /**
   * When this session was muted, or `null` when it is not muted.
   *
   * Mute silences the alert and never the fact. The row is still sent, its
   * status still says a human is wanted, and it still counts wherever
   * needs-you is counted; what a muted session does not get is the bell, the
   * title and the push. A client dims it. A mute that removed the row would be
   * the hub deciding what a person may see, which is the over-claim in the
   * other direction.
   *
   * A moment rather than a boolean because a person asks "since when", and
   * because `null` is then one unambiguous way of saying not muted rather than
   * a `false` sitting next to a stale timestamp. Unlike the field above this
   * one really is a wall-clock moment on the hub's clock, and it can be,
   * because nothing compares it with anything.
   */
  mutedAt: momentSchema,
  /**
   * The project this session is in, or `null` when it is in none.
   *
   * Here and not on the descriptor, which is the decision this field turns on.
   * A descriptor is exactly what one server sent, and a server watches a store
   * on disk and has never heard of a project: putting the field there would
   * either be the hub editing a reading it promised to pass through whole, or
   * a question asked of a machine whose only honest answer is that it does not
   * know. The association is the hub's own, off the same tree the catalogue
   * reads, so it belongs beside the other two things on this row that no server
   * reported.
   *
   * Nullable and never absent, for the reason the attention fields are: `null`
   * says the tree places this session in no project, which is a fact, and the
   * screens that name a project fall back to the storeId they named before.
   */
  project: sessionProjectSchema.nullable(),
  /**
   * What the agent on this session is presently blocked asking for.
   *
   * Present and empty on every row, which is the half of this that is a
   * decision rather than a shape. A session with nothing pending says so; so
   * does a session whose provider has no such thing to report at all -- codex
   * has no permission hook, so its rows are always empty here -- and an absent
   * list would make "nothing is waiting" and "this build cannot tell you" one
   * value that no client could tell apart.
   *
   * On the row rather than on a frame of its own, because a pending approval is
   * a claim about now and the state is where the hub states what is true now. A
   * client that has just reconnected, or has never connected, reads the rows it
   * is sent and knows what is open -- with no second channel it could have
   * missed a frame on, and no fetch to be half way through while the state says
   * something else. What that costs is the proposal text of every open approval
   * in every state frame, which is bounded and rarely more than one.
   *
   * It is not where `awaiting-permission` comes from. That status is read off
   * the provider's own record of the session, and a list that also decided a
   * status would be a second source for one word, free to disagree with the
   * transcript the moment a hook and a scan land in the wrong order.
   */
  approvals: z.array(pendingApprovalSchema),
  /**
   * The task this session was started to do, or `null` for a session that was
   * not started here.
   *
   * It is the prompt somebody typed into the start form, recorded by the hub
   * when it started the session and shown back as prose. It is emphatically not
   * "the first thing anyone typed" into a terminal: a transcript's opening
   * lines are whatever a person happened to send first, and a label derived
   * from them would be wrong often enough to mislead on the screen people scan
   * to find the session they meant.
   *
   * `null` is therefore a real answer and the common one. A session the hub
   * merely discovered in a store -- adopted, started by hand, started before
   * this hub existed -- has no task, and a row that guessed one would be the
   * over-claim this field exists to avoid. Non-empty when it is present, so
   * that there is exactly one way to say there is none.
   *
   * Display text and nothing else. Nothing acts on it, nothing spawns from it,
   * and it reaches no argv: the prompt's path to the agent is the start
   * instruction, which this does not touch.
   */
  task: z.string().min(1).max(SESSION_TASK_MAX_CHARS).nullable(),
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

/**
 * One graph run parked at a HUMAN node, as every client is told it.
 *
 * Beside the stores rather than inside any of them, and this is where the
 * no-second-copy rule decides the placement. A run is not a session and sits
 * in no store, so there is no row to put it on; the run's own state frame
 * (`graph-run-state`) says `waiting` but is sent to whoever is watching and
 * not held for a client that connects later, and a request kept only there
 * would be one a reconnecting client never sees. The machine state is the one
 * thing every client is sent whole on connect, so the one copy of "who is
 * waiting on a person" lives here -- the same argument that puts a session's
 * approvals on its row -- and the run state carries the word and never the
 * request.
 *
 * The graph and the number are here rather than in the subject because they
 * are what a person reads: the bell says "run #38 is waiting at Ship it" and
 * a tap opens the graph. The subject inside `approval` is what the tap's
 * decision sends back, and identity and display stay two fields so that a
 * client can never send the hub a number to trust.
 */
export const graphRunApprovalSchema = z.object({
  /** The graph's tree node, which is what a link to the run opens. */
  graph: nodeIdSchema,
  /** The run's number within its graph, the `#38` a person says. */
  number: z.int().positive(),
  approval: pendingApprovalSchema.extend({
    subject: approvalSubjectSchema.refine(
      (subject) => subject.kind === 'graphRun',
      'a graph-run approval is about a run',
    ),
  }),
});
export type GraphRunApproval = z.infer<typeof graphRunApprovalSchema>;

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
  /**
   * Every graph run presently waiting on a person, oldest request first.
   *
   * Required and usually empty, for the reason `candidates` is: a hub always
   * knows the answer, and an absent field would let a hub with nothing waiting
   * and a client too old to read the field draw one screen off two facts.
   */
  graphRunApprovals: z.array(graphRunApprovalSchema),
});
export type MachineState = z.infer<typeof machineStateSchema>;
