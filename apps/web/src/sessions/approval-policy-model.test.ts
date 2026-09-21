import { describe, expect, it } from 'vitest';
import {
  approvalIdSchema,
  approvalPolicyRuleIdSchema,
  nodeIdSchema,
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  type ApprovalPolicyRecord,
  type Layout,
  type PendingApproval,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { ApprovalPolicyView, RefusalView } from '../store/hub-store.js';
import {
  allowAlwaysCommand,
  coveredByPolicy,
  forgetRuleCommand,
  listPolicyCommand,
  policyFollowUp,
  policyRows,
  projectForSession,
  type SessionProject,
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
/** A session the tree places inside that project, as the block is handed it. */
const IN_PROJECT: SessionProject = { kind: 'project', id: PROJECT, label: 'work' };

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
    const rows = policyRows(IN_PROJECT, policy(record('Bash', 'command: pnpm test')));
    expect(rows.map((row) => row.kind)).toEqual(['auto', 'asks']);
  });

  it('says a session in no project has nowhere for a decision to live', () => {
    const rows = policyRows({ kind: 'unfiled' }, policy(record('Bash', 'command: pnpm test')));
    expect(rows).toEqual([{ kind: 'unfiled', words: expect.any(String) }]);
  });

  it('says nothing about the policy until the tree has said where the session is', () => {
    // The dangerous half of the same rule: "this session is in no project"
    // reads as "there is no policy", and a person who reads that stops looking.
    expect(policyRows({ kind: 'unplaced' }, null)).toEqual([
      { kind: 'unread', words: expect.any(String) },
    ]);
  });

  it('says the policy has not arrived rather than claiming an empty one', () => {
    // An empty list would claim that nothing has been decided, a moment before
    // three rules arrive saying otherwise. A row that says the client has not
    // been answered yet claims nothing about what the policy holds, and it is
    // what keeps the block from being a heading with nothing under it.
    expect(policyRows(IN_PROJECT, null)).toEqual([{ kind: 'unread', words: expect.any(String) }]);
  });

  it('drops a rule this build will not have, and keeps the rest', () => {
    // A row an older build wrote under a looser grammar. It costs itself and
    // never the policy somebody is relying on.
    const rows = policyRows(
      IN_PROJECT,
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

/**
 * Which project a session's policy belongs to, read off the tree a real hub
 * sent.
 *
 * The arrangements are the captured ones, with one node re-parented where the
 * capture has no session inside a project -- the move `doc-rows.test.ts` makes
 * for the same reason. What is being pinned is that this client walks the tree
 * the way `Catalogue.projectOf` walks the rows: upward from the session's node,
 * to the nearest project above it, and to nothing else. Two answers to "which
 * project" is the one way this screen could offer a rule to a policy that would
 * never be consulted for this session.
 */
describe('the project a session is filed under', () => {
  function layoutFrom(text: string): Layout {
    const parsed = parseTextFrame(parseHubFrame, text);
    if (!parsed.ok || parsed.value.type !== 'layout') {
      throw new Error('the fixture is not a layout frame');
    }
    return parsed.value.nodes;
  }

  const FILED = sessionRefSchema.parse({
    storeId: 'store-agentplex',
    sessionId: 'session-fix-auth',
  });
  const withProject = layoutFrom(hubFrames.layoutWithProject);
  const arranged = layoutFrom(hubFrames.layoutArranged);

  /** The captured tree with the session moved under the node named. */
  function filedUnder(layout: Layout, parent: string): Layout {
    return layout.map((node) =>
      node.kind === 'session' && node.anchor?.sessionId === FILED.sessionId
        ? { ...node, parentId: nodeIdSchema.parse(parent) }
        : node,
    );
  }

  it('names the project the session sits in, with the name the tree carries', () => {
    expect(projectForSession(filedUnder(withProject, 'hub-5'), FILED)).toEqual({
      kind: 'project',
      id: 'hub-5',
      label: 'agentplex (main checkout)',
    });
  });

  it('has no project for a session filed at the root', () => {
    // The captured arrangement: two sessions at the top of the tree, neither of
    // them inside anything. There is nowhere for a rule about them to live.
    expect(projectForSession(arranged, FILED)).toEqual({ kind: 'unfiled' });
  });

  it('does not borrow the project a folder happens to contain', () => {
    // `hub-7` is a folder holding the project, so the project is below the
    // session rather than above it. Containment is the relation, and it only
    // runs one way: a rule written here would be written into a policy the hub
    // would never consult for this session.
    expect(projectForSession(filedUnder(arranged, 'hub-7'), FILED)).toEqual({ kind: 'unfiled' });
  });

  it('cannot place a session the tree does not hold, or place any while there is no tree', () => {
    // Not "no project": the tree is the thing that says where a session is
    // filed, and a client that has not been answered one yet knows nothing
    // about this session's filing. Telling somebody there is no policy is the
    // claim that costs something, so it waits until there is a tree to make it
    // from.
    const elsewhere = sessionRefSchema.parse({
      storeId: 'store-agentplex',
      sessionId: 'session-that-is-not-in-the-tree',
    });
    expect(projectForSession(withProject, elsewhere)).toEqual({ kind: 'unplaced' });
    expect(projectForSession(null, FILED)).toEqual({ kind: 'unplaced' });
  });
});

/**
 * What the hub has said about a rule this client wrote or took out.
 *
 * The same correlation `approvalFollowUp` makes and for the same reason: one
 * snapshot holds one refusal and one policy per project, and a control that
 * read the newest of either would report another control's answer as its own.
 */
describe('where a policy edit has got to', () => {
  const refusal: RefusalView = {
    replyTo: 7,
    code: 'refused',
    message: 'that project has no policy this hub can write',
    holder: null,
  };

  it('is idle until something has been sent', () => {
    expect(policyFollowUp(null, policy(), refusal)).toEqual({ kind: 'idle' });
  });

  it('waits while the hub has said nothing about this frame', () => {
    expect(policyFollowUp(7, null, null)).toEqual({ kind: 'waiting' });
    // A policy answered for somebody else's frame is not this one's answer.
    expect(policyFollowUp(7, { replyTo: 4, rules: [] }, null)).toEqual({ kind: 'waiting' });
  });

  it('is done when the policy the hub answered with is the answer to this frame', () => {
    expect(policyFollowUp(7, { replyTo: 7, rules: [] }, null)).toEqual({ kind: 'done' });
  });

  it("repeats the hub's refusal in the hub's own words", () => {
    expect(policyFollowUp(7, null, refusal)).toEqual({
      kind: 'refused',
      words: 'that project has no policy this hub can write',
    });
  });

  it('ignores a refusal of some other frame', () => {
    expect(policyFollowUp(9, null, refusal)).toEqual({ kind: 'waiting' });
  });
});
