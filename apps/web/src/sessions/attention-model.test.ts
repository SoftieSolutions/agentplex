import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { AttentionView, RefusalView } from '../store/hub-store.js';
import {
  acknowledgeCommand,
  attentionFollowUp,
  muteCommand,
  offersAcknowledge,
} from './attention-model.js';
import { listSessions, type SessionListItem } from './session-list-model.js';

/**
 * What the two controls decide, against states and replies a real hub
 * produced: the frames they send, when they are offered at all, and how an
 * answer is joined to the click that asked for it.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

function attentionFrom(text: string): AttentionView {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'session-attention') {
    throw new Error('the fixture is not a session-attention frame');
  }
  const { replyTo, storeId, sessionId, acknowledgedAt, mutedAt } = parsed.value;
  return { replyTo, storeId, sessionId, acknowledgedAt, mutedAt };
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const attended = stateFrom(hubFrames.machineStateAttended);

function item(state: MachineState, name: string): SessionListItem {
  const found = listSessions(state).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the fixture has no session called ${name}`);
  return found;
}

describe('the frames the controls send', () => {
  it('acknowledges by naming the session and nothing else', () => {
    // No moment on it, deliberately: the hub stamps one, because the stamp is
    // compared against a moment a provider wrote on a third machine.
    expect(acknowledgeCommand(item(populated, 'migrate-db-v9'))).toEqual({
      type: 'session-acknowledge',
      storeId: 'store-agentplex',
      sessionId: 'session-migrate-db',
    });
  });

  it('mutes by saying which state it wants, never by toggling', () => {
    const muted = item(attended, 'docs-sweep');
    expect(muted.muted).toBe(true);
    // The button on an already-muted row asks for the opposite state by name.
    // A toggle would be a decision made against whatever this tab last drew,
    // and two tabs can have drawn different things.
    expect(muteCommand(muted, !muted.muted)).toEqual({
      type: 'session-mute',
      storeId: 'store-universe',
      sessionId: 'session-docs-sweep',
      muted: false,
    });
  });
});

describe('when acknowledging is offered', () => {
  it('is offered on an unacknowledged prompt', () => {
    expect(offersAcknowledge(item(populated, 'migrate-db-v9'))).toBe(true);
  });

  it('is not offered again once the prompt has been seen', () => {
    expect(offersAcknowledge(item(attended, 'migrate-db-v9'))).toBe(false);
  });

  it('is not offered on a session nobody is waiting for', () => {
    // A button here would acknowledge a prompt that does not exist.
    expect(offersAcknowledge(item(populated, 'fix-auth-refresh'))).toBe(false);
    expect(offersAcknowledge(item(populated, 'spike-wasm'))).toBe(false);
  });

  it('is still offered on a muted prompt: mute is not the same as seen', () => {
    expect(offersAcknowledge(item(attended, 'docs-sweep'))).toBe(true);
  });
});

describe('what the hub has said about the click', () => {
  const acknowledged = attentionFrom(hubFrames.sessionAcknowledged);
  const refusal: RefusalView = {
    replyTo: 7,
    code: 'refused',
    message: 'this hub knows no session by that id',
    holder: null,
  };

  it('says nothing while nothing has been sent', () => {
    expect(attentionFollowUp(null, acknowledged, null)).toEqual({ kind: 'idle' });
  });

  it('waits until an answer to this frame arrives, not until any answer does', () => {
    // The snapshot holds one reply for the whole page. A card that read the
    // newest of either would show another card's answer beside its own button.
    expect(attentionFollowUp(99, acknowledged, refusal)).toEqual({ kind: 'waiting' });
  });

  it('is done when the hub answers the frame that was sent', () => {
    expect(attentionFollowUp(acknowledged.replyTo, acknowledged, null)).toEqual({ kind: 'done' });
  });

  it("carries the hub's own words when it says no", () => {
    expect(attentionFollowUp(refusal.replyTo, acknowledged, refusal)).toEqual({
      kind: 'refused',
      words: 'this hub knows no session by that id',
    });
  });
});
