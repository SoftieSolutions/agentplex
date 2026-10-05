import { describe, expect, it } from 'vitest';
import {
  serverAddressSchema,
  sessionIdSchema,
  storeIdSchema,
  type ServerRegistrationId,
  type SessionDescriptor,
} from '@agentplex/protocol';
import { readyProvider } from '@agentplex/providers/testing';
import { createLogger, type IdGenerator } from '@agentplex/node-shared';
import { createFleetState, type HubStateSnapshot } from '../fleet-state/fleet-state.js';
import type { InstructionOutcome, ServerInstruction } from '../servers/servers.js';
import { createSessions, type Sessions, type StartSessionRequest } from './sessions.js';

/**
 * The start path's own bookkeeping, against real reduced state and a
 * connection seam whose answers the test hands out.
 *
 * What is under test is the one thing this file adds over the routing: that a
 * start naming a session is not put to a machine twice while the first is
 * still on its way. The routing cannot see that -- a resume in flight holds
 * nothing until the server answers -- so a second start in that window would
 * route exactly as the first did, and two processes would open one transcript.
 */

const START = 1_756_000_000_000;
const logger = createLogger('error', () => {});
const WORK = storeIdSchema.parse('store-work');
const SERVER = 'registration-workshop' as ServerRegistrationId;
const SESSION = sessionIdSchema.parse('session-resumable');

function descriptor(process: SessionDescriptor['process']): SessionDescriptor {
  return {
    storeId: WORK,
    sessionId: SESSION,
    provider: 'claude',
    status: 'idle',
    process,
    updatedAt: START,
    cwd: '/srv/work',
    branch: null,
    title: null,
    uncommitted: null,
  };
}

/**
 * One connected machine with the store mounted and one unheld session on it,
 * run by nothing unless a test says a process outside agentplex runs it.
 */
function fleet(process: SessionDescriptor['process']): HubStateSnapshot {
  const reducer = createFleetState({ logger });
  reducer.applyConnection({
    registrationId: SERVER,
    label: 'workshop',
    address: serverAddressSchema.parse('wss://workshop.example:8443'),
    serverId: null,
    phase: 'connected',
    providers: [readyProvider()],
    stores: [WORK],
    connectedSince: START,
    staleSince: null,
    lastConnectedAt: START,
    failedAttempts: 0,
    problem: null,
    staleReason: null,
    draining: null,
    roundTrip: null,
    os: null,
    daemonVersion: null,
  });
  reducer.applySessions({
    registrationId: SERVER,
    storeId: WORK,
    sessions: [descriptor(process)],
    holding: [],
    reportedAt: START,
  });
  return reducer.snapshot();
}

/** An instruction put to a machine, and the hand that answers it. */
interface Asked {
  readonly instruction: ServerInstruction;
  answer(outcome: InstructionOutcome): void;
}

function harness(process: SessionDescriptor['process'] = 'none'): {
  readonly sessions: Sessions;
  readonly asked: Asked[];
} {
  const snapshot = fleet(process);
  const asked: Asked[] = [];
  let next = 0;
  const ids: IdGenerator = { newId: () => `start-${String((next += 1))}` };
  const sessions = createSessions({
    state: { snapshot: () => snapshot },
    projects: { directoryOf: () => Promise.resolve(null) },
    ids,
    connections: {
      ask: (_registrationId, instruction) =>
        new Promise<InstructionOutcome>((resolve) => {
          asked.push({ instruction, answer: resolve });
        }),
    },
    logger,
    onStarted: () => Promise.resolve(),
  });
  return { sessions, asked };
}

const RESUME: StartSessionRequest = {
  storeId: WORK,
  sessionId: SESSION,
  provider: 'claude',
  prompt: null,
  server: null,
  project: null,
};

function started(): InstructionOutcome {
  return {
    ok: true,
    answer: { type: 'session-started', replyTo: 1, storeId: WORK, sessionId: SESSION },
  };
}

describe('start', () => {
  it('refuses a second start of a session while the first is still on its way', async () => {
    const { sessions, asked } = harness();

    const first = sessions.start(RESUME);
    const second = await sessions.start(RESUME);

    expect(second).toEqual({
      ok: false,
      code: 'refused',
      problem: 'that session is already being started',
      holder: null,
    });
    expect(asked).toHaveLength(1);

    asked[0]?.answer(started());
    await expect(first).resolves.toMatchObject({ ok: true, sessionId: SESSION });
  });

  it('routes a start of that session again once the first has been answered', async () => {
    const { sessions, asked } = harness();

    const first = sessions.start(RESUME);
    asked[0]?.answer(started());
    await first;

    const again = sessions.start(RESUME);
    expect(asked).toHaveLength(2);
    asked[1]?.answer(started());
    await expect(again).resolves.toMatchObject({ ok: true });
  });

  it('routes again after the first was refused by the machine', async () => {
    const { sessions, asked } = harness();

    const first = sessions.start(RESUME);
    asked[0]?.answer({ ok: false, code: 'refused', problem: 'no', hold: null });
    await expect(first).resolves.toMatchObject({ ok: false });

    void sessions.start(RESUME);
    expect(asked).toHaveLength(2);
  });

  it('does not hold fresh spawns to one at a time', async () => {
    const { sessions, asked } = harness();

    void sessions.start({ ...RESUME, sessionId: null });
    void sessions.start({ ...RESUME, sessionId: null });
    await Promise.resolve();

    expect(asked).toHaveLength(2);
  });
});

/**
 * A retake claims the session exactly as a start naming it does.
 *
 * Its last step is a resume on the server, so a start of the same session in
 * the same window is a second resume of one transcript: the routing cannot see
 * either while it is on its way, and only the claim keeps them apart.
 */
describe('retake', () => {
  const RETAKE = { storeId: WORK, sessionId: SESSION };

  it('asks the machine that sees the process, with the provider off the row', async () => {
    const { sessions, asked } = harness('running');

    const pending = sessions.retake(RETAKE);
    expect(asked.map((one) => one.instruction)).toEqual([
      { type: 'session-retake', storeId: WORK, sessionId: SESSION, provider: 'claude' },
    ]);

    asked[0]?.answer(started());
    await expect(pending).resolves.toEqual({
      ok: true,
      storeId: WORK,
      sessionId: SESSION,
      server: SERVER,
    });
  });

  it("relays the server's refusal in the server's words", async () => {
    const { sessions, asked } = harness('running');

    const pending = sessions.retake(RETAKE);
    asked[0]?.answer({
      ok: false,
      code: 'refused',
      problem: 'that session is working elsewhere; retake it when it is idle or waiting',
      hold: null,
    });

    await expect(pending).resolves.toEqual({
      ok: false,
      code: 'refused',
      problem: 'that session is working elsewhere; retake it when it is idle or waiting',
      holder: null,
    });
  });

  it('takes nothing but session-started as a retake having happened', async () => {
    const { sessions, asked } = harness('running');

    const pending = sessions.retake(RETAKE);
    asked[0]?.answer({
      ok: true,
      answer: { type: 'session-stopped', replyTo: 1, storeId: WORK, sessionId: SESSION },
    });

    await expect(pending).resolves.toMatchObject({ ok: false, code: 'internal' });
  });

  it('refuses before asking anybody when the routing does', async () => {
    const { sessions, asked } = harness('none');

    await expect(sessions.retake(RETAKE)).resolves.toMatchObject({ ok: false, code: 'refused' });
    expect(asked).toEqual([]);
  });

  it('refuses a retake while a start of the same session is still on its way', async () => {
    const { sessions, asked } = harness('running');

    const start = sessions.start(RESUME);
    const retake = await sessions.retake(RETAKE);

    expect(retake).toEqual({
      ok: false,
      code: 'refused',
      problem: 'that session is already being started',
      holder: null,
    });
    expect(asked.map((one) => one.instruction.type)).toEqual(['session-start']);

    asked[0]?.answer(started());
    await start;
  });

  it('refuses a start while a retake of the same session is still on its way', async () => {
    const { sessions, asked } = harness('running');

    const retake = sessions.retake(RETAKE);
    const start = await sessions.start(RESUME);

    expect(start).toEqual({
      ok: false,
      code: 'refused',
      problem: 'that session is already being retaken',
      holder: null,
    });
    expect(asked.map((one) => one.instruction.type)).toEqual(['session-retake']);

    // Released whatever the machine answered, so a refusal does not wedge it.
    asked[0]?.answer({ ok: false, code: 'refused', problem: 'no', hold: null });
    await retake;
    void sessions.start(RESUME);
    expect(asked.map((one) => one.instruction.type)).toEqual(['session-retake', 'session-start']);
  });
});
