import {
  nodeIdSchema,
  serverRegistrationIdSchema,
  startIdSchema,
  storeIdSchema,
} from '@agentplex/protocol';
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
const HUB_PROJECT = nodeIdSchema.parse('node-hub');

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
    // and the one piece of user content is the prompt. `project` is `null`
    // because this caller named none, which is the store's own directory.
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

  it('passes the project a caller named through as the node id it is', async () => {
    const sessions = createFakeSessions({ outcome: started });

    await starting(sessions, { projectId: HUB_PROJECT });

    // A node id and nothing else. Where that project is, and whether any
    // machine will spawn there, are the sessions feature's to answer out of
    // this hub's own rows -- this tool holds no directory to be wrong about.
    expect(sessions.starts[0]?.project).toBe(HUB_PROJECT);
  });

  it('names no directory, however the caller spells one', async () => {
    const sessions = createFakeSessions({ outcome: started });

    // A directory is the thing the frame shape exists to make unrepresentable,
    // and none of these spellings has anywhere to go: the SDK drops what the
    // input schema does not declare, so a caller that tried lands on the same
    // request as one that did not.
    await starting(sessions, {
      cwd: '/volumes/work',
      directory: '/volumes/work',
      path: '/volumes/work',
      project: '/volumes/work',
    });

    expect(sessions.starts[0]?.project).toBeNull();
  });

  it('refuses a project id that is not one, before the rows are asked', async () => {
    const sessions = createFakeSessions({ outcome: started });

    const result = await starting(sessions, { projectId: 'x'.repeat(201) });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('a node id is one to two hundred characters');
    expect(sessions.starts).toHaveLength(0);
  });

  it('hands back the feature refusal for a project this hub does not have', async () => {
    const sessions = createFakeSessions({
      outcome: {
        ok: false,
        code: 'refused',
        problem: 'this hub has no project by that id',
        holder: null,
      },
    });

    const result = await starting(sessions, { projectId: HUB_PROJECT });

    // Decided in `sessions.ts` against the rows and not here, which is the
    // whole point of the tool being the feature call: an agent gets the
    // sentence a browser's own frame gets.
    expect(result.isError).toBe(true);
    expect(result.text).toBe('this hub has no project by that id');
  });

  it('hands back the machine own words when it will not open the directory', async () => {
    const sessions = createFakeSessions({
      outcome: {
        ok: false,
        code: 'refused',
        problem: 'no directory this server is configured to browse holds /volumes/elsewhere',
        holder: null,
      },
    });

    const result = await starting(sessions, { projectId: HUB_PROJECT });

    // The refusal comes from the box that would have spawned, and it names the
    // path because it is the one party entitled to: the roots are its
    // operator's and the sentence is what somebody would go and change.
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'no directory this server is configured to browse holds /volumes/elsewhere',
    );
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
    // is what a model is handed -- and what is on it is four names and a
    // prompt, with no spelling of a path among them.
    expect(Object.keys(tool.input).sort()).toEqual([
      'projectId',
      'prompt',
      'provider',
      'server',
      'storeId',
    ]);
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
