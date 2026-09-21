import { useState, type JSX, type MouseEvent } from 'react';
import type {
  ApprovalDecision,
  ApprovalId,
  ApprovalOutcome,
  FrameId,
  SessionRef,
} from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Box, Button, Group, Text } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { approvalFollowUp, decideCommand } from './approval-model.js';
import {
  allowAlwaysCommand,
  policyFollowUp,
  TOO_LONG_TO_REMEMBER_WORDS,
  type SessionProject,
} from './approval-policy-model.js';
import type { SessionApproval } from './session-list-model.js';

/**
 * The one thing a blocked agent is waiting for: the command it says it wants
 * to run, and two words back.
 *
 * Shaped after `attention-controls.tsx`, and for the same reasons: it owns
 * nothing but what it did about the request in front of it, the facts it draws
 * come off the session row every tab is sent, and an unanswered frame leaves
 * both controls disabled rather than inviting a second answer to one question.
 * Everything it decides comes from `approval-model.ts`. What it owns is named
 * for the request rather than the card, because the card outlives the request
 * -- see `ApprovalAnswer`.
 *
 * Two things are its own. The proposal is the agent's claim about what it
 * wants to run: it is drawn as characters in the monospace face, in a box
 * that wraps and scrolls rather than widening the card, and there is nothing
 * on this surface to edit it with -- a field holding the command would be one
 * keystroke between a client and what the agent runs, which is the rule about
 * argv elements defeated by the one path built to carry a command as text.
 * And the answer is four endings rather than a yes: `withdrawn` and `expired`
 * are the two where somebody answered and nothing came of it, and reporting
 * either as a denial would be telling a person they refused something they
 * did not.
 *
 * A session holding no request draws nothing at all, which is every codex
 * session -- it has no permission hook to ask through -- and every claude one
 * that is not presently asking.
 *
 * It takes one request and not the row it came off, and that is what let the
 * Approvals tab (AGX-129) reuse it whole rather than grow a second pair of
 * buttons beside the card's: a card draws the oldest request on a session, the
 * tab draws every request on one session, and both are this component handed
 * one narrowed request and told which session it belongs to.
 */
export interface ApprovalControlsProps {
  /** The session the decision names. A decision is about a request on a row. */
  readonly sessionRef: SessionRef;
  /**
   * The one request this pair answers, already narrowed by
   * `approvalsOldestFirst` -- so the suggestions are not here to be read, and
   * neither surface can hand a policy change to a pair of buttons that promise
   * to answer one command.
   *
   * `null` draws nothing at all: every codex session, which has no permission
   * hook to ask through, and every claude one that is not presently asking.
   */
  readonly approval: SessionApproval | null;
  /**
   * What the buttons say they are answering, in the words that tell this pair
   * apart from the ones beside it.
   *
   * The session on a card, where one request stands for a session among other
   * sessions; the tool on the Approvals tab, where several requests for one
   * session are drawn at once and the session's name would label every pair the
   * same. Each surface names the thing that varies down its own list.
   */
  readonly name: string;
  readonly store: HubStore;
  readonly scheme: Scheme;
  /**
   * Where the tree has this session filed, which decides whether there is a
   * third control at all.
   *
   * A rule lives in one project's policy, so a surface that cannot name a
   * project has nothing to offer: `unfiled` is a session with nowhere to keep
   * one and `unplaced` is a surface that does not know -- the card in a list,
   * which is handed no tree -- and both draw Allow and Deny and nothing else. A
   * button that could only fail, or that named the wrong project, is worse than
   * no button.
   */
  readonly project: SessionProject;
  /**
   * Mantine's size scale. The default is one step above the card's other
   * buttons on purpose: this pair is drawn full width at both breakpoints, and
   * the phone form (mockup 7e) is where a decision gets made one-handed.
   */
  readonly size?: string;
}

/**
 * What each ending is called, in words a person can act on.
 *
 * Four sentences because there are four endings and they mean different
 * things to whoever tapped. `granted` and `denied` are an answer that took
 * effect and may not be this person's -- deciding once is what the id is for.
 * The other two are the request ending with nothing decided, and they say so.
 */
function outcomeWords(outcome: ApprovalOutcome, answeredBy: unknown): string {
  switch (outcome) {
    case 'granted':
      // The hub's receipt, and the one place a client reliably learns that an
      // automatic grant happened: a rule that matches settles the request
      // inside one broadcast flush, so the marker on the row usually reaches
      // nobody. Saying "granted" here for a grant a standing rule made would
      // credit a tap for something the policy had already decided.
      return answeredBy === null
        ? 'granted'
        : "granted by this project's standing policy, not by this tap";
    case 'denied':
      return 'denied';
    case 'withdrawn':
      return 'withdrawn: the agent is no longer asking';
    case 'expired':
      return 'expired: the agent stopped waiting before this answer reached it';
  }
}

/**
 * What this client did about one request, and which request that was.
 *
 * The id is the whole point of keeping it in one object. A card outlives the
 * request on it -- the session stays in the list, the element keeps its place,
 * and the hub reports the next request on the same row -- so state that
 * remembered only "a decision was sent" would answer a question that has been
 * replaced: both buttons dead and the last request's ending underneath the new
 * proposal, with nothing that ever clears it.
 *
 * Tied to the request here rather than by keying the element on `approvalId`
 * where the card mounts it, which would work and would put this component's
 * correctness in its caller. The Approvals tab is that second caller, and it
 * mounts one of these per open request on one session: a caller that forgot the
 * key would not fail -- it would show a stale answer above a live one. State
 * that is a claim about a request carries the request's id, and then a mismatch
 * is idle wherever it is mounted, which is also what keeps the tab's answers
 * apart from each other.
 *
 * Both fields describe the same send: `frameId` is the frame the hub owes an
 * answer for, and `refusal` is the store declining to send at all -- an
 * overflowed queue, a failed connection. Exactly one of them is set.
 */
interface ApprovalAnswer {
  readonly approvalId: ApprovalId;
  readonly frameId: FrameId | null;
  readonly refusal: string | null;
}

export function ApprovalControls({
  sessionRef,
  approval,
  name,
  store,
  scheme,
  project,
  size = 'sm',
}: ApprovalControlsProps): JSX.Element | null {
  const snapshot = useHubSnapshot(store);
  const [answer, setAnswer] = useState<ApprovalAnswer | null>(null);
  const [rule, setRule] = useState<ApprovalAnswer | null>(null);

  if (approval === null) return null;
  // Read out here rather than inside the handler: a function declaration is
  // hoisted above the guard, so the narrowing does not reach it.
  const { approvalId } = approval;
  // The two fields a rule is made of, read out here for the same reason: a
  // function declaration is hoisted above the guard, so the narrowing does not
  // reach it. Copied rather than passed whole, so that nothing a rule is made
  // from can be an id or a suggestion.
  const request = { tool: approval.tool, proposal: approval.proposal };

  // An answer to some other request is not this one's business. Not cleared
  // either: there is nothing to clear it from, and a stale object that matches
  // nothing is already idle.
  const sent = answer !== null && answer.approvalId === approvalId ? answer : null;
  const followUp = approvalFollowUp(
    sent?.frameId ?? null,
    snapshot.lastApproval,
    snapshot.lastRefusal,
  );
  const refused = followUp.kind === 'refused' ? followUp.words : (sent?.refusal ?? null);
  // Disabled while the hub has not answered, and once it has: a request that
  // has ended has ended, and a live Allow over a settled one would be a button
  // whose press can do nothing. A refusal re-enables them, because a refusal
  // is the hub saying it did not read the frame -- the request is still open.
  const spent = followUp.kind === 'waiting' || followUp.kind === 'decided';

  /**
   * Whether there is a rule to be made of this request at all.
   *
   * A project to keep one in, and a proposal that is the whole of what was
   * proposed. A cut proposal is the text of every request that starts the same
   * way, so the hub will not match a rule against one and refuses to store one
   * -- and offering a control whose only outcome is that refusal would be this
   * screen promising something it cannot do. The sentence underneath says what
   * happens instead, which is the part a person can act on.
   */
  const rememberable = project.kind === 'project' && !approval.truncated;

  /**
   * The rule half of "always allow", kept apart from the request half all the
   * way to the screen.
   *
   * Two sends, two frames, two answers, two sentences. Folding them into one
   * would mean saying something about a half nobody has answered: a refused
   * rule over a granted request must not read as a request that went nowhere,
   * and a granted request must not imply a rule was saved.
   */
  const written = rule !== null && rule.approvalId === approvalId ? rule : null;
  const rulePolicy =
    project.kind === 'project' ? (snapshot.approvalPolicies.get(project.id) ?? null) : null;
  const ruleFollowUp = policyFollowUp(written?.frameId ?? null, rulePolicy, snapshot.lastRefusal);
  const ruleWords =
    ruleFollowUp.kind === 'refused'
      ? `the rule was not added: ${ruleFollowUp.words}`
      : ruleFollowUp.kind === 'done' && project.kind === 'project'
        ? `saved in ${project.label}: this exact request will not be asked again`
        : (written?.refusal ?? '');

  function decide(event: MouseEvent<HTMLButtonElement>, decision: ApprovalDecision): boolean {
    // The card around these buttons is a link to the session. Answering is not
    // a navigation, and a person aiming at Allow meant Allow.
    event.preventDefault();
    event.stopPropagation();
    const outcome = store.sendCommand(decideCommand(sessionRef, approvalId, decision));
    setAnswer(
      outcome.accepted
        ? { approvalId, frameId: outcome.id, refusal: null }
        : { approvalId, frameId: null, refusal: outcome.reason },
    );
    return outcome.accepted;
  }

  /**
   * Both halves of "always allow this exact request", in the order that costs
   * least when one of them fails.
   *
   * The grant goes first because it is what the blocked agent is waiting for
   * and because a rule cannot answer it: the hub matches its rows at the moment
   * a request arrives, so a rule written now applies to the next request like
   * this one and never to this one. Writing the rule first would therefore buy
   * nothing and would leave the person who tapped with a standing grant and a
   * still-blocked agent if the second send failed.
   *
   * The rule is not sent at all when the store would not take the grant. That
   * is the one case where the two are not independent: the store refuses on a
   * dead connection or a full queue, and a rule written for a request nobody
   * answered is a standing grant made in a moment the person could not see the
   * outcome of.
   */
  function alwaysAllow(event: MouseEvent<HTMLButtonElement>): void {
    // The same pair of facts the control is drawn on, restated where the send
    // happens: a handler that trusted its button not to exist would be one
    // line from writing a rule for a request nobody could read whole.
    if (project.kind !== 'project' || approval === null || approval.truncated) return;
    if (!decide(event, 'grant')) {
      setRule({
        approvalId,
        frameId: null,
        refusal: 'no rule was added: this request was not answered',
      });
      return;
    }
    const outcome = store.sendCommand(allowAlwaysCommand(project.id, request));
    setRule(
      outcome.accepted
        ? { approvalId, frameId: outcome.id, refusal: null }
        : { approvalId, frameId: null, refusal: `the rule was not added: ${outcome.reason}` },
    );
  }

  return (
    // Its own stacking context above the card's stretched link overlay, and a
    // full-width column: the pair is the same at both breakpoints, which is
    // what keeps the card one component (mockup 7a and 7e).
    <Box
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
      }}
    >
      <Text
        ff="monospace"
        fz={10}
        fw={500}
        c={colorForRole('textMuted', scheme)}
        // Wrapped rather than truncated, and for the same reason the proposal
        // is: an MCP tool name is a server and a tool joined by underscores,
        // long, unbroken, and different from its neighbours at the end -- which
        // is the half an ellipsis takes. A second line costs less than a name
        // that could be any of four. `dir` for the reason the proposal has it:
        // this is the agent's word too.
        dir="ltr"
        style={{ overflowWrap: 'anywhere' }}
      >
        {approval.tool}
      </Text>
      <Text
        component="pre"
        ff="monospace"
        fz={11}
        c={colorForRole('text', scheme)}
        // Stated rather than inherited, and it is the smaller half of the
        // answer. Removing the direction controls is the provider parser's job
        // and is what actually stops a proposal rendering in an order other
        // than the one that runs; `dir` fixes the base level of the box so that
        // agent text cannot decide it, and confines what any control that did
        // survive can reach to this element. A command runs left to right, so
        // it is read left to right.
        dir="ltr"
        style={{
          margin: 0,
          background: colorForRole('background', scheme),
          borderRadius: 6,
          padding: '7px 9px',
          // Kept whole and kept inside: newlines are the provider's, a long
          // unbroken argument breaks rather than pushing the card wide, and a
          // proposal taller than this scrolls in its own box. The wire bounds
          // it at 4000 characters, so there is no length this cannot hold.
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          maxHeight: 132,
          overflowY: 'auto',
        }}
      >
        {approval.proposal}
      </Text>
      <Group gap={6} grow wrap="nowrap">
        <Button
          size={size}
          disabled={spent}
          onClick={(event) => decide(event, 'grant')}
          aria-label={`allow ${name}`}
        >
          Allow
        </Button>
        <Button
          size={size}
          // The accent says which of the two the app is pointing at; Deny is
          // the default chrome beside it. No second hue: a denial is an
          // ordinary answer, not an error.
          variant="default"
          disabled={spent}
          onClick={(event) => decide(event, 'deny')}
          aria-label={`deny ${name}`}
        >
          Deny
        </Button>
      </Group>
      {/**
       * The third answer: this one, and every request whose text is exactly
       * this one, in one named project.
       *
       * Under the pair rather than beside it, and full width, because it is
       * the longest-lived of the three -- Allow answers a question and this
       * answers every question like it -- and because it must be read before
       * it is pressed. It is drawn only where a project can be named, so the
       * words on it always say which policy is being written to.
       */}
      {rememberable && project.kind === 'project' && (
        <Button
          size={size}
          variant="default"
          disabled={spent}
          onClick={alwaysAllow}
          aria-label={`always allow this exact request in ${project.label}: ${name}`}
        >
          Always allow this exact request in {project.label}
        </Button>
      )}
      {/**
       * What stands there instead when the proposal above was cut to fit.
       *
       * A sentence and not a disabled button: a control nobody can use invites
       * a second press and says nothing about why. This says what will happen
       * -- this request reaches a person every time -- which is the thing a
       * reader can act on, and it is drawn only where the control would have
       * been, so a session with nowhere to keep a rule is not told twice.
       */}
      {project.kind === 'project' && approval.truncated && (
        <Text fz={11} c={colorForRole('textMuted', scheme)}>
          {TOO_LONG_TO_REMEMBER_WORDS}
        </Text>
      )}
      {/* Mounted before it has anything to say, and empty until it does: an
          outcome is then an update to a region a screen reader is already on,
          rather than a sentence appearing somewhere it was not looking. */}
      <Text
        role="status"
        fz={11}
        style={{
          color:
            refused === null ? colorForRole('textMuted', scheme) : colorForTone('blocked', scheme),
        }}
      >
        {refused ??
          (followUp.kind === 'decided'
            ? outcomeWords(followUp.outcome, snapshot.lastApproval?.answeredBy ?? null)
            : '')}
      </Text>
      {/**
       * The rule's own region, mounted for the same reason and kept separate
       * for a stronger one: it reports a second frame, and a person who tapped
       * once is owed both answers rather than whichever arrived last.
       *
       * Mounted where a rule could be written, which is not quite where a
       * project exists: there is no second frame to report for a request whose
       * control was withheld, so an empty region beside the sentence saying
       * why would be a place an answer might still appear.
       */}
      {rememberable && (
        <Text
          role="status"
          fz={11}
          style={{
            color: ruleWords.startsWith('the rule was not added')
              ? colorForTone('blocked', scheme)
              : colorForRole('textMuted', scheme),
          }}
        >
          {ruleWords}
        </Text>
      )}
    </Box>
  );
}
