import { useState, type CSSProperties, type JSX } from 'react';
import { needsYouWords } from '../sessions/attention-floor.js';
import { NotificationListView } from '../sessions/notification-list.js';
import type { NotificationList } from '../sessions/notification-model.js';
import { Box, Drawer, Group, Popover, Text, UnstyledButton } from '../ui/components.js';
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { ShellForm } from './shell-form.js';

/**
 * The bell in the chrome, and the panel it opens: the attention floor, said in
 * the one place that is on screen at every address and in both forms of the
 * shell, and the list of what is actually asking.
 *
 * It speaks for the whole fleet and is deliberately not narrowed to the machine
 * the selector picked. Both the bell and the browser tab are ambient -- neither
 * is a screen, neither carries a selector -- and a bell that quietly spoke for
 * one machine would sit beside a title claiming a different number, which is
 * how an attention surface stops being believed.
 *
 * The mark is a bare dot rather than a number, as the mockups draw it. The
 * number has two places already -- the tab title, and the first section of the
 * panel -- and neither is a 32px square where a two-digit count is a smudge.
 * The count is not lost: it is the bell's accessible name, and the live region
 * beside it is what reads a change out.
 *
 * The number and the list are one fact here. The mark counts `list.needsYou`
 * rather than calling the floor a second time beside a list built from the same
 * items: both spellings reduce to `wantsAttention`, but only one of them is
 * what a person counts on screen once the panel is open, and a mark that could
 * ever disagree with the section under it is the failure this panel exists to
 * prevent.
 *
 * Two containers, one panel. The popover at desk widths and the sheet at phone
 * widths hold the same header and the same `NotificationListView`, and which of
 * them is drawn is `form`, handed down from `useShellForm`. Not a media query:
 * the rule would then be written twice, once as a query string and once as the
 * function a test can hold, and two spellings of one breakpoint is exactly what
 * `shell-form.ts` exists to prevent.
 *
 * No effects. Whether the panel is open is state this component owns, because
 * nothing outside it can open it and nothing outside it needs to know.
 */

/** The bell's box: the mockup's square control, and a fingertip's floor. */
const BELL_SIDE: Record<ShellForm, number> = { wide: 32, phone: 44 };

/**
 * The glyph inside it. It grows with the box rather than sitting small in the
 * middle of a bigger one, which is how mockup 7e draws the phone header: 18px
 * of bell in 44px of button.
 */
const GLYPH_SIDE: Record<ShellForm, number> = { wide: 16, phone: 18 };

/**
 * Where the mark sits on the bell's shoulder, per form. It moves with the box
 * rather than staying where a 32px control put it: the mockups draw it just
 * inside the glyph's top-right in both sizes, and an offset that did not follow
 * the box would drift towards the middle of the bigger one.
 */
const MARK_INSET: Record<ShellForm, { readonly top: number; readonly right: number }> = {
  wide: { top: 4, right: 5 },
  phone: { top: 7, right: 9 },
};

/** The popover's width, as mockup 7b draws the card. */
export const PANEL_WIDTH = 340;

/** What the panel is, said once, in its heading and in the sheet's own name. */
const PANEL_NAME = 'Notifications';

/**
 * Off screen, and still read out. `display: none` and `visibility: hidden` are
 * both dropped from the accessibility tree, which for a live region means it
 * announces nothing at all.
 */
const OFF_SCREEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export interface AttentionBellProps {
  /**
   * What is asking and what already got somebody, across the whole fleet:
   * `notificationList` over every session the hub has reported. Its needs-you
   * section is what the bell is marked for, so the two cannot come apart.
   *
   * An empty list is drawn -- as a bell with no mark on it -- because a control
   * that disappears when it is quiet is one nobody learns the position of.
   */
  readonly list: NotificationList;
  /** Which container the panel opens in: the shell's form, never measured here. */
  readonly form: ShellForm;
  readonly scheme: Scheme;
}

export function AttentionBell({ list, form, scheme }: AttentionBellProps): JSX.Element {
  const [opened, setOpened] = useState(false);
  const count = list.needsYou.length;

  /**
   * One node, in both containers. The popover clones it as its target and the
   * sheet stands next to it, so there is one bell rather than a wide one and a
   * phone one that could drift apart in what they say or how they behave.
   */
  const button = (
    <UnstyledButton
      data-attention-bell
      aria-label={needsYouWords(count)}
      aria-haspopup="dialog"
      aria-expanded={opened}
      onClick={() => setOpened(!opened)}
      style={{
        position: 'relative',
        width: BELL_SIDE[form],
        height: BELL_SIDE[form],
        display: 'grid',
        placeItems: 'center',
        borderRadius: 7,
        border: `1px solid ${colorForRole('border', scheme)}`,
        color: colorForRole('textSecondary', scheme),
      }}
    >
      <BellGlyph side={GLYPH_SIDE[form]} />
      {count === 0 ? null : (
        <AttentionMark count={count} inset={MARK_INSET[form]} scheme={scheme} />
      )}
    </UnstyledButton>
  );

  return (
    <Box style={{ display: 'flex', position: 'relative' }}>
      {form === 'phone' ? (
        <>
          {button}
          <NotificationSheet
            list={list}
            name={needsYouWords(count)}
            opened={opened}
            onClose={() => setOpened(false)}
            scheme={scheme}
          />
        </>
      ) : (
        // Controlled, so the popover adds no click handler of its own and the
        // button's is the only one; `onChange` is how a click outside and the
        // escape key get to say the same thing the button does.
        <Popover opened={opened} onChange={setOpened} position="bottom-end" shadow="md">
          <Popover.Target>{button}</Popover.Target>
          <Popover.Dropdown
            style={{
              width: PANEL_WIDTH,
              padding: 0,
              overflow: 'hidden',
              borderRadius: 10,
              background: colorForRole('surface', scheme),
              border: `1px solid ${colorForRole('borderStrong', scheme)}`,
            }}
          >
            <NotificationPanel list={list} scheme={scheme} />
          </Popover.Dropdown>
        </Popover>
      )}
      {/* Mounted at every count, empty at zero: see the dot above for why the
          words are here rather than on the mark. */}
      <Box role="status" style={OFF_SCREEN}>
        {count === 0 ? '' : needsYouWords(count)}
      </Box>
    </Box>
  );
}

interface NotificationSheetProps {
  readonly list: NotificationList;
  /**
   * What the sheet is called to a screen reader. The popover gets this for
   * free -- it is labelled by the bell it hangs from -- and the sheet is a
   * dialog in a portal with nothing pointing at it, so it is handed the same
   * sentence rather than a second wording of it.
   *
   * It is an `aria-label` and not the header's heading because Mantine writes
   * `aria-labelledby` itself, from its own title component, and overwrites
   * whatever was passed; a heading inside the body cannot be pointed at.
   */
  readonly name: string;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly scheme: Scheme;
}

/**
 * The phone form: the panel as a sheet off the bottom edge, mockup 6c.
 *
 * The mockup's drag handle is not drawn. Nothing here drags -- a handle is a
 * promise that a swipe closes the sheet -- and what actually closes it is a tap
 * outside, the escape key, or the bell again.
 */
function NotificationSheet({
  list,
  name,
  opened,
  onClose,
  scheme,
}: NotificationSheetProps): JSX.Element {
  return (
    <Drawer.Root
      opened={opened}
      onClose={onClose}
      position="bottom"
      // The sheet is as tall as what it holds. A fixed height would be a sheet
      // with empty space under one row and a scrollbar under six.
      size="auto"
      radius={22}
      padding={0}
    >
      <Drawer.Overlay />
      <Drawer.Content
        aria-label={name}
        style={{ background: colorForRole('surface', scheme), overflow: 'hidden' }}
      >
        <NotificationPanel list={list} scheme={scheme} />
      </Drawer.Content>
    </Drawer.Root>
  );
}

interface NotificationPanelProps {
  readonly list: NotificationList;
  readonly scheme: Scheme;
}

/**
 * What is inside either container: the header, then the list.
 *
 * Built once rather than once per container, because the two have to say the
 * same thing. A popover headed one way and a sheet headed another would be two
 * panels sharing a model, and the first control the header gains would have to
 * be built twice and then kept in step by hand.
 */
function NotificationPanel({ list, scheme }: NotificationPanelProps): JSX.Element {
  return (
    <Box>
      <PanelHeader scheme={scheme} />
      <NotificationListView list={list} scheme={scheme} />
    </Box>
  );
}

interface PanelHeaderProps {
  readonly scheme: Scheme;
}

/**
 * The panel's own head: what this is, and the space beside it that the panel's
 * bulk actions go in.
 *
 * `h2` because the list's two sections under it are `h3`, so the panel reads as
 * a titled thing holding two lists rather than as two lists that happen to be
 * adjacent.
 *
 * No rule under it. The first section heading already draws its own top border,
 * and a header border against it is a two-pixel line; where there is no section
 * -- the empty panel -- there is one sentence, which needs no rule above it.
 */
function PanelHeader({ scheme }: PanelHeaderProps): JSX.Element {
  return (
    <Group component="header" gap={8} align="center" wrap="nowrap" style={{ padding: '10px 14px' }}>
      <Text
        component="h2"
        fz={12.5}
        fw={700}
        c={colorForRole('text', scheme)}
        style={{ margin: 0 }}
      >
        {PANEL_NAME}
      </Text>
    </Group>
  );
}

interface BellGlyphProps {
  readonly side: number;
}

/**
 * The bell itself, drawn rather than imported.
 *
 * The app ships no icon set -- the action button is a `+` and the selector's
 * disclosure is one character -- and this is the one place that costs
 * something, because there is no character that reads as a notification bell
 * the way a drawn one does. Two strokes inline is cheaper than a dependency
 * that would then have to be used everywhere else for consistency, and it
 * inherits the colour of the control it sits in.
 */
function BellGlyph({ side }: BellGlyphProps): JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={side}
      height={side}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

interface AttentionMarkProps {
  readonly count: number;
  /** How far in from the bell's top-right corner, which is the form's business. */
  readonly inset: { readonly top: number; readonly right: number };
  readonly scheme: Scheme;
}

/**
 * The dot on the bell's shoulder: the needs-you tone, ringed in the page's own
 * background so it stays a dot where it overlaps the glyph's stroke.
 *
 * `data-needs-you` carries the count it stands for. Nothing draws that number
 * -- the dot is bare -- but a test asking "the mark for two" should not have
 * to settle for "a mark".
 */
function AttentionMark({ count, inset, scheme }: AttentionMarkProps): JSX.Element {
  return (
    <Box
      aria-hidden
      data-needs-you={count}
      style={{
        position: 'absolute',
        top: inset.top,
        right: inset.right,
        display: 'grid',
        padding: 2,
        borderRadius: '50%',
        pointerEvents: 'none',
        background: colorForRole('background', scheme),
      }}
    >
      <ToneDot tone="needs-you" scheme={scheme} />
    </Box>
  );
}
