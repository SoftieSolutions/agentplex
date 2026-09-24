import { describe, expect, it } from 'vitest';
import { parseClientFrame, parseHubFrame } from './client.js';
import {
  GRAPH_RUN_HISTORY_MAX,
  GRAPH_RUN_OUTPUT_MAX_CHARS,
  GRAPH_RUN_STEPS_MAX,
  graphRunChildSchema,
  graphRunIdSchema,
  graphRunSummarySchema,
  graphRunStateSchema,
  graphRunStepOutputSchema,
  graphRunStepSchema,
  runStatusSchema,
  stepOutcomeSchema,
} from './graph-run.js';

/**
 * The run frames: what a client asks with, and what the hub says as a run
 * moves. The shapes are asserted through the two direction parsers as well as
 * through the module's own schemas, because a frame that parses on its own and
 * not inside the union is a frame nobody can send.
 */

const RUN_ID = 'run-38';
const GRAPH = 'node-9';
const STEP = {
  nodeId: 'start',
  attempt: 0,
  outcome: 'succeeded',
  output: { kind: 'text', text: '{"language":"rust"}' },
  child: null,
};
const SUMMARY = {
  runId: RUN_ID,
  number: 38,
  status: 'failed',
  startedAt: 1_756_000_000_000,
  endedAt: 1_756_000_060_000,
  reason: 'no route on classify matched and it has no otherwise',
};
const SESSION_OUTPUT = {
  kind: 'session',
  storeId: 'store-work',
  sessionId: 'session-9',
  status: 'idle',
};

describe('the run vocabulary', () => {
  it('names five run statuses and nothing else', () => {
    // `waiting` is the second open state: a run parked at a HUMAN node for a
    // person. It is not `running`, because a strip that read `live` for a run
    // nothing is doing would be a strip claiming work that is not happening.
    expect(runStatusSchema.options).toEqual([
      'running',
      'waiting',
      'succeeded',
      'failed',
      'cancelled',
    ]);
    expect(runStatusSchema.safeParse('paused').success).toBe(false);
  });

  it('names what one attempt of one step became, waiting included', () => {
    expect(stepOutcomeSchema.options).toEqual([
      'running',
      'waiting',
      'succeeded',
      'failed',
      'cancelled',
    ]);
  });

  it('takes a run id as an opaque string and refuses an empty one', () => {
    expect(graphRunIdSchema.safeParse(RUN_ID).success).toBe(true);
    expect(graphRunIdSchema.safeParse('').success).toBe(false);
  });

  it('records a step output as one of three bounded shapes, or nothing', () => {
    expect(graphRunStepSchema.safeParse(STEP).success).toBe(true);
    expect(graphRunStepSchema.safeParse({ ...STEP, output: null }).success).toBe(true);
    expect(
      graphRunStepOutputSchema.safeParse({ kind: 'route', route: 0, to: 'review' }).success,
    ).toBe(true);
    expect(
      graphRunStepOutputSchema.safeParse({ kind: 'route', route: null, to: 'review' }).success,
    ).toBe(true);
    expect(graphRunStepOutputSchema.safeParse(SESSION_OUTPUT).success).toBe(true);
    expect(graphRunStepSchema.safeParse({ ...STEP, attempt: -1 }).success).toBe(false);
  });

  it('refuses a route input, free words or a session with extra fields as an output', () => {
    // The old shape: the object handed to the next node. A step no longer
    // records it, because it is up to 16 000 characters per step and a run
    // may have hundreds of steps.
    expect(graphRunStepSchema.safeParse({ ...STEP, output: { language: 'rust' } }).success).toBe(
      false,
    );
    expect(graphRunStepSchema.safeParse({ ...STEP, output: 'words' }).success).toBe(false);
    expect(graphRunStepOutputSchema.safeParse({ ...SESSION_OUTPUT, transcript: 'x' }).success).toBe(
      false,
    );
    expect(graphRunStepOutputSchema.safeParse({ kind: 'route', route: 0 }).success).toBe(false);
  });

  it('names the child run a SUB-GRAPH step started, or null on every other step', () => {
    const child = { runId: 'run-7', number: 4 };
    expect(graphRunChildSchema.safeParse(child).success).toBe(true);
    expect(graphRunStepSchema.safeParse({ ...STEP, child }).success).toBe(true);
    expect(graphRunStepSchema.parse({ ...STEP, child }).child).toEqual(child);
    // Required on every step: a record that says nothing about a child is
    // not a record of a step that had none.
    const { child: _dropped, ...withoutChild } = STEP;
    expect(graphRunStepSchema.safeParse(withoutChild).success).toBe(false);
    expect(graphRunStepSchema.safeParse({ ...STEP, child: { runId: 'run-7' } }).success).toBe(
      false,
    );
    expect(graphRunStepSchema.safeParse({ ...STEP, child: { ...child, number: 0 } }).success).toBe(
      false,
    );
    expect(
      graphRunChildSchema.safeParse({ ...child, steps: [] }).success,
      'a child is named, never carried whole',
    ).toBe(false);
  });

  it('summarises a run for the history list without its steps', () => {
    expect(graphRunSummarySchema.parse(SUMMARY)).toEqual(SUMMARY);
    expect(
      graphRunSummarySchema.safeParse({
        ...SUMMARY,
        status: 'running',
        endedAt: null,
        reason: null,
      }).success,
    ).toBe(true);
    expect(graphRunSummarySchema.safeParse({ ...SUMMARY, steps: [STEP] }).success).toBe(false);
    expect(graphRunSummarySchema.safeParse({ ...SUMMARY, number: 0 }).success).toBe(false);
    const { endedAt: _endedAt, ...withoutEnd } = SUMMARY;
    expect(graphRunSummarySchema.safeParse(withoutEnd).success).toBe(false);
  });

  it('bounds the one free text a step may record', () => {
    const text = 'x'.repeat(GRAPH_RUN_OUTPUT_MAX_CHARS);
    expect(graphRunStepOutputSchema.safeParse({ kind: 'text', text }).success).toBe(true);
    expect(graphRunStepOutputSchema.safeParse({ kind: 'text', text: `${text}x` }).success).toBe(
      false,
    );
  });

  it('carries no cost anywhere in a run state', () => {
    const state = graphRunStateSchema.parse({
      nodeId: GRAPH,
      runId: RUN_ID,
      number: 38,
      status: 'running',
      reason: null,
      step: 3,
      of: 9,
      steps: [STEP],
    });
    expect(Object.keys(state)).not.toContain('cost');
    expect(Object.keys(state.steps[0] ?? {})).not.toContain('cost');
  });

  it('bounds how many step records one state may carry', () => {
    const steps = Array.from({ length: GRAPH_RUN_STEPS_MAX + 1 }, () => STEP);
    expect(
      graphRunStateSchema.safeParse({
        nodeId: GRAPH,
        runId: RUN_ID,
        number: 1,
        status: 'running',
        reason: null,
        step: 1,
        of: 1,
        steps,
      }).success,
    ).toBe(false);
  });
});

describe('parseClientFrame on the run frames', () => {
  it('takes a run with the graph node and a bounded input', () => {
    expect(
      parseClientFrame({ type: 'graph-run', id: 1, nodeId: 'node-9', input: { language: 'rust' } })
        .ok,
    ).toBe(true);
    expect(parseClientFrame({ type: 'graph-run', id: 1, nodeId: 'node-9', input: {} }).ok).toBe(
      true,
    );
    expect(
      parseClientFrame({
        type: 'graph-run',
        id: 1,
        nodeId: 'node-9',
        input: ['not', 'an', 'object'],
      }).ok,
    ).toBe(false);
    expect(parseClientFrame({ type: 'graph-run', id: 1, nodeId: 'node-9' }).ok).toBe(false);
  });

  it('takes a cancel that names the run and nothing else', () => {
    expect(parseClientFrame({ type: 'graph-run-cancel', id: 2, runId: RUN_ID }).ok).toBe(true);
    expect(parseClientFrame({ type: 'graph-run-cancel', id: 2 }).ok).toBe(false);
  });

  it('takes a read that names the graph and nothing else', () => {
    expect(parseClientFrame({ type: 'graph-run-read', id: 3, nodeId: GRAPH }).ok).toBe(true);
    expect(parseClientFrame({ type: 'graph-run-read', id: 3 }).ok).toBe(false);
    expect(parseClientFrame({ type: 'graph-run-read', id: 3, runId: RUN_ID }).ok).toBe(false);
  });

  it('takes a history request that names the graph and nothing else', () => {
    expect(parseClientFrame({ type: 'graph-run-history-request', id: 4, nodeId: GRAPH }).ok).toBe(
      true,
    );
    expect(parseClientFrame({ type: 'graph-run-history-request', id: 4 }).ok).toBe(false);
  });

  it('takes an open of one run that names its graph and the run', () => {
    expect(
      parseClientFrame({ type: 'graph-run-open', id: 5, nodeId: GRAPH, runId: RUN_ID }).ok,
    ).toBe(true);
    expect(parseClientFrame({ type: 'graph-run-open', id: 5, nodeId: GRAPH }).ok).toBe(false);
    expect(parseClientFrame({ type: 'graph-run-open', id: 5, runId: RUN_ID }).ok).toBe(false);
  });
});

describe('parseHubFrame on the run frames', () => {
  it('answers a run with the id and the number it was given', () => {
    expect(
      parseHubFrame({ type: 'graph-run-started', replyTo: 1, runId: RUN_ID, number: 38 }).ok,
    ).toBe(true);
    expect(
      parseHubFrame({ type: 'graph-run-started', replyTo: 1, runId: RUN_ID, number: 0 }).ok,
    ).toBe(false);
  });

  it('carries a run state unsolicited, with no replyTo', () => {
    const result = parseHubFrame({
      type: 'graph-run-state',
      nodeId: GRAPH,
      runId: RUN_ID,
      number: 38,
      status: 'running',
      reason: null,
      step: 3,
      of: 9,
      steps: [STEP, { ...STEP, nodeId: 'review', outcome: 'running', output: null }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('replyTo' in result.value).toBe(false);
  });

  it('names the graph a state is of, so a client can file it without a replyTo', () => {
    expect(
      parseHubFrame({
        type: 'graph-run-state',
        runId: RUN_ID,
        number: 38,
        status: 'running',
        reason: null,
        step: 3,
        of: 9,
        steps: [],
      }).ok,
    ).toBe(false);
  });

  it('answers a read of a graph with no run by naming the graph and the frame', () => {
    expect(
      parseHubFrame({ type: 'graph-run-latest', replyTo: 5, nodeId: GRAPH, run: null }).ok,
    ).toBe(true);
    expect(parseHubFrame({ type: 'graph-run-latest', replyTo: 5, run: null }).ok).toBe(false);
    expect(parseHubFrame({ type: 'graph-run-latest', replyTo: 5, nodeId: GRAPH }).ok).toBe(false);
    // The answer that replaced it; nothing else is spelled that way any more.
    expect(parseHubFrame({ type: 'graph-run-none', replyTo: 5, nodeId: GRAPH }).ok).toBe(false);
  });

  it('answers a read of a graph that has run with the run, whole, and the frame it answers', () => {
    const run = {
      nodeId: GRAPH,
      runId: RUN_ID,
      number: 38,
      status: 'succeeded',
      reason: null,
      step: 1,
      of: 1,
      steps: [STEP],
    };
    const result = parseHubFrame({ type: 'graph-run-latest', replyTo: 5, nodeId: GRAPH, run });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.type !== 'graph-run-latest') return;
    expect(result.value.replyTo).toBe(5);
    expect(result.value.run?.runId).toBe(RUN_ID);
    // A read without its frame id is not an answer to anything.
    expect(parseHubFrame({ type: 'graph-run-latest', nodeId: GRAPH, run }).ok).toBe(false);
  });

  it('carries the sentence a failed run ended with', () => {
    const result = parseHubFrame({
      type: 'graph-run-state',
      nodeId: GRAPH,
      runId: RUN_ID,
      number: 38,
      status: 'failed',
      reason: 'no route on classify matched and it has no otherwise',
      step: 2,
      of: 9,
      steps: [STEP],
    });
    expect(result.ok).toBe(true);
  });

  it('answers a history request with the graph and its runs, bounded', () => {
    const result = parseHubFrame({
      type: 'graph-run-history',
      replyTo: 4,
      nodeId: GRAPH,
      runs: [SUMMARY, { ...SUMMARY, runId: 'run-37', number: 37 }],
    });
    expect(result.ok).toBe(true);
    expect(
      parseHubFrame({ type: 'graph-run-history', replyTo: 4, nodeId: GRAPH, runs: [] }).ok,
    ).toBe(true);
    expect(parseHubFrame({ type: 'graph-run-history', replyTo: 4, runs: [] }).ok).toBe(false);
    const tooMany = Array.from({ length: GRAPH_RUN_HISTORY_MAX + 1 }, (_, index) => ({
      ...SUMMARY,
      runId: `run-${String(index)}`,
      number: index + 1,
    }));
    expect(
      parseHubFrame({ type: 'graph-run-history', replyTo: 4, nodeId: GRAPH, runs: tooMany }).ok,
    ).toBe(false);
  });

  it('carries a SUB-GRAPH step naming its child run on a state', () => {
    const result = parseHubFrame({
      type: 'graph-run-state',
      nodeId: GRAPH,
      runId: RUN_ID,
      number: 38,
      status: 'running',
      reason: null,
      step: 2,
      of: 3,
      steps: [
        STEP,
        {
          nodeId: 'lint',
          attempt: 0,
          outcome: 'running',
          output: null,
          child: { runId: 'run-7', number: 4 },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('answers a cancel with the run it cancelled', () => {
    expect(parseHubFrame({ type: 'graph-run-cancelled', replyTo: 2, runId: RUN_ID }).ok).toBe(true);
  });
});
