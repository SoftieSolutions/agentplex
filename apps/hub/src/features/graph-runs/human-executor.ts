import {
  approvalIdSchema,
  assertNever,
  displayableApprovalText,
  type ApprovalRequest,
  type GraphNode,
  type GraphRunId,
  type NodeId,
  type RouteInput,
} from '@agentplex/protocol';
import type { IdGenerator, Logger, Timers } from '@agentplex/node-shared';
import type { Approvals, GraphRunSubject } from '../approvals/approvals.js';
import { nameOf, type Executor, type StepResult } from './walker.js';

/**
 * A HUMAN step: ask a person, wait for the word, pass the input on or fail.
 *
 * ## Through the approvals feature, and nothing else
 *
 * The request is raised through `Approvals.requestedByHub`, which is the same
 * feature a blocked agent's request goes through, so a run waiting on a
 * person is drawn where a session waiting on one is -- the Approvals tab, the
 * bell -- and answered by the same Allow and Deny. Nothing here publishes,
 * broadcasts or pushes: the approvals feature tells the reducer, and the
 * reducer tells every client.
 *
 * ## What the person reads
 *
 * `PendingApproval` extends `ApprovalRequest`, whose `tool` and `proposal`
 * were shaped for a blocked tool call. A HUMAN node has no tool, so the
 * request carries a synthesised pair: `HUMAN` for the tool, and a sentence
 * naming the graph, the run number, the node and who was asked for the
 * proposal. Display text and nothing else -- nothing downstream parses it --
 * and it goes through `displayableApprovalText` for the reason every proposal
 * does, since a node label is text somebody typed into a canvas.
 *
 * ## The id is minted here
 *
 * The approvals feature has no id source: every id it ever held was minted
 * where the blocked hook was. The run is what is blocked at a HUMAN node, so
 * the id is minted here, per wait.
 *
 * ## The timeout fails the run
 *
 * A node with `timeoutMinutes` waits that long through injected timers and
 * then takes its request back and fails with a sentence naming the node and
 * the minutes -- reported like a denial, which is the decision. Both are
 * `retryable: false`: a Deny is an answer, and a timeout is the node's own
 * word on how long an answer may take, so asking again would overrule either.
 * Publish refuses a HUMAN node with retries for the same reason. A run that
 * waited unbounded for a person who never came would be a run nobody could
 * tell apart from one still worth waiting on. `null` waits as long as it
 * takes.
 *
 * A cancel takes the request back the same way and fails the step with the
 * cancel in the sentence; the walk reads its own cancellation flag and ends
 * the run `cancelled` rather than `failed`.
 */

export interface HumanExecutorDependencies {
  readonly approvals: Pick<Approvals, 'requestedByHub' | 'withdrawnByHub'>;
  readonly ids: IdGenerator;
  readonly timers: Timers;
  readonly logger: Logger;
}

/** What one run's HUMAN steps say about themselves: the subject and the words. */
export interface HumanRun {
  readonly runId: GraphRunId;
  readonly number: number;
  /** The graph's tree node, which is what a tap on the request opens. */
  readonly graph: NodeId;
  readonly graphName: string;
}

export interface HumanExecutor {
  /** The executor for one run: its identity is what every request it raises names. */
  forRun(run: HumanRun): Executor<'human'>;
}

/** The sentence a person is shown beside Allow and Deny. */
function proposalFor(run: HumanRun, node: Extract<GraphNode, { kind: 'human' }>): string {
  const who = node.approvers.join(', ');
  const wait =
    node.timeoutMinutes === null
      ? 'and waits as long as it takes'
      : `and waits ${String(node.timeoutMinutes)} minutes`;
  return displayableApprovalText(
    `run #${String(run.number)} of ${run.graphName} is waiting at ${nameOf(node)} for ${who}, ${wait}`,
  );
}

export function createHumanExecutor(dependencies: HumanExecutorDependencies): HumanExecutor {
  const { approvals, ids, timers } = dependencies;
  const logger = dependencies.logger.child({ part: 'graph-runs/human' });

  return {
    forRun(run: HumanRun): Executor<'human'> {
      return async (node, input, context) => {
        const approvalId = approvalIdSchema.parse(ids.newId());
        const subject: GraphRunSubject = { kind: 'graphRun', runId: run.runId, nodeId: node.id };
        const request: ApprovalRequest = {
          approvalId,
          tool: 'HUMAN',
          proposal: proposalFor(run, node),
          truncated: false,
          suggestions: [],
        };

        // Why the request ended, when this side ended it. `null` is a person's
        // answer, or a withdrawal this step did not ask for.
        let endedBy: 'timeout' | 'cancel' | null = null;

        const word = approvals.requestedByHub(subject, request, {
          graph: run.graph,
          number: run.number,
          nodeLabel: nameOf(node),
        });
        context.waiting();
        logger.info('a graph step is waiting on a person', {
          runId: run.runId,
          node: node.id,
          approvalId,
        });

        const cancelTimer =
          node.timeoutMinutes === null
            ? () => {}
            : timers.schedule(node.timeoutMinutes * 60_000, () => {
                endedBy = 'timeout';
                approvals.withdrawnByHub(run.runId);
              });
        const detach = context.cancellation.onCancel(() => {
          endedBy = 'cancel';
          approvals.withdrawnByHub(run.runId);
        });

        let outcome: Awaited<typeof word>;
        try {
          outcome = await word;
        } finally {
          cancelTimer();
          detach();
        }

        return resultFor(node, input, outcome, endedBy);
      };
    },
  };
}

function resultFor(
  node: Extract<GraphNode, { kind: 'human' }>,
  input: RouteInput,
  outcome: Awaited<ReturnType<Approvals['requestedByHub']>>,
  endedBy: 'timeout' | 'cancel' | null,
): StepResult {
  switch (outcome) {
    case 'granted':
      // The gate opens and the run goes on with what it had: a HUMAN node
      // decides whether, not what.
      return { ok: true, carried: input, output: null, next: null };
    case 'denied':
      return { ok: false, problem: `a person denied ${nameOf(node)}`, retryable: false };
    case 'withdrawn':
      switch (endedBy) {
        case 'timeout':
          return {
            ok: false,
            problem: `${nameOf(node)} waited ${String(node.timeoutMinutes ?? 0)} minutes for a person and nobody answered`,
            retryable: false,
          };
        case 'cancel':
          return {
            ok: false,
            problem: `the run was cancelled while ${nameOf(node)} was waiting on a person`,
          };
        case null:
          return {
            ok: false,
            problem: `the request on ${nameOf(node)} was withdrawn before anybody answered`,
          };
        default:
          return assertNever(endedBy, 'why a HUMAN step ended its own request');
      }
    case 'expired':
      // A hub-raised request has no hook to expire at; the word is handled so
      // the switch is whole, and said as what it would mean.
      return {
        ok: false,
        problem: `the request on ${nameOf(node)} expired before anybody answered`,
      };
    default:
      return assertNever(outcome, 'approval outcome');
  }
}
