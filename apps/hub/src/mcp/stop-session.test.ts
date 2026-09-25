import {
  serverRegistrationIdSchema,
  sessionIdSchema,
  startIdSchema,
  storeIdSchema,
} from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeSessions, type FakeSessions } from '../sessions/fake-sessions.js';
import { stopSessionTool } from './stop-session.js';
import { callTool, type ToolCall } from './test-tool-call.js';

/**
 * `stop_session`, against the sessions feature's own fake.
 *
 * The two refusals are the subject. Which machine holds a session and whether
 * it may be stopped are decided in `session-routing.ts` against reduced state
 * and tested there; what is here is that an agent is told, in words it can act
 * on, which machine is holding the thing it was not allowed to stop.
 */

const WORK = storeIdSchema.parse('store-work');
const QUIET = sessionIdSchema.parse('session-quiet');
const ATTIC = serverRegistrationIdSchema.parse('registration-attic');

const stopped = {
  ok: true,
  storeId: WORK,
  sessionId: QUIET,
  server: ATTIC,
  startId: startIdSchema.parse('start-1'),
} as const;

function stopping(sessions: FakeSessions, args: Record<string, unknown> = {}): Promise<ToolCall> {
  return callTool(stopSessionTool({ sessions }), {
    storeId: WORK,
    sessionId: QUIET,
    ...args,
  });
}

interface Stopped {
  readonly storeId: string;
  readonly sessionId: string;
  readonly server: string;
}

describe('stop_session', () => {
  it('names a session and never a machine', async () => {
    const sessions = createFakeSessions({ outcome: stopped });

    const answered = (await stopping(sessions)).structured as unknown as Stopped;

    // The request is the identity and nothing else: no machine, no terminal
    // handle, no pid. Which server holds it is resolved hub-side, and comes
    // back on the answer rather than going out on the ask.
    expect(sessions.stops).toEqual([{ storeId: WORK, sessionId: QUIET }]);
    expect(answered).toEqual({ storeId: WORK, sessionId: QUIET, server: ATTIC });
  });

  it('refuses a busy holder with the machine named', async () => {
    const sessions = createFakeSessions({
      outcome: {
        ok: false,
        code: 'refused',
        problem: 'that session is mid-turn; stopping it now could leave an edit half applied',
        holder: { server: ATTIC, stoppable: false, pause: 'none' },
      },
    });

    const result = await stopping(sessions);

    expect(result.isError).toBe(true);
    expect(result.structured).toBeUndefined();
    // The busy holder gets no button in the client and no stop here, and the
    // agent is told which machine to look at rather than only that it may not.
    expect(result.text).toBe(
      `that session is mid-turn; stopping it now could leave an edit half applied; it is held by ${ATTIC}`,
    );
  });

  it('refuses a session nothing is running, rather than answering as if it had stopped one', async () => {
    const sessions = createFakeSessions({
      outcome: {
        ok: false,
        code: 'refused',
        problem: 'nothing the hub can see is running that session',
        holder: null,
      },
    });

    const result = await stopping(sessions);

    expect(result.isError).toBe(true);
    // "There was nothing to stop" and "it is stopped now" are different facts.
    // The sentence is the feature's, with nothing appended: no machine is
    // holding it, so there is no machine to name.
    expect(result.text).toBe('nothing the hub can see is running that session');
  });

  it('refuses an id that is not one, before anything is asked of a machine', async () => {
    const sessions = createFakeSessions({ outcome: stopped });

    const result = await stopping(sessions, { sessionId: 'x'.repeat(201) });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('a store id and a session id are each one to two hundred characters');
    expect(sessions.stops).toHaveLength(0);
  });

  it('says it destroys, which is what a client asks a person about', () => {
    const tool = stopSessionTool({ sessions: createFakeSessions({ outcome: stopped }) });

    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});
