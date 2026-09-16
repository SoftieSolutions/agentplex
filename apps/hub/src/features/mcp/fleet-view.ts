import type { MachineState, ServerView, SessionRow, StoreView } from '@agentplex/protocol';
import { z } from 'zod';

/**
 * The fleet, as a tool shows it.
 *
 * Three tools answer out of one state -- `list_servers`, `list_sessions` and
 * `session_status` -- so the shapes and the projections that fill them are
 * here, once, and each tool file is its filter and its bounds.
 *
 * ## Why these schemas are written again rather than imported
 *
 * `machineStateSchema` in `@agentplex/protocol` already describes all of this,
 * and publishing it as a tool's output schema would be one import rather than
 * the hundred lines below. It is deliberately not done, for the reason the
 * whole of Stack E turns on: **a tool is a curated projection of what a client
 * can already see, not a second way to read the wire.** An output schema that
 * was the wire schema would grow a field the moment the protocol did, would
 * publish the hub's own bookkeeping the moment a frame carried some, and would
 * make every protocol change an unreviewed change to what an agent is handed.
 *
 * What that costs is duplication, and the duplication is paid for by this:
 * every projection below is written with an explicit return type, so a value
 * from the protocol is *assigned* into these shapes rather than cast. An enum
 * member added to `serverPhaseSchema`, `sessionStatusSchema` or
 * `staleReasonSchema` and not added here fails to compile in this file. That is
 * the same rule `fleet-state/machine-state.ts` keeps on the way to a client,
 * kept once more on the way to an agent. It has already earned its keep once:
 * `draining` arrived on `staleReasonSchema` and this file failed to compile
 * until somebody decided whether an agent should be told a machine is going
 * away on purpose. The answer is yes, and it is published twice, because the
 * two halves are different questions. `staleReason: 'draining'` is why a
 * machine that has already gone is unreachable -- a thing to wait out rather
 * than to report -- and `draining` beside it is the announcement itself, which
 * arrives while the phase is still `connected`. Without the second, an agent
 * reading a healthy-looking row would start work on a machine that is in the
 * middle of leaving, which is precisely the case a person is shown on screen.
 */

/**
 * What these tools need of the fleet state: the state it publishes, whole.
 *
 * The published projection and not the reducer's own snapshot, and that is the
 * point rather than a convenience. `published()` is the fleet state's decision
 * about which of its fields a client may see -- the dialled address and the
 * retry counter are not among them -- and a tool reading `snapshot()` instead
 * would be reaching past that decision to publish the hub's deployment to an
 * agent. "MCP gains no capability the UI lacks" is enforced here by reading
 * exactly what the UI is sent.
 */
export interface FleetReads {
  published(): MachineState;
}

/** One paired machine, as `list_servers` answers. */
export const serverShape = {
  registrationId: z
    .string()
    .describe('The stable id of this pairing. What every other tool names a machine by.'),
  label: z.string().describe('What the person who paired it called it.'),
  phase: z
    .enum(['connecting', 'connected', 'stale', 'stopped'])
    .describe('Where the hub-to-server connection is right now.'),
  staleReason: z
    .enum([
      'unreachable',
      'timeout',
      'unauthorized',
      'protocol-version',
      'protocol-error',
      'closed',
      'dropped',
      'draining',
      'identity-changed',
      'hub-error',
    ])
    .nullable()
    .describe(
      'Why it is unreachable, as a word to branch on. Null while it is reachable. `draining` is the one an agent waits out rather than reports: the machine said it was going down and then went.',
    ),
  draining: z
    .object({
      since: z.int().describe('Epoch ms of when this hub was told, by the hub clock.'),
      graceMs: z
        .int()
        .describe('How long the machine said it would wait for a turn to end before killing it.'),
      sessions: z
        .array(z.object({ storeId: z.string(), sessionId: z.string() }))
        .describe('What it was holding as the drain began.'),
    })
    .nullable()
    .describe(
      'The shutdown this machine announced, or null for one that has announced none. Set while the phase is still connected, which is the pair that says "going away, N sessions finishing". Do not start work here.',
    ),
  problem: z
    .string()
    .nullable()
    .describe('The same thing in words, for a reader. Never a token or an address.'),
  stores: z
    .array(z.string())
    .describe('The stores this machine had mounted when it was last connected.'),
  providers: z
    .array(
      z.object({
        provider: z.enum(['claude', 'codex', 'opencode']),
        state: z.enum(['ready', 'missing', 'unauthenticated', 'unknown']),
        version: z.string().nullable().describe('What the program printed, verbatim.'),
        directory: z.string().nullable().describe('Where the program resolved from.'),
        problem: z.string().nullable().describe('Why it cannot be started here.'),
      }),
    )
    .describe(
      'What this machine reported it can start. Kept while it is stale, so a row that cannot presently be asked still says what it had.',
    ),
};
export type ServerRow = z.infer<z.ZodObject<typeof serverShape>>;

/** One session, as `list_sessions` answers. */
export const sessionShape = {
  storeId: z.string().describe('The store the session lives in. Half of its identity.'),
  sessionId: z.string().describe('The id the provider gave it. The other half.'),
  provider: z.enum(['claude', 'codex', 'opencode']),
  status: z
    .enum(['working', 'awaiting-permission', 'awaiting-input', 'idle', 'unknown'])
    .describe('How it is doing, in the one vocabulary every provider is reduced to.'),
  title: z.string().nullable().describe('What the provider calls it, if it names sessions.'),
  cwd: z
    .string()
    .nullable()
    .describe('The directory its own transcript recorded. A label, never an argument.'),
  branch: z
    .string()
    .nullable()
    .describe('The branch checked out there, or null for no name to show.'),
  updatedAt: z
    .int()
    .describe('Epoch ms of the last thing the provider wrote, as the provider dated it.'),
  holder: z
    .object({
      server: z.string().describe('The registration id of the machine running it.'),
      stoppable: z.boolean().describe('Whether that machine says this one may be stopped.'),
    })
    .nullable()
    .describe(
      'The machine with a live process for this session, or null when nobody reports one. Not the same fact as status.',
    ),
  reachable: z
    .boolean()
    .describe(
      'Whether any machine that reported it can be reached right now. False is a label and not a deletion: the row is real and cannot presently be acted on.',
    ),
};
export type SessionRowView = z.infer<z.ZodObject<typeof sessionShape>>;

/**
 * The same session with the two facts a listing has no room for.
 *
 * Split from `sessionShape` rather than folded into it because a list of two
 * hundred rows carrying a diffstat and a token count each is a list a model
 * pays for in full every time it asks what is running. `session_status` is the
 * one-row question, and this is what asking about one row is worth.
 */
export const sessionDetailShape = {
  ...sessionShape,
  uncommitted: z
    .object({
      files: z.int().describe('Tracked files differing from HEAD.'),
      added: z.int(),
      removed: z.int(),
    })
    .nullable()
    .describe(
      'The uncommitted work in the working directory, or null when the machine did not read it. Null is never zero: zero says a person has nothing outstanding, and null says nobody looked.',
    ),
  usage: z
    .object({
      inputTokens: z.int(),
      cacheReadTokens: z.int(),
      cacheWriteTokens: z.int(),
      outputTokens: z.int(),
    })
    .nullable()
    .describe(
      'What the provider counted for this session, or null when it counts nothing. Null is not zero, for the same reason.',
    ),
};
export type SessionDetailView = z.infer<z.ZodObject<typeof sessionDetailShape>>;

/** A machine, projected. Written as an assignment, which is what checks it. */
export function toServerRow(view: ServerView): ServerRow {
  return {
    registrationId: view.registrationId,
    label: view.label,
    phase: view.phase,
    staleReason: view.staleReason,
    draining:
      view.draining === null
        ? null
        : {
            since: view.draining.since,
            graceMs: view.draining.graceMs,
            sessions: view.draining.sessions.map((ref) => ({
              storeId: ref.storeId,
              sessionId: ref.sessionId,
            })),
          },
    problem: view.problem,
    stores: [...view.stores],
    providers: view.providers.map((readiness) => ({
      provider: readiness.provider,
      state: readiness.state,
      version: readiness.version,
      directory: readiness.directory,
      problem: readiness.problem,
    })),
  };
}

/**
 * A session, projected.
 *
 * `source` and `reportedBy` do not make the trip and `reportedAt` does not
 * either. Which of two machines' readings of one shared volume was chosen is
 * the reducer's own bookkeeping, and an agent handed it would be handed a
 * decision it has no way to second-guess. What it can act on is whether anybody
 * can be reached -- which is `reachable` -- and which machine holds the process,
 * which is `holder`.
 */
export function toSessionRow(row: SessionRow): SessionRowView {
  return {
    storeId: row.descriptor.storeId,
    sessionId: row.descriptor.sessionId,
    provider: row.descriptor.provider,
    status: row.descriptor.status,
    title: row.descriptor.title,
    cwd: row.descriptor.cwd,
    branch: row.descriptor.branch,
    updatedAt: row.descriptor.updatedAt,
    holder:
      row.holder === null ? null : { server: row.holder.server, stoppable: row.holder.stoppable },
    reachable: row.reachable,
  };
}

/** The same, with the diffstat and the token count. */
export function toSessionDetail(row: SessionRow): SessionDetailView {
  const { uncommitted, usage } = row.descriptor;
  return {
    ...toSessionRow(row),
    uncommitted:
      uncommitted === null
        ? null
        : { files: uncommitted.files, added: uncommitted.added, removed: uncommitted.removed },
    // `undefined` and `null` are the same fact here and JSON has only one of
    // them. The descriptor distinguishes an absent field from a zeroed record
    // because the difference is "nobody counted" against "it cost nothing";
    // this keeps that difference and spells the first one `null`.
    usage: usage === undefined ? null : { ...usage },
  };
}

/**
 * Every session the hub knows of, with the store it is filed under already
 * flattened away.
 *
 * The store grouping is how a client draws a sidebar and it is not how an agent
 * asks a question: "what is awaiting permission" crosses every store, and a
 * tool that answered with a tree would be making the model do the flattening.
 * `storeId` is on every row, so nothing is lost.
 */
export function allSessions(state: MachineState): readonly SessionRow[] {
  return state.stores.flatMap((store: StoreView) => store.sessions);
}
