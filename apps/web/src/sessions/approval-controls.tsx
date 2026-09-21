import { useState, type JSX, type MouseEvent } from 'react';
import type { ApprovalDecision, ApprovalId, ApprovalOutcome, FrameId } from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Box, Button, Group, Text } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { approvalFollowUp, decideCommand } from './approval-model.js';
import type { SessionListItem } from './session-list-model.js';

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
 */
export interface ApprovalControlsProps {
  readonly item: SessionListItem;
  readonly store: HubStore;
  readonly scheme: Scheme;
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
function outcomeWords(outcome: ApprovalOutcome): string {
  switch (outcome) {
    case 'granted':
      return 'granted';
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
 * correctness in its caller. `session-pane.tsx` already names Approvals among
 * the tabs to come, so there will be a second caller, and one that forgot the
 * key would not fail -- it would show a stale answer above a live one. State
 * that is a claim about a request carries the request's id, and then a mismatch
 * is idle wherever it is mounted.
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
  item,
  store,
  scheme,
  size = 'sm',
}: ApprovalControlsProps): JSX.Element | null {
  const snapshot = useHubSnapshot(store);
  const [answer, setAnswer] = useState<ApprovalAnswer | null>(null);

  const { approval } = item;
  if (approval === null) return null;
  // Read out here rather than inside the handler: a function declaration is
  // hoisted above the guard, so the narrowing does not reach it.
  const { approvalId } = approval;

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

  function decide(event: MouseEvent<HTMLButtonElement>, decision: ApprovalDecision): void {
    // The card around these buttons is a link to the session. Answering is not
    // a navigation, and a person aiming at Allow meant Allow.
    event.preventDefault();
    event.stopPropagation();
    const outcome = store.sendCommand(decideCommand(item.ref, approvalId, decision));
    setAnswer(
      outcome.accepted
        ? { approvalId, frameId: outcome.id, refusal: null }
        : { approvalId, frameId: null, refusal: outcome.reason },
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
          aria-label={`allow ${item.name}`}
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
          aria-label={`deny ${item.name}`}
        >
          Deny
        </Button>
      </Group>
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
        {refused ?? (followUp.kind === 'decided' ? outcomeWords(followUp.outcome) : '')}
      </Text>
    </Box>
  );
}
