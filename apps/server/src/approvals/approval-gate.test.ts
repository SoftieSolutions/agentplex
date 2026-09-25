import { describe, expect, it } from 'vitest';
import {
  createLogger,
  type IdGenerator,
  type LogRecord,
  type TokenMinter,
} from '@agentplex/node-shared';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import {
  sessionIdSchema,
  type ApprovalId,
  type SessionId,
  type StoreId,
} from '@agentplex/protocol';
import { encodeClaudePermissionAnswer } from '@agentplex/providers';
import { readProviderFixture } from '@agentplex/providers/testing';
import { createFakeApprovalListener, createFakeHookConnection } from './fake-approval-hooks.js';
import {
  APPROVAL_DENIAL_MESSAGE,
  APPROVAL_HOOK_TIMEOUT_SECONDS,
  APPROVAL_TIMEOUT_MS,
  createApprovalGate,
  type ApprovalEvent,
} from './approval-gate.js';

/**
 * The payload is the captured one, not a shape written from memory.
 *
 * What a `PermissionRequest` hook is handed is the providers package's fact and
 * its capture test's to keep true -- this suite's subject is what the gate does
 * with a payload that parser accepts, so it reads the same bytes rather than
 * inventing a second description of them. The command in it is the ticket's own
 * example, which is a coincidence worth keeping.
 */
const CAPTURED = await readProviderFixture('claude-permission-request.json');
const SESSION: SessionId = sessionIdSchema.parse(
  (JSON.parse(CAPTURED) as { readonly session_id: string }).session_id,
);
const STORE = 'store-a' as StoreId;
const OTHER_STORE = 'store-b' as StoreId;

/** The line a hook sends: a secret and the bytes Claude Code handed it. */
function sent(secret: string, payload: string = CAPTURED): string {
  return JSON.stringify({ secret, payload });
}

/** The captured payload with one value bent, so every other field stays real. */
function captured(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(CAPTURED) as Record<string, unknown>), ...overrides });
}

function counting(prefix: string): { newId(): string } {
  let next = 0;
  return { newId: () => `${prefix}-${(next += 1)}` };
}

function gate(now = 1_000) {
  const listener = createFakeApprovalListener();
  const timers: FakeTimers = createFakeTimers();
  const events: ApprovalEvent[] = [];
  const records: LogRecord[] = [];
  const ids: IdGenerator = counting('approval');
  const minted = counting('secret');
  const tokens: TokenMinter = { newToken: () => minted.newId() };
  let clockNow = now;
  return {
    listener,
    timers,
    events,
    records,
    /** Moves this machine's clock, which is the only one a wait is measured by. */
    advanceBy(ms: number): void {
      clockNow += ms;
    },
    gate: createApprovalGate({
      listener,
      clock: { now: () => clockNow },
      ids,
      timers,
      tokens,
      logger: createLogger('info', (record) => void records.push(record)),
      onEvent: (event) => void events.push(event),
    }),
  };
}

/** The whole ordinary opening: one launch admitted, one hook blocked on it. */
function blocked(harness: ReturnType<typeof gate>, onWrite?: () => void) {
  const admission = harness.gate.admit(STORE);
  const hook = createFakeHookConnection(sent(admission.secret), onWrite);
  harness.listener.present(hook.connection);
  const requested = harness.events[0];
  if (requested?.type !== 'approval-requested') {
    throw new Error(`no request was reported: ${JSON.stringify(harness.events)}`);
  }
  return { admission, hook, approvalId: requested.approval.approvalId };
}

describe('createApprovalGate', () => {
  it('mints an id for a hook presenting the secret its launch was given, and reports the request', () => {
    const harness = gate();
    const admission = harness.gate.admit(STORE);
    const hook = createFakeHookConnection(sent(admission.secret));

    harness.listener.present(hook.connection);

    expect(harness.events).toEqual([
      {
        type: 'approval-requested',
        storeId: STORE,
        sessionId: SESSION,
        approval: {
          approvalId: 'approval-1',
          tool: 'Bash',
          proposal: [
            'command: prisma migrate deploy --schema ./db',
            'description: Apply pending Prisma migrations',
          ].join('\n'),
          truncated: false,
          suggestions: [
            {
              behavior: 'allow',
              destination: 'localSettings',
              rules: [{ tool: 'Bash', content: 'prisma migrate *' }],
            },
          ],
        },
      },
    ]);
    // The hook is still blocked: nothing has been decided, so nothing is
    // written and the connection stays open holding the tool call.
    expect(hook.writes).toEqual([]);
    expect(hook.closed).toBe(false);
  });

  it('carries the provider’s word that a proposal was cut, rather than the text', () => {
    // The gate copies the parser's claim out to the wire untouched. Working it
    // out here from the length, or from the marker in the text, would be a
    // second opinion about a fact only the thing that did the cutting has.
    const harness = gate();
    const admission = harness.gate.admit(STORE);

    harness.listener.present(
      createFakeHookConnection(
        sent(admission.secret, captured({ tool_input: { command: 'echo '.repeat(20_000) } })),
      ).connection,
    );

    const requested = harness.events[0];
    expect(requested?.type).toBe('approval-requested');
    if (requested?.type !== 'approval-requested') return;
    expect(requested.approval.truncated).toBe(true);
  });

  it('gives each launch its own secret', () => {
    const harness = gate();

    const first = harness.gate.admit(STORE);
    const second = harness.gate.admit(OTHER_STORE);

    expect(first.secret).not.toBe(second.secret);
  });

  it('attributes a request to the store of the launch whose secret was presented', () => {
    const harness = gate();
    harness.gate.admit(STORE);
    const second = harness.gate.admit(OTHER_STORE);

    harness.listener.present(createFakeHookConnection(sent(second.secret)).connection);

    expect(harness.events[0]).toMatchObject({ type: 'approval-requested', storeId: OTHER_STORE });
  });

  it('refuses a hook presenting a secret this server never minted, and creates nothing', () => {
    const harness = gate();
    harness.gate.admit(STORE);
    const hook = createFakeHookConnection(sent('secret-nobody-minted'));

    harness.listener.present(hook.connection);

    expect(harness.events).toEqual([]);
    // Closed with nothing written, which is the hook's "no decision": Claude
    // Code's own flow resumes and the terminal prompt stands.
    expect(hook.writes).toEqual([]);
    expect(hook.closed).toBe(true);
  });

  it('refuses a hook that presents no secret at all', () => {
    const harness = gate();
    harness.gate.admit(STORE);
    const hook = createFakeHookConnection(JSON.stringify({ payload: CAPTURED }));

    harness.listener.present(hook.connection);

    expect(harness.events).toEqual([]);
    expect(hook.writes).toEqual([]);
    expect(hook.closed).toBe(true);
  });

  it('refuses a hook whose line is not readable at all', () => {
    const harness = gate();
    harness.gate.admit(STORE);
    const hook = createFakeHookConnection('not json');

    harness.listener.present(hook.connection);

    expect(harness.events).toEqual([]);
    expect(hook.closed).toBe(true);
  });

  it('refuses a payload the provider parser does not accept, and creates nothing', () => {
    const harness = gate();
    const admission = harness.gate.admit(STORE);
    const hook = createFakeHookConnection(
      sent(admission.secret, captured({ hook_event_name: 'PreToolUse' })),
    );

    harness.listener.present(hook.connection);

    expect(harness.events).toEqual([]);
    expect(hook.writes).toEqual([]);
    expect(hook.closed).toBe(true);
  });

  it('answers the blocked hook and settles granted', () => {
    const harness = gate();
    const { hook, approvalId } = blocked(harness);

    const result = harness.gate.decide(approvalId, 'grant');

    expect(result).toEqual({ ok: true, settlement: 'granted' });
    expect(hook.writes).toEqual([encodeClaudePermissionAnswer({ behavior: 'allow' })]);
    expect(hook.closed).toBe(true);
    expect(harness.events.at(-1)).toEqual({
      type: 'approval-settled',
      storeId: STORE,
      sessionId: SESSION,
      approvalId,
      outcome: 'granted',
    });
    // Two frames for the whole life of a request, and neither is a status: what
    // a session is doing stays the provider's own record.
    expect(harness.events.map((event) => event.type)).toEqual([
      'approval-requested',
      'approval-settled',
    ]);
    expect(harness.timers.pending).toBe(0);
  });

  it('answers the blocked hook in the spelling PermissionRequest reads, and settles denied', () => {
    const harness = gate();
    const { hook, approvalId } = blocked(harness);

    const result = harness.gate.decide(approvalId, 'deny');

    expect(result).toEqual({ ok: true, settlement: 'denied' });
    expect(hook.writes).toEqual([
      encodeClaudePermissionAnswer({ behavior: 'deny', message: APPROVAL_DENIAL_MESSAGE }),
    ]);
    // Spelled out rather than only compared with the encoder: `permissionDecision`
    // is the spelling this event ignores silently, and a denial that did nothing
    // is the failure this whole path exists to avoid.
    expect(hook.writes[0]).toContain('"behavior":"deny"');
    expect(harness.events.at(-1)).toMatchObject({ type: 'approval-settled', outcome: 'denied' });
  });

  it('says how long the person took, by this machine’s clock', () => {
    const harness = gate();
    const { approvalId } = blocked(harness);

    harness.advanceBy(12_000);
    harness.gate.decide(approvalId, 'grant');

    // Not on any frame: how long a request waited is the hub's to state from
    // when it heard, because two machines' clocks disagree. Here it is a log
    // line for whoever is reading this machine's own.
    expect(harness.records.at(-1)).toMatchObject({
      message: 'approval settled',
      fields: { approvalId, outcome: 'granted', waitedMs: 12_000 },
    });
  });

  it('refuses a second decision on a request that was already answered', () => {
    const harness = gate();
    const { hook, approvalId } = blocked(harness);
    harness.gate.decide(approvalId, 'grant');

    const second = harness.gate.decide(approvalId, 'deny');

    expect(second).toEqual({ ok: false, reason: 'granted' });
    expect(hook.writes).toHaveLength(1);
    expect(harness.events).toHaveLength(2);
  });

  it('reports a withdrawal when the hook goes away before anybody answers', () => {
    const harness = gate();
    const { hook, approvalId } = blocked(harness);

    hook.disconnect();

    expect(harness.events.at(-1)).toEqual({
      type: 'approval-withdrawn',
      storeId: STORE,
      sessionId: SESSION,
      approvalId,
    });
    expect(harness.gate.decide(approvalId, 'grant')).toEqual({ ok: false, reason: 'withdrawn' });
    expect(hook.writes).toEqual([]);
    expect(harness.timers.pending).toBe(0);
  });

  it('says nothing more when the hook closes after its answer was written', () => {
    const harness = gate();
    const { hook, approvalId } = blocked(harness);
    harness.gate.decide(approvalId, 'grant');

    hook.disconnect();

    expect(harness.events.map((event) => event.type)).toEqual([
      'approval-requested',
      'approval-settled',
    ]);
  });

  it('gives up short of the hook, and says the request expired rather than answering it', () => {
    const harness = gate();
    const { hook, approvalId } = blocked(harness);

    expect(harness.timers.delays).toEqual([APPROVAL_TIMEOUT_MS]);
    expect(APPROVAL_TIMEOUT_MS).toBeLessThan(APPROVAL_HOOK_TIMEOUT_SECONDS * 1_000);

    harness.timers.fireAll();

    expect(harness.events.at(-1)).toEqual({
      type: 'approval-settled',
      storeId: STORE,
      sessionId: SESSION,
      approvalId,
      outcome: 'expired',
    });
    // Nothing written, so the hook's own timeout finds no decision and Claude
    // Code asks in the terminal: the one place an answer can still be given.
    expect(hook.writes).toEqual([]);
    expect(hook.closed).toBe(true);
    expect(harness.gate.decide(approvalId, 'grant')).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a decision on an id it never minted', () => {
    const harness = gate();

    expect(harness.gate.decide('approval-nobody-minted' as ApprovalId, 'grant')).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('calls a decision that could not reach the hook a withdrawal rather than a grant', () => {
    const harness = gate();
    const { approvalId } = blocked(harness, () => {
      throw new Error('this socket is gone');
    });

    const result = harness.gate.decide(approvalId, 'grant');

    expect(result).toEqual({ ok: false, reason: 'withdrawn' });
    expect(harness.events.at(-1)).toMatchObject({ type: 'approval-withdrawn', approvalId });
  });

  it('retires a launch secret, and withdraws what that launch left open', () => {
    const harness = gate();
    const { admission, hook, approvalId } = blocked(harness);

    admission.close();

    expect(harness.events.at(-1)).toMatchObject({ type: 'approval-withdrawn', approvalId });
    expect(hook.writes).toEqual([]);
    expect(hook.closed).toBe(true);

    const second = createFakeHookConnection(sent(admission.secret));
    harness.listener.present(second.connection);
    expect(second.closed).toBe(true);
    expect(harness.events.filter((event) => event.type === 'approval-requested')).toHaveLength(1);
  });

  it('stops listening and withdraws everything still open', () => {
    const harness = gate();
    const { hook, approvalId } = blocked(harness);

    harness.gate.stop();

    expect(harness.listener.closed).toBe(true);
    expect(harness.events.at(-1)).toMatchObject({ type: 'approval-withdrawn', approvalId });
    expect(hook.closed).toBe(true);
    expect(harness.timers.pending).toBe(0);
  });
});
