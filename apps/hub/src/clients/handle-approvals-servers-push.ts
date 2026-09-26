import type {
  ApprovalPolicyRule,
  ApprovalPolicyRuleId,
  FrameId,
  NodeId,
  PushEndpoint,
  PushSubscription,
  ServerRegistrationId,
} from '@agentplex/protocol';
import type { Approvals, DecideRequest } from '../approvals/approvals.js';
import type { ApprovalPolicy } from '../approval-policy/approval-policy.js';
import { newServerRegistrationSchema, type Pairing } from '../pairing/pairing.js';
import type { ClientPush } from './connection-dependencies.js';
import { refusal, reply, type ReplyContext } from './reply.js';

/**
 * Answers one approval and tells the client that asked what became of it.
 *
 * The rule is the whole of what this frame pair means: an outcome is an
 * `approval-decided`, and no outcome is a refusal. Those are two different
 * things for a person to be shown. A request that ended -- granted by
 * somebody else's tap, taken back by the agent, or expired at a hook that
 * stopped waiting -- is a receipt about the request, and it is a receipt even
 * when this client's own answer was not the one applied: `ok` is about whose
 * tap it was, and the client is owed the ending rather than a verdict on its
 * timing. Only when there is no ending to report -- this hub is holding no
 * such request and remembers none -- is there nothing to put in a receipt,
 * and then it is a refusal, which is what a client draws as an error rather
 * than as an answer.
 *
 * The decision still stands when the socket closes while the machine is being
 * waited on; what is dropped is the receipt.
 */
export function answerApproval(
  ctx: ReplyContext,
  approvals: Approvals,
  replyTo: FrameId,
  request: DecideRequest,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    {
      doing: 'could not answer an approval',
      failure: 'the hub could not answer that approval',
    },
    () => approvals.decide(request),
    (answer) => {
      if (answer.ok) {
        return {
          type: 'approval-decided',
          replyTo,
          outcome: answer.outcome,
          answeredBy: answer.answeredBy,
        };
      }
      if (answer.outcome !== null) {
        // The standing rule travels with the word even here, and especially
        // here: this is the client that tapped and was not the one applied, and
        // `granted` with nothing beside it reads as its own tap having counted.
        return {
          type: 'approval-decided',
          replyTo,
          outcome: answer.outcome,
          answeredBy: answer.answeredBy,
        };
      }
      return refusal(replyTo, answer.code, answer.problem);
    },
  );
}

/**
 * Answers one project's policy, whole.
 *
 * The one answer all three policy frames end in, which is why it is a
 * function rather than three near-copies: list, add and remove all end with
 * the policy as it now stands, and a client that had to apply its own add
 * would be holding a policy nobody vouched for.
 *
 * A read that fails is a refusal and never an empty policy. An empty list
 * means "this project has decided nothing", which is a claim -- and one that
 * would be drawn as "every request here reaches you" while the truth was that
 * the hub could not read its own disk.
 */
export function answerPolicy(
  ctx: ReplyContext,
  approvalPolicy: ApprovalPolicy,
  replyTo: FrameId,
  projectId: NodeId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    {
      doing: 'could not read a standing policy',
      failure: 'the hub could not read that project’s standing policy',
    },
    () => approvalPolicy.rulesFor(projectId),
    (rules) => ({
      type: 'approval-policy',
      replyTo,
      projectId,
      rules: rules.map((record) => ({
        ruleId: record.ruleId,
        rule: record.rule,
        createdAt: record.createdAt,
      })),
    }),
  );
}

/**
 * Writes one rule and answers with the policy it is now part of.
 *
 * The rule goes to the feature as it arrived, unparsed by this file: what a
 * rule may be -- no empty tool, no empty text, no control characters, no text
 * longer than a proposal -- is `parseApprovalPolicyRule`'s to say, and a
 * check here would be a second opinion free to disagree with the one that
 * decides what actually matches.
 */
export function addPolicyRule(
  ctx: ReplyContext,
  approvalPolicy: ApprovalPolicy,
  replyTo: FrameId,
  projectId: NodeId,
  rule: ApprovalPolicyRule,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not write a policy rule', failure: 'the hub could not write that rule' },
    () => approvalPolicy.add({ project: projectId, rule }),
    (written) => {
      // The feature's own sentence, passed through. It is what the person who
      // typed the rule needs to read, and rewording it here would be this
      // file inventing a reason it does not have.
      if (!written.ok) return refusal(replyTo, written.code, written.problem);
      return answerPolicy(ctx, approvalPolicy, replyTo, projectId);
    },
  );
}

/**
 * Takes one rule out and answers with what is left.
 *
 * A rule that was not there is a refusal rather than a silent success. The
 * two are different things to show somebody: one is "it is gone", and the
 * other is "the screen you are looking at is not the policy this hub holds".
 */
export function removePolicyRule(
  ctx: ReplyContext,
  approvalPolicy: ApprovalPolicy,
  replyTo: FrameId,
  projectId: NodeId,
  ruleId: ApprovalPolicyRuleId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not remove a policy rule', failure: 'the hub could not remove that rule' },
    () => approvalPolicy.remove({ project: projectId, ruleId }),
    (removed) => {
      if (!removed) return refusal(replyTo, 'refused', 'that project holds no rule by that id');
      return answerPolicy(ctx, approvalPolicy, replyTo, projectId);
    },
  );
}

/**
 * The sentence a hub with no push answers both push frames with.
 *
 * `refused` and not `internal`, because nothing broke: this hub was built
 * without a way to sign or send, which is the ordinary state of one served
 * over plaintext. It says what the client should do instead, because the
 * client can do it -- the in-page floor is what everybody relies on anyway,
 * and a bare "no" would leave a settings control with nothing to render.
 *
 * It is also already knowable: the welcome said `pushPublicKey: null`. A
 * client that asked anyway is one that ignored it, and the refusal is what
 * makes that legible rather than a subscription stored against a hub that
 * will never push to it.
 */
function noPush(ctx: ReplyContext, replyTo: FrameId): Promise<void> {
  ctx.refuse(
    replyTo,
    'refused',
    'this hub has no push key pair, so it cannot notify a browser; the in-page attention floor is what it has',
  );
  return Promise.resolve();
}

/**
 * Records a browser's subscription and answers the client that sent it.
 *
 * The frame's subscription is already parsed -- the protocol's own schema
 * held the endpoint to https, a host, no credentials, a bound and an address
 * that is not one only this hub can reach -- so there is nothing here to
 * check and nothing that could be checked a second way.
 *
 * The endpoint is not logged. It is the capability -- whoever holds it can
 * push to that browser -- so the feature's own line says that somebody
 * subscribed and not who.
 */
export function answerPushSubscribe(
  ctx: ReplyContext,
  push: ClientPush | null,
  replyTo: FrameId,
  subscription: PushSubscription,
): Promise<void> {
  if (push === null) return noPush(ctx, replyTo);
  return reply(
    ctx,
    replyTo,
    {
      doing: 'could not store a push subscription',
      failure: 'the hub could not store that push subscription',
    },
    () => push.subscribe(subscription),
    () => ({ type: 'push-subscribed', replyTo }),
  );
}

/**
 * Forgets one endpoint and answers the client that asked.
 *
 * The same yes whether or not there was a row, because the browser ends in
 * one state either way and a client that had to tell the two apart would be
 * reading a difference it cannot act on. A hub with no push refuses instead
 * of answering yes: it never held the row, and pretending it removed one
 * would be a receipt for something that did not happen.
 */
export function answerPushUnsubscribe(
  ctx: ReplyContext,
  push: ClientPush | null,
  replyTo: FrameId,
  endpoint: PushEndpoint,
): Promise<void> {
  if (push === null) return noPush(ctx, replyTo);
  return reply(
    ctx,
    replyTo,
    {
      doing: 'could not remove a push subscription',
      failure: 'the hub could not remove that push subscription',
    },
    () => push.unsubscribe(endpoint),
    () => ({ type: 'push-unsubscribed', replyTo }),
  );
}

/**
 * Records a pairing and answers the client that submitted it.
 *
 * Three answers and each says something different. A `bad-request` is the
 * form: the address is not one, or the label is empty, and the words are the
 * parser's own so the person reads what was wrong with what they typed
 * rather than "no". A `server-paired` means the row exists -- not that the
 * machine answered, which is the dial's to find out and the row's `phase` to
 * say a moment later. An `internal` is the hub's own failure, where retrying
 * may work.
 *
 * The token is written to the pairing table and appears nowhere else: not in
 * the reply, which has no field for it; not in the log line; and not in the
 * refusal, whose words come from a parser that was handed the address and the
 * label and never the token.
 *
 * The sync is awaited before the reply, so a client that has been told
 * `server-paired` is a client whose server the hub is already dialling. The
 * dial itself is not awaited -- nothing waits for a machine to answer -- but
 * the decision to dial it has been made by the time the answer goes out.
 */
export function answerPair(
  ctx: ReplyContext,
  pairing: Pairing,
  syncServers: () => Promise<void>,
  replyTo: FrameId,
  submitted: { readonly label: string; readonly address: string; readonly token: string },
): Promise<void> {
  const parsed = newServerRegistrationSchema.safeParse(submitted);
  if (!parsed.success) {
    // The parser's own sentences. They were written to be read by whoever
    // typed the address, which is exactly who is waiting for this frame.
    ctx.refuse(
      replyTo,
      'bad-request',
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
    return Promise.resolve();
  }
  return reply(
    ctx,
    replyTo,
    { doing: 'could not pair a server', failure: 'the hub could not record that pairing' },
    async () => {
      const registration = await pairing.register(parsed.data);
      await syncServers();
      return registration;
    },
    (registration) => ({ type: 'server-paired', replyTo, registrationId: registration.id }),
  );
}

/**
 * Revokes a pairing and answers the client that asked.
 *
 * `refused` and not `bad-request` for a registration that is not there: the
 * frame was well-formed and the hub understood it perfectly; what says no is
 * the state of the world. Unknown and already-revoked are one answer because
 * they are one outcome -- there is no live pairing to end -- and a client
 * that has just watched a row disappear from the state does not need to be
 * told which of the two it raced.
 *
 * The sync is awaited before the reply for the reason the pair's is, and it
 * matters more here: a client told `server-unpaired` must not be able to see
 * the hub still holding a connection it was told is gone. There is nothing to
 * sync when nothing was revoked.
 */
export function answerUnpair(
  ctx: ReplyContext,
  pairing: Pairing,
  syncServers: () => Promise<void>,
  replyTo: FrameId,
  registrationId: ServerRegistrationId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not unpair a server', failure: 'the hub could not revoke that pairing' },
    async () => {
      const revoked = await pairing.revoke(registrationId);
      if (revoked === null) return false;
      await syncServers();
      return true;
    },
    (revoked) => {
      if (!revoked) return refusal(replyTo, 'refused', 'this hub has no such server paired');
      return { type: 'server-unpaired', replyTo };
    },
  );
}
