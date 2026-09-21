import type { JSX } from 'react';
import type { SessionRef } from '@agentplex/protocol';

import { ApprovalControls } from '../sessions/approval-controls.js';
import type { SessionProject } from '../sessions/approval-policy-model.js';
import type { SessionApproval } from '../sessions/session-list-model.js';
import { Box, Stack } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { HubStore } from '../store/hub-store.js';

/**
 * The Approvals tab of the session screen (mockup 7c): every request this one
 * session is presently blocked on, each with the same Allow and Deny the card
 * carries.
 *
 * It exists because the card cannot grow. A card has room for one request and
 * shows the oldest, which is the right one to show when there is room for one;
 * an agent stopped on three is stopped three times, and answering only the
 * longest-waiting of them and waiting for the list to shuffle is not a way to
 * unblock it. This tab is the place where all of them are answerable, so the
 * card can go on being a card.
 *
 * What it draws per request is `ApprovalControls` and nothing of its own. The
 * card's pair and this one are the same component because they are the same
 * decision -- one command, allowed or denied, once -- and a second pair of
 * buttons written for this surface is how two surfaces end up disagreeing about
 * what a refusal means or which endings are not a denial. The answer state is
 * per `approvalId` inside that component, which is what makes three of them on
 * one screen three independent answers.
 *
 * What it does not draw is the policy the provider suggested alongside each
 * request. `SessionApproval` does not carry it, and that is the line this tab
 * holds: a suggestion is the provider's idea of a pattern (`prisma migrate *`),
 * and agreeing to one while tapping through a queue is how a person grants a
 * shape they never read.
 *
 * The control it does carry is the other kind. "Always allow this exact
 * request in <project>" is made from the tool and the proposal in front of the
 * person, whole, with nothing to widen -- so it is offered wherever Allow and
 * Deny are, including here, and the panel's APPROVALS block is where the rules
 * it writes are read back and taken out again.
 *
 * The list is never empty. The pane offers this tab only while the session is
 * holding a request and falls back to the Terminal the moment the last one
 * settles, off the same array this is handed -- so an empty state here would be
 * unreachable code standing in for a screen nobody can open.
 */

export interface ApprovalsTabProps {
  /** The session every request in the list belongs to. */
  readonly sessionRef: SessionRef;
  /** Oldest first, as `approvalsOldestFirst` orders them. Never empty. */
  readonly approvals: readonly SessionApproval[];
  /**
   * Where the tree has this session filed, passed straight through to the
   * controls: it is what decides whether "always allow this exact request in
   * <project>" is offered beside each Allow and Deny.
   */
  readonly project: SessionProject;
  readonly store: HubStore;
  readonly scheme: Scheme;
}

export function ApprovalsTab({
  sessionRef,
  approvals,
  project,
  store,
  scheme,
}: ApprovalsTabProps): JSX.Element {
  const border = `1px solid ${colorForRole('border', scheme)}`;
  return (
    <Stack
      component="ul"
      // A list, so that somebody reading this with a screen reader is told how
      // many things are waiting and which one they are on before they decide
      // anything. The words are the tab's own, because the heading above it is
      // the tab and the count on it.
      aria-label="pending approvals"
      gap={0}
      style={{
        flex: 1,
        // The tab scrolls; the pane around it does not. A session holding a
        // dozen requests must not push the steer bar off the bottom of the
        // pane, which is the one control that is on every tab.
        minHeight: 0,
        overflowY: 'auto',
        margin: 0,
        padding: 0,
        listStyle: 'none',
      }}
    >
      {approvals.map((approval, index) => (
        <Box
          component="li"
          // The request's own id and not its position: a request that settles
          // takes its element with it, and the ones below it keep the answers
          // they already hold rather than inheriting the answer of whatever
          // used to be at their index.
          key={approval.approvalId}
          px={18}
          py={14}
          style={{ borderBottom: index === approvals.length - 1 ? undefined : border }}
        >
          <ApprovalControls
            sessionRef={sessionRef}
            approval={approval}
            // The tool, not the session: every pair on this tab answers for
            // one session, so the session's name would label all of them the
            // same and name nothing.
            name={approval.tool}
            project={project}
            store={store}
            scheme={scheme}
          />
        </Box>
      ))}
    </Stack>
  );
}
