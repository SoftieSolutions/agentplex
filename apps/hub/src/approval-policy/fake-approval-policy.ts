import {
  approvalPolicyRuleIdSchema,
  approvalPolicyRuleMatches,
  parseApprovalPolicyRule,
  type NodeId,
  type SessionRef,
} from '@agentplex/protocol';
import type {
  ApprovalPolicy,
  ApprovalPolicyGrant,
  ApprovalPolicyOutcome,
  ApprovalPolicyRuleRecord,
} from './approval-policy.js';

/**
 * The standing policy, in memory, for suites that are not about the rows.
 *
 * It keeps the one behaviour a caller can get wrong -- a rule is parsed before
 * it is kept, so a rule the protocol refuses is refused here too -- and nothing
 * else. Everything about the table, the foreign key and the unique index is the
 * real feature's, demonstrated against a migrated schema in its own suite; a
 * fake that reimplemented any of it would be a second opinion about SQL.
 *
 * `fails` is how a suite asks what a socket does when the disk does not answer,
 * which is the case a policy must never turn into an empty policy.
 *
 * Test support: `tsconfig.build.json` excludes `fake-*.ts`, so this never ships.
 */

export interface FakeApprovalPolicy extends ApprovalPolicy {
  /** Every rule held, by project, so a suite can arrange one without `add`. */
  readonly held: Map<NodeId, ApprovalPolicyRuleRecord[]>;
  /** Makes every read and write reject, as an unreadable disk would. */
  fails(problem: string | null): void;
}

export function createFakeApprovalPolicy(): FakeApprovalPolicy {
  const held = new Map<NodeId, ApprovalPolicyRuleRecord[]>();
  let broken: string | null = null;
  let minted = 0;

  const refuseIfBroken = (): void => {
    if (broken !== null) throw new Error(broken);
  };

  return {
    held,

    fails(problem: string | null): void {
      broken = problem;
    },

    rulesFor(project: NodeId): Promise<readonly ApprovalPolicyRuleRecord[]> {
      refuseIfBroken();
      return Promise.resolve([...(held.get(project) ?? [])]);
    },

    add({ project, rule }): Promise<ApprovalPolicyOutcome> {
      refuseIfBroken();
      const parsed = parseApprovalPolicyRule(rule);
      if (!parsed.ok) {
        return Promise.resolve({ ok: false, code: 'refused', problem: parsed.problem });
      }
      const rules = held.get(project) ?? [];
      held.set(project, rules);
      const already = rules.find((record) => approvalPolicyRuleMatches(record.rule, parsed.rule));
      if (already !== undefined) return Promise.resolve({ ok: true, ruleId: already.ruleId });

      minted += 1;
      const ruleId = approvalPolicyRuleIdSchema.parse(`rule-${String(minted)}`);
      rules.push({ ruleId, project, rule: parsed.rule, createdAt: minted });
      return Promise.resolve({ ok: true, ruleId });
    },

    remove({ project, ruleId }): Promise<boolean> {
      refuseIfBroken();
      const rules = held.get(project) ?? [];
      const at = rules.findIndex((record) => record.ruleId === ruleId);
      if (at === -1) return Promise.resolve(false);
      rules.splice(at, 1);
      return Promise.resolve(true);
    },

    grantFor(
      _ref: SessionRef,
      _request: { readonly tool: string; readonly proposal: string },
    ): Promise<ApprovalPolicyGrant | null> {
      // Never rejects, whatever `fails` says: the real one swallows every way
      // of not knowing, because the caller's answer to `null` is to ask a
      // person and that is the right thing to do about a policy nobody could
      // read.
      return Promise.resolve(null);
    },
  };
}
