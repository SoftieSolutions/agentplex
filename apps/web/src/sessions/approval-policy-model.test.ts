import { describe, expect, it } from 'vitest';
import {
  approvalIdSchema,
  approvalPolicyRuleIdSchema,
  nodeIdSchema,
  type ApprovalPolicyRecord,
  type PendingApproval,
} from '@agentplex/protocol';
import type { ApprovalPolicyView } from '../store/hub-store.js';
import {
  allowAlwaysCommand,
  coveredByPolicy,
  forgetRuleCommand,
  listPolicyCommand,
  policyRows,
} from './approval-policy-model.js';

/**
 * What the APPROVALS block and the "always allow this" control decide, with no
 * socket and no component.
 *
 * The assertions worth making here are the two that could quietly over-claim:
 * that the block never reads as a complete account of what will happen, and
 * that a rule made from a request is exactly that request rather than anything
 * broader.
 */

const PROJECT = nodeIdSchema.parse('node-project-work');

function record(tool: string, proposal: string, id = 'rule-1'): ApprovalPolicyRecord {
  return {
    ruleId: approvalPolicyRuleIdSchema.parse(id),
    rule: { tool, proposal },
    createdAt: 1_756_000_000_000,
  };
}

function policy(...rules: readonly ApprovalPolicyRecord[]): ApprovalPolicyView {
  return { replyTo: 1, rules };
}

function pending(tool: string, proposal: string): PendingApproval {
  return {
    approvalId: approvalIdSchema.parse('approval-1'),
    tool,
    proposal,
    suggestions: [],
    requestedAt: 1_756_000_000_000,
    answeredBy: null,
  };
}

describe('the policy commands', () => {
  it('asks for one project by its node, because a policy has no session form', () => {
    expect(listPolicyCommand(PROJECT)).toEqual({
      type: 'approval-policy-list',
      projectId: PROJECT,
    });
  });

  it('makes a rule that is exactly the request a person read, and nothing broader', () => {
    // The whole of what exact match buys on a screen: there is no prefix to
    // choose, nothing to trim, and no way to widen it by accident.
    const request = pending('Bash', 'command: pnpm test\ndescription: run the tests');
    expect(allowAlwaysCommand(PROJECT, request)).toEqual({
      type: 'approval-policy-add',
      projectId: PROJECT,
      rule: { tool: 'Bash', proposal: 'command: pnpm test\ndescription: run the tests' },
    });
  });

  it('forgets a rule by the id the hub minted, never by restating it', () => {
    expect(forgetRuleCommand(PROJECT, approvalPolicyRuleIdSchema.parse('rule-1'))).toEqual({
      type: 'approval-policy-remove',
      projectId: PROJECT,
      ruleId: 'rule-1',
    });
  });
});

describe('the rows the APPROVALS block draws', () => {
  it('ends in a line saying everything else asks', () => {
    // Without it, three grants with nothing after them read as a list of
    // everything that will happen.
    const rows = policyRows(PROJECT, policy(record('Bash', 'command: pnpm test')));
    expect(rows.map((row) => row.kind)).toEqual(['auto', 'asks']);
  });

  it('says a session in no project has nowhere for a decision to live', () => {
    const rows = policyRows(null, policy(record('Bash', 'command: pnpm test')));
    expect(rows).toEqual([{ kind: 'unfiled', words: expect.any(String) }]);
  });

  it('draws nothing at all before the hub has answered', () => {
    // An empty list would claim that nothing has been decided, a moment before
    // three rules arrive saying otherwise.
    expect(policyRows(PROJECT, null)).toEqual([]);
  });

  it('drops a rule this build will not have, and keeps the rest', () => {
    // A row an older build wrote under a looser grammar. It costs itself and
    // never the policy somebody is relying on.
    const rows = policyRows(
      PROJECT,
      policy(record('Bash', '   ', 'rule-loose'), record('Bash', 'command: pnpm test', 'rule-1')),
    );
    expect(rows).toEqual([
      { kind: 'auto', ruleId: 'rule-1', tool: 'Bash', proposal: 'command: pnpm test' },
      { kind: 'asks', words: expect.any(String) },
    ]);
  });
});

describe('whether a request is already covered', () => {
  const held = policy(record('Bash', 'command: pnpm test'));

  it('is covered by the rule it is exactly', () => {
    expect(coveredByPolicy(held, pending('Bash', 'command: pnpm test'))).toMatchObject({
      ruleId: 'rule-1',
    });
  });

  it('is not covered by a rule it merely begins with', () => {
    expect(coveredByPolicy(held, pending('Bash', 'command: pnpm test --force'))).toBe(null);
    expect(coveredByPolicy(held, pending('BashOutput', 'command: pnpm test'))).toBe(null);
  });

  it('is not covered before the policy has been read', () => {
    expect(coveredByPolicy(null, pending('Bash', 'command: pnpm test'))).toBe(null);
  });
});
