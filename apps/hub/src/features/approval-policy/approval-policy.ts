import { z } from 'zod';
import {
  APPROVAL_POLICY_RULES_MAX,
  APPROVAL_PROPOSAL_MAX_CHARS,
  approvalPolicyRuleIdSchema,
  approvalPolicyRuleMatches,
  nodeIdSchema,
  parseApprovalPolicyRule,
  type ApprovalAnsweredBy,
  type ApprovalPolicyRecord,
  type ApprovalPolicyRuleId,
  type NodeId,
  type RefusalCode,
  type SessionRef,
} from '@agentplex/protocol';
import type { Clock, IdGenerator, Logger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';

/**
 * The standing policy: what a project has already decided, so that nobody is
 * asked about it twice.
 *
 * ## Why this is a table and the requests are not
 *
 * `features/approvals` argues at length that a pending request must never be
 * written down: on the other side of one there is a process parked on a socket
 * with a timeout running, and a row read back after a restart would present a
 * question whose hook stopped waiting minutes ago as answerable. This is the
 * opposite fact. A rule is a thing a person decided on purpose, nothing on any
 * server knows it exists, no scan can rebuild it, and a hub that forgot every
 * rule on a deploy would immediately start asking about the very things it had
 * just been told to stop asking about.
 *
 * ## Why a project and not a session
 *
 * The human decision this feature exists to carry. A rule is a statement about
 * a body of work -- "in this repository, `pnpm test` does not need me" -- and a
 * session is a conversation that lasts an afternoon. Per-session rules would
 * have to be written again for every session, which in practice means written
 * while somebody is staring at a blocked agent and wants it to continue, which
 * is the worst moment anybody ever decides a policy.
 *
 * So a session filed under no project has no policy and is always asked about.
 * That is the answer and not a gap: the hub holds nothing anybody said about
 * that work, and inventing something would be the over-claim this whole feature
 * has to avoid.
 *
 * ## Everything that is not a match is a question
 *
 * `grantFor` returns a grant or `null`, and `null` is the answer to all of: no
 * project, no rule, a rule that does not match, a row that will not parse, and
 * a database that will not answer. It cannot reject, and that is load-bearing
 * rather than defensive -- it is called on the path a blocked agent's request
 * takes, and a rejection there would be an exception thrown through the one
 * code path whose job is to make sure a person gets asked.
 *
 * The direction of the failure is the point. A policy that fails closed asks a
 * question somebody has already answered, which is an annoyance. A policy that
 * fails open runs a command nobody approved.
 *
 * ## Read at the request and at no other time
 *
 * There is no cache and no subscription. The rules are read when a request
 * arrives, which is what makes "a rule deleted while a request is pending does
 * not retroactively grant it" true by construction rather than by a rule
 * somebody has to remember: nothing holds a decision made from a rule, because
 * the only moment a rule is consulted is the moment the question appears. One
 * small indexed read per blocked tool call is not a cost worth a cache that
 * could be wrong.
 */

/**
 * One rule as it sits on disk, read back and parsed.
 *
 * The protocol's own record plus the project it belongs to. The record is the
 * protocol's rather than this file's because it is what a client is answered
 * with, and a second shape here would be a mapping step whose only job would be
 * to fall out of step with the wire.
 */
export interface ApprovalPolicyRuleRecord extends ApprovalPolicyRecord {
  readonly project: NodeId;
}

/**
 * Why a request was not put to anybody: the rule that already answered it.
 *
 * It carries the rule and not merely the fact of a grant, because a decision
 * nobody was asked about has to be attributable afterwards. Whoever reads the
 * log, and whoever reads the screen, is owed the sentence a person wrote, in
 * the project they wrote it in.
 *
 * It is the protocol's `ApprovalAnsweredBy` and not a shape of this hub's,
 * because it travels: it is what the session row and the decision receipt
 * carry, so the thing the policy hands back and the thing a client reads are
 * one object rather than two that have to be kept in step.
 */
export type ApprovalPolicyGrant = ApprovalAnsweredBy;

/** A rule written, or the sentence saying why it was not. */
export type ApprovalPolicyOutcome =
  | { readonly ok: true; readonly ruleId: ApprovalPolicyRuleId }
  | { readonly ok: false; readonly code: RefusalCode; readonly problem: string };

export interface ApprovalPolicyDependencies {
  readonly database: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /**
   * Which project a session is filed under, or `null` for one filed nowhere.
   *
   * A function rather than the catalogue, for the reason `approvals` takes its
   * dispatch as a function: the rules above are then a unit test rather than
   * something only a populated node tree could demonstrate, and nothing in this
   * file can reach the tree for any other purpose. The composition root wires
   * it to `Catalogue.projectOf`.
   */
  readonly projectOf: (ref: SessionRef) => Promise<NodeId | null>;
}

export interface ApprovalPolicy {
  /** Every rule one project holds, oldest first. Rejects if the read fails. */
  rulesFor(project: NodeId): Promise<readonly ApprovalPolicyRuleRecord[]>;
  /**
   * Writes one rule for one project, or refuses it with a sentence.
   *
   * Writing the same rule twice is writing it once: the id that comes back is
   * the id of the rule that is there, because two identical rows are not two
   * grants -- they are one grant a person would have to revoke twice, and the
   * second revocation would be a rule they had no memory of writing.
   */
  add(request: {
    readonly project: NodeId;
    readonly rule: unknown;
  }): Promise<ApprovalPolicyOutcome>;
  /**
   * Removes one rule from one project. `false` when that project held no such
   * rule.
   *
   * Scoped to the project and not only to the id, because the id comes off a
   * client's screen: a client holding one it read from a policy it is no longer
   * looking at must not be able to reach into a policy it never asked for. The
   * project is also what the removal is answered with, so nothing here would
   * work without it anyway.
   */
  remove(request: {
    readonly project: NodeId;
    readonly ruleId: ApprovalPolicyRuleId;
  }): Promise<boolean>;
  /**
   * The standing decision covering this request, or `null`: ask somebody.
   *
   * Takes the tool and the proposal rather than a whole request, so that
   * nothing it is handed can include an id, a decision or the provider's
   * suggestions. What decides a match is what a person would have read, and the
   * argument list is where that is made true.
   *
   * Never rejects.
   */
  grantFor(
    ref: SessionRef,
    request: { readonly tool: string; readonly proposal: string },
  ): Promise<ApprovalPolicyGrant | null>;
}

/**
 * A row read back off disk, as a claim rather than as the shape we wrote.
 *
 * The bounds are restated here and not trusted from the columns, for the reason
 * `tasks.ts` restates its own: a row written by an older build, or by a hand on
 * the database, is input. It then goes through `parseApprovalPolicyRule` as
 * well, which is the part that matters -- the CHECK constraints can say a
 * string is short, and only the parser can say it is not a rule that would
 * match everything.
 */
const storedRowSchema = z.object({
  id: approvalPolicyRuleIdSchema,
  node_id: z.string().min(1),
  tool: z.string().min(1),
  proposal: z.string().min(1).max(APPROVAL_PROPOSAL_MAX_CHARS),
  created_at: z.coerce.number().int().nonnegative(),
});

export function createApprovalPolicy({
  database,
  clock,
  ids,
  logger: parent,
  projectOf,
}: ApprovalPolicyDependencies): ApprovalPolicy {
  const logger = parent.child({ part: 'approval-policy' });

  const read = async (project: NodeId): Promise<readonly ApprovalPolicyRuleRecord[]> => {
    const result = await database.query(
      `SELECT id, node_id, tool, proposal, created_at FROM approval_policy_rules
       WHERE node_id = ? ORDER BY created_at, id`,
      [project],
    );

    const records: ApprovalPolicyRuleRecord[] = [];
    for (const row of result.rows) {
      const stored = storedRowSchema.safeParse(row);
      if (!stored.success) {
        logger.warn('a policy rule row could not be read', {
          project,
          problem: stored.error.message,
        });
        continue;
      }
      // Parsed again on the way out, and not only on the way in. A row that
      // predates a refusal this parser has since learned, or one a hand wrote,
      // must not grant anything -- and an unreadable rule costs itself and not
      // the project's other rules, which is what keeps one bad row from
      // silently disarming a policy somebody is relying on.
      const rule = parseApprovalPolicyRule({
        tool: stored.data.tool,
        proposal: stored.data.proposal,
      });
      if (!rule.ok) {
        logger.warn('a stored policy rule is not one, and grants nothing', {
          project,
          ruleId: stored.data.id,
          problem: rule.problem,
        });
        continue;
      }
      const owner = nodeIdSchema.safeParse(stored.data.node_id);
      if (!owner.success) {
        logger.warn('a policy rule names something that is not a node', { project });
        continue;
      }
      records.push({
        ruleId: stored.data.id,
        project: owner.data,
        rule: rule.rule,
        createdAt: stored.data.created_at,
      });
    }
    return records;
  };

  return {
    rulesFor: read,

    async add({ project, rule }): Promise<ApprovalPolicyOutcome> {
      const parsed = parseApprovalPolicyRule(rule);
      if (!parsed.ok) return { ok: false, code: 'refused', problem: parsed.problem };

      // A policy is answered whole or not at all, so the bound on the frame is
      // a bound on the table: refusing the rule that would make the policy too
      // big to send is the only way the alternative -- answering a prefix of a
      // policy and calling it one -- never happens.
      const held = await read(project);
      if (
        held.length >= APPROVAL_POLICY_RULES_MAX &&
        !held.some((record) => approvalPolicyRuleMatches(record.rule, parsed.rule))
      ) {
        return {
          ok: false,
          code: 'refused',
          problem: `that project already holds ${String(APPROVAL_POLICY_RULES_MAX)} rules, which is as many as one policy may have`,
        };
      }

      const ruleId = ids.newId();
      try {
        // `DO NOTHING` states where the write happens the same rule the
        // interface states: one rule per project per tool and proposal. The read
        // after it is what returns the id of the row that is actually there,
        // which is the earlier one when this insert did nothing.
        await database.query(
          `INSERT INTO approval_policy_rules (id, node_id, tool, proposal, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (node_id, tool, proposal) DO NOTHING`,
          [ruleId, project, parsed.rule.tool, parsed.rule.proposal, clock.now()],
        );
      } catch (error) {
        // The foreign key is what refuses a rule for a node that is not a
        // project, and it is the schema saying so rather than a check this
        // file would have to remember to make.
        logger.info('a policy rule could not be written', {
          project,
          problem: String(error),
        });
        return {
          ok: false,
          code: 'refused',
          problem: 'that rule could not be written: it names no project this hub has',
        };
      }

      const written = (await read(project)).find((record) =>
        approvalPolicyRuleMatches(record.rule, parsed.rule),
      );
      if (written === undefined) {
        logger.warn('a policy rule was written and could not be read back', { project, ruleId });
        return { ok: false, code: 'internal', problem: 'that rule could not be read back' };
      }
      logger.info('a policy rule was written', {
        project,
        ruleId: written.ruleId,
        tool: written.rule.tool,
      });
      return { ok: true, ruleId: written.ruleId };
    },

    async remove({ project, ruleId }): Promise<boolean> {
      const before = await database.query(
        'SELECT id FROM approval_policy_rules WHERE id = ? AND node_id = ?',
        [ruleId, project],
      );
      if (before.rows.length === 0) return false;
      await database.query('DELETE FROM approval_policy_rules WHERE id = ? AND node_id = ?', [
        ruleId,
        project,
      ]);
      logger.info('a policy rule was removed', { project, ruleId });
      return true;
    },

    async grantFor(
      ref: SessionRef,
      request: { readonly tool: string; readonly proposal: string },
    ): Promise<ApprovalPolicyGrant | null> {
      try {
        const project = await projectOf(ref);
        if (project === null) return null;

        for (const record of await read(project)) {
          if (!approvalPolicyRuleMatches(record.rule, request)) continue;
          return { project, ruleId: record.ruleId, rule: record.rule };
        }
        return null;
      } catch (error) {
        // Any doubt means ask. A read that failed is doubt, and it is swallowed
        // here rather than thrown at the request path: the caller's job when
        // this answers `null` is to put the question to a person, which is
        // exactly the right thing to do about a policy nobody could read.
        logger.warn('the standing policy could not be read, so this will be asked', {
          ...ref,
          problem: String(error),
        });
        return null;
      }
    },
  };
}
