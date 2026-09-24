import { describe, expect, it } from 'vitest';
import {
  graphNodeIdSchema,
  parseHubFrame,
  parseTextFrame,
  sessionIdSchema,
  storeIdSchema,
  type GraphRunState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { lastOutputFor, lastOutputText, runningNode, runStripText, runTone } from './run-model.js';

/**
 * What the screen reads off a run, against the states a real hub sent: a
 * run parked at its AGENT step, the same run cancelled, a run that failed
 * at its ROUTER, and one that ran to the end.
 */

function state(text: string): GraphRunState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'graph-run-state') {
    throw new Error('the captured frame is not a run state');
  }
  const { type: _type, ...run } = parsed.value;
  return run;
}

const id = (text: string) => graphNodeIdSchema.parse(text);

describe('runStripText', () => {
  it('reads `run #N · live · step S/OF` for a run in flight', () => {
    expect(runStripText(state(hubFrames.graphRunStateRunning))).toBe('run #1 · live · step 3/3');
  });

  it('names how a run ended', () => {
    expect(runStripText(state(hubFrames.graphRunStateCancelled))).toBe(
      'run #1 · cancelled · step 3/3',
    );
    expect(runStripText(state(hubFrames.graphRunStateFailed))).toBe('run #2 · failed · step 2/3');
    expect(runStripText(state(hubFrames.graphRunStateSucceeded))).toBe(
      'run #1 · succeeded · step 1/1',
    );
  });

  it('reads a stale run as reconnecting rather than live, and an ended one as it ended', () => {
    expect(runStripText(state(hubFrames.graphRunStateRunning), true)).toBe(
      'run #1 · reconnecting · step 3/3',
    );
    expect(runStripText(state(hubFrames.graphRunStateFailed), true)).toBe(
      'run #2 · failed · step 2/3',
    );
  });

  it('reads the mock’s example when given its numbers', () => {
    const mock: GraphRunState = {
      ...state(hubFrames.graphRunStateRunning),
      number: 38,
      step: 3,
      of: 9,
    };
    expect(runStripText(mock)).toBe('run #38 · live · step 3/9');
  });
});

describe('runTone', () => {
  it('draws a run in flight as running, a failed one as blocked, and the rest at rest', () => {
    expect(runTone('running')).toBe('running');
    expect(runTone('failed')).toBe('blocked');
    expect(runTone('succeeded')).toBe('idle');
    expect(runTone('cancelled')).toBe('idle');
  });

  it('draws a stale run at rest: nothing here can vouch that it is still running', () => {
    expect(runTone('running', true)).toBe('idle');
    expect(runTone('failed', true)).toBe('blocked');
  });
});

describe('runningNode', () => {
  it('names the node whose step is in flight', () => {
    expect(runningNode(state(hubFrames.graphRunStateRunning))).toBe('review');
  });

  it('names nothing for a stale run', () => {
    expect(runningNode(state(hubFrames.graphRunStateRunning), true)).toBeNull();
  });

  it('names nothing for a run that has ended, or no run', () => {
    expect(runningNode(state(hubFrames.graphRunStateCancelled))).toBeNull();
    expect(runningNode(state(hubFrames.graphRunStateFailed))).toBeNull();
    expect(runningNode(null)).toBeNull();
  });
});

describe('lastOutputFor', () => {
  it('finds the node’s last step in the run, with the run number', () => {
    expect(lastOutputFor(state(hubFrames.graphRunStateRunning), id('classify'))).toEqual({
      number: 1,
      step: {
        nodeId: 'classify',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'route', route: 0, to: 'review' },
      },
    });
  });

  it('answers null for a node the run never reached, and for no run', () => {
    expect(lastOutputFor(state(hubFrames.graphRunStateFailed), id('review'))).toBeNull();
    expect(lastOutputFor(null, id('start'))).toBeNull();
  });

  it('prefers the latest attempt when a node was retried', () => {
    const retried: GraphRunState = {
      ...state(hubFrames.graphRunStateRunning),
      steps: [
        { nodeId: id('review'), attempt: 0, outcome: 'failed', output: null },
        {
          nodeId: id('review'),
          attempt: 1,
          outcome: 'succeeded',
          output: {
            kind: 'session',
            storeId: storeIdSchema.parse('store-work'),
            sessionId: sessionIdSchema.parse('session-9'),
            status: 'idle',
          },
        },
      ],
    };
    expect(lastOutputFor(retried, id('review'))?.step.attempt).toBe(1);
  });
});

describe('lastOutputText', () => {
  it('is the trigger’s text as the hub cut it, or the outcome when there is no output', () => {
    const last = lastOutputFor(state(hubFrames.graphRunStateSucceeded), id('start'));
    if (last === null) throw new Error('the trigger has no step');
    expect(lastOutputText(last)).toBe('{"suite":"nightly","language":"rust"}');

    const failed = lastOutputFor(state(hubFrames.graphRunStateFailed), id('classify'));
    if (failed === null) throw new Error('the router has no step');
    expect(lastOutputText(failed)).toBe('failed');
  });

  it('reads a router’s choice and an agent’s session in words', () => {
    const routed = lastOutputFor(state(hubFrames.graphRunStateRunning), id('classify'));
    if (routed === null) throw new Error('the router has no step');
    expect(lastOutputText(routed)).toBe('route 1 to review');

    const number = 1;
    expect(
      lastOutputText({
        number,
        step: {
          nodeId: id('classify'),
          attempt: 0,
          outcome: 'succeeded',
          output: { kind: 'route', route: null, to: id('docs') },
        },
      }),
    ).toBe('otherwise to docs');
    expect(
      lastOutputText({
        number,
        step: {
          nodeId: id('review'),
          attempt: 0,
          outcome: 'succeeded',
          output: {
            kind: 'session',
            storeId: storeIdSchema.parse('store-work'),
            sessionId: sessionIdSchema.parse('session-9'),
            status: 'awaiting-input',
          },
        },
      }),
    ).toBe('session session-9 · awaiting-input');
  });
});
