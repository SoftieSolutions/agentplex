import { beforeEach, describe, expect, it } from 'vitest';
import {
  approvalIdSchema,
  sessionRefSchema,
  type ApprovalId,
  type ApprovalRequest,
  type PendingApproval,
  nodeIdSchema,
  type ServerRegistrationId,
  type ServerToHubFrame,
  type SessionRef,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import {
  createApprovals,
  type ApprovalAnswer,
  type ApprovalDispatch,
  type ApprovalInstruction,
  type Approvals,
} from './approvals.js';
import type { ApprovalPolicyGrant } from '../approval-policy/approval-policy.js';

/**
 * The requests this hub is holding open, driven by hand.
 *
 * Everything here is a race, because the races are the ticket: two clients
 * answering at one moment, a client answering a question the agent already took
 * back, a client answering one this hub never heard of, and a machine going
 * away with a question still open on it. What is asserted about each of them is
 * the same pair of things -- exactly one instruction leaves the hub, and
 * everybody who asked is told what actually happened.
 *
 * No database and no socket. A pending approval is a claim about now, so there
 * is nothing to migrate; the one thing that reaches a machine is the dispatch
 * seam, which is a function here and a frame on a connection in the hub.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;

const LAPTOP = 'registration-laptop' as ServerRegistrationId;
const DESKTOP = 'registration-desktop' as ServerRegistrationId;

const MIGRATING = sessionRefSchema.parse({
  storeId: 'store-work',
  sessionId: 'session-migrate-db',
});
const FIXING = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-fix-auth' });

const FIRST = approvalIdSchema.parse('approval-7f21');
const SECOND = approvalIdSchema.parse('approval-91c4');

let now = START;
let changes: { ref: SessionRef; approvals: readonly PendingApproval[] }[] = [];
let dispatched: ApprovalInstruction[] = [];
/** What the connection seam answers with. `ok` is a server that said nothing. */
let dispatchAnswer: ApprovalDispatch = { ok: true };
/** What the standing policy answers with. `null` is "ask somebody". */
let policyAnswer: () => Promise<ApprovalPolicyGrant | null> = () => Promise.resolve(null);
/** Every request the policy was consulted about, in order. */
let consulted: { tool: string; proposal: string }[] = [];

const A_PROJECT = nodeIdSchema.parse('node-project-work');
const A_GRANT: ApprovalPolicyGrant = {
  project: A_PROJECT,
  ruleId: 'rule-1',
  rule: { tool: 'Bash', proposal: 'command: prisma migrate deploy' },
};

function feature(): Approvals {
  return createApprovals({
    clock: { now: () => now },
    logger,
    onChanged: (ref, approvals) => changes.push({ ref, approvals }),
    dispatch: async (instruction) => {
      dispatched.push(instruction);
      return dispatchAnswer;
    },
    policy: (_ref, request) => {
      consulted.push({ tool: request.tool, proposal: request.proposal });
      return policyAnswer();
    },
  });
}

function request(approvalId: ApprovalId, tool = 'Bash'): ApprovalRequest {
  return {
    approvalId,
    tool,
    proposal: 'prisma migrate deploy --schema ./db',
    suggestions: [],
  };
}

function requested(
  ref: SessionRef,
  approvalId: ApprovalId,
): Extract<ServerToHubFrame, { type: 'approval-requested' }> {
  return {
    type: 'approval-requested',
    storeId: ref.storeId,
    sessionId: ref.sessionId,
    approval: request(approvalId),
  };
}

function withdrawn(
  ref: SessionRef,
  approvalId: ApprovalId,
): Extract<ServerToHubFrame, { type: 'approval-withdrawn' }> {
  return {
    type: 'approval-withdrawn',
    storeId: ref.storeId,
    sessionId: ref.sessionId,
    approvalId,
  };
}

function settled(
  ref: SessionRef,
  approvalId: ApprovalId,
  outcome: 'granted' | 'denied' | 'expired',
): Extract<ServerToHubFrame, { type: 'approval-settled' }> {
  return {
    type: 'approval-settled',
    storeId: ref.storeId,
    sessionId: ref.sessionId,
    approvalId,
    outcome,
  };
}

/** The last thing said about one session, or `null` when nothing was. */
function lastChange(ref: SessionRef): readonly PendingApproval[] | null {
  const said = changes.filter(
    (change) => change.ref.storeId === ref.storeId && change.ref.sessionId === ref.sessionId,
  );
  return said.at(-1)?.approvals ?? null;
}

/**
 * A decision in flight, so that a test can say it has not been answered yet.
 *
 * The whole point of the decide path is that it does not resolve when the frame
 * goes out -- the hook it releases may run for ten minutes -- so "still
 * waiting" is an assertion this file has to be able to make.
 */
function watch(answer: Promise<ApprovalAnswer>): { readonly answer: ApprovalAnswer | null } {
  const held: { answer: ApprovalAnswer | null } = { answer: null };
  void answer.then((value) => {
    held.answer = value;
  });
  return held;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('the approvals the hub is holding', () => {
  beforeEach(() => {
    now = START;
    changes = [];
    dispatched = [];
    dispatchAnswer = { ok: true };
    consulted = [];
    policyAnswer = () => Promise.resolve(null);
  });

  it("holds a request as pending for its session, stamped with this hub's clock", () => {
    const approvals = feature();
    now = START + 4_000;
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));

    // The hub's own reading, because the frame carries no date: two machines'
    // clocks disagree, and how long somebody has been waiting is a fact the
    // receiver can state honestly and the sender cannot.
    expect(lastChange(MIGRATING)).toEqual([{ ...request(FIRST), requestedAt: START + 4_000 }]);
  });

  it('holds two open requests for one session, oldest first', () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    now = START + 1_000;
    approvals.requested(LAPTOP, requested(MIGRATING, SECOND));

    expect(lastChange(MIGRATING)?.map((pending) => pending.approvalId)).toEqual([FIRST, SECOND]);
  });

  it('says nothing about a session that has nothing open', () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    expect(lastChange(FIXING)).toBeNull();
  });

  it('sends a decision to the machine that reported the request, and to nobody else', async () => {
    const approvals = feature();
    approvals.requested(DESKTOP, requested(MIGRATING, FIRST));
    void approvals.decide({ ref: MIGRATING, approvalId: FIRST, decision: 'grant' });
    await settle();

    expect(dispatched).toEqual([{ registrationId: DESKTOP, approvalId: FIRST, decision: 'grant' }]);
  });

  it('answers on the settlement rather than on a reply, because the tool may run for minutes', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    const held = watch(approvals.decide({ ref: MIGRATING, approvalId: FIRST, decision: 'grant' }));
    await settle();

    // The frame has gone and the server has said nothing, which is what a
    // server that accepted a decision says. Nothing is known yet.
    expect(dispatched).toHaveLength(1);
    expect(held.answer).toBeNull();

    approvals.settled(LAPTOP, settled(MIGRATING, FIRST, 'granted'));
    await settle();
    expect(held.answer).toEqual({ ok: true, outcome: 'granted' });
    // And the request is no longer open on the row.
    expect(lastChange(MIGRATING)).toEqual([]);
  });

  it('tells the client the truth when the hook stopped waiting before the answer reached it', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    const held = watch(approvals.decide({ ref: MIGRATING, approvalId: FIRST, decision: 'grant' }));
    await settle();

    approvals.settled(LAPTOP, settled(MIGRATING, FIRST, 'expired'));
    await settle();

    // A grant was sent and nothing was granted. Reporting this as a success
    // would be the hub over-claiming about a machine it cannot see into.
    expect(held.answer?.ok).toBe(false);
    expect(held.answer?.outcome).toBe('expired');
  });

  it('decides once: two clients at one moment, one instruction, and the loser is told what happened', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));

    const winner = watch(
      approvals.decide({ ref: MIGRATING, approvalId: FIRST, decision: 'grant' }),
    );
    const loser = watch(approvals.decide({ ref: MIGRATING, approvalId: FIRST, decision: 'deny' }));
    await settle();

    // The second answer reached a request that was already claimed, so it never
    // became a frame: an agent must not be denied a command it was granted.
    expect(dispatched).toEqual([{ registrationId: LAPTOP, approvalId: FIRST, decision: 'grant' }]);

    approvals.settled(LAPTOP, settled(MIGRATING, FIRST, 'granted'));
    await settle();

    expect(winner.answer).toEqual({ ok: true, outcome: 'granted' });
    expect(loser.answer?.ok).toBe(false);
    // The refusal carries the outcome: the person who tapped second is owed
    // what became of the request, not merely that they were late.
    expect(loser.answer?.outcome).toBe('granted');
  });

  it('refuses an answer to a request the agent had already taken back', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    approvals.withdrawn(LAPTOP, withdrawn(MIGRATING, FIRST));

    const answer = await approvals.decide({
      ref: MIGRATING,
      approvalId: FIRST,
      decision: 'grant',
    });

    expect(answer.ok).toBe(false);
    expect(answer.outcome).toBe('withdrawn');
    expect(dispatched).toEqual([]);
  });

  it('refuses an answer to a request somebody else already settled', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    approvals.settled(LAPTOP, settled(MIGRATING, FIRST, 'denied'));

    const answer = await approvals.decide({
      ref: MIGRATING,
      approvalId: FIRST,
      decision: 'grant',
    });

    expect(answer.ok).toBe(false);
    expect(answer.outcome).toBe('denied');
    expect(dispatched).toEqual([]);
  });

  it('refuses an answer to a request that expired, with that word rather than a denial', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    approvals.settled(LAPTOP, settled(MIGRATING, FIRST, 'expired'));

    const answer = await approvals.decide({ ref: MIGRATING, approvalId: FIRST, decision: 'deny' });

    expect(answer.ok).toBe(false);
    expect(answer.outcome).toBe('expired');
  });

  it('refuses an answer naming a request this hub has never held, with no outcome to report', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));

    const answer = await approvals.decide({
      ref: MIGRATING,
      approvalId: SECOND,
      decision: 'grant',
    });

    // Not an outcome: this hub has no memory of the id at all, and inventing
    // `withdrawn` for it would be stating what became of something it never saw.
    expect(answer).toEqual({
      ok: false,
      outcome: null,
      code: 'refused',
      problem: expect.stringContaining('no approval'),
    });
    expect(dispatched).toEqual([]);
  });

  it('refuses an answer that names the wrong session for a request it is holding', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));

    const answer = await approvals.decide({ ref: FIXING, approvalId: FIRST, decision: 'grant' });

    expect(answer.outcome).toBeNull();
    expect(dispatched).toEqual([]);
  });

  it('clears the request when the agent takes it back', () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    approvals.requested(LAPTOP, requested(MIGRATING, SECOND));
    approvals.withdrawn(LAPTOP, withdrawn(MIGRATING, FIRST));

    expect(lastChange(MIGRATING)?.map((pending) => pending.approvalId)).toEqual([SECOND]);
  });

  it('clears the request when the machine says what became of it', () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    approvals.settled(LAPTOP, settled(MIGRATING, FIRST, 'granted'));

    expect(lastChange(MIGRATING)).toEqual([]);
  });

  it('says nothing twice about a request that ended once', () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    approvals.settled(LAPTOP, settled(MIGRATING, FIRST, 'granted'));
    const said = changes.length;
    // A withdrawal chasing a settlement across the wire, which happens: the
    // gate closes the hook's socket as it answers it. Announcing the same empty
    // list again would move the state's version for nothing.
    approvals.withdrawn(LAPTOP, withdrawn(MIGRATING, FIRST));

    expect(changes).toHaveLength(said);
  });

  it('ignores a withdrawal from a machine that did not report the request', () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    approvals.withdrawn(DESKTOP, withdrawn(MIGRATING, FIRST));

    expect(lastChange(MIGRATING)?.map((pending) => pending.approvalId)).toEqual([FIRST]);
  });

  it('withdraws what a disconnected machine was holding, and leaves the other machine alone', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    approvals.requested(DESKTOP, requested(FIXING, SECOND));
    const held = watch(approvals.decide({ ref: MIGRATING, approvalId: FIRST, decision: 'grant' }));
    await settle();

    approvals.serverGone(LAPTOP);
    await settle();

    expect(lastChange(MIGRATING)).toEqual([]);
    expect(lastChange(FIXING)?.map((pending) => pending.approvalId)).toEqual([SECOND]);
    // Nobody's answer was wrong so much as late: the hub cannot reach the
    // blocked process any more, and saying the grant was applied would be a
    // claim about a machine it has no route to.
    expect(held.answer?.ok).toBe(false);
    expect(held.answer?.outcome).toBe('withdrawn');
  });

  it('leaves the request open when the machine refuses the decision, and lets it be answered again', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    dispatchAnswer = { ok: false, code: 'refused', problem: 'that approval is unknown' };

    const first = await approvals.decide({ ref: MIGRATING, approvalId: FIRST, decision: 'grant' });
    expect(first).toEqual({
      ok: false,
      outcome: null,
      code: 'refused',
      problem: 'that approval is unknown',
    });

    // Nothing was applied, so nothing was decided: the claim is released rather
    // than leaving a request on the row that no second tap can ever reach.
    dispatchAnswer = { ok: true };
    void approvals.decide({ ref: MIGRATING, approvalId: FIRST, decision: 'deny' });
    await settle();
    expect(dispatched).toHaveLength(2);
  });
});

/**
 * The standing policy, from the side that has to act on it.
 *
 * What is asserted here is not what a rule means -- that is the protocol's
 * parser and the policy feature's rows -- but that a grant nobody was asked for
 * takes the same path a person's does. One instruction leaves the hub, the
 * settlement is still what ends the request, and everything that is not an
 * unambiguous match reaches a person.
 */
describe('a request the standing policy already answered', () => {
  beforeEach(() => {
    now = START;
    changes = [];
    dispatched = [];
    dispatchAnswer = { ok: true };
    consulted = [];
    policyAnswer = () => Promise.resolve(null);
  });

  it('is granted by the hub, without any client being asked', async () => {
    policyAnswer = () => Promise.resolve(A_GRANT);
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    await settle();

    expect(consulted).toEqual([{ tool: 'Bash', proposal: 'prisma migrate deploy --schema ./db' }]);
    expect(dispatched).toEqual([{ registrationId: LAPTOP, approvalId: FIRST, decision: 'grant' }]);
  });

  it('is still open until the machine says what happened', async () => {
    // The same rule a person's answer lives under: the hub knows it sent a
    // grant and can still be wrong about the result, because a grant that met
    // a hook which had stopped waiting changed nothing.
    policyAnswer = () => Promise.resolve(A_GRANT);
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    await settle();

    expect(lastChange(MIGRATING)).toHaveLength(1);
    approvals.settled(LAPTOP, settled(MIGRATING, FIRST, 'granted'));
    expect(lastChange(MIGRATING)).toEqual([]);
  });

  it('is put to a person when no rule covers it', async () => {
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    await settle();

    expect(dispatched).toEqual([]);
    expect(lastChange(MIGRATING)).toHaveLength(1);
  });

  it('is put to a person when the policy could not be read at all', async () => {
    // The seam is not supposed to reject -- the policy feature answers `null`
    // for every way of not knowing -- but a request left hanging because
    // something upstream threw would be an agent blocked with nobody asked.
    policyAnswer = () => Promise.reject(new Error('disk gone'));
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    await settle();

    expect(dispatched).toEqual([]);
    expect(lastChange(MIGRATING)).toHaveLength(1);
  });

  it('settles once when a person answers in the same moment', async () => {
    // The policy is read asynchronously, so a person tapping while that read
    // is in flight is the ordinary race. The claim is what decides it, and it
    // is the same claim two clients race for.
    let release = (): void => undefined;
    policyAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve(A_GRANT);
      });
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    await settle();

    const person = approvals.decide({ ref: MIGRATING, approvalId: FIRST, decision: 'deny' });
    release();
    await settle();

    expect(dispatched).toEqual([{ registrationId: LAPTOP, approvalId: FIRST, decision: 'deny' }]);
    approvals.settled(LAPTOP, settled(MIGRATING, FIRST, 'denied'));
    expect(await person).toEqual({ ok: true, outcome: 'denied' });
  });

  it('grants nothing for a request the agent took back while the policy was read', async () => {
    let release = (): void => undefined;
    policyAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve(A_GRANT);
      });
    const approvals = feature();
    approvals.requested(LAPTOP, requested(MIGRATING, FIRST));
    await settle();

    approvals.withdrawn(LAPTOP, withdrawn(MIGRATING, FIRST));
    release();
    await settle();

    expect(dispatched).toEqual([]);
  });
});
