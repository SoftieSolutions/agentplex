import { z } from 'zod';

/**
 * An approval: an agent asking a person for something, and what became of it.
 *
 * The shape is declared here rather than beside the provider that produces it,
 * and that is a rule of this package rather than a preference. `protocol` is
 * bundled into a browser as well as loaded by a service, so it may use neither
 * a Node builtin nor another workspace package -- and an approval object
 * imported from `packages/providers` would make the wire contract depend on
 * whichever provider happens to have a hook today. What crosses is the same
 * four fields the Claude Code parser produces, stated once, by the thing both
 * ends already agree on.
 *
 * The id is the whole design. There is no `tool_use_id` or anything like it in
 * what a provider hands the hook: nothing upstream identifies the tool call
 * being asked about, so the server mints a name for the request and that name
 * is what every later frame says. Deciding once -- two clients answering at the
 * same moment, one answering a request the agent already took back -- is
 * keeping a record per `{ storeId, sessionId, approvalId }`, which only works
 * because the id is minted where the blocked hook is and nowhere else.
 *
 * Nothing here travels back toward the agent. A decision is one of two words;
 * the proposal, the tool name and the suggestions go outward only. A frame that
 * returned the proposal would be a frame that let a client choose what the
 * agent is about to run, which is the rule about operation names and argv
 * elements defeated by the one path built to carry a command as text.
 */

/**
 * How much of a proposal crosses the wire.
 *
 * The same bound the provider's parser truncates to, and this is where it is
 * decided: a bound owned by the edge would be a number the wire had to trust,
 * and a wire bound below it would refuse exactly the requests that edge worked
 * hardest to fit. The size is the point -- `Write` proposes a whole file and
 * `Edit` proposes every edit in a turn, so an approval carrying either whole
 * would be a megabyte crossing two hops and then sitting in every client's copy
 * of the machine state, so that a browser could show its first line.
 */
export const APPROVAL_PROPOSAL_MAX_CHARS = 4_000;

/** As long as a tool's name is ever worth reading. It is a word, not content. */
const APPROVAL_TOOL_MAX_CHARS = 200;

/**
 * Enough remembered answers for one request, and a cap because this list rides
 * the machine state to every client. A provider with more to offer than this
 * has more than a person is going to read off a phone.
 */
const APPROVAL_SUGGESTIONS_MAX = 16;

/**
 * The server's name for one blocked tool call, minted when the request arrives
 * and dead when it ends.
 *
 * Opaque and branded like the ids in `identity.ts`, and deliberately not among
 * them: those name things that outlive a connection and are recognised across
 * the fleet -- a store, a session, a pairing. This names a question one machine
 * is presently holding open, is unique within that machine's own registry, and
 * means nothing to anybody once the hook it belongs to has stopped waiting.
 */
export const approvalIdSchema = z.string().min(1).max(200).brand<'ApprovalId'>();
export type ApprovalId = z.infer<typeof approvalIdSchema>;

/**
 * What a person can say about a pending approval. Two words, and no third.
 *
 * There is no message beside them. A denial does put a sentence in front of the
 * agent -- that is what makes deny different from a kill, the session stays
 * alive and answerable -- but the words are the server's own, composed where
 * the hook is answered. A free-text field here would be text chosen by a client
 * and delivered into an agent's context on the other side of two hops, which is
 * the surface this protocol keeps shut everywhere else.
 */
export const approvalDecisionSchema = z.enum(['grant', 'deny']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/**
 * How an approval ended, as a client is told.
 *
 * Four words, because there are four endings and a client draws each of them
 * differently. `granted` and `denied` are a decision that took effect --
 * possibly somebody else's, which is what deciding once means. `withdrawn` is
 * the agent no longer asking: the session ended, or the hook's process went
 * away, and nobody's answer was wrong so much as late. `expired` is the hook
 * having stopped waiting before any answer reached it, which is the one ending
 * where a person answered and nothing happened -- and the one it would be
 * dishonest to report as a denial.
 */
export const approvalOutcomeSchema = z.enum(['granted', 'denied', 'withdrawn', 'expired']);
export type ApprovalOutcome = z.infer<typeof approvalOutcomeSchema>;

/**
 * The endings a server can report, which is every one but a withdrawal.
 *
 * Narrower than the outcome a client reads, on purpose. A withdrawal is the
 * request being taken back and has a frame of its own -- nothing was decided,
 * so there is no answer to have taken effect. What is left is what happened at
 * the hook, which is the one thing only the machine running it can say: the hub
 * can know it sent `deny` and still be wrong about the result, because an
 * answer that arrives after the hook's timeout changes nothing and the tool
 * call fell through.
 */
export const approvalSettlementSchema = z.enum(['granted', 'denied', 'expired']);
export type ApprovalSettlement = z.infer<typeof approvalSettlementSchema>;

/**
 * One rule a provider offers to remember, in that provider's own grammar.
 *
 * Two strings, uninterpreted. What a pattern means -- how `prisma migrate *`
 * matches, which tools take one at all -- is the provider's business, and a
 * policy that reasoned about it here would be a second implementation of
 * matching, free to disagree with the one actually doing the matching.
 */
export const approvalRuleSchema = z.object({
  tool: z.string().min(1).max(APPROVAL_TOOL_MAX_CHARS),
  content: z.string().max(2_000),
});
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

/** A remembered answer the provider would accept for requests like this one. */
export const approvalSuggestionSchema = z.object({
  /** The three answers a rule can carry. A fourth is one nobody could explain. */
  behavior: z.enum(['allow', 'deny', 'ask']),
  /** Which settings file the provider would write it to. Its vocabulary, not ours. */
  destination: z.string().min(1).max(200),
  rules: z.array(approvalRuleSchema).max(APPROVAL_SUGGESTIONS_MAX),
});
export type ApprovalSuggestion = z.infer<typeof approvalSuggestionSchema>;

/**
 * What one server reports about one blocked tool call.
 *
 * Four fields and no timestamp. The moment is not the server's to state, for
 * the reason `store-report` carries no date and `server-draining` sends a
 * duration: two machines' clocks disagree, and a hub comparing requests dated
 * by the machines that made them is comparing different times. The hub stamps
 * what it receives -- see `pendingApprovalSchema`.
 *
 * `suggestions` is present and empty for a request the provider offers nothing
 * for, rather than absent, so that every request has one shape and no reader
 * has to remember which kind carries a list.
 */
export const approvalRequestSchema = z.object({
  approvalId: approvalIdSchema,
  /** The tool's name as the provider spells it: `Bash`, `Edit`, `WebFetch`. */
  tool: z.string().min(1).max(APPROVAL_TOOL_MAX_CHARS),
  /**
   * Bounded display text describing what the tool was asked to do.
   *
   * For a person to read and for nothing to act on. It is derived from the
   * tool's input and is not that input: no reader can pull an argument back out
   * of it and mean it, which is the property that lets an approval cross two
   * hops at all. Empty is a tool called with no input, and is not an error.
   */
  proposal: z.string().max(APPROVAL_PROPOSAL_MAX_CHARS),
  suggestions: z.array(approvalSuggestionSchema).max(APPROVAL_SUGGESTIONS_MAX),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

/**
 * A request the hub is holding open, as a client reads it off a session row.
 *
 * The request plus the one thing the hub is entitled to add: when it heard.
 * That is the hub's own clock, deliberately -- a client showing "waiting four
 * minutes" is comparing it with the client's notion of now, and both sides of
 * that comparison are then clocks nobody has to reconcile with a provider's.
 *
 * It rides the session row rather than a broadcast of its own, and the cost is
 * real: every pending approval's proposal is in every client's copy of the
 * machine state, resent whole on every change. What it buys is that a client
 * which has just reconnected, or has never connected before, sees exactly the
 * approvals that are open -- with no second channel to have missed a frame on,
 * and no fetch to be half way through while the state says something else.
 */
export const pendingApprovalSchema = approvalRequestSchema.extend({
  /** When the hub was told, by the hub's clock. */
  requestedAt: z.int().nonnegative(),
});
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
