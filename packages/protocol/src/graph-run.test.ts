import { describe, expect, it } from 'vitest';
import { parseClientFrame, parseHubFrame } from './client.js';
import {
  GRAPH_RUN_OUTPUT_MAX_CHARS,
  GRAPH_RUN_STEPS_MAX,
  graphRunIdSchema,
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
};
const SESSION_OUTPUT = {
  kind: 'session',
  storeId: 'store-work',
  sessionId: 'session-9',
  status: 'idle',
};

describe('the run vocabulary', () => {
  it('names four run statuses and nothing else', () => {
    expect(runStatusSchema.options).toEqual(['running', 'succeeded', 'failed', 'cancelled']);
    expect(runStatusSchema.safeParse('paused').success).toBe(false);
  });

  it('names what one attempt of one step became', () => {
    expect(stepOutcomeSchema.options).toEqual(['running', 'succeeded', 'failed', 'cancelled']);
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
    expect(parseHubFrame({ type: 'graph-run-none', replyTo: 5, nodeId: GRAPH }).ok).toBe(true);
    expect(parseHubFrame({ type: 'graph-run-none', replyTo: 5 }).ok).toBe(false);
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

  it('answers a cancel with the run it cancelled', () => {
    expect(parseHubFrame({ type: 'graph-run-cancelled', replyTo: 2, runId: RUN_ID }).ok).toBe(true);
  });
});
