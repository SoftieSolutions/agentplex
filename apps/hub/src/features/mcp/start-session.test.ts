import { serverRegistrationIdSchema, startIdSchema, storeIdSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeSessions, type FakeSessions } from '../sessions/fake-sessions.js';
import { startSessionTool } from './start-session.js';
import { callTool, type ToolCall } from './test-tool-call.js';

/**
 * `start_session`, against the sessions feature's own fake.
 *
 * The fake is a real implementation of the seam driven by hand, so what is
 * under test here is exactly what this tool decides: which request the feature
 * is handed, and what an agent is told about the answer. Which machine a start
 * lands on, and every reason one is refused, are decided in
 * `session-routing.ts` and tested there against reduced state; the
 * `tests/hub-server` scenario drives this tool against a real server end and a
 * real pty.
 */

const WORK = storeIdSchema.parse('store-work');
const ATTIC = serverRegistrationIdSchema.parse('registration-attic');
const START = startIdSchema.parse('start-1');

const started = {
  ok: true,
  storeId: WORK,
  sessionId: null,
  server: ATTIC,
  startId: START,
} as const;

function starting(sessions: FakeSessions, args: Record<string, unknown> = {}): Promise<ToolCall> {
  return callTool(startSessionTool({ sessions }), {
    storeId: WORK,
    provider: 'claude',
    ...args,
  });
}

interface Started {
  readonly storeId: string;
  readonly sessionId: string | null;
  readonly server: string;
  readonly startId: string;
}

describe('start_session', () => {
  it('asks for exactly what the client frame asks for', async () => {
    const sessions = createFakeSessions({ outcome: started });

    await starting(sessions, { prompt: 'read the ticket and start' });

    // The whole request, field by field, because what is not on it is the
    // subject: there is no argv, no environment and no working directory here,
    // and the one piece of user content is the prompt. `project: null` is the
    // nearest thing to a directory on this request and it is the hub's own
    // rows either way -- a project is a node id, never a path, and this tool
    // names none.
    expect(sessions.starts).toEqual([
      {
        storeId: WORK,
        sessionId: null,
        provider: 'claude',
        prompt: 'read the ticket and start',
        server: null,
        project: null,
      },
    ]);
  });

  it('leaves a prompt nobody gave as null rather than undefined', async () => {
    const sessions = createFakeSessions({ outcome: started });

    await starting(sessions);

    // An argument that was not supplied is absent in MCP and `null` on the
    // frame. The provider is left at its own prompt either way, and the two
    // spellings must not both reach a feature that takes one of them.
    expect(sessions.starts[0]?.prompt).toBeNull();
  });

  it('passes a machine the caller named through as the override it is', async () => {
    const sessions = createFakeSessions({ outcome: started });

    await starting(sessions, { server: ATTIC });

    expect(sessions.starts[0]?.server).toBe(ATTIC);
  });

  it('answers a spawn with no session id and the name the hub gave the start', async () => {
    const sessions = createFakeSessions({ outcome: started });

    const answered = (await starting(sessions)).structured as unknown as Started;

    // `null` rather than a name this hub made up. A new session's id is the
    // provider's to mint, and `list_sessions` is what says it once the machine
    // has scanned; until then the start id is the only name there is.
    expect(answered).toEqual({
      storeId: WORK,
      sessionId: null,
      server: ATTIC,
      startId: START,
    });
  });

  it('hands back a refusal with the holder named, in the feature words', async () => {
    const sessions = createFakeSessions({
      outcome: {
        ok: false,
        code: 'refused',
        problem: 'that session is already running on attic',
        holder: { server: ATTIC, stoppable: true },
      },
    });

    const result = await starting(sessions);

    expect(result.isError).toBe(true);
    expect(result.structured).toBeUndefined();
    // The feature's own sentence, which names the machine the way a person
    // reads it, plus the id another call needs. A refusal carries no structured
    // half -- an MCP client validates one against the output schema whatever
    // `isError` says -- so the sentence is the whole channel.
    expect(result.text).toBe(`that session is already running on attic; it is held by ${ATTIC}`);
  });

  it('carries a refusal that names no machine as the sentence it is', async () => {
    const sessions = createFakeSessions({
      outcome: {
        ok: false,
        code: 'refused',
        problem: 'attic cannot run claude: no directory this server searches holds claude',
        holder: null,
      },
    });

    const result = await starting(sessions);

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'attic cannot run claude: no directory this server searches holds claude',
    );
  });

  it('refuses an id that is not one, before anything is asked of a machine', async () => {
    const sessions = createFakeSessions({ outcome: started });

    const result = await starting(sessions, { storeId: '' });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('a store id is one to two hundred characters');
    expect(sessions.starts).toHaveLength(0);
  });

  it('refuses a machine id that is not one, without asking the fleet about it', async () => {
    const sessions = createFakeSessions({ outcome: started });

    const result = await starting(sessions, { server: 'x'.repeat(201) });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('a server registration id is one to two hundred characters');
    expect(sessions.starts).toHaveLength(0);
  });

  it('refuses a provider this build has no name for, before the fleet is asked', async () => {
    const sessions = createFakeSessions({ outcome: started });

    const result = await starting(sessions, { provider: 'something-else' });

    // The SDK refuses it against the published schema, which is the point of
    // publishing the closed set: a model reading the listing can see the three
    // names rather than discovering them one refusal at a time.
    expect(result.isError).toBe(true);
    expect(sessions.starts).toHaveLength(0);
  });

  it('takes a session nowhere: there is no id to resume with', () => {
    const sessions = createFakeSessions({ outcome: started });

    const tool = startSessionTool({ sessions });

    // A start that could name a session is a resume, which this tool is not.
    // Asserted on the published schema rather than in prose, because the schema
    // is what a model is handed.
    expect(Object.keys(tool.input).sort()).toEqual(['prompt', 'provider', 'server', 'storeId']);
  });

  it('says it changes something, and that it destroys nothing', () => {
    const tool = startSessionTool({ sessions: createFakeSessions({ outcome: started }) });

    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});
