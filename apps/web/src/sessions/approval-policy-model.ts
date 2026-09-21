import {
  parseApprovalPolicyRule,
  type ApprovalPolicyRecord,
  type ApprovalPolicyRuleId,
  type NodeId,
  type PendingApproval,
} from '@agentplex/protocol';
import type { ApprovalPolicyView, HubCommand } from '../store/hub-store.js';

/**
 * The standing policy as a screen reads it: the three commands, and the rows
 * the APPROVALS block draws.
 *
 * Pure functions beside `approval-model.ts` and for the same reason: what a
 * frame carries and what to make of an answer are decisions, and decisions
 * belong somewhere a test can call them without a socket. The component that
 * lands in step four owns a project id and a list of rows, and nothing else.
 *
 * The policy is per project and never per session, which is the human decision
 * this whole feature carries. So every function here takes a project node id,
 * and a session filed under no project has no policy to show -- `policyRows`
 * says so in words rather than drawing an empty list, because an empty list
 * reads as "nothing has been decided" and the truth is "there is nowhere for a
 * decision to live".
 */

/** Asks for one project's rules. The panel that opens sends this once. */
export function listPolicyCommand(project: NodeId): HubCommand {
  return { type: 'approval-policy-list', projectId: project };
}

/**
 * Writes one rule, from the request a person is looking at.
 *
 * It takes the pending approval rather than two strings, and that is the point
 * of exact match rather than an incidental convenience: the rule a person gets
 * from "always allow this" is exactly the tool and exactly the proposal they
 * just read, with nothing for them to edit into something broader by accident
 * and nothing for this file to trim, shorten or turn into a pattern.
 *
 * The text is display text. It is compared for equality by the hub and is never
 * executed, never spliced into a command line and never reaches a spawn -- the
 * proposal it will be matched against is itself derived from a tool input and
 * is not that input.
 */
export function allowAlwaysCommand(project: NodeId, request: PendingApproval): HubCommand {
  return {
    type: 'approval-policy-add',
    projectId: project,
    rule: { tool: request.tool, proposal: request.proposal },
  };
}

/** Takes one rule out again, by the id the hub minted for it. */
export function forgetRuleCommand(project: NodeId, ruleId: ApprovalPolicyRuleId): HubCommand {
  return { type: 'approval-policy-remove', projectId: project, ruleId };
}

/**
 * One line of the APPROVALS block.
 *
 * `auto` is a rule somebody wrote: this tool, this text, and nothing else.
 * `asks` is the standing truth underneath the list and is not a rule -- there
 * is no deny row to draw, because the table holds grants only and no row means
 * ask. Drawing it as a line is what stops the block reading as a complete
 * account of what will happen: a list of three grants with nothing after it
 * looks like a list of everything.
 */
export type PolicyRow =
  | {
      readonly kind: 'auto';
      readonly ruleId: ApprovalPolicyRuleId;
      readonly tool: string;
      /** The exact text a request must carry, whole, to be granted. */
      readonly proposal: string;
    }
  | { readonly kind: 'asks'; readonly words: string }
  | { readonly kind: 'unfiled'; readonly words: string };

const ASKS = 'everything else asks';
const UNFILED = 'this session is in no project, so every request reaches you';

/**
 * The rows for one session's project, from what the store holds.
 *
 * `project` is `null` for a session filed nowhere, and the one row that comes
 * back says so. `policy` is `null` before the hub has answered, and the block
 * is then empty rather than claiming an empty policy -- "nothing has been
 * decided" is a claim, and a screen making it while the answer is in flight
 * would tell somebody every request reaches them a moment before showing them
 * three rules saying otherwise.
 *
 * Each rule is put back through `parseApprovalPolicyRule` on the way in. The
 * hub parsed it, and the wire schema bounds it, and this parses it again for
 * the reason the hub re-parses its own rows: what is drawn as "you will not be
 * asked about this" must be a rule this build agrees is one. A rule that fails
 * costs itself and not the list, so one row written by a build that knew a
 * looser grammar cannot blank a policy somebody is relying on.
 */
export function policyRows(
  project: NodeId | null,
  policy: ApprovalPolicyView | null,
): readonly PolicyRow[] {
  if (project === null) return [{ kind: 'unfiled', words: UNFILED }];
  if (policy === null) return [];

  const rows: PolicyRow[] = [];
  for (const record of policy.rules) {
    const parsed = parseApprovalPolicyRule(record.rule);
    if (!parsed.ok) continue;
    rows.push({
      kind: 'auto',
      ruleId: record.ruleId,
      tool: parsed.rule.tool,
      proposal: parsed.rule.proposal,
    });
  }
  rows.push({ kind: 'asks', words: ASKS });
  return rows;
}

/**
 * Whether one project's policy already covers a request, as the screen knows
 * it.
 *
 * For one job: deciding whether to offer "always allow this" beside a pending
 * request, or to say it is already covered. It is emphatically not what grants
 * anything -- the hub matches, on its own rows, at the moment the request
 * arrives -- and a screen that treated this as the answer would be a second
 * matcher free to disagree with the one that decides.
 *
 * The comparison is the protocol's, through the same parser, so there is no
 * second opinion here about what equal means either.
 */
export function coveredByPolicy(
  policy: ApprovalPolicyView | null,
  request: PendingApproval,
): ApprovalPolicyRecord | null {
  if (policy === null) return null;
  for (const record of policy.rules) {
    const parsed = parseApprovalPolicyRule(record.rule);
    if (!parsed.ok) continue;
    if (parsed.rule.tool === request.tool && parsed.rule.proposal === request.proposal) {
      return record;
    }
  }
  return null;
}
