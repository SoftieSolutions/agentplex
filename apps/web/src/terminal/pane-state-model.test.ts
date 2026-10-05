import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  type FrameId,
  type MachineState,
  type SessionRow,
} from '@agentplex/protocol';
import {
  followUp,
  NO_ANSWERS,
  rememberAnswer,
  type Answers,
  type Reply,
} from '../store/answers.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { findSessionRow } from './presentation.js';
import {
  capableServers,
  headerTone,
  headerWords,
  paneState,
  resumeCommand,
  type PaneStateInput,
} from './pane-state-model.js';

/**
 * Every row here is one a real hub sent, read through the protocol's own
 * parser: the question this model answers is "what does the pane do with this
 * row", and a hand-written row would answer it about a row no hub produces.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

function replyFrom(text: string, replyTo: FrameId): Reply {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok) throw new Error('the fixture is not a hub frame');
  const frame = { ...parsed.value, replyTo };
  if (frame.type !== 'refusal' && frame.type !== 'session-started') {
    throw new Error('the fixture is not an answer to a start');
  }
  return frame;
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const stale = stateFrom(hubFrames.machineStateStale);
const shared = stateFrom(hubFrames.machineStateShared);
const resumable = stateFrom(hubFrames.machineStateResumable);
const resumed = stateFrom(hubFrames.machineStateResumed);

function rowIn(state: MachineState, storeId: string, sessionId: string): SessionRow {
  const row = findSessionRow(state, sessionRefSchema.parse({ storeId, sessionId }));
  if (row === null) throw new Error(`no ${sessionId} in the fixture`);
  return row;
}

const spikeWasm = rowIn(resumable, 'store-agentplex', 'session-spike-wasm');
const cliRun = rowIn(resumable, 'store-agentplex', 'session-cli-run');
const fixAuth = rowIn(populated, 'store-agentplex', 'session-fix-auth');
const docsSweep = rowIn(populated, 'store-universe', 'session-docs-sweep');
const sharedNotes = rowIn(shared, 'store-shared', 'session-shared-notes');
const staleBench = rowIn(stale, 'store-universe', 'session-bench-tokenizer');

const ASKED = 7 as FrameId;

function answered(text: string): Answers {
  return {
    replies: rememberAnswer(NO_ANSWERS.replies, replyFrom(text, ASKED)),
    outstanding: new Set(),
  };
}

function input(overrides: Partial<PaneStateInput>): PaneStateInput {
  return {
    row: spikeWasm,
    state: resumable,
    start: null,
    terminal: null,
    ran: false,
    startLapsed: false,
    phase: 'connected',
    stateCurrent: true,
    ...overrides,
  };
}

describe('paneState', () => {
  it('is the terminal it always was for a row the state does not hold', () => {
    expect(paneState(input({ row: null })).kind).toBe('unknown-row');
  });

  it('is held whenever a holder is published, whatever else is true', () => {
    // A refusal that this pane is still showing, and a terminal that ended:
    // the holder appearing settles both, which is how an "already being
    // started" refusal from a second pane resolves itself.
    const refused = followUp(ASKED, answered(hubFrames.refusal), 'session-started');
    expect(
      paneState(
        input({
          row: fixAuth,
          state: populated,
          start: refused,
          terminal: { ended: 'session-ended' },
        }),
      ).kind,
    ).toBe('held');
  });

  it('resumes on its own a session nothing runs, on a connected hub', () => {
    expect(paneState(input({}))).toMatchObject({ kind: 'starting', send: true });
  });

  it('waits for the connection before resuming on its own', () => {
    expect(paneState(input({ phase: 'reconnecting' }))).toMatchObject({
      kind: 'starting',
      send: false,
    });
  });

  it('waits for this connection’s own state before resuming on its own', () => {
    // A welcome is answered with the whole current state, but the one held
    // until it lands is the last connection's: nothing to act on.
    const state = paneState(input({ stateCurrent: false }));
    expect(state).toMatchObject({ kind: 'starting', send: false });
    if (state.kind !== 'starting') return;
    expect(state.words).toContain('current state');
  });

  it('goes on starting, sending nothing more, while the start is owed an answer', () => {
    const waiting = followUp(
      ASKED,
      { replies: new Map(), outstanding: new Set([ASKED]) },
      'session-started',
    );
    expect(paneState(input({ start: waiting }))).toMatchObject({ kind: 'starting', send: false });
  });

  it('goes on starting once answered, until the holder is published', () => {
    const yes = followUp(ASKED, answered(hubFrames.sessionStartedResumed), 'session-started');
    const state = paneState(input({ start: yes }));
    expect(state).toMatchObject({ kind: 'starting', send: false });
    if (state.kind !== 'starting') return;
    expect(state.words).toContain('mbp-robert');
    // And the next state frame names the holder, which ends it.
    const row = rowIn(resumed, 'store-agentplex', 'session-spike-wasm');
    expect(paneState(input({ row, state: resumed, start: yes })).kind).toBe('held');
  });

  it('says an answered start lapsed when a later state shows nothing running it', () => {
    const yes = followUp(ASKED, answered(hubFrames.sessionStartedResumed), 'session-started');
    const state = paneState(input({ start: yes, startLapsed: true }));
    expect(state).toMatchObject({ kind: 'lapsed', action: 'try-again' });
    if (state.kind !== 'lapsed') return;
    expect(state.words).toContain('mbp-robert');
    // The holder still beats it: a slow report that names one is the answer.
    const row = rowIn(resumed, 'store-agentplex', 'session-spike-wasm');
    expect(paneState(input({ row, state: resumed, start: yes, startLapsed: true })).kind).toBe(
      'held',
    );
  });

  it('repeats the hub’s own words when the start was refused, with a way to try again', () => {
    const refused = followUp(ASKED, answered(hubFrames.refusal), 'session-started');
    expect(paneState(input({ start: refused }))).toMatchObject({
      kind: 'refused',
      words: 'no server the hub is paired with has that store mounted',
      action: 'try-again',
    });
  });

  it('says a start whose answer will never come was lost, with a way to try again', () => {
    const idle = followUp(ASKED, NO_ANSWERS, 'session-started');
    expect(paneState(input({ start: idle }))).toMatchObject({ kind: 'lost', action: 'try-again' });
  });

  it('is ended when the hub said the session ended, and never resumes on its own', () => {
    expect(paneState(input({ terminal: { ended: 'session-ended' } }))).toMatchObject({
      kind: 'ended',
      action: 'resume',
    });
  });

  it('is ended for a pane that saw the session held and now sees nothing running it', () => {
    // The moment between the holder going and the hub ending the
    // subscription: a pane that read it as a session to resume would restart
    // a session somebody had just stopped.
    expect(paneState(input({ ran: true }))).toMatchObject({ kind: 'ended' });
  });

  it('says a session stopped, and waits for a press, once a pane has seen it run anywhere', () => {
    // Somebody quit their own claude in another terminal: the pane saw it
    // running outside agentplex, and now nothing runs it. That is a session
    // that stopped, not one that was already stopped when the pane opened.
    const state = paneState(input({ ran: true }));
    expect(state).toMatchObject({ kind: 'ended', action: 'resume' });
    if (state.kind !== 'ended') return;
    expect(state.words).toContain('stopped');
  });

  it('does not read a dropped or draining machine as the session ending', () => {
    expect(paneState(input({ row: cliRun, terminal: { ended: 'server-dropped' } })).kind).toBe(
      'outside',
    );
    expect(paneState(input({ terminal: { ended: 'server-draining' } })).kind).toBe('starting');
  });

  it('a pane that asked again shows that start rather than the ending', () => {
    const waiting = followUp(
      ASKED,
      { replies: new Map(), outstanding: new Set([ASKED]) },
      'session-started',
    );
    expect(
      paneState(input({ terminal: { ended: 'session-ended' }, ran: true, start: waiting })).kind,
    ).toBe('starting');
  });

  it('says a session on a machine it cannot reach cannot be acted on, and offers nothing', () => {
    const state = paneState(input({ row: staleBench, state: stale }));
    expect(state).toMatchObject({ kind: 'unreachable', machine: 'gpu-box-01', action: null });
  });

  it('says where a session runs that something outside agentplex is running', () => {
    expect(paneState(input({ row: cliRun }))).toMatchObject({
      kind: 'outside',
      machine: 'mbp-robert',
      action: null,
    });
  });

  it('offers a resume, with the warning, when nothing can say whether it runs', () => {
    const state = paneState(input({ row: sharedNotes, state: shared }));
    expect(state).toMatchObject({ kind: 'cannot-tell', action: 'resume' });
    if (state.kind !== 'cannot-tell') return;
    expect(state.warning).toContain('two processes');
  });

  it('names the provider and each machine’s reason when nothing connected can run it', () => {
    const state = paneState(input({ row: docsSweep, state: populated }));
    expect(state).toMatchObject({ kind: 'unsupported', provider: 'codex', action: null });
    if (state.kind !== 'unsupported') return;
    expect(state.reasons).toEqual([expect.stringMatching(/^gpu-box-01 cannot run codex: /)]);
  });
});

describe('capableServers', () => {
  it('is the connected machines on the store that can start the provider', () => {
    expect(capableServers(populated, docsSweep.descriptor.storeId, 'codex')).toEqual([]);
    expect(
      capableServers(populated, docsSweep.descriptor.storeId, 'claude').map((view) => view.label),
    ).toEqual(['gpu-box-01']);
  });
});

describe('resumeCommand', () => {
  it('names the session and its provider, and leaves the placement to the hub', () => {
    expect(resumeCommand(spikeWasm.descriptor)).toEqual({
      type: 'session-start',
      storeId: 'store-agentplex',
      sessionId: 'session-spike-wasm',
      provider: 'claude',
      prompt: null,
      server: null,
      project: null,
    });
  });
});

describe('the header over a pane', () => {
  it('says not running, quietly, for a row nothing holds and no process runs', () => {
    expect(headerWords(docsSweep)).toBe('not running');
    expect(headerTone(docsSweep)).toBe('idle');
  });

  it('says what the list says for a held row, and for one running outside agentplex', () => {
    expect(headerWords(fixAuth)).toBe('working');
    expect(headerWords(cliRun)).toBe('working');
    expect(headerTone(cliRun)).toBe('running');
  });

  it('says what the list says when there is no row', () => {
    expect(headerWords(null)).toBe('not reported');
  });
});
