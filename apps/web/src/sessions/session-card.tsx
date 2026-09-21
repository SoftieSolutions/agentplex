import { type JSX, type ReactNode } from 'react';
import { Box, Group, Text } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import type { HubStore } from '../store/hub-store.js';
import { sessionHash } from '../terminal/session-route.js';
import { ApprovalControls } from './approval-controls.js';
import type { SessionProject } from './approval-policy-model.js';
import { AttentionControls } from './attention-controls.js';
import { placeLabel, unseenPrompt, type SessionListItem } from './session-list-model.js';
import { SessionMetaLine } from './session-meta-line.js';
import { SessionSummaryLine } from './session-summary-line.js';
import { StopButton } from './stop-button.js';

/**
 * What a card knows about where a session is filed: nothing.
 *
 * One object rather than one per render, so a list of forty cards hands the
 * same value down every time it re-renders.
 */
const UNPLACED: SessionProject = { kind: 'unplaced' };

/**
 * One compact session card, from the approved mockup (turn 7, screens 7a/7e):
 * tone dot, name, where the session is in the monospace face, one summary
 * line, and a provider-and-age line. That meta line is the project and the
 * machine, or the store and the machine where the tree places the session in
 * no project, and it is `placeLabel` rather than a join written here: the
 * sidebar draws the same line about the same session, and a fallback spelled
 * twice is a fallback one of the two will forget.
 *
 * A needs-you card carries the accent border -- the
 * partition is also visible per card -- and its age reads as waiting time.
 *
 * A session holding an open request carries Allow and Deny as well, full
 * width above that last line, and then the waiting clock counts from the
 * moment the hub heard the request rather than from the session's last
 * activity: those are the two readings a person is choosing between, and the
 * one they are waiting on is the request. It is also the honest comparison --
 * the hub's clock against this render's -- where `updatedAt` is the provider's
 * clock on a third machine. A session asking for nothing draws neither, which
 * is every codex session, and a card can be in the needs-you half with no
 * request on it: the status and the request arrive by different routes and
 * this one does not wait for that one.
 *
 * Attention rides on the same card. A muted session is dimmed and keeps
 * everything else -- its tone dot, its accent border, its status, its place in
 * the needs-you partition -- because mute silences the alert and never the
 * fact, and a card that vanished or went grey-status would be the app deciding
 * what a person may see. An acknowledged prompt is the other half: the card
 * drops the accent border and the waiting clock and says it has been seen,
 * without moving, and it comes back the moment the session speaks again --
 * which is the whole reason the acknowledgement is a timestamp.
 *
 * The whole card opens the session, as a real link to the pane's hash address
 * rather than an `onClick`: an anchor is what the browser already makes
 * keyboard reachable, what a middle click opens in a second tab, and what a
 * hover shows the destination of. The link is a stretched overlay rather than
 * a wrapper around the content, because the stop button is inside the card and
 * a button nested inside an anchor is neither valid nor separately operable --
 * the overlay covers the card and the button sits above it.
 */
export interface SessionCardProps {
  readonly item: SessionListItem;
  readonly scheme: Scheme;
  /** The moment the ages on this render are measured against. */
  readonly now: number;
  /** The page's one hub store, for the stop this card may offer. */
  readonly store: HubStore;
  /**
   * What can be done to this card's node, or nothing when the tree does not
   * hold one.
   *
   * Passed in rather than built here, so this stays a component that draws a
   * session and knows nothing about the tree: a session the tree has no node
   * for is a card with no menu, and that is a decision the screen holding the
   * layout makes.
   */
  readonly actions?: ReactNode;
}

export function SessionCard({ item, scheme, now, store, actions }: SessionCardProps): JSX.Element {
  // The accent border follows the unacknowledged prompt rather than the raw
  // needs-you fact: saying "seen" has to do something visible, or nobody will
  // say it twice. Muting deliberately does not touch it -- a muted card is the
  // same card, dimmed.
  const border = unseenPrompt(item)
    ? colorForTone('needs-you', scheme)
    : colorForRole('border', scheme);
  const muted = colorForRole('textMuted', scheme);
  return (
    <Box
      component="article"
      bg={colorForRole('surface', scheme)}
      style={{
        position: 'relative',
        border: `1px solid ${border}`,
        borderRadius: 10,
        padding: '11px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
        // Dimmed, not hidden and not recoloured. Opacity is the one way to say
        // "this is still here and still true, and it is not asking for you"
        // without spending a hue on it -- and it costs the card's own tone
        // nothing, which is what keeps the badge readable.
        opacity: item.muted ? 0.55 : 1,
      }}
    >
      <Box
        component="a"
        href={sessionHash(item.ref)}
        aria-label={`open ${item.name}`}
        style={{ position: 'absolute', inset: 0, borderRadius: 10 }}
      />
      <Group gap={7} wrap="nowrap">
        <Box
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flexShrink: 0,
            background: colorForTone(item.tone, scheme),
          }}
        />
        <Text fw={600} truncate="end" style={{ flex: 1 }} c={colorForRole('text', scheme)}>
          {item.name}
        </Text>
        <Text ff="monospace" fz={10} fw={500} c={muted}>
          {placeLabel(item)}
        </Text>
        {actions}
      </Group>
      <SessionSummaryLine text={item.summary} scheme={scheme} />
      {/* The oldest request this session is holding, named by the session:
          one pair of buttons among a list of other sessions' cards, where the
          session is what tells this one apart. Every other request it is
          holding is on the session screen's Approvals tab. */}
      <ApprovalControls
        sessionRef={item.ref}
        approval={item.approval}
        name={item.name}
        store={store}
        scheme={scheme}
        // A card in a list is handed no tree, so it cannot name the project a
        // rule would be written into and does not offer to write one.
        // Answering the request in front of you is what a card is for; the
        // standing policy is the session screen's panel.
        project={UNPLACED}
      />
      <Group gap={8} wrap="nowrap" justify="space-between" align="center">
        {/* The provider, the age and the qualifications on it, drawn by the
            component the list's row draws too: the judgements in that sentence
            are the same judgements whichever way the fleet is being read. */}
        <SessionMetaLine item={item} scheme={scheme} now={now} />
        {/* Above the link overlay, so the button is the button. It renders
            nothing at all unless the holder says this session can be stopped. */}
        <Box style={{ position: 'relative', flexShrink: 0, display: 'flex', gap: 6 }}>
          <AttentionControls item={item} store={store} scheme={scheme} />
          <StopButton store={store} sessionRef={item.ref} holder={item.holder} scheme={scheme} />
        </Box>
      </Group>
    </Box>
  );
}
