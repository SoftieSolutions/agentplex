import { beforeEach, describe, expect, it } from 'vitest';
import {
  approvalIdSchema,
  nodeIdSchema,
  serverAddressSchema,
  sessionIdSchema,
  storeIdSchema,
  type GraphRunApproval,
  type ServerRegistrationId,
  type SessionDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { readyProvider } from '@agentplex/providers/testing';
import { createLogger } from '@agentplex/node-shared';
import type { ServerConnectionPhase, ServerConnectionReport } from '../servers/servers.js';
import { createFleetState, type FleetState } from '../fleet-state/fleet-state.js';
import { createAttentionEdge } from './attention-edge.js';
import type { PushEvent } from './push.js';

/**
 * The needs-you edge, driven through the real reducer.
 *
 * Against `createFleetState` and not a hand-built snapshot, because every
 * question worth asking here is about the order the hub actually produces
 * snapshots in. A connection lands before the report that fills the store; a
 * server reporting the same thing twice publishes nothing; a machine going
 * stale rewrites every row it reported. A fake snapshot would agree with
 * whatever this file believed about that, which is the one thing under test.
 *
 * The seams are the reducer and the collector below. There is no clock: the
 * whole rule is a comparison of two `updatedAt` values a provider wrote, and a
 * detector that read a wall clock would be one whose answer depended on how
 * long a boot took.
 */

const START = 1_756_000_000_000;
const logger = createLogger('error', () => {});

const STORE = storeIdSchema.parse('store-work');
const OTHER_STORE = storeIdSchema.parse('store-spare');

function registration(label: string): ServerRegistrationId {
  return `registration-${label}` as ServerRegistrationId;
}

function connection(
  label: string,
  phase: ServerConnectionPhase,
  stores: readonly StoreId[],
): ServerConnectionReport {
  return {
    registrationId: registration(label),
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    providers: [readyProvider()],
    stores: [...stores],
    connectedSince: phase === 'connected' ? START : null,
    staleSince: phase === 'stale' ? START + 1_000 : null,
    lastConnectedAt: phase === 'connecting' ? null : START,
    failedAttempts: phase === 'stale' ? 4 : 0,
    problem: phase === 'stale' ? 'connection refused' : null,
    staleReason: phase === 'stale' ? 'unreachable' : null,
    draining: null,
  };
}

interface SessionOptions {
  readonly storeId?: StoreId;
  readonly status?: SessionDescriptor['status'];
  readonly updatedAt?: number;
}

function session(id: string, options: SessionOptions = {}): SessionDescriptor {
  return {
    storeId: options.storeId ?? STORE,
    sessionId: sessionIdSchema.parse(id),
    provider: 'claude',
    status: options.status ?? 'awaiting-permission',
    updatedAt: options.updatedAt ?? START,
    // The three fields a notification may never carry. They are here because a
    // real descriptor has them, and the test below reads the event for them.
    cwd: '/srv/work/agentplex',
    branch: 'feature-branch',
    title: 'rename the widget',
    uncommitted: null,
  };
}

let state: FleetState;
let sent: PushEvent[];

function watch(): void {
  const edge = createAttentionEdge({ notify: (event) => sent.push(event), logger });
  state.subscribe((snapshot) => edge.observe(snapshot));
}

function report(
  label: string,
  sessions: readonly SessionDescriptor[],
  storeId: StoreId = STORE,
): void {
  state.applySessions({
    registrationId: registration(label),
    storeId,
    sessions: [...sessions],
    holding: [],
    reportedAt: START,
  });
}

/**
 * A hub that has just come up and settled: one server connected, one store
 * reported, one session in it already sitting on a permission prompt.
 *
 * This is the boot storm in four lines. Every one of them publishes a
 * snapshot, and a detector that subscribed cold would push for that prompt on
 * every restart, to every browser, for a prompt whose owner has seen it.
 */
function bootWithAPromptWaiting(): void {
  watch();
  state.applyConnection(connection('workshop', 'connected', [STORE]));
  report('workshop', [session('session-a')]);
}

describe('the needs-you edge', () => {
  beforeEach(() => {
    state = createFleetState({ logger });
    sent = [];
  });

  it('says nothing about the prompts a restart finds already waiting', () => {
    bootWithAPromptWaiting();

    expect(sent).toEqual([]);
  });

  it('says nothing when the attention rows replay before the first report', () => {
    // The order the hub boots in: `attention.load()` replays every row it has
    // before `servers.sync()` dials anything, so the mute and the
    // acknowledgement are already on the row the first report produces.
    watch();
    state.applyAttention(
      { storeId: STORE, sessionId: sessionIdSchema.parse('session-a') },
      { acknowledgedThrough: null, mutedAt: null },
    );
    state.applyConnection(connection('workshop', 'connected', [STORE]));
    report('workshop', [session('session-a')]);

    expect(sent).toEqual([]);
  });

  it('sends exactly one push when a session newly wants a human', () => {
    watch();
    state.applyConnection(connection('workshop', 'connected', [STORE]));
    report('workshop', [session('session-a', { status: 'working' })]);

    report('workshop', [
      session('session-a', { status: 'awaiting-permission', updatedAt: START + 1 }),
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      kind: 'session',
      storeId: STORE,
      sessionId: sessionIdSchema.parse('session-a'),
      provider: 'claude',
      status: 'awaiting-permission',
    });
  });

  it('carries no title, directory or branch off the descriptor', () => {
    watch();
    state.applyConnection(connection('workshop', 'connected', [STORE]));
    report('workshop', [session('session-a', { status: 'working' })]);
    report('workshop', [session('session-a', { updatedAt: START + 1 })]);

    const carried = JSON.stringify(sent);
    expect(carried).not.toContain('rename the widget');
    expect(carried).not.toContain('/srv/work/agentplex');
    expect(carried).not.toContain('feature-branch');
  });

  it('does not say it again when a machine flaps in and out of reach', () => {
    watch();
    state.applyConnection(connection('workshop', 'connected', [STORE]));
    report('workshop', [session('session-a', { status: 'working' })]);
    report('workshop', [session('session-a', { updatedAt: START + 1 })]);
    expect(sent).toHaveLength(1);

    // Unreachable takes the row out of the rule; reachable puts it back, with
    // the same prompt on it. The key is the prompt, so this is not news.
    state.applyConnection(connection('workshop', 'stale', [STORE]));
    state.applyConnection(connection('workshop', 'connected', [STORE]));

    expect(sent).toHaveLength(1);
  });

  it('says it again when the provider writes a new prompt on the same session', () => {
    watch();
    state.applyConnection(connection('workshop', 'connected', [STORE]));
    report('workshop', [session('session-a', { status: 'working' })]);
    report('workshop', [session('session-a', { updatedAt: START + 1 })]);

    report('workshop', [session('session-a', { status: 'working', updatedAt: START + 2 })]);
    report('workshop', [session('session-a', { updatedAt: START + 3 })]);

    expect(sent).toHaveLength(2);
  });

  it('says nothing about a muted session', () => {
    watch();
    state.applyConnection(connection('workshop', 'connected', [STORE]));
    report('workshop', [session('session-a', { status: 'working' })]);
    state.applyAttention(
      { storeId: STORE, sessionId: sessionIdSchema.parse('session-a') },
      { acknowledgedThrough: null, mutedAt: START },
    );

    report('workshop', [session('session-a', { updatedAt: START + 1 })]);

    expect(sent).toEqual([]);
  });

  it('says nothing about a prompt somebody has already acknowledged', () => {
    watch();
    state.applyConnection(connection('workshop', 'connected', [STORE]));
    report('workshop', [session('session-a', { status: 'working' })]);
    state.applyAttention(
      { storeId: STORE, sessionId: sessionIdSchema.parse('session-a') },
      { acknowledgedThrough: START + 1, mutedAt: null },
    );

    report('workshop', [session('session-a', { updatedAt: START + 1 })]);

    expect(sent).toEqual([]);
  });

  it('seeds each store on its own, so a second machine coming up says nothing', () => {
    watch();
    state.applyConnection(connection('workshop', 'connected', [STORE]));
    report('workshop', [session('session-a')]);

    state.applyConnection(connection('spare', 'connected', [OTHER_STORE]));
    report('spare', [session('session-b', { storeId: OTHER_STORE })], OTHER_STORE);

    expect(sent).toEqual([]);
  });
});

/**
 * The other edge: a graph run newly waiting on a person.
 *
 * Off the reducer's `graphRunApprovals` rather than any session row, because
 * a run is not a session. The rule is simpler than a session's -- a request
 * is news exactly once, when it first appears, and a run that asks a second
 * time at another node is a second request with its own id -- so what is
 * remembered is the approval id and nothing else.
 */
describe('the needs-you edge, for a run waiting on a person', () => {
  const RELEASE = nodeIdSchema.parse('node-graph-release');
  const PROMPT = 'Review the Rust in this change.';

  function waiting(id: string, number: number, label = 'Ship it'): GraphRunApproval {
    return {
      graph: RELEASE,
      number,
      nodeLabel: label,
      approval: {
        approvalId: approvalIdSchema.parse(id),
        subject: {
          kind: 'graphRun',
          runId: `run-${String(number)}` as never,
          nodeId: 'gate' as never,
        },
        tool: 'HUMAN',
        // The words a client draws. The prompt is here to prove it never
        // leaves: a notification names the run and the node, and nothing
        // an agent was asked to do.
        proposal: `run #${String(number)} of release is waiting at ${label} for robert; ${PROMPT}`,
        truncated: false,
        suggestions: [],
        requestedAt: START,
        answeredBy: null,
      },
    };
  }

  beforeEach(() => {
    state = createFleetState({ logger });
    sent = [];
  });

  it('sends exactly one push when a run starts waiting, naming the run number and the node', () => {
    watch();
    state.applyGraphRunApprovals([waiting('approval-1', 38)]);

    expect(sent).toEqual([{ kind: 'graphRun', graph: RELEASE, number: 38, node: 'Ship it' }]);
  });

  it('does not say it again while the same request is still waiting', () => {
    watch();
    state.applyGraphRunApprovals([waiting('approval-1', 38)]);
    // Something else moves the state; the list is republished unchanged.
    state.applyConnection(connection('workshop', 'connected', [STORE]));

    expect(sent).toHaveLength(1);
  });

  it('says it again for a second request, whether from another run or the same one later', () => {
    watch();
    state.applyGraphRunApprovals([waiting('approval-1', 38)]);
    state.applyGraphRunApprovals([waiting('approval-1', 38), waiting('approval-2', 39)]);
    state.applyGraphRunApprovals([]);
    state.applyGraphRunApprovals([waiting('approval-3', 38, 'Deploy')]);

    expect(sent.map((event) => (event.kind === 'graphRun' ? event.node : null))).toEqual([
      'Ship it',
      'Ship it',
      'Deploy',
    ]);
  });

  it('carries nothing of the proposal past the node label', () => {
    watch();
    state.applyGraphRunApprovals([waiting('approval-1', 38)]);
    expect(JSON.stringify(sent)).not.toContain(PROMPT);
    expect(JSON.stringify(sent)).not.toContain('robert');
  });

  it('does not seed: a run already waiting when the hub comes up is one nobody was told about', () => {
    // A hub restart ends every run, so there is no run to have been waiting
    // before the detector watched. A request in the first snapshot is news.
    watch();
    state.applyGraphRunApprovals([waiting('approval-1', 38)]);
    expect(sent).toHaveLength(1);
  });
});
