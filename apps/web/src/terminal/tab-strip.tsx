import type { CSSProperties, JSX, KeyboardEvent } from 'react';

import { Box, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { tabForKey, type SessionTab } from './tab-strip-model.js';

/**
 * The strip across the top of a session pane (mockup 7c): Terminal today, and
 * Transcript, Diff and Approvals as their epics land.
 *
 * It takes a list and draws it. Nothing here knows which tabs exist, how many
 * there are meant to be, or what is behind any of them -- the pane owns the
 * list and the panel, and this owns the row and the keyboard. That is what
 * lets the strip ship with one tab: a later ticket appends to an array rather
 * than editing a control.
 *
 * Selection is a request sent up, not state kept here. Two panes can be open
 * on one session, a pane is remounted by the layout whenever the tree changes
 * shape, and a strip that remembered its own tab would answer for the wrong
 * one of them.
 */

const BADGE = {
  fontFamily: 'var(--mantine-font-family-monospace)',
  fontSize: 10,
  fontWeight: 500,
} as const;

export interface TabStripProps {
  readonly tabs: readonly SessionTab[];
  /** The tab being shown, already resolved against the list by `activeTab`. */
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly scheme: Scheme;
  /** What this strip is a strip of, for a screen reader. */
  readonly label: string;
}

/**
 * The button for one tab. Outside the component body, since it needs nothing
 * from it but its arguments.
 */
function tabStyle(active: boolean, scheme: Scheme): CSSProperties {
  return {
    padding: '9px 0',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    color: colorForRole(active ? 'text' : 'textMuted', scheme),
    // Two pixels of accent under the live tab, pulled down over the strip's
    // own hairline so the two read as one edge rather than as a stack.
    borderBottom: active ? `2px solid ${colorForRole('accent', scheme)}` : '2px solid transparent',
    marginBottom: -1,
  };
}

export function TabStrip({
  tabs,
  activeId,
  onSelect,
  scheme,
  label,
}: TabStripProps): JSX.Element | null {
  // A strip of nothing is not a strip. It cannot happen from the pane as it
  // stands, and drawing an empty bordered row if it ever did would be chrome
  // around an absence.
  if (tabs.length === 0 || activeId === null) return null;
  const shown: string = activeId;

  /**
   * The arrows, Home and End, which is the whole of what a tablist owes a
   * keyboard beyond Tab reaching it once.
   *
   * Selection follows focus, the usual pattern for tabs whose panels are
   * already loaded: the key asks for the tab and the caret goes to it. Focus
   * is moved through the strip's own DOM rather than a map of refs -- the
   * element is a child of the node the handler is on, the lookup is scoped to
   * that node, and a pane opened twice on one session therefore cannot focus
   * the other one's tab. Focusing before the re-render is deliberate and safe:
   * `focus()` does not care about the `tabindex` a repaint is about to change.
   */
  function stripKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const next = tabForKey(tabs, shown, event.key);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-tab-id="${next}"]`)?.focus();
  }

  return (
    <Box
      role="tablist"
      aria-label={label}
      onKeyDown={stripKeyDown}
      style={{
        display: 'flex',
        gap: 14,
        padding: '0 18px',
        borderBottom: `1px solid ${colorForRole('border', scheme)}`,
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === shown;
        return (
          <UnstyledButton
            key={tab.id}
            role="tab"
            data-tab-id={tab.id}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            style={tabStyle(active, scheme)}
          >
            {tab.label}
            {tab.badge !== null && (
              <Text component="span" style={{ ...BADGE, color: colorForRole('textMuted', scheme) }}>
                {tab.badge}
              </Text>
            )}
          </UnstyledButton>
        );
      })}
    </Box>
  );
}
