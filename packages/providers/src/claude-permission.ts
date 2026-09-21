import { displayableApprovalText, sessionIdSchema, type SessionId } from '@agentplex/protocol';
import { z } from 'zod';

/**
 * The two halves of one conversation with Claude Code's `PermissionRequest`
 * hook: what it hands a hook on stdin, and what a hook writes back on stdout.
 *
 * The hook fires before a tool call and blocks it until something answers, so
 * this is where an approval starts and ends. Both halves are parsed and
 * encoded here rather than anywhere else for the reason one parser per
 * protocol direction exists at all: two spellings of an answer would be two
 * behaviours, and one of them is silent. `PreToolUse` takes
 * `permissionDecision`; `PermissionRequest` takes `decision.behavior`, and a
 * payload carrying the wrong one is not refused -- it is ignored, and the tool
 * call falls through to whatever would have happened with no hook at all. An
 * approvals feature whose denials sometimes did nothing, with nothing in any
 * log saying so, is the failure this file is shaped against.
 *
 * What comes out is deliberately four fields and not the payload. Claude Code
 * sends a transcript path, a prompt id, a permission mode and an effort level
 * along with the request, and none of them are anybody's business further up:
 * a transcript path is a path on that machine, and the rule that no frame
 * carries an operation name, an argv element or an env var is kept by the
 * conversion happening here, at the edge, rather than by everything downstream
 * remembering not to look.
 *
 * There is no id among the four, and that is the finding this design rests on:
 * the payload has no `tool_use_id` or anything like it, so nothing the
 * provider says identifies the tool call being asked about. The id an approval
 * is decided by is minted on this side, which is also what makes deciding once
 * possible -- see the approvals feature for what keys on it.
 */

/** The one hook event this file speaks for. Anything else is another protocol. */
export const CLAUDE_PERMISSION_HOOK_EVENT = 'PermissionRequest';

/**
 * How much of a proposal travels.
 *
 * The text is for a person to read before answering, and a person deciding
 * whether to allow a command has decided long before four thousand characters.
 * The bound is what keeps a tool input from setting the size of a frame:
 * `Write` proposes a whole file, `Edit` proposes every edit in a turn, and an
 * approval carrying either in full would be a megabyte crossing two hops so
 * that a browser could show its first line. Above the cap the text says it was
 * cut, because a proposal that silently ended early is one somebody could
 * approve without seeing the part that mattered.
 */
export const PROPOSAL_MAX_CHARS = 4_000;

const TRUNCATION_NOTE = '\n[truncated]';

/** What an agent is asking for, as the hub and its clients need it. */
export interface ClaudePermissionRequest {
  /** The provider's own id for the session, which is half of a session's identity. */
  readonly sessionId: SessionId;
  /** The tool's name as Claude Code spells it: `Bash`, `Edit`, `WebFetch`. */
  readonly tool: string;
  /**
   * Bounded text describing what the tool was asked to do, for a client to
   * render and nothing to act on. It is derived from the tool's input and is
   * not that input: no caller can read an argument back out of it and mean it,
   * which is the point.
   */
  readonly proposal: string;
  /**
   * Whether the proposal above is all of what the tool was asked to do.
   *
   * Said by the one place that knows -- the function that did or did not cut --
   * rather than left for a reader to infer from the `[truncated]` marker. The
   * marker is for a person and sits in text the agent wrote: a command ending
   * in those words would read as cut, and an agent wanting to be taken for one
   * is exactly what would write them.
   *
   * It matters because the cut is lossy in a direction nothing downstream can
   * see. Two tool inputs agreeing for their first few thousand rendered
   * characters produce one identical proposal, so a standing rule made from one
   * grants the other -- a continuation nobody read. Everything that matches a
   * rule against a request is required to refuse when this is `true`.
   */
  readonly truncated: boolean;
  /** What Claude Code offers to remember, if the person wants to stop being asked. */
  readonly suggestions: readonly ClaudePermissionSuggestion[];
}

/**
 * One rule Claude Code offers to add, in its own grammar.
 *
 * Kept as the provider's two strings rather than interpreted. What a rule
 * means -- how `prisma migrate *` matches, which tools take a pattern at all
 * -- is Claude Code's business, and a policy that reasoned about the pattern
 * here would be a second implementation of matching that could disagree with
 * the one doing the matching.
 */
export interface ClaudePermissionRule {
  readonly tool: string;
  readonly content: string;
}

/** A remembered answer Claude Code would accept for requests like this one. */
export interface ClaudePermissionSuggestion {
  readonly behavior: 'allow' | 'deny' | 'ask';
  /** Which settings file Claude Code would write it to. Its vocabulary, not ours. */
  readonly destination: string;
  readonly rules: readonly ClaudePermissionRule[];
}

export type ClaudePermissionParse =
  | { readonly ok: true; readonly request: ClaudePermissionRequest }
  | { readonly ok: false; readonly reason: 'not-json' }
  | { readonly ok: false; readonly reason: 'refused'; readonly problem: string };

/**
 * A suggestion, parsed as far as it is useful and no further.
 *
 * `addRules` is the only type seen, and `behavior` is bounded to the three
 * answers a rule can carry. Both are strict on purpose while the payload
 * around them is loose: a suggestion is a thing a person is offered as "never
 * ask me this again", and one whose behaviour this code did not recognise
 * would be offered without knowing what accepting it does.
 */
const suggestionSchema = z
  .object({
    type: z.literal('addRules'),
    behavior: z.enum(['allow', 'deny', 'ask']),
    destination: z.string().min(1).max(200),
    rules: z.array(
      z
        .object({ toolName: z.string().min(1).max(200), ruleContent: z.string().max(2_000) })
        .loose(),
    ),
  })
  .loose();

/**
 * The payload, read for the fields that are acted on and loose about the rest.
 *
 * Unknown keys are kept rather than rejected, because Claude Code adds fields
 * between releases and a request from a newer CLI has to stay answerable --
 * the alternative is an agent blocked at a prompt nobody can see because
 * agentplex did not recognise a field it had no use for. The fields that *are*
 * read are strict for the opposite reason: each one is a claim this side acts
 * on, and a request with no session id belongs to no session.
 *
 * `hook_event_name` is checked rather than assumed. The same hook command is
 * how the server will be told about other events later, and a parser that
 * accepted any payload with the right-looking fields would read a `PreToolUse`
 * as a permission request and answer it in a spelling that event ignores.
 */
const payloadSchema = z
  .object({
    hook_event_name: z.literal(CLAUDE_PERMISSION_HOOK_EVENT),
    session_id: sessionIdSchema,
    tool_name: z.string().min(1).max(200),
    tool_input: z.record(z.string(), z.unknown()),
    /**
     * Absent on a request Claude Code has nothing to offer for, and every item
     * is read on its own: an unreadable suggestion costs itself and not the
     * request, which would otherwise mean an agent left blocked because one
     * entry in a list of shortcuts was newer than this parser.
     */
    permission_suggestions: z.array(z.unknown()).optional(),
  })
  .loose();

export function parseClaudePermissionRequest(contents: string): ClaudePermissionParse {
  let payload: unknown;
  try {
    payload = JSON.parse(contents);
  } catch {
    return { ok: false, reason: 'not-json' };
  }

  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: 'refused', problem: z.prettifyError(parsed.error) };
  }

  const described = describeToolInput(parsed.data.tool_input);
  return {
    ok: true,
    request: {
      sessionId: parsed.data.session_id,
      tool: displayableApprovalText(parsed.data.tool_name),
      proposal: described.text,
      truncated: described.truncated,
      suggestions: readSuggestions(parsed.data.permission_suggestions ?? []),
    },
  };
}

/** Display text, and whether it is all of what there was. */
interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * The tool's input as lines a person reads, and never as a structure.
 *
 * Every field the tool was given, in the order the provider sent them, one per
 * line: `command: prisma migrate deploy --schema ./db`. Flat text rather than
 * the JSON it came from, deliberately. A client showing an approval wants to
 * show what was proposed, and JSON would invite something between here and
 * there to parse an argument back out and act on it -- which is exactly what a
 * proposal must never be good for.
 *
 * Nothing here knows any tool. A formatter per tool name would read better for
 * the four tools somebody thought of and render nothing at all for the fifth,
 * on the day it shipped, in the one screen whose job is to say what is about
 * to happen.
 */
function describeToolInput(input: Readonly<Record<string, unknown>>): BoundedText {
  const lines = Object.entries(input).map(
    ([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
  return bounded(displayableApprovalText(lines.join('\n')));
}

/**
 * Control characters are not display text, and neither is anything that
 * reorders it.
 *
 * The strip itself is `displayableApprovalText`, in `packages/protocol`, and it
 * is there rather than here for a reason worth keeping in front of whoever
 * moves it back. The standing policy's rules are compared against the proposal
 * this function produces, so the alphabet the proposal is written in and the
 * alphabet a rule is refused for carrying have to be one alphabet: two copies
 * that drifted apart would be a rule matching text a person would have read
 * differently. The argument for removing these characters at all is with the
 * function.
 *
 * It guards the tool name and a suggestion's rule as well as the proposal.
 * All three are text from the same turn and all three are rendered: a tool name
 * is the label above the proposal, and a rule is what a person is offered as
 * "never ask me this again".
 *
 * The cut is reported as well as marked, and the two are not the same claim.
 * The marker is for whoever reads the box; the flag is for whoever has to
 * decide something, because a cut proposal no longer identifies what the tool
 * was asked to do -- every input sharing that prefix renders as these same
 * bytes. Returning the pair is what stops a later reader working the fact out
 * of text the agent wrote most of.
 */
function bounded(text: string): BoundedText {
  if (text.length <= PROPOSAL_MAX_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, PROPOSAL_MAX_CHARS - TRUNCATION_NOTE.length) + TRUNCATION_NOTE,
    truncated: true,
  };
}

function readSuggestions(entries: readonly unknown[]): readonly ClaudePermissionSuggestion[] {
  const suggestions: ClaudePermissionSuggestion[] = [];
  for (const entry of entries) {
    const parsed = suggestionSchema.safeParse(entry);
    if (!parsed.success) continue;
    suggestions.push({
      behavior: parsed.data.behavior,
      destination: parsed.data.destination,
      rules: parsed.data.rules.map((rule) => ({
        tool: displayableApprovalText(rule.toolName),
        content: displayableApprovalText(rule.ruleContent),
      })),
    });
  }
  return suggestions;
}

/**
 * What a hook says back.
 *
 * `interrupt` is the difference between "not that, do something else" and
 * "stop": without it the agent takes the denial as a tool result and carries
 * on, with it the turn ends. A denial is not a killed session either way --
 * the session stays alive and answerable, which is what makes deny a thing a
 * person can do from a phone without ending somebody's work.
 */
export type ClaudePermissionAnswer =
  | { readonly behavior: 'allow' }
  | { readonly behavior: 'deny'; readonly message: string; readonly interrupt?: boolean };

/**
 * The exact bytes a hook writes to stdout, and the only place they are built.
 *
 * Writing nothing is a third answer and is not this function's: exit 0 with an
 * empty stdout means the hook made no decision and Claude Code's own flow
 * resumes, which is what a hook that could not reach the hub has to do rather
 * than guess at an answer nobody gave.
 */
export function encodeClaudePermissionAnswer(answer: ClaudePermissionAnswer): string {
  const decision =
    answer.behavior === 'allow'
      ? { behavior: answer.behavior }
      : {
          behavior: answer.behavior,
          message: answer.message,
          ...(answer.interrupt === undefined ? {} : { interrupt: answer.interrupt }),
        };
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: CLAUDE_PERMISSION_HOOK_EVENT, decision },
  });
}
