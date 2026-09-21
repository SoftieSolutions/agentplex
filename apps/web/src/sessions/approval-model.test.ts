import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  type MachineState,
  type PendingApproval,
  type SessionRef,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { ApprovalView, RefusalView } from '../store/hub-store.js';
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

function approvalFrom(text: string): ApprovalView {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'approval-decided') {
    throw new Error('the fixture is not an approval-decided frame');
  }
  return {
    replyTo: parsed.value.replyTo,
    outcome: parsed.value.outcome,
    answeredBy: parsed.value.answeredBy,
  };
}

/** The one session in the captured state that has a request open on it. */
function blocked(state: MachineState): { ref: SessionRef; approval: PendingApproval } {
  for (const store of state.stores) {
    for (const row of store.sessions) {
      const [approval] = row.approvals;
      if (approval !== undefined) {
        const { storeId, sessionId } = row.descriptor;
        return { ref: { storeId, sessionId }, approval };
      }
    }
  }
  throw new Error('the fixture has no session with a pending approval');
}

const pending = blocked(stateFrom(hubFrames.machineStateApproval));

describe('the frame an answer sends', () => {
  it('names the session, the request and one of two words', () => {
    // The id is the server's name for one blocked tool call, read back off the
    // row it arrived on. Nothing of the proposal goes back: a client returning
    // it would be a client choosing what the agent runs.
    expect(decideCommand(pending.ref, pending.approval.approvalId, 'grant')).toEqual({
      type: 'approval-decide',
      storeId: 'store-agentplex',
      sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
      approvalId: 'approval-1',
      decision: 'grant',
    });
  });

  it('denies the same request the same way, by the word and not by a second frame', () => {
    expect(decideCommand(pending.ref, pending.approval.approvalId, 'deny')).toEqual({
      type: 'approval-decide',
      storeId: 'store-agentplex',
      sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
      approvalId: 'approval-1',
      decision: 'deny',
    });
  });
});

describe('what the hub has said about the answer', () => {
  const granted = approvalFrom(hubFrames.approvalDecided);
  const refusal: RefusalView = {
    replyTo: 7,
    code: 'refused',
    message: 'this hub knows no session by that id',
    holder: null,
  };

  it('says nothing while nothing has been sent', () => {
    expect(approvalFollowUp(null, granted, null)).toEqual({ kind: 'idle' });
  });

  it('waits until an answer to this frame arrives, not until any answer does', () => {
    // One snapshot holds one reply for the whole page. Two cards can each be
    // waiting, and a card reading the newest of either would draw the other
    // one's outcome under its own buttons.
    expect(approvalFollowUp(99, granted, refusal)).toEqual({ kind: 'waiting' });
  });

  it('carries the outcome word, because the four endings are drawn differently', () => {
    expect(approvalFollowUp(granted.replyTo, granted, null)).toEqual({
      kind: 'decided',
      outcome: 'granted',
    });
    // The three the hub can send in the same slot. `withdrawn` and `expired`
    // are the endings where somebody answered and nothing happened, and
    // reporting either as a denial would be the one dishonest thing here.
    for (const outcome of ['denied', 'withdrawn', 'expired'] as const) {
      expect(approvalFollowUp(4, { replyTo: 4, outcome, answeredBy: null }, null)).toEqual({
        kind: 'decided',
        outcome,
      });
    }
  });

  it("carries the hub's own words when it says no", () => {
    expect(approvalFollowUp(refusal.replyTo, granted, refusal)).toEqual({
      kind: 'refused',
      words: 'this hub knows no session by that id',
    });
  });
});
