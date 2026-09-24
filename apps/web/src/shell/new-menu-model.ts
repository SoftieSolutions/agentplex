import { ONBOARDING_HASH } from '../onboarding/onboarding-route.js';

/**
 * What the New button offers, and whether it is a menu at all.
 *
 * The mockup draws five things a person can make -- Session, Project, Graph,
 * Agent, and Enroll machine -- and four of them exist. A kind with nothing
 * behind it is absent from the menu, not drawn greyed with a tooltip promising
 * it later: a disabled row is a promise the app cannot keep, and there is no
 * date behind it. That is the rule the sidebar's nav already follows
 * (`destinations.ts`) and the same one here.
 *
 * `NEW_NODE_KINDS` is the one place that says which is which. The unbuilt kind
 * stays in the table with `built: false` rather than being deleted, so the epic
 * that builds it (AGX-149 for Agent) flips a flag beside the wording the
 * mockup already decided, instead of re-inventing an entry from the mockup a
 * second time -- which is what AGX-145 did for Graph.
 *
 * The menu decides its own shape from that table. With one kind built there is
 * nothing to choose between, so the mode is `direct` and the button does the
 * one thing rather than opening a popover over a single row -- which is the
 * behaviour the app shipped before this table existed, and the reason
 * `new-session-form.tsx` recorded for drawing no menu at all.
 */

/** One of the five things the mockup's New popover can make. */
export type NewNodeKind = 'session' | 'project' | 'graph' | 'agent' | 'machine';

/**
 * The chord a row draws on its right, as text and nothing more.
 *
 * By decision these hints are placeholder UI: the app has no chrome-level
 * shortcut registry (`terminal/shortcuts.ts` is per pane and its `isChord`
 * refuses a plain Cmd-N anyway), and AGX-260 decides the real chords and binds
 * them. So the hint carries `bound: false` as a type and not a comment -- the
 * day something registers a chord, this field has to be widened deliberately,
 * and every drawn hint has to say which side of that line it is on.
 */
export interface NewMenuHint {
  /** The chord as the mockup draws it, for example `⌘N`. */
  readonly text: string;
  /** Always false: nothing listens for this chord. */
  readonly bound: false;
}

/** One row of the popover. */
export interface NewMenuEntry {
  readonly kind: NewNodeKind;
  readonly label: string;
  /** The one-line description, worded as the mockup words it. */
  readonly description: string;
  /** Display-only; absent when the mockup draws no chord for the row. */
  readonly hint?: NewMenuHint;
  /**
   * Where the row goes, for the one row that is an address rather than a form.
   * Enroll machine is how onboarding is reached a second time, which is what
   * "you can enroll more machines later" is a link to.
   */
  readonly href?: string;
}

/** A row of the table, which is an entry plus whether it can be drawn yet. */
export interface NewNodeRow extends NewMenuEntry {
  readonly built: boolean;
}

/**
 * The built-or-not table: every kind the mockup draws, in the mockup's order.
 *
 * Session, Project, Graph and Enroll machine are built today. Agent is listed
 * with its wording so that the epic behind it has one line to change and
 * nowhere else to look.
 */
export const NEW_NODE_KINDS: readonly NewNodeRow[] = [
  {
    kind: 'session',
    label: 'Session',
    description: 'Start an agent in a repo',
    hint: { text: '⌘N', bound: false },
    built: true,
  },
  {
    kind: 'project',
    label: 'Project',
    description: 'Group repos and sessions',
    built: true,
  },
  {
    kind: 'graph',
    label: 'Graph',
    description: 'Wire agents into a workflow',
    hint: { text: '⌘G', bound: false },
    built: true,
  },
  {
    kind: 'agent',
    label: 'Agent',
    description: 'Reusable, versioned in Library',
    built: false,
  },
  {
    kind: 'machine',
    label: 'Enroll machine',
    description: 'One command, adopts running sessions',
    href: ONBOARDING_HASH,
    built: true,
  },
];

/**
 * `menu` opens the popover. `direct` means the button does its one entry's
 * thing on click and draws no popover at all.
 */
export type NewMenuMode = 'menu' | 'direct';

export interface NewMenu {
  readonly mode: NewMenuMode;
  /** Only the entries that can honestly be drawn, in the table's order. */
  readonly entries: readonly NewMenuEntry[];
}

/**
 * The menu as it can honestly be drawn.
 *
 * The table is a default argument rather than a module constant read inside,
 * because the rule and today's truth are two different things to pin: a test
 * asks what one built kind means without having to make the app have one.
 */
export function newMenu(kinds: readonly NewNodeRow[] = NEW_NODE_KINDS): NewMenu {
  const entries = kinds.filter((row) => row.built).map(entryOf);
  return { mode: entries.length > 1 ? 'menu' : 'direct', entries };
}

function entryOf(row: NewNodeRow): NewMenuEntry {
  const { built: _built, ...entry } = row;
  return entry;
}
