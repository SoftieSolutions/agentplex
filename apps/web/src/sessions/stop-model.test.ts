import { describe, expect, it } from 'vitest';
import {
  frameIdSchema,
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  type MachineState,
  type SessionHolder,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { RefusalView, StoppedView } from '../store/hub-store.js';
import { offersStop, stopCommand, stopFollowUp, stoppedNotice } from './stop-model.js';

/**
 * The stop rules against captured hub output: the two holders a real fleet
 * published, the refusals a real hub answered two real stops with, and the
 * reply it sent when one landed.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

function refusalFrom(text: string): RefusalView {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'refusal') {
    throw new Error('the fixture is not a refusal frame');
  }
  const frame = parsed.value;
  return {
    replyTo: frame.replyTo,
    code: frame.code,
    message: frame.message,
    holder: frame.holder,
  };
}

function stoppedFrom(text: string): StoppedView {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'session-stopped') {
    throw new Error('the fixture is not a session-stopped frame');
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
const stopped = stoppedFrom(hubFrames.sessionStopped);
const busy = refusalFrom(hubFrames.refusalHeldBusy);
const heldElsewhere = refusalFrom(hubFrames.refusalHeldStoppable);

/** The holder a captured state published for one session, by id. */
function holderOf(state: MachineState, sessionId: string): SessionHolder | null {
  for (const store of state.stores) {
    for (const row of store.sessions) {
      if (row.descriptor.sessionId === sessionId) return row.holder;
    }
  }
  throw new Error(`the fixture describes no session ${sessionId}`);
}

describe('who gets a stop button', () => {
  it('offers one where the hub published a stoppable holder', () => {
    // Held, and the server says it can be interrupted: awaiting a permission
    // answer with nothing half-applied behind it.
    expect(offersStop(holderOf(populated, 'session-migrate-db'))).toBe(true);
  });

  it('offers none for a busy holder, however loud its status is', () => {
    const holder = holderOf(populated, 'session-fix-auth');
    // The status would say "working", and a button derived from a status would
    // be drawn right here. The published fact says otherwise.
    expect(holder?.stoppable).toBe(false);
    expect(offersStop(holder)).toBe(false);
  });

  it('offers none where nobody is running the session', () => {
    expect(holderOf(populated, 'session-spike-wasm')).toBeNull();
    expect(offersStop(null)).toBe(false);
  });

  it('offers none to a session that wants a human but is held by nobody', () => {
    // The inverse of the busy case, and the other reason a status cannot
    // decide this: awaiting input is the loudest thing a row can say, and
    // there is no process here for a stop to reach.
    expect(holderOf(populated, 'session-docs-sweep')).toBeNull();
  });
});

describe('the stop command', () => {
  it('addresses the session and names no machine, terminal or process', () => {
    const ref = sessionRefSchema.parse({
      storeId: 'store-agentplex',
      sessionId: 'session-migrate-db',
    });
    expect(stopCommand(ref)).toEqual({
      type: 'session-stop',
      storeId: 'store-agentplex',
      sessionId: 'session-migrate-db',
    });
  });
});

describe('what the hub said about the stop this screen asked for', () => {
  const pending = stopped.replyTo;

  it('says nothing at all until one has been asked for', () => {
    expect(stopFollowUp(null, stopped, busy)).toEqual({ kind: 'idle' });
  });

  it('waits while nothing has answered it', () => {
    expect(stopFollowUp(pending, null, null)).toEqual({ kind: 'waiting' });
  });

  it("ignores an answer to somebody else's command", () => {
    const other = frameIdSchema.parse(99);
    expect(stopFollowUp(other, stopped, busy)).toEqual({ kind: 'waiting' });
  });

  it('ends the wait when the stop lands', () => {
    expect(stopFollowUp(pending, stopped, null)).toEqual({ kind: 'stopped' });
  });

  it("ends the wait on a refusal, in the hub's own words", () => {
    expect(stopFollowUp(busy.replyTo, null, busy)).toEqual({
      kind: 'refused',
      words: 'that session is mid-turn; stopping it now could leave an edit half applied',
    });
  });

  it('a refusal that names a holder still carries one for the screen to draw', () => {
    // Not this function's output -- it says what happened to this stop -- but
    // the field the new-session form reads off the same snapshot.
    expect(heldElsewhere.holder).toEqual({
      server: 'registration-mbp-robert',
      stoppable: true,
      pause: 'none',
    });
  });
});

describe('the notice a landed stop leaves on the list', () => {
  it('names the session and the machine the reply resolved it to', () => {
    expect(stoppedNotice(populated, stopped)).toBe('stopped migrate-db-v9 on mbp-robert');
  });

  it('says nothing while no stop has landed', () => {
    expect(stoppedNotice(populated, null)).toBeNull();
  });

  it('falls back to the ids when the state no longer describes either', () => {
    // A stop is a thing that happened; a state that has since dropped the row
    // -- an unreachable machine, a revoked pairing -- does not unhappen it.
    const empty = stateFrom(hubFrames.machineState);
    expect(stoppedNotice(empty, stopped)).toBe(
      'stopped session-migrate-db on registration-mbp-robert',
    );
  });

  it('says it from the payload alone before any state has arrived', () => {
    expect(stoppedNotice(null, stopped)).toBe(
      'stopped session-migrate-db on registration-mbp-robert',
    );
  });
});
