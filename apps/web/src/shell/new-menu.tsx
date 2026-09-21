import { Fragment, useState, type CSSProperties, type JSX, type MouseEvent } from 'react';
import { opensElsewhere } from '../sessions/notification-list.js';
import { Box, Popover, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { NewMenu, NewMenuEntry, NewMenuHint, NewNodeKind } from './new-menu-model.js';

/**
 * The New button in the chrome, and the popover mockup 7a draws under it.
 *
 * It draws what `newMenu` handed it and decides nothing about what is on the
 * list: which kinds are offered, in which order and in what words is
 * `new-menu-model.ts`. It also knows nothing about what making one of them
 * involves -- no form, no store, no hash but the one an entry carries -- so
 * the shell that mounts it answers `onPick` with whichever form belongs to the
 * kind, and this file cannot grow a second opinion about that.
 *
 * Two shapes, one control. With more than one live kind the button opens the
 * popover; with exactly one there is nothing to choose between, so it is a
 * plain button that does the one thing, which is what the app did before the
 * table existed. It says the entry's own label rather than "New" in that
 * shape: "New" with no menu behind it names a category and not the thing the
 * press is about to do.
 *
 * A row is a button or an anchor according to what it is. Four of the five
 * kinds are something to make, which is a request to the shell; Enroll machine
 * is a place to go, so it is a real anchor to its hash -- keyboard reachable,
 * middle clickable and with its destination shown, the same reason the
 * notification rows and the session cards are anchors. The rule above it is
 * the mockup's, and it is drawn where the addresses start rather than above a
 * named kind, so the day a second address joins the list there is still one
 * rule in the popover.
 *
 * The chords are drawn and not claimed. `NewMenuHint.bound` is `false` for
 * every one of them -- nothing in the app listens for ⌘N, and AGX-260 is where
 * the chrome-level registry and the real chords are decided -- so the hint is
 * hidden from the accessibility tree and carries `bound` as an attribute.
 * Announcing a shortcut that answers nothing is the over-claim this app's
 * degrade rule is about, and an `aria-keyshortcuts` here would be exactly
 * that; the visual hint costs a sighted person nothing when it turns out to be
 * decoration, because the row beside it is what works.
 *
 * Choosing an entry closes the popover, the way every other overlay in the app
 * closes on the item that was chosen (`attention-bell.tsx`, `tree/node-menu.tsx`,
 * `machines/machine-selector.tsx`). What a pick opens -- a form over the
 * content -- would otherwise open under a dropdown still standing over it. A
 * click asking for the address somewhere else is neither closed on nor
 * prevented: see `opensElsewhere`, which is the rule the notification rows
 * already carry rather than a second wording of it.
 *
 * No effects, and no roles beyond the popover's own. Whether it is open is
 * state this component owns, because nothing outside it can open it. The
 * dropdown is a dialog holding controls and is deliberately not declared a
 * `menu`: an ARIA menu promises arrow-key navigation between its items, this
 * one has the tab order the browser gives it, and a promise in a role is still
 * a promise.
 */

/** The popover's width, as mockup 7a draws the card. */
export const MENU_WIDTH = 250;

/** The accent pill in the chrome, which both shapes of the button wear. */
function pillStyle(scheme: Scheme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: 7,
    background: colorForRole('accent', scheme),
    color: colorForRole('onAccent', scheme),
    fontWeight: 700,
    fontSize: 13,
    lineHeight: 1.2,
    textDecoration: 'none',
  };
}

/** One row of the popover, as the mockup spaces them. */
function rowStyle(scheme: Scheme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '8px 10px',
    borderRadius: 7,
    textAlign: 'left',
    textDecoration: 'none',
    color: colorForRole('text', scheme),
  };
}

export interface NewMenuButtonProps {
  /**
   * What can be made, from `newMenu`. The menu is passed in rather than read
   * here so that the shell holds the one call and a test can ask what a
   * one-kind app draws without having to make the app have one kind.
   */
  readonly menu: NewMenu;
  /**
   * That a kind was chosen. Not called for the entries that are an address:
   * their `href` is what happens, and a callback beside it would be a second
   * answer to one click.
   */
  readonly onPick: (kind: NewNodeKind) => void;
  readonly scheme: Scheme;
}

/**
 * Named for the control and not for the model, because `NewMenu` is the
 * model's shape and a component sharing that name would make every file
 * holding both rename one of them.
 */
export function NewMenuButton({ menu, onPick, scheme }: NewMenuButtonProps): JSX.Element | null {
  const [opened, setOpened] = useState(false);
  const [first] = menu.entries;

  // Nothing to make, so no button: a control that opens an empty list is the
  // same broken promise as a row for a kind that is not built.
  if (first === undefined) return null;

  if (menu.mode === 'direct') {
    return <DirectButton entry={first} onPick={onPick} scheme={scheme} />;
  }

  return (
    <Popover
      opened={opened}
      // Controlled, so the popover adds no click handler of its own and the
      // button's is the only one; `onChange` is how a click outside and the
      // escape key get to say the same thing the button does.
      onChange={setOpened}
      position="bottom-end"
      shadow="md"
    >
      <Popover.Target>
        <UnstyledButton
          data-new-menu
          aria-haspopup="dialog"
          aria-expanded={opened}
          onClick={() => setOpened(!opened)}
          style={pillStyle(scheme)}
        >
          New
          <Box
            aria-hidden
            style={{
              alignSelf: 'stretch',
              width: 1,
              background: colorForRole('onAccent', scheme),
              opacity: 0.2,
            }}
          />
          <Text component="span" aria-hidden fz={10} lh={1.2}>
            {opened ? '▴' : '▾'}
          </Text>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown
        data-new-menu-dropdown
        style={{
          width: MENU_WIDTH,
          padding: 6,
          borderRadius: 10,
          background: colorForRole('surface', scheme),
          border: `1px solid ${colorForRole('borderStrong', scheme)}`,
        }}
      >
        {menu.entries.map((entry, index) => (
          <Fragment key={entry.kind}>
            {startsAddresses(menu.entries, index) ? <Rule scheme={scheme} /> : null}
            <EntryRow
              entry={entry}
              onPick={onPick}
              onClose={() => setOpened(false)}
              scheme={scheme}
            />
          </Fragment>
        ))}
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * Whether the mockup's rule goes above this entry: it is the first of the
 * entries that are somewhere to go rather than something to make.
 *
 * Asked of the list rather than of the kind, so the rule follows the shape of
 * what was drawn. A list with no address draws no rule, and one that begins
 * with an address draws none above its first row -- a rule against the top
 * edge is a line with nothing on one side of it.
 */
function startsAddresses(entries: readonly NewMenuEntry[], index: number): boolean {
  if (entries[index]?.href === undefined) return false;
  const previous = entries[index - 1];
  return previous !== undefined && previous.href === undefined;
}

interface RuleProps {
  readonly scheme: Scheme;
}

function Rule({ scheme }: RuleProps): JSX.Element {
  return (
    <Box
      aria-hidden
      data-new-menu-rule
      style={{ height: 1, margin: '4px 6px', background: colorForRole('border', scheme) }}
    />
  );
}

interface DirectButtonProps {
  readonly entry: NewMenuEntry;
  readonly onPick: (kind: NewNodeKind) => void;
  readonly scheme: Scheme;
}

/**
 * The one-kind shape: the pill, saying what it makes, with no popover under it.
 *
 * It goes through the same address-or-request fork as a row, so a single live
 * kind that happens to be an address is still a link rather than a button that
 * navigates.
 */
function DirectButton({ entry, onPick, scheme }: DirectButtonProps): JSX.Element {
  if (entry.href !== undefined) {
    return (
      <Box component="a" data-new-menu href={entry.href} style={pillStyle(scheme)}>
        {entry.label}
      </Box>
    );
  }
  return (
    <UnstyledButton data-new-menu onClick={() => onPick(entry.kind)} style={pillStyle(scheme)}>
      {entry.label}
    </UnstyledButton>
  );
}

interface EntryRowProps {
  readonly entry: NewMenuEntry;
  readonly onPick: (kind: NewNodeKind) => void;
  /** That the popover is in the way of whatever this row just started. */
  readonly onClose: () => void;
  readonly scheme: Scheme;
}

function EntryRow({ entry, onPick, onClose, scheme }: EntryRowProps): JSX.Element {
  const body = (
    <>
      <Glyph kind={entry.kind} scheme={scheme} />
      <Box style={{ flex: 1, minWidth: 0, lineHeight: 1.25 }}>
        <Text fz={12.5} fw={600} c={colorForRole('text', scheme)}>
          {entry.label}
        </Text>
        <Text fz={11} c={colorForRole('textMuted', scheme)}>
          {entry.description}
        </Text>
      </Box>
      {entry.hint === undefined ? null : <Hint hint={entry.hint} scheme={scheme} />}
    </>
  );

  if (entry.href !== undefined) {
    return (
      <Box
        component="a"
        data-new-menu-entry={entry.kind}
        href={entry.href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (!opensElsewhere(event)) onClose();
        }}
        style={rowStyle(scheme)}
      >
        {body}
      </Box>
    );
  }

  return (
    <UnstyledButton
      data-new-menu-entry={entry.kind}
      onClick={() => {
        onClose();
        onPick(entry.kind);
      }}
      style={rowStyle(scheme)}
    >
      {body}
    </UnstyledButton>
  );
}

interface HintProps {
  readonly hint: NewMenuHint;
  readonly scheme: Scheme;
}

/**
 * The chord on the row's right, as text and nothing more.
 *
 * `aria-hidden` and not `aria-keyshortcuts`: nothing is listening, so the one
 * attribute that would make a screen reader offer it as a way to work the app
 * is the one attribute this must not have. `data-bound` carries the model's
 * own field rather than a hard-coded "false", so the day a chord is really
 * bound this hint has to be looked at again.
 */
function Hint({ hint, scheme }: HintProps): JSX.Element {
  return (
    <Text
      component="span"
      aria-hidden
      data-shortcut-hint
      data-bound={String(hint.bound)}
      ff="monospace"
      fz={10}
      fw={500}
      c={colorForRole('textMuted', scheme)}
    >
      {hint.text}
    </Text>
  );
}

/**
 * The mark beside a row, one per kind, drawn inline.
 *
 * The app ships no icon set and the bell's glyph is the argued exception
 * (`attention-bell.tsx`): a dependency taken for one shape would have to be
 * used for every other shape afterwards. This is that exception's second half
 * and not a new argument -- five rows a person picks between at a glance are
 * what the mockup gives marks to, the strokes are the mockup's own, and they
 * inherit the colour of the row they sit in.
 */
const GLYPHS: Record<NewNodeKind, JSX.Element> = {
  session: <path d="m4 17 6-6-6-6M12 19h8" />,
  project: (
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  graph: (
    <>
      <rect width="8" height="8" x="3" y="3" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
      <rect width="8" height="8" x="13" y="13" rx="2" />
    </>
  ),
  agent: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  machine: (
    <>
      <rect width="20" height="8" x="2" y="2" rx="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" />
      <path d="M6 6h.01M6 18h.01" />
    </>
  ),
};

interface GlyphProps {
  readonly kind: NewNodeKind;
  readonly scheme: Scheme;
}

function Glyph({ kind, scheme }: GlyphProps): JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke={colorForRole('textMuted', scheme)}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {GLYPHS[kind]}
    </svg>
  );
}
