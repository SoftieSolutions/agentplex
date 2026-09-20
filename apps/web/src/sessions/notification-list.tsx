import { useId, type JSX } from 'react';
import { Box, Text } from '../ui/components.js';
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import type { NotificationList, NotificationRow } from './notification-model.js';

/**
 * The list the bell opens, with nothing around it.
 *
 * One list, two presentations: the popover at desk widths and the sheet at
 * phone widths both render this node, and neither is mentioned here. The
 * breakpoint decides the container, not the content -- a panel that said one
 * thing on a laptop and another on a phone would be two claims about one
 * fleet, and the reason it cannot become that is that there is only this file
 * to draw a row.
 *
 * Every row is a link, for the reason the card is one (`session-card.tsx`): an
 * anchor is what the browser already makes keyboard reachable, middle
 * clickable and hoverable with its destination shown, and the address comes
 * from the model, which built it with the helper the card uses. Nothing is
 * nested inside the anchor that could be operated on its own, so the link
 * wraps the row rather than covering it the way the card's overlay does.
 *
 * It renders what the model handed it and decides nothing: which sessions are
 * listed, in which section and in what words is `notification-model.ts`.
 */
export interface NotificationListViewProps {
  /** The two sections, from `notificationList`. */
  readonly list: NotificationList;
  readonly scheme: Scheme;
}

/**
 * Named for the view rather than the list because `NotificationList` is the
 * model's shape, and a component sharing that name would make every file that
 * holds both rename one of them.
 */
export function NotificationListView({ list, scheme }: NotificationListViewProps): JSX.Element {
  // `useId` and not a constant: both presentations may be mounted at once --
  // a breakpoint hides a container, it does not unmount it -- and two sections
  // sharing a heading id would point half the labels at the wrong words.
  const needsYouHeading = useId();
  const earlierHeading = useId();

  if (list.needsYou.length === 0 && list.earlier.length === 0) {
    // One sentence, and no headings above it. Two empty sections would be the
    // panel describing its own structure to somebody who asked it a question,
    // and the answer to that question is this line. It carries no link: the
    // bell opens this over whatever screen is already there, so the resolution
    // is to dismiss it rather than to go somewhere.
    return (
      <Text fz={12.5} c={colorForRole('textSecondary', scheme)} style={{ padding: '14px' }}>
        Nothing is waiting on you.
      </Text>
    );
  }

  return (
    <Box>
      {list.needsYou.length === 0 ? null : (
        <Box component="section" data-section="needs-you" aria-labelledby={needsYouHeading}>
          <SectionHeading
            id={needsYouHeading}
            // The count the bell was marked for, as mockup 6c heads it. The
            // section under a mark has to add up to the mark, and this is the
            // one place the number is drawn rather than implied.
            words={`NEEDS YOU · ${list.needsYou.length}`}
            color={colorForTone('needs-you', scheme)}
            scheme={scheme}
          />
          {list.needsYou.map((row) => (
            <Row key={row.key} row={row} scheme={scheme} unseen />
          ))}
        </Box>
      )}
      {list.earlier.length === 0 ? null : (
        <Box component="section" data-section="earlier" aria-labelledby={earlierHeading}>
          {/* No count. The first section's number answers the bell; this one
              is a receipt, and a number on a receipt is a number nobody is
              being asked to act on. */}
          <SectionHeading
            id={earlierHeading}
            words="EARLIER"
            color={colorForRole('textMuted', scheme)}
            scheme={scheme}
          />
          {list.earlier.map((row) => (
            <Row key={row.key} row={row} scheme={scheme} unseen={false} />
          ))}
        </Box>
      )}
    </Box>
  );
}

interface SectionHeadingProps {
  readonly id: string;
  readonly words: string;
  /** The hue, already resolved: the tone for the section that needs a person. */
  readonly color: string;
  readonly scheme: Scheme;
}

/**
 * The mockup's small monospace label, as a real heading.
 *
 * `h3` because the container supplies the panel's own title -- the popover and
 * the sheet are both labelled `Notifications` -- and these are the two lists
 * under it. The level is fixed rather than a prop: a caller free to choose it
 * is a caller free to get the document outline wrong.
 */
function SectionHeading({ id, words, color, scheme }: SectionHeadingProps): JSX.Element {
  return (
    <Text
      component="h3"
      id={id}
      ff="monospace"
      fz={9}
      fw={600}
      style={{
        color,
        margin: 0,
        letterSpacing: '0.08em',
        padding: '10px 14px 4px',
        borderTop: `1px solid ${colorForRole('border', scheme)}`,
      }}
    >
      {words}
    </Text>
  );
}

interface RowProps {
  readonly row: NotificationRow;
  readonly scheme: Scheme;
  /**
   * Whether this row is still asking. It is the section it sits in rather than
   * a fact re-derived from the item: the model already decided which section a
   * session belongs to, and a row that re-checked would be a second opinion.
   */
  readonly unseen: boolean;
}

/** One row: the session's tone dot, what it is doing, and where it is doing it. */
function Row({ row, scheme, unseen }: RowProps): JSX.Element {
  const muted = colorForRole('textMuted', scheme);
  return (
    <Box
      component="a"
      data-notification-row
      href={row.href}
      style={{
        display: 'flex',
        gap: 10,
        padding: '8px 14px',
        textDecoration: 'none',
        // The unanswered rows sit on the lifted surface, the way the mockup
        // tints them. It follows the section and not the tone, so a row does
        // not change colour when it is acknowledged in place -- it moves.
        background: unseen ? colorForRole('raised', scheme) : 'transparent',
      }}
    >
      <Box style={{ paddingTop: 5 }}>
        <ToneDot tone={row.tone} scheme={scheme} />
      </Box>
      <Box style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>
        <Text fz={12.5} c={colorForRole('text', scheme)}>
          {row.sentence}
        </Text>
        <Text fz={11} c={muted}>
          {row.place}
        </Text>
      </Box>
      {/* The mockup's arrow. Hidden from the accessibility tree because the
          row is already an anchor, and "link" is said better by the link. */}
      <Text aria-hidden fz={12.5} c={muted}>
        {'→'}
      </Text>
    </Box>
  );
}
