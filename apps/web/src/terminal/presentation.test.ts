import { describe, expect, it } from 'vitest';
import {
  machineStateSchema,
  sessionRefSchema,
  sessionStatusSchema,
  subscriptionEndReasonSchema,
  type MachineState,
  type ServerView,
  type SessionRow,
} from '@agentplex/protocol';
import { statusWords } from '../sessions/session-list-model.js';
import type { ConnectionPhase, HubSnapshot, TerminalWatchView } from '../store/hub-store.js';
import { createTerminalFeed } from './chunk-feed.js';
import { EMULATOR_SCROLLBACK_LINES } from './emulator.js';
import {
  breadcrumb,
  findSessionRow,
  formatBytes,
  machineFor,
  machineLabel,
  matchSummary,
  metadataSegments,
  paneAttachment,
  searchScopeNotice,
  statusWord,
  terminalFeedNotice,
  terminalInputNotice,
  terminalIsPartial,
  terminalScopeNotice,
  toneForStatus,
} from './presentation.js';

/**
 * Values here are built through the protocol's own parsers — the same door
 * wire data comes through — so a schema change fails these tests instead of
 * letting a hand-shaped object drift from the real frames.
 */

const ref = sessionRefSchema.parse({ storeId: 'store-a', sessionId: 'sess-1' });

function stateWith(overrides?: {
  holder?: { server: string; stoppable: boolean } | null;
  /** What that machine's connectivity is, for the panes that read it. */
  server?: Record<string, unknown>;
  /** Descriptor fields the header reads: the title, the model, the cwd. */
  descriptor?: Record<string, unknown>;
  /** Where the hub's tree places the session, when it places it anywhere. */
  project?: { nodeId: string; name: string } | null;
}): MachineState {
  return machineStateSchema.parse({
    version: 3,
    stores: [
      {
        storeId: 'store-a',
        servers: ['reg-1'],
        reachable: true,
        unreachableSince: null,
        lastReachableAt: 1_756_000_000_000,
        sessions: [
          {
            descriptor: {
              storeId: 'store-a',
              sessionId: 'sess-1',
              provider: 'claude',
              status: 'working',
              updatedAt: 1_756_000_000_000,
              cwd: '/home/robert/code/universe',
              branch: null,
              title: 'fix-auth-refresh',
              uncommitted: null,
              ...overrides?.descriptor,
            },
            source: 'reg-1',
            reportedBy: ['reg-1'],
            reportedAt: 1_756_000_000_000,
            reachable: true,
            holder:
              overrides?.holder === undefined
                ? { server: 'reg-1', stoppable: true }
                : overrides.holder,
            acknowledgedThrough: null,
            mutedAt: null,
            // In no project unless a case asks for one: the fallback has to be
            // drawn as readily as the named case, since a pane whose hub
            // places the session nowhere falls back to what it said before the
            // field existed.
            project: overrides?.project ?? null,
            approvals: [],
            // Routing is what these tests are about, and a session routed to a
            // pane is as often one the hub found as one it started.
            task: null,
          },
        ],
      },
    ],
    servers: [
      {
        registrationId: 'reg-1',
        label: 'mbp-robert',
        address: 'wss://mbp-robert.example:8443',
        serverId: 'srv-1',
        phase: 'connected',
        stores: ['store-a'],
        // What that machine can start. This file is about drawing sessions, so
        // it is the ordinary case: the provider these sessions run under is
        // installed and logged in.
        providers: [
          {
            provider: 'claude',
            state: 'ready',
            version: '2.1.259',
            directory: '/home/robert/.local/bin',
            problem: null,
          },
        ],
        connectedSince: 1_756_000_000_000,
        staleSince: null,
        lastConnectedAt: 1_756_000_000_000,
        staleReason: null,
        // Not going anywhere: this file is about drawing sessions on a machine
        // that is answering, and a drain is the settings screen's subject.
        draining: null,
        problem: null,
        ...overrides?.server,
      },
    ],
    // Nothing heard on the network: this file is about drawing sessions, and
    // a candidate is neither a session nor a machine any of them run on.
    candidates: [],
  });
}

function snapshotWith(overrides: Partial<HubSnapshot>): HubSnapshot {
  return {
    phase: 'connected',
    problem: null,
    hubId: null,
    machineState: null,
    layout: null,
    paneLayout: null,
    commandQueue: { queued: 0, capacity: 32, overflowed: null },
    terminals: new Map(),
    terminalInput: { discarded: 0, notice: null },
    lastRefusal: null,
    lastStarted: null,
    starts: new Map(),
    lastStopped: null,
    lastAttention: null,
    lastApproval: null,
    approvalPolicies: new Map(),
    lastListing: null,
    lastTreeChange: null,
    catalogue: null,
    lastProjectCreated: null,
    lastDocCreated: null,
    lastDocSaved: null,
    lastDocContent: null,
    lastPush: null,
    pushPublicKey: null,
    ...overrides,
  };
}

/**
 * One watched terminal, attached and whole unless an override says otherwise
 * -- which is the pane every one of these functions has to say nothing about.
 */
function terminalWith(overrides: Partial<TerminalWatchView> = {}): TerminalWatchView {
  return {
    target: { by: 'session', storeId: ref.storeId, sessionId: ref.sessionId },
    feed: createTerminalFeed({ maxBytes: 1024 }),
    attached: true,
    session: ref,
    replayChunks: 4,
    droppedBytes: 0,
    droppedChunks: 0,
    evicted: false,
    printed: true,
    problem: null,
    ended: null,
    resumed: false,
    ...overrides,
  };
}

describe('toneForStatus', () => {
  it('maps every status the wire can carry, both awaiting states loudly', () => {
    const tones = Object.fromEntries(
      sessionStatusSchema.options.map((status) => [status, toneForStatus(status)]),
    );
    expect(tones).toEqual({
      working: 'running',
      'awaiting-permission': 'needs-you',
      'awaiting-input': 'needs-you',
      idle: 'idle',
      unknown: 'idle',
    });
  });
});

describe('findSessionRow', () => {
  it('finds the routed session', () => {
    const row = findSessionRow(stateWith(), ref);
    expect(row?.descriptor.title).toBe('fix-auth-refresh');
  });

  it('answers null before any state arrived, and for a session the hub does not know', () => {
    expect(findSessionRow(null, ref)).toBeNull();
    const other = sessionRefSchema.parse({ storeId: 'store-a', sessionId: 'sess-9' });
    expect(findSessionRow(stateWith(), other)).toBeNull();
  });
});

describe('machineLabel', () => {
  it('names the holder while somebody runs the session', () => {
    const state = stateWith();
    const row = findSessionRow(state, ref);
    if (row === null) throw new Error('the fixture lost its row');
    expect(machineLabel(state, row)).toBe('mbp-robert');
  });

  it('falls back to the reporting server for an unheld session', () => {
    const state = stateWith({ holder: null });
    const row = findSessionRow(state, ref);
    if (row === null) throw new Error('the fixture lost its row');
    expect(machineLabel(state, row)).toBe('mbp-robert');
  });
});

describe('terminalInputNotice', () => {
  it('says nothing while typing is going somewhere', () => {
    expect(terminalInputNotice(snapshotWith({}), terminalWith())).toBeNull();
    // And nothing at all about a pane that is not watching anything yet.
    expect(terminalInputNotice(snapshotWith({}), null)).toBeNull();
  });

  it('repeats the store notice while the connection is down: discarded, in words', () => {
    const notice =
      'the connection is down: 3 keystrokes were discarded, not queued — nothing typed here will replay when it returns';
    const snapshot = snapshotWith({
      phase: 'reconnecting',
      terminalInput: { discarded: 3, notice },
    });
    expect(terminalInputNotice(snapshot, terminalWith())).toBe(notice);
  });

  it("repeats the hub's own no about this terminal, which the echo cannot show", () => {
    const refused = terminalInputNotice(
      snapshotWith({}),
      terminalWith({ attached: false, problem: 'the hub cannot reach mbp-robert right now' }),
    );
    expect(refused).toBe('the hub said no: the hub cannot reach mbp-robert right now');
  });

  it('does not carry a stale refusal into a reconnecting spell the store already words', () => {
    const snapshot = snapshotWith({ phase: 'reconnecting' });
    expect(terminalInputNotice(snapshot, terminalWith({ problem: 'stale reason' }))).toBeNull();
  });
});

describe('formatBytes', () => {
  it('reads as a person reads one', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3_145_754)).toBe('3.0 MB');
  });
});

describe('terminalScopeNotice', () => {
  it('says nothing before the subscription is answered', () => {
    expect(terminalScopeNotice(null)).toBeNull();
    expect(terminalScopeNotice(terminalWith({ attached: false }))).toBeNull();
  });

  it('says nothing while the pane is showing the whole of what there is', () => {
    expect(terminalScopeNotice(terminalWith())).toBeNull();
  });

  it('tells an empty pane apart from an empty session, which draw the same rectangle', () => {
    const quiet = terminalScopeNotice(terminalWith({ printed: false, replayChunks: 0 }));
    expect(quiet).toContain('this session has printed nothing');
    // Once something arrives it is an ordinary pane again and says nothing.
    expect(terminalScopeNotice(terminalWith({ printed: true, replayChunks: 0 }))).toBeNull();
  });

  it('names history the terminal evicted before this pane attached', () => {
    const notice = terminalScopeNotice(terminalWith({ droppedBytes: 3_145_754 }));
    expect(notice).toBe(
      'showing less than everything: the first 3.0 MB this session printed was gone before this pane attached',
    );
  });

  it('names output this connection could not carry, separately', () => {
    const notice = terminalScopeNotice(terminalWith({ droppedChunks: 30 }));
    expect(notice).toContain('30 chunks of output did not fit down this connection');
    expect(terminalScopeNotice(terminalWith({ droppedChunks: 1 }))).toContain('1 chunk of output');
  });

  it('names this pane throwing away its own oldest output', () => {
    expect(terminalScopeNotice(terminalWith({ evicted: true }))).toContain(
      'this pane has since thrown away its own oldest output',
    );
  });

  it('names all three when all three happened, in the order they happened', () => {
    const notice = terminalScopeNotice(
      terminalWith({ droppedBytes: 4096, droppedChunks: 2, evicted: true }),
    );
    // Three losses in three places, never summed: a pane saying "the first 4
    // KB is gone" and a pane saying "this link is dropping output" are asking
    // for two different things to be done about it.
    expect(notice).toBe(
      'showing less than everything: the first 4 KB this session printed was gone before this pane attached; ' +
        '2 chunks of output did not fit down this connection and were dropped; ' +
        'this pane has since thrown away its own oldest output',
    );
  });
});

describe('machineFor', () => {
  it('finds the machine a session is on, and says nothing when there is none', () => {
    const state = stateWith();
    const row = findSessionRow(state, ref);
    expect(machineFor(state, row)?.label).toBe('mbp-robert');
    expect(machineFor(null, row)).toBeNull();
    expect(machineFor(state, null)).toBeNull();
  });
});

describe('terminalFeedNotice', () => {
  /** The machine this session is on, as the state has it. */
  function machine(server?: Record<string, unknown>): ServerView | null {
    const state = stateWith(server === undefined ? undefined : { server });
    return machineFor(state, findSessionRow(state, ref));
  }

  it('says nothing about a pane something is feeding', () => {
    expect(terminalFeedNotice(null)).toBeNull();
    expect(terminalFeedNotice(terminalWith())).toBeNull();
  });

  it('does not tell a user to wait out something only they can fix', () => {
    const dropped = terminalFeedNotice(terminalWith({ ended: 'server-dropped' }), machine());
    expect(dropped).toContain('dialling it again');

    // The hub does go on dialling this one -- and every dial is refused the
    // same way, so a pane that said "dialling it again" would be telling
    // somebody to wait for a minute that changes nothing.
    const wrongToken = terminalFeedNotice(
      terminalWith({ ended: 'server-dropped' }),
      machine({
        phase: 'stale',
        connectedSince: null,
        staleSince: 1_756_000_000_000,
        staleReason: 'unauthorized',
        problem: 'the server did not accept this pairing; pair the machine again',
      }),
    );
    expect(wrongToken).toContain('waiting will not fix it');
    // In the machine's own words, which name what to do: nothing else in this
    // pane knows that a token is what is wrong.
    expect(wrongToken).toContain('pair the machine again');
    expect(wrongToken).not.toContain('dialling it again');
  });

  it('tells a machine that went away from one that is going down on purpose', () => {
    // Two silences that draw the same rectangle and mean two different things
    // to do: wait a moment, or leave a box that is restarting alone.
    expect(terminalFeedNotice(terminalWith({ ended: 'server-dropped' }))).toContain(
      'stopped answering',
    );
    expect(terminalFeedNotice(terminalWith({ ended: 'server-draining' }))).toContain(
      'shutting down',
    );
  });

  it('says outright when there is nothing left to wait for', () => {
    const notice = terminalFeedNotice(terminalWith({ ended: 'session-ended' }));
    // The one reason the hub is not about to re-attach this pane, so the words
    // do not tell the user to wait for something that is not coming.
    expect(notice).toContain('this terminal is gone');
    expect(notice).not.toContain('dialling');
  });

  it('says a replayed history repeats rather than that something is missing', () => {
    const notice = terminalScopeNotice(terminalWith({ resumed: true }));
    // Not one of the losses: a feed that came back is showing something twice,
    // not showing less, and a label that said "showing less than everything"
    // about it would send a user looking for output that is right there.
    expect(notice).toBe(
      'this feed was re-established and the session replayed what it still held, so output above may appear twice',
    );
    expect(terminalScopeNotice(terminalWith({ resumed: true, droppedChunks: 2 }))).toBe(
      'showing less than everything: 2 chunks of output did not fit down this connection and were dropped' +
        ' — this feed was re-established and the session replayed what it still held, so output above may appear twice',
    );
  });
});

describe('terminalIsPartial', () => {
  it('is false for a whole pane and for one watching nothing', () => {
    expect(terminalIsPartial(terminalWith())).toBe(false);
    expect(terminalIsPartial(null)).toBe(false);
  });

  it('is true for each of the three ways a pane comes to be short', () => {
    expect(terminalIsPartial(terminalWith({ droppedBytes: 1 }))).toBe(true);
    expect(terminalIsPartial(terminalWith({ droppedChunks: 1 }))).toBe(true);
    expect(terminalIsPartial(terminalWith({ evicted: true }))).toBe(true);
  });
});

describe('matchSummary', () => {
  it('says nothing before anything has been typed', () => {
    expect(matchSummary('', { index: 4, count: 9 })).toBe('');
    expect(matchSummary('refresh', null)).toBe('');
  });

  it('counts from one, because the user is not counting from zero', () => {
    expect(matchSummary('refresh', { index: 2, count: 12 })).toBe('3 of 12');
    expect(matchSummary('refresh', { index: 0, count: 1 })).toBe('1 of 1');
  });

  it('gives a total without a position when it is standing on no match', () => {
    expect(matchSummary('refresh', { index: -1, count: 12 })).toBe('12 matches');
    expect(matchSummary('refresh', { index: -1, count: 1 })).toBe('1 match');
  });

  it('says a miss is a miss rather than showing an empty count', () => {
    expect(matchSummary('refresh', { index: -1, count: 0 })).toBe('no matches');
  });
});

describe('searchScopeNotice', () => {
  it('says nothing while the pane still holds everything it was sent', () => {
    expect(searchScopeNotice(false)).toBeNull();
  });

  it('names the window and refuses to let a miss stand for absence', () => {
    const notice = searchScopeNotice(true);
    expect(notice).toContain(String(EMULATOR_SCROLLBACK_LINES));
    expect(notice).toContain('not proof of absence');
  });
});

/**
 * Every phase the store can be in, written out so the strip's indicator can be
 * held to saying something different in each. The compiler keeps this list
 * honest in the other direction: `paneAttachment` switches over the union and
 * a phase added to it fails to typecheck until it has words here too.
 */
const connectionPhaseNames: readonly ConnectionPhase[] = [
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'failed',
];

describe('paneAttachment', () => {
  it('claims attachment only when the socket is up and the watch was answered', () => {
    expect(paneAttachment('connected', terminalWith())).toEqual({
      tone: 'running',
      words: 'Attached',
    });
  });

  it('says it is still attaching while the hub has not answered the watch', () => {
    // The first frames of a pane's life, and every reconnection's: the
    // subscribe is out and nothing has come back. "Attached" here would be a
    // claim about a terminal this pane is not being sent yet.
    expect(paneAttachment('connected', terminalWith({ attached: false }))).toEqual({
      tone: 'idle',
      words: 'Attaching',
    });
    expect(paneAttachment('connected', null)).toEqual({ tone: 'idle', words: 'Attaching' });
  });

  it('says the connection is down rather than what the last frame said', () => {
    // The watch record keeps `attached` true until the store tears the
    // connection down, and a pane reading only that would go on saying
    // "Attached" over a socket that is gone. The connection is read first for
    // exactly that reason.
    expect(paneAttachment('reconnecting', terminalWith())).toEqual({
      tone: 'blocked',
      words: 'Reconnecting',
    });
    expect(paneAttachment('failed', terminalWith())).toEqual({
      tone: 'blocked',
      words: 'Dropped',
    });
    expect(paneAttachment('connecting', terminalWith())).toEqual({
      tone: 'idle',
      words: 'Connecting',
    });
    expect(paneAttachment('idle', terminalWith())).toEqual({
      tone: 'idle',
      words: 'Not connected',
    });
  });

  it('has a word for every phase the store can be in', () => {
    const words = connectionPhaseNames.map((phase) => paneAttachment(phase, null).words);
    expect(new Set(words).size).toBe(connectionPhaseNames.length);
  });

  it('says a watch the hub ended is detached, whichever reason ended it', () => {
    // The reasons off the parser rather than a list written here: a fourth one
    // added to the wire is a fourth one this chip has to have an answer for,
    // and the answer is the same for all of them. Which of them it was is the
    // sentence under the terminal, where there is room to say what to do about
    // it; the chip has one word and spends it on the fact that nothing is
    // arriving. "Attaching" would be the wrong one -- it promises a subscribe
    // that is on its way, and there is none.
    for (const ended of subscriptionEndReasonSchema.options) {
      expect(paneAttachment('connected', terminalWith({ attached: false, ended }))).toEqual({
        tone: 'blocked',
        words: 'Detached',
      });
    }
  });

  it('reads the ended flag before the attached one, not after', () => {
    // The store clears `attached` in the same step it sets `ended`, so today
    // the two never disagree and this case does not arise. The order is
    // asserted anyway, because it is what stops being free the moment they do:
    // a pane that asked `attached` first would go on saying "Attached" about a
    // terminal the hub has said is over, which is the over-claim this whole
    // indicator exists to prevent.
    expect(
      paneAttachment('connected', terminalWith({ attached: true, ended: 'session-ended' })),
    ).toEqual({ tone: 'blocked', words: 'Detached' });
  });
});

/** The routed row out of a built state, or a failure that names the fixture. */
function rowIn(state: MachineState): SessionRow {
  const row = findSessionRow(state, ref);
  if (row === null) throw new Error('the fixture lost its row');
  return row;
}

describe('breadcrumb', () => {
  it('names the project quietly and the session loudly', () => {
    const state = stateWith({ project: { nodeId: 'node-7', name: 'universe' } });
    expect(breadcrumb(rowIn(state), ref)).toEqual([
      { text: 'universe', role: 'muted' },
      { text: 'fix-auth-refresh', role: 'emphatic' },
    ]);
  });

  it('falls back to the storeId when the tree places the session in no project', () => {
    // The field's own contract: `null` is a fact about the tree, and the
    // screens that name a project say what they said before it existed.
    expect(breadcrumb(rowIn(stateWith()), ref)).toEqual([
      { text: 'store-a', role: 'muted' },
      { text: 'fix-auth-refresh', role: 'emphatic' },
    ]);
  });

  it('falls back to the sessionId when the provider does not name its sessions', () => {
    const state = stateWith({
      descriptor: { title: null },
      project: { nodeId: 'node-7', name: 'universe' },
    });
    expect(breadcrumb(rowIn(state), ref)).toEqual([
      { text: 'universe', role: 'muted' },
      { text: 'sess-1', role: 'emphatic' },
    ]);
  });

  it('is exactly the storeId / sessionId pair when it knows neither name', () => {
    const state = stateWith({ descriptor: { title: null } });
    expect(breadcrumb(rowIn(state), ref)).toEqual([
      { text: 'store-a', role: 'muted' },
      { text: 'sess-1', role: 'emphatic' },
    ]);
    // And the same before any state arrives: the route is the only thing that
    // names the session, and it names it the way it always has.
    expect(breadcrumb(null, ref)).toEqual([
      { text: 'store-a', role: 'muted' },
      { text: 'sess-1', role: 'emphatic' },
    ]);
  });

  it('never hands the header an empty segment or the word null', () => {
    // Every combination of the two nullable names, because a crumb built by
    // joining strings is exactly how `universe / null` reaches a screen.
    for (const title of [null, 'fix-auth-refresh']) {
      for (const project of [null, { nodeId: 'node-7', name: 'universe' }]) {
        const segments = breadcrumb(rowIn(stateWith({ descriptor: { title }, project })), ref);
        expect(segments.length).toBe(2);
        for (const segment of segments) {
          expect(segment.text.length).toBeGreaterThan(0);
          expect(segment.text).not.toBe('null');
          expect(segment.text).not.toBe('undefined');
        }
      }
    }
  });
});

describe('statusWord', () => {
  it('says what the list says, for every status the wire can carry', () => {
    // Against `statusWords` itself rather than a second table written here:
    // the point of the reuse is that the header and the list cannot come to
    // two words for one status, and a copy of the mapping in this file would
    // be the drift it exists to prevent.
    for (const status of sessionStatusSchema.options) {
      const row = rowIn(stateWith({ descriptor: { status } }));
      expect(statusWord(row)).toBe(statusWords(status));
    }
  });

  it('says nothing has reported when the state holds no such row', () => {
    // Not 'unknown', which is a reading an adapter took and could not resolve.
    // Nobody has said anything about this session at all yet.
    expect(statusWord(null)).toBe('not reported');
  });
});

describe('metadataSegments', () => {
  it('reads provider, machine and working directory', () => {
    const state = stateWith();
    expect(metadataSegments(state, rowIn(state))).toEqual([
      'claude',
      'mbp-robert',
      '/home/robert/code/universe',
    ]);
  });

  it('puts the model after the provider when the provider recorded one', () => {
    const state = stateWith({ descriptor: { model: 'claude-opus-5' } });
    expect(metadataSegments(state, rowIn(state))).toEqual([
      'claude',
      'claude-opus-5',
      'mbp-robert',
      '/home/robert/code/universe',
    ]);
  });

  it('omits the segment for anything the descriptor does not carry', () => {
    // A gap where the model would go is a claim that something is missing; an
    // absent segment is the truth, which is that there was never one to show.
    const state = stateWith({ descriptor: { cwd: null } });
    expect(metadataSegments(state, rowIn(state))).toEqual(['claude', 'mbp-robert']);
  });

  it('says nothing at all before a row or a state exists to read', () => {
    const state = stateWith();
    expect(metadataSegments(null, rowIn(state))).toEqual([]);
    expect(metadataSegments(state, null)).toEqual([]);
  });
});
