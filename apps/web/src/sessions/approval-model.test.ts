import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  type MachineState,
  type PendingApproval,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { answersOf, replyFrom } from '../store/replies.fixture.js';
import { approvalFollowUp, decideCommand } from './approval-model.js';

/**
 * What the two answers decide, against a state and a reply a real hub
 * produced: the frame a grant or a denial sends, and how the hub's word about
 * the request is joined to the tap that asked for it.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

/** The one session in the captured state that has a request open on it. */
function blocked(state: MachineState): PendingApproval {
  for (const store of state.stores) {
    for (const row of store.sessions) {
      const [approval] = row.approvals;
      if (approval !== undefined) return approval;
    }
  }
  throw new Error('the fixture has no session with a pending approval');
}

/** The one run in the captured state that is waiting on a person. */
function waiting(state: MachineState): PendingApproval {
  const [first] = state.graphRunApprovals;
  if (first === undefined) throw new Error('the fixture has no run waiting on a person');
  return first.approval;
}

const pending = blocked(stateFrom(hubFrames.machineStateApproval));
const parked = waiting(stateFrom(hubFrames.machineStateGraphRunWaiting));

describe('the frame an answer sends', () => {
  it('names the session, the request and one of two words', () => {
    // The id is the server's name for one blocked tool call, read back off the
    // row it arrived on, and the subject goes back as the hub put it there.
    // Nothing of the proposal goes back: a client returning it would be a
    // client choosing what the agent runs.
    expect(decideCommand(pending.subject, pending.approvalId, 'grant')).toEqual({
      type: 'approval-decide',
      subject: {
        kind: 'session',
        storeId: 'store-agentplex',
        sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
      },
      approvalId: 'approval-1',
      decision: 'grant',
    });
  });

  it('denies the same request the same way, by the word and not by a second frame', () => {
    expect(decideCommand(pending.subject, pending.approvalId, 'deny')).toEqual({
      type: 'approval-decide',
      subject: {
        kind: 'session',
        storeId: 'store-agentplex',
        sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
      },
      approvalId: 'approval-1',
      decision: 'deny',
    });
  });

  it('answers a run waiting on a person with the same frame, the run for its subject', () => {
    // The subject is a claim the hub made and the client repeats: which run,
    // which node. The client adds nothing -- not the graph, not the number --
    // because the hub would have to trust whatever it added.
    expect(decideCommand(parked.subject, parked.approvalId, 'grant')).toEqual({
      type: 'approval-decide',
      subject: {
        kind: 'graphRun',
        runId: parked.subject.kind === 'graphRun' ? parked.subject.runId : '',
        nodeId: 'approve',
      },
      approvalId: parked.approvalId,
      decision: 'grant',
    });
    expect(parked.tool).toBe('HUMAN');
  });
});

describe('what the hub has said about the answer', () => {
  // A thin mapping over `followUp`: each of its four answers, renamed.
  const granted = replyFrom(hubFrames.approvalDecided, 'approval-decided');
  const refusal = { ...replyFrom(hubFrames.refusalAttention, 'refusal'), replyTo: 7 };
  const answers = answersOf(granted, refusal);

  it('says nothing while nothing has been sent', () => {
    expect(approvalFollowUp(null, answers)).toEqual({ kind: 'idle' });
  });

  it('waits until an answer to this frame arrives, not until any answer does', () => {
    // Two cards can each be waiting, and each reads the answer to its own frame.
    expect(approvalFollowUp(99, answers)).toEqual({ kind: 'waiting' });
  });

  it('carries the outcome word, because the four endings are drawn differently', () => {
    expect(approvalFollowUp(granted.replyTo, answers)).toEqual({
      kind: 'decided',
      outcome: 'granted',
      answeredBy: null,
    });
    // The three the hub can send in the same frame. `withdrawn` and `expired`
    // are the endings where somebody answered and nothing happened, and
    // reporting either as a denial would be the one dishonest thing here.
    for (const outcome of ['denied', 'withdrawn', 'expired'] as const) {
      const other = answersOf({ ...granted, replyTo: 4, outcome });
      expect(approvalFollowUp(4, other)).toEqual({ kind: 'decided', outcome, answeredBy: null });
    }
  });

  it("carries the hub's own words when it says no", () => {
    expect(approvalFollowUp(refusal.replyTo, answers)).toEqual({
      kind: 'refused',
      words: 'this hub knows no session by that id',
    });
  });
});
