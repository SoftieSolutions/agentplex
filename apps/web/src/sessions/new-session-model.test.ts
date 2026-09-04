import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  storeIdSchema,
  type MachineState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { RefusalView, StartedView } from '../store/hub-store.js';
import {
  buildStart,
  deliveryWords,
  parsePrompt,
  serverOverrideChoices,
  sessionPaneHash,
  startFollowUp,
  startableStores,
  submitBlockedReason,
} from './new-session-model.js';

/**
 * The flow's rules against captured hub output. Every machine state here was
 * assembled by a real hub from real store reports (hub-frames.fixture.ts), and
 * the start reply is the one a real hub sent back to a real session-start.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

/** The captured session-started reply, as the store would put it in a snapshot. */
function startedFrom(text: string): StartedView {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'session-started') {
    throw new Error('the fixture is not a session-started frame');
  }
  const frame = parsed.value;
  return {
    replyTo: frame.replyTo,
    storeId: frame.storeId,
    sessionId: frame.sessionId,
    server: frame.server,
  };
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const single = stateFrom(hubFrames.machineStateSingle);
const empty = stateFrom(hubFrames.machineState);
const shared = stateFrom(hubFrames.machineStateShared);
const sharedDegraded = stateFrom(hubFrames.machineStateSharedDegraded);

const AGENTPLEX = storeIdSchema.parse('store-agentplex');
const SHARED = storeIdSchema.parse('store-shared');

describe('store picker', () => {
  it('offers every store the hub reports, in hub order', () => {
    expect(startableStores(populated)).toEqual(['store-agentplex', 'store-universe']);
  });

  it('offers the one store there is: the form names it in words instead of a picker', () => {
    expect(startableStores(single)).toEqual(['store-agentplex']);
  });

  it('offers nothing when no server reports a store', () => {
    expect(startableStores(empty)).toEqual([]);
  });
});

describe('server override', () => {
  it('is not drawn when one machine has the store: there is no decision to override', () => {
    expect(serverOverrideChoices(populated, AGENTPLEX)).toEqual([]);
  });

  it('is drawn when two connected machines share the volume, worded by label', () => {
    expect(serverOverrideChoices(shared, SHARED)).toEqual([
      { id: 'registration-gpu-box-01', label: 'gpu-box-01' },
      { id: 'registration-mbp-robert', label: 'mbp-robert' },
    ]);
  });

  it('is not drawn when the shared volume degrades to one reachable machine', () => {
    expect(serverOverrideChoices(sharedDegraded, SHARED)).toEqual([]);
  });

  it('is not drawn before a store is chosen', () => {
    expect(serverOverrideChoices(shared, null)).toEqual([]);
  });
});

describe('the frame', () => {
  it('builds a session-start the protocol parser accepts, exactly as typed', () => {
    const command = buildStart(AGENTPLEX, null, '  fix the auth refresh loop  ');
    const parsed = parseClientFrame({ ...command, id: 7 });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value).toEqual({
      type: 'session-start',
      id: 7,
      storeId: 'store-agentplex',
      sessionId: null,
      provider: 'claude',
      prompt: 'fix the auth refresh loop',
      server: null,
    });
  });

  it('carries the override when one was picked', () => {
    const [gpu] = serverOverrideChoices(shared, SHARED);
    if (gpu === undefined) throw new Error('the shared fixture offers no override');
    const command = buildStart(SHARED, gpu.id, '');
    expect(command.type === 'session-start' && command.server).toBe('registration-gpu-box-01');
  });

  it('a whitespace prompt is the absence of a prompt: the wire refuses an empty string', () => {
    expect(parsePrompt('   ')).toBeNull();
    const parsed = parseClientFrame({ ...buildStart(AGENTPLEX, null, '   '), id: 1 });
    expect(parsed.ok && parsed.value.type === 'session-start' && parsed.value.prompt).toBeNull();
  });
});

describe('submit', () => {
  it('is blocked while disconnected, with the phase in words', () => {
    expect(submitBlockedReason('reconnecting', [AGENTPLEX], AGENTPLEX)).toBe(
      'the connection to the hub is down; reconnecting',
    );
    expect(submitBlockedReason('connecting', [AGENTPLEX], AGENTPLEX)).toBe(
      'still connecting to the hub',
    );
    expect(submitBlockedReason('failed', [AGENTPLEX], AGENTPLEX)).toBe(
      'the connection has failed and is not retrying',
    );
  });

  it('is blocked with no store, and while none of several is chosen', () => {
    expect(submitBlockedReason('connected', [], null)).toBe(
      'no paired server reports a store to start in',
    );
    expect(submitBlockedReason('connected', startableStores(populated), null)).toBe(
      'choose a store to start in',
    );
  });

  it('is allowed with a connection and a store', () => {
    expect(submitBlockedReason('connected', [AGENTPLEX], AGENTPLEX)).toBeNull();
  });

  it('a queued delivery is said in words; a sent one needs none', () => {
    expect(deliveryWords('queued')).toBe(
      'the connection is down; the start is queued and will be sent when it returns',
    );
    expect(deliveryWords('sent')).toBeNull();
  });
});

describe('the follow-up to a start', () => {
  const started = startedFrom(hubFrames.sessionStarted);

  it('waits while no answer names the command', () => {
    expect(startFollowUp(started.replyTo, null, null, single)).toEqual({ kind: 'waiting' });
  });

  it("ignores an answer to somebody else's command", () => {
    const other = frameIdSchema.parse(99);
    expect(startFollowUp(other, started, null, single)).toEqual({ kind: 'waiting' });
  });

  it('a fresh spawn is said in words, naming the machine the hub picked', () => {
    // The captured reply's sessionId is null: the provider has not written an
    // id yet, so there is no pane address to navigate to -- inventing one would
    // give a page that never matches the id the provider mints.
    expect(started.sessionId).toBeNull();
    expect(startFollowUp(started.replyTo, started, null, single)).toEqual({
      kind: 'started',
      words:
        'started on mbp-robert; the session appears in the list once the provider writes its first turn',
    });
  });

  it('navigates immediately when the reply names the session', () => {
    const resumed: StartedView = {
      ...started,
      sessionId: single.stores[0]?.sessions[0]?.descriptor.sessionId ?? null,
    };
    expect(startFollowUp(started.replyTo, resumed, null, single)).toEqual({
      kind: 'navigate',
      hash: '#/session/store-agentplex/session-fix-auth',
    });
  });

  it("a refusal surfaces the hub's own words", () => {
    const parsed = parseTextFrame(parseHubFrame, hubFrames.refusal);
    if (!parsed.ok || parsed.value.type !== 'refusal') throw new Error('not a refusal fixture');
    const refusal: RefusalView = {
      replyTo: parsed.value.replyTo,
      code: parsed.value.code,
      message: parsed.value.message,
      holder: parsed.value.holder,
    };
    expect(startFollowUp(refusal.replyTo, null, refusal, single)).toEqual({
      kind: 'refused',
      words: 'no server the hub is paired with has that store mounted',
    });
  });
});

describe('the pane address', () => {
  it('percent-escapes each segment: an opaque id may contain any separator', () => {
    const sessionId = single.stores[0]?.sessions[0]?.descriptor.sessionId;
    if (sessionId === undefined) throw new Error('the single fixture has no session');
    expect(sessionPaneHash({ storeId: storeIdSchema.parse('store/one'), sessionId })).toBe(
      '#/session/store%2Fone/session-fix-auth',
    );
  });
});
