import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROPOSAL_MAX_CHARS,
  encodeClaudePermissionAnswer,
  parseClaudePermissionRequest,
} from './claude-permission.js';

/**
 * The fixture is a captured payload, not a shape written from memory.
 *
 * `capture-claude-permission-fixture.test.ts` beside this file took it from a
 * real `claude` 2.1.278 turn stopped at a real hook, and only paths and the
 * session id were replaced -- with the ones the transcript and registry
 * fixtures already carry, so the captures describe one session on one machine.
 * Every key, every type and every other value is as Claude Code wrote it,
 * including the absence the design turns on: there is no `tool_use_id` on the
 * payload, so nothing in it identifies the tool call, and the id an approval is
 * decided by has to be minted on this side.
 */
const CAPTURED = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'claude-permission-request.json'),
  'utf8',
);

const SESSION_ID = '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde';

/**
 * Bends the captured payload instead of inventing one.
 *
 * The move `claude-registry.test.ts` and `claude-transcript.test.ts` both
 * make: a case this machine did not happen to be in when the capture was taken
 * is reached by changing one value of real output, so every other field stays
 * exactly as the provider writes it.
 */
function captured(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...(JSON.parse(CAPTURED) as Record<string, unknown>), ...overrides });
}

function without(key: string): string {
  const payload = JSON.parse(CAPTURED) as Record<string, unknown>;
  delete payload[key];
  return JSON.stringify(payload);
}

describe('parsing a Claude Code permission request', () => {
  it('reads the captured payload as what an approval is made of', () => {
    const parse = parseClaudePermissionRequest(CAPTURED);
    expect(parse).toStrictEqual({
      ok: true,
      request: {
        sessionId: SESSION_ID,
        tool: 'Bash',
        proposal:
          'command: prisma migrate deploy --schema ./db\ndescription: Apply pending Prisma migrations',
        suggestions: [
          {
            behavior: 'allow',
            destination: 'localSettings',
            rules: [{ tool: 'Bash', content: 'prisma migrate *' }],
          },
        ],
      },
    });
  });

  it('takes no id from the provider, because the payload carries none', () => {
    expect(JSON.parse(CAPTURED)).not.toHaveProperty('tool_use_id');

    const parse = parseClaudePermissionRequest(CAPTURED);
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(Object.keys(parse.request).sort()).toStrictEqual([
      'proposal',
      'sessionId',
      'suggestions',
      'tool',
    ]);
  });

  it('renders a value that is not a string as the data it is', () => {
    const parse = parseClaudePermissionRequest(
      captured({ tool_input: { file_path: '/srv/work/app.ts', edits: [{ old: 'a', new: 'b' }] } }),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.request.proposal).toBe(
      'file_path: /srv/work/app.ts\nedits: [{"old":"a","new":"b"}]',
    );
  });

  it('bounds the proposal, and says so where it cut', () => {
    const parse = parseClaudePermissionRequest(
      captured({ tool_input: { command: 'echo '.repeat(20_000) } }),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.request.proposal.length).toBeLessThanOrEqual(PROPOSAL_MAX_CHARS);
    expect(parse.request.proposal).toMatch(/truncated/);
    expect(parse.request.proposal.startsWith('command: echo echo ')).toBe(true);
  });

  it('keeps no control characters in text meant to be displayed', () => {
    const parse = parseClaudePermissionRequest(
      captured({ tool_input: { command: 'clear\u001b[2J\u0007 && ls' } }),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.request.proposal).toBe('command: clear[2J && ls');
  });

  /**
   * Every character Unicode gives for changing the direction text is read in:
   * the two marks, the four embeddings and overrides, the pop, and the four
   * isolates. Listed rather than described, because the point of the strip is
   * that none of them survives and a range written from memory is how one of
   * them does.
   */
  const BIDI_CONTROLS = [
    '\u061c',
    '\u200e',
    '\u200f',
    '\u202a',
    '\u202b',
    '\u202c',
    '\u202d',
    '\u202e',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
  ];

  it('keeps no direction control in text meant to be displayed', () => {
    const marked = BIDI_CONTROLS.join('');
    const parse = parseClaudePermissionRequest(
      captured({ tool_name: `Ba${marked}sh`, tool_input: { command: `rm -rf /${marked} .` } }),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.request.tool).toBe('Bash');
    expect(parse.request.proposal).toBe('command: rm -rf / .');
  });

  it('keeps none of them in a rule either, which is text from the same turn', () => {
    const parse = parseClaudePermissionRequest(
      captured({
        permission_suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'localSettings',
            rules: [{ toolName: 'Ba\u200fsh', ruleContent: 'prisma \u202emigrate\u202c *' }],
          },
        ],
      }),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.request.suggestions).toStrictEqual([
      {
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ tool: 'Bash', content: 'prisma migrate *' }],
      },
    ]);
  });

  it('reads an override for what it does, which is reorder what a person sees', () => {
    // The attack in one line: what runs is `rm -rf /tmp/x`, and a terminal or a
    // browser honouring the override draws the comment first and the command
    // last, so the line above Allow is not the line that executes.
    const parse = parseClaudePermissionRequest(
      captured({ tool_input: { command: 'rm -rf /tmp/x \u202e# sl eman elif a si siht' } }),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.request.proposal).toBe('command: rm -rf /tmp/x # sl eman elif a si siht');
    for (const control of BIDI_CONTROLS) {
      expect(parse.request.proposal).not.toContain(control);
    }
  });

  it('accepts a tool that proposes nothing', () => {
    const parse = parseClaudePermissionRequest(captured({ tool_input: {} }));
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.request.proposal).toBe('');
  });

  it('reads a request with no suggestions on it', () => {
    const parse = parseClaudePermissionRequest(without('permission_suggestions'));
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.request.suggestions).toStrictEqual([]);
  });

  it('drops a suggestion it cannot read and keeps the ones it can', () => {
    const readable = (JSON.parse(CAPTURED) as { permission_suggestions: unknown[] })
      .permission_suggestions[0];
    const parse = parseClaudePermissionRequest(
      captured({
        permission_suggestions: [
          { type: 'somethingNewer', rules: [] },
          { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'x' },
          { type: 'addRules', rules: [], behavior: 'whenever', destination: 'localSettings' },
          readable,
        ],
      }),
    );
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.request.suggestions).toStrictEqual([
      {
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ tool: 'Bash', content: 'prisma migrate *' }],
      },
    ]);
  });

  it('reads a payload from a newer CLI that carries more than it knows', () => {
    const parse = parseClaudePermissionRequest(captured({ something_new: { added: 'later' } }));
    expect(parse.ok).toBe(true);
  });

  it('refuses what is not JSON at all', () => {
    expect(parseClaudePermissionRequest('')).toStrictEqual({ ok: false, reason: 'not-json' });
    expect(parseClaudePermissionRequest('{"session_id":')).toStrictEqual({
      ok: false,
      reason: 'not-json',
    });
  });

  it('refuses JSON that is not a permission request', () => {
    for (const contents of [
      '"a string"',
      '[]',
      'null',
      captured({ hook_event_name: 'PreToolUse' }),
      captured({ session_id: '' }),
      captured({ tool_name: '' }),
      captured({ tool_input: 'prisma migrate deploy' }),
      without('session_id'),
      without('tool_name'),
      without('tool_input'),
    ]) {
      const parse = parseClaudePermissionRequest(contents);
      expect(parse.ok, contents).toBe(false);
      if (parse.ok) continue;
      expect(parse.reason).toBe('refused');
    }
  });
});

/**
 * The answer schema was verified at the origin the same way the payload was,
 * against claude 2.1.278, and it is not the one `PreToolUse` uses: a
 * `permissionDecision` field is ignored silently and the tool call falls
 * through to whatever would have happened without a hook. That is the failure
 * this encoder exists to make impossible, so the assertions are the exact
 * bytes rather than a shape.
 */
describe('encoding the answer a hook writes to its stdout', () => {
  it('allows in the spelling Claude Code reads', () => {
    expect(encodeClaudePermissionAnswer({ behavior: 'allow' })).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    );
  });

  it('denies with the reason the person gave', () => {
    expect(encodeClaudePermissionAnswer({ behavior: 'deny', message: 'not on production' })).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"not on production"}}}',
    );
  });

  it('interrupts the turn when the denial is meant to stop it', () => {
    expect(
      encodeClaudePermissionAnswer({ behavior: 'deny', message: 'stop', interrupt: true }),
    ).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"stop","interrupt":true}}}',
    );
  });
});
