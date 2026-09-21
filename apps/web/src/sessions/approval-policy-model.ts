import {
  parseApprovalPolicyRule,
  type ApprovalPolicyRecord,
  type ApprovalPolicyRuleId,
  type FrameId,
  type Layout,
  type NodeId,
  type SessionRef,
} from '@agentplex/protocol';
import { PROJECT_KIND } from '../projects/project-kind.js';
import type { ApprovalPolicyView, HubCommand, RefusalView } from '../store/hub-store.js';

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
export function allowAlwaysCommand(
  project: NodeId,
  /**
   * The two fields a person read, and not the request object, for the reason
   * the hub's own policy seam takes the same pair: nothing a rule is ever made
   * from can then include an id, a suggestion or a decision, and the control
   * that offers this can be handed the narrowed request a card already draws.
   */
  request: { readonly tool: string; readonly proposal: string },
): HubCommand {
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
  | { readonly kind: 'unfiled'; readonly words: string }
  | { readonly kind: 'unread'; readonly words: string };

const ASKS = 'Everything else asks you first.';
const UNFILED = 'No policy: this session is in no project, so every request reaches you.';
const UNREAD = "This project's policy has not arrived yet.";
const UNPLACED = 'Where this session is filed has not arrived yet.';

/**
 * What exact means, in the one sentence the block owes a reader.
 *
 * It is here rather than in the component because it is a claim about how the
 * hub matches, not a caption: the rule text is compared whole and byte for
 * byte, so the nearest miss a person can imagine -- the same command with one
 * more flag, or one more space -- is a question they will still be asked. A
 * reader who assumes otherwise has assumed a policy broader than the one they
 * have, which is the only direction this screen must never be wrong in.
 */
export const EXACT_MATCH_WORDS =
  'A rule matches the whole text, exactly: a request that differs by one character asks you.';

/**
 * The rows for one session's project, from what the store holds.
 *
 * Three absences, three sentences, which is the whole of why `project` is a
 * union rather than a nullable id. A tree that has not arrived is not a session
 * filed nowhere, and saying "this session is in no project" while the tree is
 * in flight is this block's one chance to be wrong in the direction that costs
 * something: a person told there is no policy stops looking for one. `policy`
 * is `null` before the hub has answered, and the row for that says the answer
 * has not arrived rather than claiming an empty policy -- "nothing has been
 * decided" is a claim, and a screen making it a moment before three rules
 * arrive has made the same mistake.
 *
 * Each of them is a row rather than no rows, because the block is drawn under a
 * heading: an empty body is the promise `context-panel.tsx` argues no block may
 * make, and "not read yet" is the honest thing to put there.
 *
 * Each rule is put back through `parseApprovalPolicyRule` on the way in. The
 * hub parsed it, and the wire schema bounds it, and this parses it again for
 * the reason the hub re-parses its own rows: what is drawn as "you will not be
 * asked about this" must be a rule this build agrees is one. A rule that fails
 * costs itself and not the list, so one row written by a build that knew a
 * looser grammar cannot blank a policy somebody is relying on.
 */
export function policyRows(
  project: SessionProject,
  policy: ApprovalPolicyView | null,
): readonly PolicyRow[] {
  if (project.kind === 'unplaced') return [{ kind: 'unread', words: UNPLACED }];
  if (project.kind === 'unfiled') return [{ kind: 'unfiled', words: UNFILED }];
  if (policy === null) return [{ kind: 'unread', words: UNREAD }];

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
  request: { readonly tool: string; readonly proposal: string },
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

/**
 * The project whose policy covers one session, and what the tree calls it.
 *
 * The same walk the hub makes (`Catalogue.projectOf`): from the node that
 * anchors this session, upward, to the nearest project above it. Written again
 * here rather than asked for, because the tree is a frame this client already
 * holds -- and it is written to walk the same way, because two answers to
 * "which project" is how a screen comes to offer a rule to a policy the hub
 * would never consult for this session. A project below the session, or beside
 * it, is not this session's: containment runs one way.
 *
 * `unfiled` is a session this client can place and that is in no project --
 * filed at the root, or filed only under folders -- and there is nowhere for a
 * rule about it to live. `unplaced` is the tree not having arrived, or not
 * holding this session: two absences that look the same from here and that are
 * both "this client cannot say yet", which is a different sentence from "there
 * is no project" and must stay one.
 *
 * The label falls back to the node's id for a project the hub named nothing,
 * the way the pane's header falls back to the session id. A project a person
 * made always has a name; showing the id is at least showing something true,
 * where a minted "Untitled project" would be a name they could not tell from
 * one they chose.
 */
export type SessionProject =
  | { readonly kind: 'project'; readonly id: NodeId; readonly label: string }
  | { readonly kind: 'unfiled' }
  | { readonly kind: 'unplaced' };

const UNPLACED_PROJECT: SessionProject = { kind: 'unplaced' };
const UNFILED_PROJECT: SessionProject = { kind: 'unfiled' };

export function projectForSession(layout: Layout | null, ref: SessionRef): SessionProject {
  if (layout === null) return UNPLACED_PROJECT;
  const node = layout.find(
    (candidate) =>
      candidate.anchor !== null &&
      candidate.anchor.storeId === ref.storeId &&
      candidate.anchor.sessionId === ref.sessionId,
  );
  if (node === undefined) return UNPLACED_PROJECT;

  const byId = new Map(layout.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<NodeId>([node.id]);
  let above = node.parentId === null ? undefined : byId.get(node.parentId);
  while (above !== undefined) {
    if (above.kind === PROJECT_KIND) {
      return { kind: 'project', id: above.id, label: above.name ?? above.id };
    }
    // A tree the hub writes cannot contain a cycle -- `moveNode` refuses one --
    // and this is what stops the walk rather than spinning if one arrives
    // anyway. An unplaceable session costs itself and not the pane.
    if (seen.has(above.id)) return UNFILED_PROJECT;
    seen.add(above.id);
    above = above.parentId === null ? undefined : byId.get(above.parentId);
  }
  return UNFILED_PROJECT;
}

/**
 * Where a rule this client wrote or took out has got to.
 *
 * `done` and not `written`, because one function serves the add and the remove:
 * both end in the hub answering with the project's policy as it now stands, and
 * both are refused the same way. What they end in is the same receipt, so
 * telling them apart here would be a distinction the hub does not draw.
 *
 * Correlated by `replyTo` for the reason `approvalFollowUp` is: one snapshot
 * holds one refusal and one policy per project, and a control reading the
 * newest of either would report the answer to somebody else's frame as its own
 * -- two remove buttons in one block are exactly that case.
 */
export type PolicyFollowUp =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'done' }
  | { readonly kind: 'refused'; readonly words: string };

export function policyFollowUp(
  pending: FrameId | null,
  policy: ApprovalPolicyView | null,
  lastRefusal: RefusalView | null,
): PolicyFollowUp {
  if (pending === null) return { kind: 'idle' };
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    return { kind: 'refused', words: lastRefusal.message };
  }
  if (policy !== null && policy.replyTo === pending) return { kind: 'done' };
  return { kind: 'waiting' };
}
