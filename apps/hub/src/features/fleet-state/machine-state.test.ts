import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  approvalIdSchema,
  machineStateSchema,
  nodeIdSchema,
  serverIdSchema,
  serverAddressSchema,
  sessionIdSchema,
  storeIdSchema,
  type Activity,
  type MachineState,
  type ServerRegistrationId,
  type SessionDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { readyProvider } from '@agentplex/providers/testing';
import { createLogger } from '@agentplex/node-shared';
import type { ServerConnectionPhase, ServerConnectionReport } from '../servers/servers.js';
import { createFleetState, sessionKey, type SessionProject } from '../fleet-state/fleet-state.js';
import { toMachineState } from './machine-state.js';

/**
 * The projection, driven through the real reducer.
 *
 * The interesting questions are mostly about what does *not* come out: the
 * retry counter, a candidate's aging timestamp, and above all a second copy of
 * a server inlined under each store it has mounted. The address is the one that
 * used to be on that list and is not: a client that can unpair is drawing the
 * pairing screen, and a row it can destroy has to say which machine it is.
 */

const START = 1_756_000_000_000;
const logger = createLogger('error', () => {});

function store(id: string): StoreId {
  return storeIdSchema.parse(id);
}

function registration(label: string): ServerRegistrationId {
  return `registration-${label}` as ServerRegistrationId;
}

function connection(
  label: string,
  phase: ServerConnectionPhase,
  stores: readonly string[],
): ServerConnectionReport {
  return {
    registrationId: registration(label),
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    providers: [readyProvider()],
    stores: stores.map(store),
    connectedSince: phase === 'connected' ? START : null,
    staleSince: phase === 'stale' ? START + 1_000 : null,
    lastConnectedAt: phase === 'connecting' ? null : START,
    failedAttempts: phase === 'stale' ? 4 : 0,
    problem: phase === 'stale' ? 'connection refused' : null,
    staleReason: phase === 'stale' ? 'unreachable' : null,
    draining: null,
  };
}

function session(id: string, model?: string, activity?: Activity): SessionDescriptor {
  return {
    storeId: store('store-work'),
    sessionId: sessionIdSchema.parse(id),
    provider: 'claude',
    status: 'awaiting-permission',
    updatedAt: START,
    cwd: '/srv/work',
    branch: null,
    title: 'the ticket',
    // Left off rather than nulled when there is none, because that is the frame
    // a server actually sends for a session whose record named no model: a
    // helper that put a `null` here would be asserting against a shape no
    // adapter produces.
    ...(model === undefined ? {} : { model }),
    // The same, and for a stronger reason: `activity` has no `null` on the
    // wire at all, so a helper that offered one would be describing a frame
    // the protocol refuses.
    ...(activity === undefined ? {} : { activity }),
    uncommitted: null,
  };
}

/** The same fleet, with its one session reported as running a named model. */
function publishedRunning(model: string) {
  const state = createFleetState({ logger });
  state.applyConnection(connection('workshop', 'connected', ['store-work']));
  state.applySessions({
    holding: [],
    registrationId: registration('workshop'),
    storeId: store('store-work'),
    sessions: [session('session-1', model)],
    reportedAt: START,
  });
  return toMachineState(state.snapshot());
}

/** The same fleet, with its one session reported as doing something nameable. */
function publishedDoing(activity: Activity) {
  const state = createFleetState({ logger });
  state.applyConnection(connection('workshop', 'connected', ['store-work']));
  state.applySessions({
    holding: [],
    registrationId: registration('workshop'),
    storeId: store('store-work'),
    sessions: [session('session-1', undefined, activity)],
    reportedAt: START,
  });
  return toMachineState(state.snapshot());
}

/** Two servers with one volume mounted, one of them down, and a session on it. */
function published(attention?: { acknowledgedThrough: number | null; mutedAt: number | null }) {
  const state = createFleetState({ logger });
  state.applyConnection(connection('workshop', 'connected', ['store-work']));
  state.applyConnection(connection('laptop', 'stale', ['store-work']));
  state.applySessions({
    holding: [],
    registrationId: registration('workshop'),
    storeId: store('store-work'),
    sessions: [session('session-1')],
    reportedAt: START,
  });
  if (attention !== undefined) {
    state.applyAttention(
      { storeId: store('store-work'), sessionId: sessionIdSchema.parse('session-1') },
      attention,
    );
  }
  return toMachineState(state.snapshot());
}

/** The same fleet, with the hub's tree having placed its one session somewhere. */
function publishedInProject(project: SessionProject) {
  const state = createFleetState({ logger });
  state.applyConnection(connection('workshop', 'connected', ['store-work']));
  state.applySessions({
    holding: [],
    registrationId: registration('workshop'),
    storeId: store('store-work'),
    sessions: [session('session-1')],
    reportedAt: START,
  });
  state.applyProjects(
    new Map([
      [
        sessionKey({ storeId: store('store-work'), sessionId: sessionIdSchema.parse('session-1') }),
        project,
      ],
    ]),
  );
  return toMachineState(state.snapshot());
}

describe('toMachineState', () => {
  it('produces something the wire parser accepts', () => {
    const parsed = machineStateSchema.safeParse(published());
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it('describes a server once and names it by id everywhere else', () => {
    const state = published();

    expect(state.servers.map((server) => server.registrationId)).toEqual([
      registration('laptop'),
      registration('workshop'),
    ]);
    // The store names its servers, it does not carry them. A frame that carried
    // them twice could say `connected` in one place and `stale` in the other.
    expect(state.stores[0]?.servers).toEqual([registration('laptop'), registration('workshop')]);
  });

  it('publishes the address the hub dials, which is the row the settings screen draws', () => {
    const laptop = published().servers.find((server) => server.label === 'laptop');
    expect(laptop?.address).toBe('wss://laptop.example:8443');
  });

  it('does not publish the retry bookkeeping: a number nobody can act on', () => {
    const [server] = published().servers;
    expect(server).toBeDefined();
    expect(server).not.toHaveProperty('failedAttempts');
  });

  it('keeps a stale server, its reason and its age, rather than dropping the row', () => {
    const laptop = published().servers.find((server) => server.label === 'laptop');
    expect(laptop).toMatchObject({
      phase: 'stale',
      staleReason: 'unreachable',
      staleSince: START + 1_000,
      lastConnectedAt: START,
      problem: 'connection refused',
      stores: [store('store-work')],
    });
  });

  it('flattens the two attention fields onto the row, beside the descriptor', () => {
    const [row] =
      published({ acknowledgedThrough: START, mutedAt: START + 9 })?.stores[0]?.sessions ?? [];
    expect(row?.acknowledgedThrough).toBe(START);
    expect(row?.mutedAt).toBe(START + 9);
    // Flat and not nested: the comparison a client makes is against
    // `descriptor.updatedAt` on the same row, and a `null` object in the way
    // of it would be a branch on the common case of a session nobody has said
    // anything about.
    expect(row).not.toHaveProperty('attention');
  });

  it('publishes nulls for a session nobody has spoken about, rather than leaving the fields out', () => {
    const [row] = published().stores[0]?.sessions ?? [];
    expect(row).toMatchObject({ acknowledgedThrough: null, mutedAt: null });
  });

  it('carries the project the tree placed a session in, both fields, untouched', () => {
    const project = { nodeId: nodeIdSchema.parse('node-universe'), name: 'universe' };
    const [row] = publishedInProject(project).stores[0]?.sessions ?? [];

    // Whole and not reduced to an id: the name is what the sidebar row and the
    // session card draw, and a client that got only a key would have to join
    // this row against the catalogue at a second instant to find the word.
    expect(row?.project).toEqual(project);
  });

  it('publishes null for a session the tree places in no project', () => {
    const [row] = published().stores[0]?.sessions ?? [];
    // Not an absent field and not an empty object: `null` is a session in no
    // project, which is the case the screens fall back to a storeId for.
    expect(row?.project).toBeNull();
    expect(machineStateSchema.safeParse(published()).success).toBe(true);
  });

  it('carries the session descriptor whole, with who saw it beside it', () => {
    const [row] = published().stores[0]?.sessions ?? [];
    expect(row?.descriptor).toEqual(session('session-1'));
    expect(row?.source).toBe(registration('workshop'));
    expect(row?.reportedBy).toEqual([registration('workshop')]);
    // The reducer's `ref` is not restated: it is the descriptor's own two
    // fields, and two fields on a wire that must agree can disagree.
    expect(row).not.toHaveProperty('ref');
  });

  it('publishes the model the server stated, through the parser a client reads with', () => {
    // Parsed and not merely projected: the wire schema is the one thing on this
    // path that can silently drop a field, because an object schema strips what
    // it does not declare. Reading the value back off the parser's output is
    // what makes this a test of the relay rather than of the projection.
    const parsed = machineStateSchema.parse(publishedRunning('claude-opus-5'));
    expect(parsed.stores[0]?.sessions[0]?.descriptor.model).toBe('claude-opus-5');
  });

  it('publishes a model this hub has never heard of, because it reads none of them', () => {
    // The point of the field being a string: a model that shipped this morning
    // reaches a client without a release here. A hub that checked the value
    // against anything would turn a session running perfectly well into a row
    // with no model on it, or no row at all.
    const parsed = machineStateSchema.parse(publishedRunning('a-model-nobody-here-has-heard-of'));
    expect(parsed.stores[0]?.sessions[0]?.descriptor.model).toBe(
      'a-model-nobody-here-has-heard-of',
    );
  });

  it('publishes no model at all for a session whose provider named none', () => {
    // Absent, not `null` and not the provider's usual model. "probably opus"
    // printed beside a session is a guess wearing a reading's clothes, and the
    // only way a surface can draw the absence as absence is to be sent it.
    const parsed = machineStateSchema.parse(published());
    const descriptor = parsed.stores[0]?.sessions[0]?.descriptor;
    expect(descriptor).toBeDefined();
    expect(descriptor).not.toHaveProperty('model');
  });

  it('publishes the activity the server stated, whole and unclassified by this hub', () => {
    // The activity the Codex adapter derives from `packages/providers/fixtures/
    // codex-pending-tool-call.jsonl`, exit status and all. The hub reads no
    // provider's transcript and owns no part of this vocabulary: it either
    // hands the variant across as the machine sent it or it silently reshapes
    // what a card claims happened.
    const parsed = machineStateSchema.parse(
      publishedDoing({ kind: 'command', text: "printf 'hello' > probe.txt", exitStatus: 1 }),
    );
    expect(parsed.stores[0]?.sessions[0]?.descriptor.activity).toEqual({
      kind: 'command',
      text: "printf 'hello' > probe.txt",
      exitStatus: 1,
    });
  });

  it('publishes a kind whose optional fields the server left off, still left off', () => {
    // The Claude adapter's shape: a tool name and no exit status, because the
    // turn that called it has not come back. Absent and not `0`, which is the
    // status of a command that succeeded -- a hub that filled this in would
    // turn a command still running into one that finished well.
    const parsed = machineStateSchema.parse(publishedDoing({ kind: 'command', text: 'Bash' }));
    const activity = parsed.stores[0]?.sessions[0]?.descriptor.activity;
    expect(activity).toEqual({ kind: 'command', text: 'Bash' });
    expect(activity).not.toHaveProperty('exitStatus');
  });

  it('publishes no activity at all for a session whose adapter derived none', () => {
    // Absent, not a `plain` line, and the difference is the whole reason the
    // field is optional: `plain` says "here is what it said and I could not
    // classify it", and absence says there is nothing to show. A hub that
    // manufactured the first from the second would put a line under every
    // quiet session in the fleet.
    const parsed = machineStateSchema.parse(published());
    const descriptor = parsed.stores[0]?.sessions[0]?.descriptor;
    expect(descriptor).toBeDefined();
    expect(descriptor).not.toHaveProperty('activity');
  });

  it('publishes each provider whole, version and directory included', () => {
    // Not reduced to "ready". Which directory a provider came from is the
    // question an operator asks when the wrong version runs, and the hub is the
    // only thing that was ever told the answer.
    const [server] = published().servers;

    expect(server?.providers).toEqual([
      {
        provider: 'claude',
        state: 'ready',
        version: '9.9.9',
        directory: '/home/robert/.agentplex/bin',
        problem: null,
      },
    ]);
  });

  it('carries the open requests onto the row, which is where a client reads them', () => {
    const state = createFleetState({ logger });
    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    state.applySessions({
      holding: [],
      registrationId: registration('workshop'),
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });
    const waiting = {
      approvalId: approvalIdSchema.parse('approval-7f21'),
      subject: {
        kind: 'session' as const,
        storeId: store('store-work'),
        sessionId: sessionIdSchema.parse('session-1'),
      },
      tool: 'Bash',
      proposal: 'prisma migrate deploy --schema ./db',
      truncated: false,
      suggestions: [],
      requestedAt: START + 500,
      answeredBy: null,
    };
    state.applyApprovals(
      { storeId: store('store-work'), sessionId: sessionIdSchema.parse('session-1') },
      [waiting],
    );

    const sent = toMachineState(state.snapshot());
    expect(sent.stores[0]?.sessions[0]?.approvals).toEqual([waiting]);
    // Through the wire's own parser, because a request a client cannot read is
    // an agent nobody can unblock.
    expect(machineStateSchema.safeParse(sent).success).toBe(true);
  });

  it('publishes the task a session was started with', () => {
    const state = createFleetState({ logger });
    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    state.applySessions({
      holding: [],
      registrationId: registration('workshop'),
      storeId: store('store-work'),
      sessions: [session('session-1')],
      reportedAt: START,
    });
    state.applyTask(
      { storeId: store('store-work'), sessionId: sessionIdSchema.parse('session-1') },
      'fix the auth refresh loop and open a PR against main',
    );

    const sent = toMachineState(state.snapshot());
    expect(sent.stores[0]?.sessions[0]?.task).toBe(
      'fix the auth refresh loop and open a PR against main',
    );
    // Through the wire's own parser: a label the client refuses would cost it
    // the whole state frame rather than one panel.
    expect(machineStateSchema.safeParse(sent).success).toBe(true);
  });

  it('publishes null for a session this hub did not start', () => {
    // The common answer, and the one any guess from a transcript would replace
    // with something that reads as a sentence a person wrote.
    expect(published().stores[0]?.sessions[0]?.task).toBeNull();
  });

  it('publishes the runs waiting on a person beside the stores, through the wire’s parser', () => {
    const state = createFleetState({ logger });
    const waiting = {
      graph: nodeIdSchema.parse('node-graph-release'),
      number: 38,
      nodeLabel: 'Ship it',
      approval: {
        approvalId: approvalIdSchema.parse('approval-1'),
        subject: { kind: 'graphRun' as const, runId: 'run-38' as never, nodeId: 'gate' as never },
        tool: 'HUMAN',
        proposal: 'run #38 of release is waiting at Ship it for robert',
        truncated: false,
        suggestions: [],
        requestedAt: START + 500,
        answeredBy: null,
      },
    };
    state.applyGraphRunApprovals([waiting]);

    const sent = toMachineState(state.snapshot());
    expect(sent.graphRunApprovals).toEqual([waiting]);
    // Copied, not shared: nothing a client is sent is the reducer's own array.
    expect(sent.graphRunApprovals).not.toBe(state.snapshot().graphRunApprovals);
    expect(machineStateSchema.safeParse(sent).success).toBe(true);
  });

  it('publishes an empty list for a session with nothing open', () => {
    // Empty is the true value and not a placeholder. A codex session has no
    // hook to ask through and will always publish this, so "nothing is
    // waiting" must not be the same value as "this build cannot tell you".
    expect(published().stores[0]?.sessions[0]?.approvals).toEqual([]);
  });

  it('publishes the empty state a hub with no pairings has', () => {
    const state = toMachineState(createFleetState({ logger }).snapshot());
    expect(state).toEqual({
      version: 0,
      stores: [],
      servers: [],
      candidates: [],
      graphRunApprovals: [],
    });
    expect(machineStateSchema.safeParse(state).success).toBe(true);
  });
});

describe('candidates on the wire', () => {
  function heard(): MachineState {
    const state = createFleetState({ logger });
    state.applyConnection(connection('workshop', 'connected', ['store-work']));
    state.applyCandidates([
      {
        serverId: serverIdSchema.parse('server-heard'),
        address: '192.168.1.24',
        port: 8443,
        protocolVersion: PROTOCOL_VERSION,
        heardAt: START,
        heardFrom: '192.168.1.24',
      },
    ]);
    return toMachineState(state.snapshot());
  }

  it('publishes what was heard as a candidate and never as a server', () => {
    const state = heard();
    expect(state.candidates.map((candidate) => candidate.serverId)).toEqual(['server-heard']);
    expect(state.servers.map((server) => server.registrationId)).toEqual([
      registration('workshop'),
    ]);
    expect(machineStateSchema.safeParse(state).success).toBe(true);
  });

  it('drops when it was heard and where the datagram came from', () => {
    // Both are the hub's own bookkeeping. The age is what the aging is done
    // against, and publishing it would put a field that moves every five
    // seconds into a frame that goes whole to every client; the source address
    // is a cross-check an operator reads in a log, and a client shown two
    // addresses has been handed a decision the hub could not make either.
    const candidate = heard().candidates[0];
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(Object.keys(candidate).sort()).toEqual([
      'address',
      'port',
      'protocolVersion',
      'serverId',
    ]);
  });

  it('carries the claimed protocol version rather than a verdict about it', () => {
    const state = createFleetState({ logger });
    state.applyCandidates([
      {
        serverId: serverIdSchema.parse('server-old'),
        address: '192.168.1.9',
        port: 8443,
        protocolVersion: PROTOCOL_VERSION - 1,
        heardAt: START,
        heardFrom: '192.168.1.9',
      },
    ]);
    const published = toMachineState(state.snapshot());
    expect(published.candidates[0]?.protocolVersion).toBe(PROTOCOL_VERSION - 1);
  });

  it('publishes an empty list for a hub that has heard nothing', () => {
    // Not an absent field: "I have heard nothing" is an answer, and a client
    // must not have to tell it apart from a hub too old to have listened.
    expect(toMachineState(createFleetState({ logger }).snapshot()).candidates).toEqual([]);
  });
});
