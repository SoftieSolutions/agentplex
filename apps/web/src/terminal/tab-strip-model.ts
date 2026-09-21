/**
 * What a tab strip is, and the two questions it answers, as pure functions.
 *
 * The strip is drawn from a list and never from a count. Today that list holds
 * Terminal and Transcript always, and Approvals while the session is holding a
 * request -- so it is two tabs or three, and the mockup's last one arrives as
 * its own epic lands: Diff (AGX-105). A strip that assumed four would spend
 * that time drawing a control that does nothing, which is the same
 * blank-screen lie the panes around it exist to avoid; so nothing disabled and
 * nothing placeholder is ever in the list.
 *
 * Which makes the list a thing that changes shape under a mounted pane, and
 * that is the whole reason these are functions rather than a `useState` and an
 * index. The tab a pane is on is a request, not a fact: it is answered against
 * whatever the strip is holding now.
 */

export interface SessionTab {
  /** Stable across renders and across releases: what a request names. */
  readonly id: string;
  /** The word on the tab. */
  readonly label: string;
  /**
   * The id of the element this tab shows, for `aria-controls`.
   *
   * Supplied by the pane rather than derived from `id` here, because two panes
   * can be open on one session and two elements cannot share an id: the pane
   * mints one prefix of its own and hands each tab the id of its own panel.
   * The strip only places it.
   */
  readonly panelId: string;
  /**
   * The count or measure drawn after the label -- `+142 -38` on Diff, `3` on
   * Approvals -- or `null` for a tab with nothing to add. Already words: a tab
   * knows how to say its own number, and the strip only places it.
   */
  readonly badge: string | null;
}

/**
 * The tab actually being shown: the one asked for while the strip still holds
 * it, the first one otherwise, and `null` for a strip with no tabs at all.
 *
 * The fallback is not defensive coding. A request outlives the strip it was
 * made against -- a pane remembers a tab, the layout reopens it, and the tab
 * it named is one this session does not offer -- and a strip that answered
 * with the request would highlight nothing.
 */
export function activeTab(tabs: readonly SessionTab[], requested: string): string | null {
  const first = tabs[0];
  if (first === undefined) return null;
  return tabs.some((tab) => tab.id === requested) ? requested : first.id;
}

/**
 * The tab one step along from the current one, wrapping at both ends.
 *
 * Wrapping because the arrows on a tablist are a ring: the alternative is an
 * arrow key that silently does nothing at one end, which reads as a broken
 * control rather than as an edge. A strip of one is a ring of one and the
 * answer is the tab you are already on.
 */
export function tabAfter(
  tabs: readonly SessionTab[],
  activeId: string,
  step: 1 | -1,
): string | null {
  const first = tabs[0];
  if (first === undefined) return null;
  const index = tabs.findIndex((tab) => tab.id === activeId);
  if (index < 0) return first.id;
  const next = tabs[(index + step + tabs.length) % tabs.length];
  return next === undefined ? first.id : next.id;
}

/**
 * The tab a key press asks for, or `null` for a key the strip has no business
 * taking.
 *
 * The four keys a horizontal tablist owes a keyboard, and only those. Up and
 * Down are deliberately not among them: on a strip laid out left to right they
 * mean nothing, and a control that swallowed them would take away the page's
 * scroll on the way to meaning nothing.
 */
export function tabForKey(
  tabs: readonly SessionTab[],
  activeId: string,
  key: string,
): string | null {
  switch (key) {
    case 'ArrowRight':
      return tabAfter(tabs, activeId, 1);
    case 'ArrowLeft':
      return tabAfter(tabs, activeId, -1);
    case 'Home':
      return tabs[0]?.id ?? null;
    case 'End':
      return tabs.at(-1)?.id ?? null;
    default:
      return null;
  }
}
