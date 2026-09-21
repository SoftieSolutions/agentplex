import { type JSX, type ReactNode } from 'react';
import { Box, Text } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import type { HubStore } from '../store/hub-store.js';
import { sessionHash } from '../terminal/session-route.js';
import { AttentionControls } from './attention-controls.js';
import { placeLabel, unseenPrompt, type SessionListItem } from './session-list-model.js';
import { SessionMetaLine } from './session-meta-line.js';
import { SessionSummaryLine } from './session-summary-line.js';
import { StopButton } from './stop-button.js';

/**
 * The session list's other reading: one session on one line.
 *
 * The mockups draw the toggle and never draw the list it switches to, so this
 * is deliberately a re-layout of the card and not an occasion to say anything
 * new. It carries the card's facts in the card's own reading order -- who,
 * where, what it is doing, how old -- and it carries no column the card
 * cannot fill: a fact the grid has no room for is a fact this app does not
 * have, and the approvals affordances the mockup sketches are absent here for
 * the same reason they are absent on the card.
 *
 * What it does differently is what one line demands. Every fact truncates
 * rather than wrapping, and the row itself clips: a row that wrapped would be
 * a two-line row, and a row that scrolled sideways would hide the controls at
 * its end behind a gesture nobody makes on a list. The summary takes the slack
 * because it is the longest and the least costly to cut -- a path loses its
 * head, where a name or a machine loses its identity.
 *
 * The affordances are the card's, and the same components: the whole row is
 * the link to the session, as a stretched anchor rather than a wrapper, and
 * the node menu, the attention controls and the stop button sit together in a
 * positioned box above that overlay. That grouping is the one departure from
 * the card's placement -- the card keeps its menu up beside the name -- and it
 * is what makes "pressing a control never navigates" one rule about one box
 * instead of a claim about three scattered elements.
 */
export interface SessionRowProps {
  readonly item: SessionListItem;
  readonly scheme: Scheme;
  /** The moment the age on this render is measured against. */
  readonly now: number;
  /** The page's one hub store, for the stop and the attention this row offers. */
  readonly store: HubStore;
  /**
   * What can be done to this row's node, or nothing when the tree holds none.
   * Passed in for the reason the card's slot is passed in: which node a session
   * hangs off is the screen's knowledge, not this component's.
   */
  readonly actions?: ReactNode;
}

export function SessionRow({ item, scheme, now, store, actions }: SessionRowProps): JSX.Element {
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
        borderRadius: 8,
        padding: '6px 10px',
        display: 'flex',
        flexWrap: 'nowrap',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
        // The row clips rather than scrolls. Anything that did not fit has
        // already been cut short by the truncation on the facts themselves;
        // this is what keeps a long node menu or a refusal sentence from
        // pushing the line wider than the list.
        overflow: 'hidden',
        // Dimmed, not hidden and not recoloured, exactly as on the card.
        opacity: item.muted ? 0.55 : 1,
      }}
    >
      <Box
        component="a"
        href={sessionHash(item.ref)}
        aria-label={`open ${item.name}`}
        style={{ position: 'absolute', inset: 0, borderRadius: 8 }}
      />
      <Box
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          flexShrink: 0,
          background: colorForTone(item.tone, scheme),
        }}
      />
      <Text
        fw={600}
        truncate="end"
        c={colorForRole('text', scheme)}
        style={{ flex: '0 1 auto', minWidth: 0 }}
      >
        {item.name}
      </Text>
      <Text ff="monospace" fz={10} fw={500} truncate="end" c={muted} style={{ minWidth: 0 }}>
        {placeLabel(item)}
      </Text>
      {/* The slack goes here: the summary is the longest fact and the one a
          reader can still use half of. `SessionSummaryLine` is the card's own,
          so the line quotes the session in the same ink in both forms. */}
      <Box style={{ flex: '1 1 auto', minWidth: 0 }}>
        <SessionSummaryLine activity={item.activity} text={item.summary} scheme={scheme} />
      </Box>
      <SessionMetaLine item={item} scheme={scheme} now={now} />
      {/* Above the link overlay, so a control is the control. Each of the
          three renders nothing at all where it would mean nothing. */}
      <Box style={{ position: 'relative', flexShrink: 0, display: 'flex', gap: 6 }}>
        {actions}
        <AttentionControls item={item} store={store} scheme={scheme} />
        <StopButton store={store} sessionRef={item.ref} holder={item.holder} scheme={scheme} />
      </Box>
    </Box>
  );
}
