import { describe, expect, it } from 'vitest';
import {
  GRAPH_RUN_HISTORY_MAX,
  graphRunIdSchema,
  nodeIdSchema,
  type GraphRunState,
  type GraphRunSummary,
} from '@agentplex/protocol';
import { durationText, historyIsBehind, historyRows } from './run-history-model.js';

/**
 * What the history list reads off the hub's answer: a row per run, newest
 * first as the hub sent it, and whether the list has fallen behind the runs
 * this screen has been told about since it was asked.
 */

const GRAPH = nodeIdSchema.parse('hub-10');
const OTHER = nodeIdSchema.parse('hub-99');
const START = 1_756_000_000_000;

function summary(number: number, over: Partial<GraphRunSummary> = {}): GraphRunSummary {
  return {
    runId: graphRunIdSchema.parse(`run-${String(number)}`),
    number,
    status: 'succeeded',
    startedAt: START,
    endedAt: START + 12_000,
    reason: null,
    ...over,
  };
}

function state(number: number, over: Partial<GraphRunState> = {}): GraphRunState {
  return {
    nodeId: GRAPH,
    runId: graphRunIdSchema.parse(`run-${String(number)}`),
    number,
    status: 'succeeded',
    reason: null,
    step: 1,
    of: 1,
    steps: [],
    ...over,
  };
}

describe('historyRows', () => {
  it('keeps the hub’s order, newest first, and words each run the way the strip does', () => {
    const rows = historyRows(
      [
        summary(3, { status: 'running', endedAt: null }),
        summary(2, { status: 'failed', reason: 'the ROUTER node Classify failed' }),
        summary(1),
      ],
      null,
    );

    expect(rows.map((row) => row.text)).toEqual([
      'run #3 · live',
      'run #2 · failed · 12s',
      'run #1 · succeeded · 12s',
    ]);
    expect(rows.map((row) => row.tone)).toEqual(['running', 'blocked', 'idle']);
    expect(rows[1]?.reason).toBe('the ROUTER node Classify failed');
    expect(rows.every((row) => !row.selected)).toBe(true);
  });

  it('marks the selected run, and only that one', () => {
    const rows = historyRows([summary(2), summary(1)], graphRunIdSchema.parse('run-1'));

    expect(rows.map((row) => row.selected)).toEqual([false, true]);
  });

  it('says a run waiting on a person as waiting, not live', () => {
    expect(historyRows([summary(4, { status: 'waiting', endedAt: null })], null)[0]).toMatchObject({
      text: 'run #4 · waiting on a person',
      tone: 'needs-you',
    });
  });

  it('is empty for a graph never run', () => {
    expect(historyRows([], null)).toEqual([]);
  });
});

describe('durationText', () => {
  it('says seconds, then minutes and seconds, then hours and minutes', () => {
    expect(durationText(START, START + 400)).toBe('0s');
    expect(durationText(START, START + 12_000)).toBe('12s');
    expect(durationText(START, START + 184_000)).toBe('3m 4s');
    expect(durationText(START, START + 3_720_000)).toBe('1h 2m');
  });

  it('says nothing for a run that has not ended, and never a negative span', () => {
    expect(durationText(START, null)).toBeNull();
    expect(durationText(START, START - 5)).toBe('0s');
  });
});

describe('historyIsBehind', () => {
  it('is behind before the hub has answered at all', () => {
    expect(historyIsBehind(null, [], GRAPH)).toBe(true);
  });

  it('is not behind when every run of the graph it has been told about reads the same', () => {
    const history = [summary(2, { status: 'running', endedAt: null }), summary(1)];

    expect(historyIsBehind(history, [state(2, { status: 'running' }), state(1)], GRAPH)).toBe(
      false,
    );
  });

  it('is behind once a listed run has ended since the list was read', () => {
    const history = [summary(2, { status: 'running', endedAt: null }), summary(1)];

    expect(historyIsBehind(history, [state(2, { status: 'failed' })], GRAPH)).toBe(true);
  });

  it('is behind once a run it does not list has started', () => {
    expect(historyIsBehind([summary(1)], [state(2, { status: 'running' })], GRAPH)).toBe(true);
  });

  it('ignores another graph’s runs', () => {
    expect(
      historyIsBehind([summary(1)], [state(7, { nodeId: OTHER, status: 'running' })], GRAPH),
    ).toBe(false);
  });

  it('ignores a run older than a full list reaches, so an old run held is not a reason to ask forever', () => {
    const full = Array.from({ length: GRAPH_RUN_HISTORY_MAX }, (_, index) => summary(100 - index));

    expect(historyIsBehind(full, [state(3)], GRAPH)).toBe(false);
    expect(historyIsBehind(full, [state(101, { status: 'running' })], GRAPH)).toBe(true);
  });
});
