import type {
  DocName,
  FrameId,
  GraphDocument,
  GraphRunId,
  NodeId,
  RouteInput,
  ServerRegistrationId,
} from '@agentplex/protocol';
import type { Docs } from '../docs/docs.js';
import type { GraphRuns } from '../graph-runs/graph-runs.js';
import type { Graphs } from '../graphs/graphs.js';
import { refusal, reply, type ReplyContext } from './reply.js';

/**
 * Makes a document on one machine and answers the client that asked.
 *
 * The reply carries the node and nothing else. The tree change reaches
 * everybody as `catalogue-changed`, so there is nothing else to say here.
 */
export function answerDocCreate(
  ctx: ReplyContext,
  docs: Docs,
  replyTo: FrameId,
  projectId: NodeId,
  server: ServerRegistrationId,
  name: DocName,
  content: string,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not create a document', failure: 'the hub could not create that document' },
    () => docs.create(projectId, server, name, content),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return { type: 'doc-created', replyTo, nodeId: outcome.nodeId };
    },
  );
}

/**
 * Replaces a document and answers the client that asked.
 *
 * `updatedAt` is the machine's, relayed rather than stamped here: a client
 * showing when a document was last written is describing a file, and the
 * hub's receipt time would be that answer plus however long two machines
 * took to talk.
 */
export function answerDocSave(
  ctx: ReplyContext,
  docs: Docs,
  replyTo: FrameId,
  nodeId: NodeId,
  content: string,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not save a document', failure: 'the hub could not save that document' },
    () => docs.save(nodeId, content),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return { type: 'doc-saved', replyTo, updatedAt: outcome.updatedAt };
    },
  );
}

/**
 * Reads a document back and answers the client that asked.
 *
 * A document on a machine that is not connected is a refusal naming that
 * machine, and the sentence comes from the feature rather than from here:
 * the hub holds no copy, and what a client renders is the reason it cannot
 * have one right now.
 */
export function answerDocOpen(
  ctx: ReplyContext,
  docs: Docs,
  replyTo: FrameId,
  nodeId: NodeId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not open a document', failure: 'the hub could not open that document' },
    () => docs.open(nodeId),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return {
        type: 'doc-content',
        replyTo,
        content: outcome.content,
        updatedAt: outcome.updatedAt,
      };
    },
  );
}

/**
 * Makes a graph and answers the client that asked with the node it will be
 * named by. The tree change reaches everybody as `catalogue-changed`, so
 * there is nothing else to say here.
 */
export function answerGraphCreate(
  ctx: ReplyContext,
  graphs: Graphs,
  replyTo: FrameId,
  projectId: NodeId,
  name: string,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not create a graph', failure: 'the hub could not create that graph' },
    () => graphs.create(projectId, name),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return { type: 'graph-created', replyTo, nodeId: outcome.nodeId };
    },
  );
}

/** Reads a graph's draft and version numbers back to the client that asked. */
export function answerGraphOpen(
  ctx: ReplyContext,
  graphs: Graphs,
  replyTo: FrameId,
  nodeId: NodeId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not open a graph', failure: 'the hub could not open that graph' },
    () => graphs.open(nodeId),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return {
        type: 'graph-document',
        replyTo,
        nodeId: outcome.nodeId,
        name: outcome.name,
        draftVersion: outcome.draftVersion,
        document: outcome.document,
        published: [...outcome.published],
      };
    },
  );
}

/**
 * Replaces a graph's draft and answers when. The document arrived parsed by
 * the frame schema, which is the same schema the rows are read by, so
 * nothing here or below re-checks its shape.
 */
export function answerGraphSave(
  ctx: ReplyContext,
  graphs: Graphs,
  replyTo: FrameId,
  nodeId: NodeId,
  document: GraphDocument,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not save a graph', failure: 'the hub could not save that graph' },
    () => graphs.save(nodeId, document),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return {
        type: 'graph-saved',
        replyTo,
        version: outcome.version,
        updatedAt: outcome.updatedAt,
      };
    },
  );
}

/**
 * Publishes a graph's draft and answers with the version it became, or with
 * the feature's sentence about why it cannot run yet.
 */
export function answerGraphPublish(
  ctx: ReplyContext,
  graphs: Graphs,
  replyTo: FrameId,
  nodeId: NodeId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not publish a graph', failure: 'the hub could not publish that graph' },
    () => graphs.publish(nodeId),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return { type: 'graph-published', replyTo, version: outcome.version };
    },
  );
}

/**
 * Starts a run and answers with its name and number. The run itself
 * arrives as `graph-run-state`, unsolicited, on every client watching the
 * graph; this reply says only that it began. A refusal is the feature's
 * sentence: no such graph, nothing published to run, or a run of it
 * already in flight.
 */
export function answerGraphRun(
  ctx: ReplyContext,
  graphRuns: GraphRuns,
  replyTo: FrameId,
  nodeId: NodeId,
  input: RouteInput,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not start a run', failure: 'the hub could not start that run' },
    () => graphRuns.start(nodeId, input),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return {
        type: 'graph-run-started',
        replyTo,
        runId: outcome.runId,
        number: outcome.number,
      };
    },
  );
}

/**
 * Answers where the graph's newest run stands, addressed to the read that
 * asked: the run whole, or `null` for a graph that has never run.
 */
export function answerGraphRunRead(
  ctx: ReplyContext,
  graphRuns: GraphRuns,
  replyTo: FrameId,
  nodeId: NodeId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not read a run', failure: 'the hub could not read that graph’s runs' },
    () => graphRuns.latest(nodeId),
    (run) => ({ type: 'graph-run-latest', replyTo, nodeId, run }),
  );
}

/**
 * Answers with the graph's runs newest first, bounded, to this client
 * alone. An empty list is the answer for a graph that has never run, and
 * for a node that is no graph: the list of its runs is empty either way.
 */
export function answerGraphRunHistory(
  ctx: ReplyContext,
  graphRuns: GraphRuns,
  replyTo: FrameId,
  nodeId: NodeId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    {
      doing: 'could not read a graph’s run history',
      failure: 'the hub could not read that graph’s runs',
    },
    () => graphRuns.history(nodeId),
    (runs) => ({ type: 'graph-run-history', replyTo, nodeId, runs: [...runs] }),
  );
}

/**
 * Answers one run of the graph, whole, in a `graph-run-latest` addressed to
 * the open -- the answer shape the read already has, so the client settles
 * the frame it filed as pending and files the run under its id the same way
 * -- or a refusal when the graph has no run by that id. Never another graph's run:
 * the feature checks the pair, so a screen is not handed a run to draw as
 * its own that belongs to something else.
 */
export function answerGraphRunOpen(
  ctx: ReplyContext,
  graphRuns: GraphRuns,
  replyTo: FrameId,
  nodeId: NodeId,
  runId: GraphRunId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not open a run', failure: 'the hub could not read that run' },
    () => graphRuns.open(nodeId, runId),
    (run) => {
      if (run === null) return refusal(replyTo, 'refused', 'that graph has no run by that id');
      return { type: 'graph-run-latest', replyTo, nodeId, run };
    },
  );
}

/**
 * Answers what a run of the graph's draft would do, to this client alone:
 * the path with a reason per step, and the sentence it stopped on. A
 * refusal is the feature's sentence -- no graph by that id.
 */
export function answerGraphSimulate(
  ctx: ReplyContext,
  graphRuns: GraphRuns,
  replyTo: FrameId,
  nodeId: NodeId,
  input: RouteInput,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not simulate a graph', failure: 'the hub could not simulate that graph' },
    () => graphRuns.simulate(nodeId, input),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return {
        type: 'graph-simulated',
        replyTo,
        nodeId,
        path: [...outcome.path],
        reason: outcome.reason,
      };
    },
  );
}

/** Asks a run to stop before its next step, and says the ask was taken. */
export function answerGraphRunCancel(
  ctx: ReplyContext,
  graphRuns: GraphRuns,
  replyTo: FrameId,
  runId: GraphRunId,
): Promise<void> {
  return reply(
    ctx,
    replyTo,
    { doing: 'could not cancel a run', failure: 'the hub could not cancel that run' },
    () => graphRuns.cancel(runId),
    (outcome) => {
      if (!outcome.ok) return refusal(replyTo, outcome.code, outcome.problem);
      return { type: 'graph-run-cancelled', replyTo, runId };
    },
  );
}
