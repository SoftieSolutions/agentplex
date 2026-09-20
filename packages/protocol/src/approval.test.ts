import { describe, expect, it } from 'vitest';
import {
  APPROVAL_PROPOSAL_MAX_CHARS,
  approvalDecisionSchema,
  approvalIdSchema,
  approvalOutcomeSchema,
  approvalRequestSchema,
  approvalSettlementSchema,
  approvalSuggestionSchema,
  pendingApprovalSchema,
} from './approval.js';

/**
 * Hand-written, like every other fixture in this package and for the reason
 * `machine-state.test.ts` states: the subject is the parser, and a fixture
 * recorded from the thing being parsed could only ever agree with it. The
 * shapes here are the ones `packages/providers` produces from a real captured
 * payload, restated as the wire's own claim about what it accepts.
 */
const A_REQUEST = {
  approvalId: 'approval-7f21',
  tool: 'Bash',
  proposal: 'command: prisma migrate deploy --schema ./db\ndescription: run the migrations',
  suggestions: [
    {
      behavior: 'allow',
      destination: 'projectSettings',
      rules: [{ tool: 'Bash', content: 'prisma migrate deploy:*' }],
    },
  ],
};

describe('approvalRequestSchema', () => {
  it('accepts what a server reports about one blocked tool call', () => {
    expect(approvalRequestSchema.safeParse(A_REQUEST).success).toBe(true);
  });

  it('accepts a request nothing is offered for', () => {
    // A provider with no shortcut to suggest still has a question to ask.
    // Present and empty rather than absent, so every request has one shape.
    expect(approvalRequestSchema.safeParse({ ...A_REQUEST, suggestions: [] }).success).toBe(true);
  });

  it('refuses a request with no suggestions field at all', () => {
    const { suggestions: _dropped, ...withoutSuggestions } = A_REQUEST;
    expect(approvalRequestSchema.safeParse(withoutSuggestions).success).toBe(false);
  });

  it('refuses an approval with no id, because the id is what a decision names', () => {
    expect(approvalRequestSchema.safeParse({ ...A_REQUEST, approvalId: '' }).success).toBe(false);
  });

  it('bounds the proposal, so a tool input cannot set the size of a frame', () => {
    const atTheBound = { ...A_REQUEST, proposal: 'x'.repeat(APPROVAL_PROPOSAL_MAX_CHARS) };
    const overIt = { ...A_REQUEST, proposal: 'x'.repeat(APPROVAL_PROPOSAL_MAX_CHARS + 1) };
    expect(approvalRequestSchema.safeParse(atTheBound).success).toBe(true);
    expect(approvalRequestSchema.safeParse(overIt).success).toBe(false);
  });

  it('accepts a proposal with nothing in it', () => {
    // A tool called with no input proposes nothing, and a parser that refused
    // that would leave an agent blocked at a prompt nobody can answer.
    expect(approvalRequestSchema.safeParse({ ...A_REQUEST, proposal: '' }).success).toBe(true);
  });

  it('carries no tool input, no argv, no env and no cwd', () => {
    // The proposal is what a person reads. The structure it was derived from
    // stays on the machine that read it: anything that arrived here could be
    // parsed back out into an argument by something downstream, which is
    // exactly what a proposal must never be good for.
    const result = approvalRequestSchema.safeParse({
      ...A_REQUEST,
      toolInput: { command: 'rm -rf /' },
      cwd: '/srv/work',
      env: { PATH: '/usr/bin' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).not.toHaveProperty('toolInput');
    expect(result.data).not.toHaveProperty('cwd');
    expect(result.data).not.toHaveProperty('env');
  });
});

describe('approvalSuggestionSchema', () => {
  it("keeps a rule as the provider's own two strings", () => {
    const result = approvalSuggestionSchema.safeParse({
      behavior: 'deny',
      destination: 'userSettings',
      rules: [{ tool: 'WebFetch', content: 'domain:example.com' }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rules[0]).toEqual({ tool: 'WebFetch', content: 'domain:example.com' });
  });

  it('refuses a behaviour outside the three a rule can carry', () => {
    // A suggestion is offered to a person as "never ask me this again", and one
    // whose behaviour nothing here recognises would be offered without anybody
    // knowing what accepting it does.
    expect(
      approvalSuggestionSchema.safeParse({
        behavior: 'always-allow',
        destination: 'userSettings',
        rules: [],
      }).success,
    ).toBe(false);
  });
});

describe('pendingApprovalSchema', () => {
  it('dates the request with the moment it arrived', () => {
    expect(
      pendingApprovalSchema.safeParse({ ...A_REQUEST, requestedAt: 1_756_000_000_000 }).success,
    ).toBe(true);
  });

  it('refuses an undated one, because a wait with no start is not a wait', () => {
    expect(pendingApprovalSchema.safeParse(A_REQUEST).success).toBe(false);
  });
});

describe('the approval vocabulary', () => {
  it('offers two decisions and no third', () => {
    expect(approvalDecisionSchema.options).toEqual(['grant', 'deny']);
  });

  it('names the four ways an approval can end', () => {
    expect(approvalOutcomeSchema.options).toEqual(['granted', 'denied', 'withdrawn', 'expired']);
  });

  it('lets a server settle an approval in three of them, never in a withdrawal', () => {
    // A withdrawal is the agent taking the question back and has a frame of its
    // own. What a settlement says is what happened at the hook, which is the
    // one thing the machine running it can state and the hub cannot.
    expect(approvalSettlementSchema.options).toEqual(['granted', 'denied', 'expired']);
    expect(approvalSettlementSchema.safeParse('withdrawn').success).toBe(false);
  });

  it('brands an approval id, so nothing passes a session id where one belongs', () => {
    expect(approvalIdSchema.safeParse('approval-7f21').success).toBe(true);
    expect(approvalIdSchema.safeParse('').success).toBe(false);
  });
});
