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
  resumeFollowUp,
  retakeCommand,
  retakeFollowUp,
  retakeOutstanding,
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
const retakeable = stateFrom(hubFrames.machineStateRetakeable);
const retaken = stateFrom(hubFrames.machineStateRetaken);
const outsideQuit = stateFrom(hubFrames.machineStateOutsideQuit);

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
/** Nothing runs it, by the last word of a machine now out of reach. */
const staleLora = rowIn(stale, 'store-universe', 'session-train-lora');
/** Run outside agentplex at its prompt, rather than working as `cliRun` is. */
const cliAtPrompt = rowIn(retakeable, 'store-agentplex', 'session-cli-run');
const cliRetaken = rowIn(retaken, 'store-agentplex', 'session-cli-run');
/** The same session once the claude outside agentplex quit, and nothing runs it. */
const cliQuit = rowIn(outsideQuit, 'store-agentplex', 'session-cli-run');

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
    retake: null,
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

  it('lets the row decide what a lapsed start offers once it says anything but none', () => {
    // A resume that exited before it was held, and then somebody ran the
    // session in their own terminal: trying the resume again would put a
    // second process on its transcript, so what runs it now is what is said.
    const yes = followUp(ASKED, answered(hubFrames.sessionStartedResumed), 'session-started');
    const lapsed = { start: yes, startLapsed: true };
    expect(paneState(input({ ...lapsed, row: cliAtPrompt, state: retakeable }))).toMatchObject({
      kind: 'outside',
      action: null,
      retake: { kind: 'available' },
    });
    expect(paneState(input({ ...lapsed, row: cliRun }))).toMatchObject({
      kind: 'outside',
      retake: { kind: 'working-elsewhere' },
    });
    expect(paneState(input({ ...lapsed, row: sharedNotes, state: shared }))).toMatchObject({
      kind: 'cannot-tell',
      action: 'resume',
      warning: expect.stringContaining('two processes') as string,
    });
    expect(paneState(input({ ...lapsed, row: staleBench, state: stale }))).toMatchObject({
      kind: 'unreachable',
      machine: 'gpu-box-01',
      action: null,
    });
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

  it('offers the retake, not Try again, once a refused or lost start meets an outside claude', () => {
    // A refusal such as "that session is running outside agentplex on this
    // machine", or a start no answer will come for, then a state that reads
    // the session running unheld: Try again is a resume over that process.
    const refused = followUp(ASKED, answered(hubFrames.refusal), 'session-started');
    const idle = followUp(ASKED, NO_ANSWERS, 'session-started');
    for (const start of [refused, idle]) {
      expect(paneState(input({ start, row: cliAtPrompt, state: retakeable }))).toMatchObject({
        kind: 'outside',
        action: null,
        retake: { kind: 'available' },
      });
      expect(paneState(input({ start, row: cliRun }))).toMatchObject({
        kind: 'outside',
        retake: { kind: 'working-elsewhere' },
      });
    }
  });

  it('keeps a start still in flight over a row that reads running', () => {
    // The start this pane sent has not come to anything yet: what it becomes
    // is owed to the person who pressed, not the row's word from before it.
    const waiting = followUp(
      ASKED,
      { replies: new Map(), outstanding: new Set([ASKED]) },
      'session-started',
    );
    const yes = followUp(ASKED, answered(hubFrames.sessionStartedResumed), 'session-started');
    for (const start of [waiting, yes]) {
      expect(paneState(input({ start, row: cliAtPrompt, state: retakeable }))).toMatchObject({
        kind: 'starting',
        send: false,
        action: null,
      });
    }
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

  it('offers the retake, not Resume, when a claude outside agentplex runs a session that ended', () => {
    // The pane watched a held session end, and then somebody ran
    // `claude --resume` in their own terminal: the ending is history, and
    // Resume over that process would put a second one on its transcript.
    const ended = { terminal: { ended: 'session-ended' as const }, ran: true };
    expect(paneState(input({ ...ended, row: cliAtPrompt, state: retakeable }))).toMatchObject({
      kind: 'outside',
      action: null,
      retake: { kind: 'available' },
    });
    expect(paneState(input({ ...ended, row: cliRun }))).toMatchObject({
      kind: 'outside',
      retake: { kind: 'working-elsewhere' },
    });
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
    expect(state).toMatchObject({
      kind: 'unreachable',
      machine: 'gpu-box-01',
      action: null,
      refusal: null,
    });
  });

  describe('a machine out of reach offers nothing, whatever this pane’s last start came to', () => {
    // staleBench was last reported running and unheld by a machine now out of
    // reach: whatever runs it there may still run it, and a start routed to
    // another machine on a shared store cannot see that process.
    const unreachableBench = {
      kind: 'unreachable',
      machine: 'gpu-box-01',
      action: null,
    } as const;
    const refusedStart = followUp(ASKED, answered(hubFrames.refusal), 'session-started');
    const refusedRetake = followUp(ASKED, answered(hubFrames.refusalRetake), 'session-started');
    const idle = followUp(ASKED, NO_ANSWERS, 'session-started');

    it('keeps a refused start’s words, without Try again', () => {
      expect(paneState(input({ start: refusedStart, row: staleBench, state: stale }))).toEqual({
        ...unreachableBench,
        words: expect.stringContaining('cannot be reached') as string,
        refusal: {
          of: 'resume',
          words: 'no server the hub is paired with has that store mounted',
        },
      });
    });

    it('offers no Try again for a lost start', () => {
      expect(paneState(input({ start: idle, row: staleBench, state: stale }))).toMatchObject({
        ...unreachableBench,
        refusal: null,
      });
    });

    it('offers no Resume for a terminal that ended, or a session it saw run', () => {
      for (const overrides of [{ terminal: { ended: 'session-ended' as const } }, { ran: true }]) {
        for (const row of [staleBench, staleLora]) {
          expect(paneState(input({ ...overrides, row, state: stale }))).toMatchObject({
            ...unreachableBench,
            refusal: null,
          });
        }
      }
    });

    it('keeps a refused retake’s words, without Resume', () => {
      for (const terminal of [null, { ended: 'session-ended' as const }]) {
        expect(
          paneState(input({ retake: refusedRetake, terminal, row: staleBench, state: stale })),
        ).toMatchObject({
          ...unreachableBench,
          refusal: {
            of: 'retake',
            words:
              'nothing is running that session, so there is nothing to retake; resume it instead',
          },
        });
      }
    });

    it('offers no Resume for a lost retake over a terminal that ended', () => {
      expect(
        paneState(
          input({
            retake: idle,
            terminal: { ended: 'session-ended' },
            row: staleBench,
            state: stale,
          }),
        ),
      ).toMatchObject({ ...unreachableBench, refusal: null });
    });
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

describe('taking over a session run outside agentplex', () => {
  const asked = followUp(
    ASKED,
    { replies: new Map(), outstanding: new Set([ASKED]) },
    'session-started',
  );

  it('offers the retake, disabled with the reason, while the outside claude works', () => {
    const state = paneState(input({ row: cliRun }));
    expect(state).toMatchObject({ kind: 'outside', retake: { kind: 'working-elsewhere' } });
    if (state.kind !== 'outside' || state.retake.kind !== 'working-elsewhere') return;
    expect(state.retake.words).toContain('working');
    expect(state.retakeLabel).toBe('Stop the claude on mbp-robert and run this session here');
  });

  it('offers it, pressable, for any status but working', () => {
    expect(paneState(input({ row: cliAtPrompt, state: retakeable }))).toMatchObject({
      kind: 'outside',
      machine: 'mbp-robert',
      retake: { kind: 'available' },
      retakeLabel: 'Stop the claude on mbp-robert and run this session here',
    });
  });

  it('says it is retaking while the retake is owed an answer, then is held once it is', () => {
    const state = paneState(input({ row: cliAtPrompt, state: retakeable, retake: asked }));
    expect(state).toMatchObject({ kind: 'outside', retake: { kind: 'retaking' } });
    if (state.kind !== 'outside') return;
    expect(state.retakeLabel).toBe('stopping it, then starting here');

    // The machine reports the hold before it answers, and either way round
    // the holder is what ends it.
    const yes = followUp(ASKED, answered(hubFrames.sessionStartedRetaken), 'session-started');
    expect(paneState(input({ row: cliRetaken, state: retaken, retake: asked })).kind).toBe('held');
    expect(paneState(input({ row: cliRetaken, state: retaken, retake: yes })).kind).toBe('held');
  });

  it('waits for the hold once answered', () => {
    const yes = followUp(ASKED, answered(hubFrames.sessionStartedRetaken), 'session-started');
    const waiting = paneState(input({ row: cliAtPrompt, state: retakeable, retake: yes }));
    expect(waiting).toMatchObject({ kind: 'starting', send: false });
    if (waiting.kind !== 'starting') return;
    expect(waiting.words).toContain('mbp-robert');
  });

  describe('once the retake lapsed, what the row says decides', () => {
    // The claude the retake started exited before its machine reported it
    // held. A lapse says nothing about what runs the session now, and the
    // try-again a resume's lapse offers is a resume: over a process somebody
    // started since, that is a second claude on one transcript.
    const yes = followUp(ASKED, answered(hubFrames.sessionStartedRetaken), 'session-started');
    const lapsed = { retake: yes, startLapsed: true, ran: true };

    it('offers the retake again when a claude outside agentplex runs it again', () => {
      expect(paneState(input({ ...lapsed, row: cliAtPrompt, state: retakeable }))).toMatchObject({
        kind: 'outside',
        action: null,
        retake: { kind: 'available' },
        retakeLabel: 'Stop the claude on mbp-robert and run this session here',
      });
      expect(paneState(input({ ...lapsed, row: cliRun }))).toMatchObject({
        kind: 'outside',
        retake: { kind: 'working-elsewhere' },
      });
    });

    it('says it stopped, with Resume, when nothing runs it', () => {
      const state = paneState(input({ ...lapsed, row: cliQuit, state: outsideQuit }));
      expect(state).toMatchObject({ kind: 'ended', action: 'resume' });
      if (state.kind !== 'ended') return;
      expect(state.words).toContain('mbp-robert');
    });

    it('cannot tell, with the warning, when nothing can say whether it runs', () => {
      expect(paneState(input({ ...lapsed, row: sharedNotes, state: shared }))).toMatchObject({
        kind: 'cannot-tell',
        action: 'resume',
        warning: expect.stringContaining('two processes') as string,
      });
    });

    it('offers nothing when its machine is out of reach', () => {
      expect(paneState(input({ ...lapsed, row: staleBench, state: stale }))).toMatchObject({
        kind: 'unreachable',
        machine: 'gpu-box-01',
        action: null,
      });
    });
  });

  it('is not an ending while the outside claude has gone and the retake is still owed', () => {
    // The process the retake ended is gone before the one it starts is held:
    // nothing runs the session for that moment, and a pane that has seen it
    // run would otherwise call that a session somebody stopped.
    const state = paneState(input({ ran: true, retake: asked }));
    expect(state).toMatchObject({ kind: 'starting', send: false, action: null });
  });

  it('says the outside claude stopped while the retake is owed only when nothing runs it', () => {
    const state = paneState(input({ row: cliQuit, state: outsideQuit, retake: asked }));
    expect(state).toMatchObject({ kind: 'starting', send: false, action: null });
    if (state.kind !== 'starting') return;
    expect(state.words).toContain(
      'the claude that was running this session on mbp-robert has stopped',
    );
  });

  it('claims nothing stopped while the retake is owed and nothing can tell what runs it', () => {
    const state = paneState(input({ row: sharedNotes, state: shared, retake: asked }));
    expect(state).toMatchObject({ kind: 'starting', send: false, action: null });
    if (state.kind !== 'starting') return;
    expect(state.words).not.toContain('stopped');
    expect(state.words).toContain('cannot tell');
  });

  it('claims nothing stopped while the retake is owed and its machine is out of reach', () => {
    for (const row of [staleLora, staleBench]) {
      const state = paneState(input({ row, state: stale, retake: asked }));
      expect(state).toMatchObject({ kind: 'starting', send: false, action: null });
      if (state.kind !== 'starting') return;
      expect(state.words).not.toContain('stopped');
      expect(state.words).toContain('gpu-box-01');
      expect(state.words).toContain('cannot be reached');
    }
  });

  it('keeps the hub’s own words when the retake was refused, and offers it again', () => {
    const refused = followUp(ASKED, answered(hubFrames.refusalRetake), 'session-started');
    expect(
      paneState(input({ row: cliAtPrompt, state: retakeable, retake: refused, ran: true })),
    ).toMatchObject({
      kind: 'outside',
      retake: {
        kind: 'refused',
        words: 'nothing is running that session, so there is nothing to retake; resume it instead',
      },
      retakeLabel: 'Stop the claude on mbp-robert and run this session here',
    });
  });

  it('says the session stopped, not refused, when the outside claude went after a refusal', () => {
    const refused = followUp(ASKED, answered(hubFrames.refusalRetake), 'session-started');
    expect(paneState(input({ retake: refused, ran: true }))).toMatchObject({ kind: 'ended' });
  });

  it('offers it again when no answer will ever come for the retake', () => {
    const idle = followUp(ASKED, NO_ANSWERS, 'session-started');
    expect(paneState(input({ row: cliAtPrompt, state: retakeable, retake: idle }))).toMatchObject({
      kind: 'outside',
      retake: { kind: 'available' },
    });
  });

  it('offers no retake when nothing can say whether a process runs it', () => {
    const state = paneState(input({ row: sharedNotes, state: shared }));
    expect(state.kind).toBe('cannot-tell');
    expect(state).not.toHaveProperty('retake');
  });
});

describe('retakeCommand', () => {
  it('names the session and nothing else', () => {
    expect(retakeCommand(cliAtPrompt.descriptor)).toEqual({
      type: 'session-retake',
      storeId: 'store-agentplex',
      sessionId: 'session-cli-run',
    });
  });
});

describe('the start a pane reads out of resume memory', () => {
  const answers = answered(hubFrames.refusalRetake);

  it('is the retake when the start was one, and the resume otherwise', () => {
    const retake = { ran: true, start: ASKED, lapsed: false, retake: true };
    expect(retakeFollowUp(retake, answers)).toMatchObject({ kind: 'refused' });
    expect(resumeFollowUp(retake, answers)).toBeNull();

    const resume = { ...retake, retake: false };
    expect(resumeFollowUp(resume, answers)).toMatchObject({ kind: 'refused' });
    expect(retakeFollowUp(resume, answers)).toBeNull();
  });

  it('is neither when no start is out', () => {
    const none = { ran: false, start: null, lapsed: false, retake: false };
    expect(resumeFollowUp(none, answers)).toBeNull();
    expect(retakeFollowUp(none, answers)).toBeNull();
  });
});

describe('whether a retake is still out', () => {
  const owed = { replies: new Map(), outstanding: new Set([ASKED]) };
  const retake = { ran: true, start: ASKED, lapsed: false, retake: true };

  it('is while it is owed an answer, and while its answer waits for the hold', () => {
    expect(retakeOutstanding(retake, owed)).toBe(true);
    expect(retakeOutstanding(retake, answered(hubFrames.sessionStartedRetaken))).toBe(true);
  });

  it('is not once it lapsed, was refused, or will never be answered', () => {
    const yes = answered(hubFrames.sessionStartedRetaken);
    expect(retakeOutstanding({ ...retake, lapsed: true }, yes)).toBe(false);
    expect(retakeOutstanding(retake, answered(hubFrames.refusalRetake))).toBe(false);
    expect(retakeOutstanding(retake, NO_ANSWERS)).toBe(false);
  });

  it('is not when the start out is a resume, or none is', () => {
    expect(retakeOutstanding({ ...retake, retake: false }, owed)).toBe(false);
    expect(retakeOutstanding({ ...retake, start: null }, owed)).toBe(false);
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
