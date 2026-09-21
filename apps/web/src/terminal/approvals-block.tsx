import { useCallback, useState, useSyncExternalStore, type JSX } from 'react';
import type { ApprovalPolicyRuleId, FrameId } from '@agentplex/protocol';

import {
  EXACT_MATCH_WORDS,
  forgetRuleCommand,
  listPolicyCommand,
  policyFollowUp,
  policyRows,
  type PolicyRow,
  type SessionProject,
} from '../sessions/approval-policy-model.js';
import type { ApprovalPolicyView, HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Box, Button, Group, Stack, Text } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';

/**
 * The APPROVALS block of the context panel (mockups 7c and 7d): not the
 * requests a session is presently blocked on -- those are the tab and the card
 * -- but the standing policy that decides which requests reach a person at all.
 *
 * Three things about it are the ticket rather than the layout.
 *
 * **It is the project's, and a session filed nowhere has no policy.** The rules
 * are keyed by project and never by session, so the honest thing to draw for a
 * session at the root of the tree is a sentence saying there is nowhere for a
 * rule about it to live -- not an empty list, which reads as "nothing has been
 * decided" and invites somebody to decide something here.
 *
 * **The auto half is enumerated and the will-ask half is one sentence.** The
 * table holds grants only: no row means ask, so there is no deny row to draw
 * and no list of will-ask things that could ever be complete. The mockup's
 * third line (`git push · gh pr create · will ask`) is drawn here as the
 * sentence it really is, because an enumeration of three of the infinitely many
 * things that will be asked about reads as the whole of what will be asked
 * about.
 *
 * **The rule text is the request's, untouched.** What the hub compares against
 * is the proposal byte for byte, so this draws it whole, in the monospace face,
 * as characters and never as markup, with its own direction fixed -- the same
 * treatment `approval-controls.tsx` gives the live proposal, and for the same
 * reason: it is the agent's text, not the app's.
 *
 * What it deliberately does not draw is a "granted automatically" marker
 * against a request as it happens. A hub that matches a rule settles the
 * request inside one broadcast flush, so the row carrying that marker usually
 * never reaches a client at all (AGX-129's integration test), and a marker that
 * appears for one auto-grant in twenty would teach a reader that its absence
 * means a person was asked. What this client reliably has is the rule list here
 * and, when this client itself tapped, the `answeredBy` receipt on the
 * decision -- which is where `approval-controls.tsx` says it instead.
 */

/** As tall as one rule's text may get before it scrolls in its own box. */
const RULE_MAX_HEIGHT = 96;

export interface ApprovalsBlockProps {
  /**
   * Where the tree has this session filed: a project, no project, or not yet
   * known. It arrives as a prop rather than being looked up here because it is
   * a fact about the tree and not about this block, and the pane already holds
   * the tree for the header beside it.
   */
  readonly project: SessionProject;
  readonly store: HubStore;
  readonly scheme: Scheme;
}

/**
 * What this block last asked the hub to change, and which rule that was about.
 *
 * Keyed by rule for the reason the approval controls' answer is keyed by
 * request: a block holds several rules and one of these, so a removal in
 * flight must disable its own row and no other. `frameId` is the frame the hub
 * owes an answer for and `refusal` is the store declining to send at all;
 * exactly one of them is set.
 */
interface RuleEdit {
  readonly ruleId: ApprovalPolicyRuleId;
  readonly frameId: FrameId | null;
  readonly refusal: string | null;
}

/**
 * The project's policy, with this block's read of it declared.
 *
 * `useSyncExternalStore` and not an effect, the way `useTerminalWatch` declares
 * a terminal: subscribing is what asking means here, the store is already the
 * external store, and the answer is read back out of its snapshot rather than
 * held in state that a second tab's edit could not reach.
 *
 * The read is a command and not standing interest, which is step three's
 * decision and still the right one: a policy is a question somebody asked by
 * opening a panel. It queues over a blink like any other command, so a block
 * that opens while the socket is down asks the moment it comes back.
 */
function usePolicy(store: HubStore, project: SessionProject): ApprovalPolicyView | null {
  const id = project.kind === 'project' ? project.id : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (id !== null) store.sendCommand(listPolicyCommand(id));
      return store.subscribe(listener);
    },
    [store, id],
  );
  return useSyncExternalStore(subscribe, () =>
    id === null ? null : (store.getSnapshot().approvalPolicies.get(id) ?? null),
  );
}

export function ApprovalsBlock({ project, store, scheme }: ApprovalsBlockProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  const policy = usePolicy(store, project);
  const [edit, setEdit] = useState<RuleEdit | null>(null);

  const rows = policyRows(project, policy);
  const auto = rows.filter(
    (row): row is Extract<PolicyRow, { kind: 'auto' }> => row.kind === 'auto',
  );
  const sentences = rows.filter((row) => row.kind !== 'auto');
  const followUp = policyFollowUp(edit?.frameId ?? null, policy, snapshot.lastRefusal);
  const refused = followUp.kind === 'refused' ? followUp.words : (edit?.refusal ?? null);

  function forget(ruleId: ApprovalPolicyRuleId): void {
    if (project.kind !== 'project') return;
    const outcome = store.sendCommand(forgetRuleCommand(project.id, ruleId));
    setEdit(
      outcome.accepted
        ? { ruleId, frameId: outcome.id, refusal: null }
        : { ruleId, frameId: null, refusal: outcome.reason },
    );
  }

  return (
    <Stack gap={8}>
      {auto.length > 0 && (
        <Stack
          component="ul"
          // Named with the project, because that is the one fact about this
          // list a reader cannot get from the heading above it: the rules are
          // the project's and apply to every session filed under it, not to
          // the session this pane happens to be open on.
          aria-label={`rules in ${project.kind === 'project' ? project.label : ''}`}
          gap={8}
          style={{ margin: 0, padding: 0, listStyle: 'none' }}
        >
          {auto.map((row) => (
            <Box component="li" key={row.ruleId}>
              <Group gap={6} wrap="nowrap" align="flex-start">
                <Text
                  ff="monospace"
                  fz={10}
                  fw={500}
                  c={colorForRole('textMuted', scheme)}
                  // Wrapped rather than truncated, the way the live request's
                  // tool name is: an MCP name differs from its neighbours at
                  // the end, which is the half an ellipsis takes.
                  dir="ltr"
                  style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
                >
                  {row.tool}
                </Text>
                <Button
                  size="compact-xs"
                  variant="default"
                  // The tool names it, and the row's own text is what tells two
                  // rules for one tool apart -- a label carrying the whole
                  // proposal would be a screen reader reading a command out
                  // twice before saying what the button does.
                  aria-label={`forget the rule for ${row.tool}`}
                  disabled={edit?.ruleId === row.ruleId && followUp.kind === 'waiting'}
                  onClick={() => forget(row.ruleId)}
                  style={{ flex: 'none' }}
                >
                  Forget
                </Button>
              </Group>
              <Text
                component="pre"
                ff="monospace"
                fz={11}
                c={colorForRole('text', scheme)}
                // The agent's words, so the base direction is fixed here rather
                // than left to the characters in them: the provider's parser
                // removes the direction controls, and this confines what any
                // that survived could reach to this element.
                dir="ltr"
                style={{
                  margin: 0,
                  marginTop: 4,
                  background: colorForRole('background', scheme),
                  borderRadius: 6,
                  padding: '6px 8px',
                  // The column is 300 fixed pixels and cannot grow: a long
                  // unbroken argument breaks rather than pushing the panel over
                  // the terminal, the provider's newlines are kept, and a tall
                  // rule scrolls in its own box rather than in the panel's.
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  maxHeight: RULE_MAX_HEIGHT,
                  overflowY: 'auto',
                }}
              >
                {row.proposal}
              </Text>
            </Box>
          ))}
        </Stack>
      )}

      {sentences.map((row) => (
        <Text key={row.kind} fz={11} c={colorForRole('textSecondary', scheme)}>
          {row.words}
        </Text>
      ))}

      {/* What exact means, said wherever there is a policy to be exact about.
          A reader who assumes a rule is a pattern has assumed a policy broader
          than the one they have, which is the one direction this block must
          never be wrong in. */}
      {policy !== null && project.kind === 'project' && (
        <Text fz={11} c={colorForRole('textFaint', scheme)}>
          {EXACT_MATCH_WORDS}
        </Text>
      )}

      {/* Mounted before it has anything to say, and empty until it does: a
          refusal is then an update to a region a screen reader is already on
          rather than a sentence appearing somewhere it was not looking. */}
      <Text
        role="status"
        fz={11}
        style={{
          color:
            refused === null ? colorForRole('textMuted', scheme) : colorForTone('blocked', scheme),
        }}
      >
        {refused ?? ''}
      </Text>
    </Stack>
  );
}
