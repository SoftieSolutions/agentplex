/**
 * Room for the part of the display that is not rectangular.
 *
 * The app is a PWA, so on a phone it is drawn behind the home indicator and,
 * in landscape, behind the notch: `index.html` asks for `viewport-fit=cover`
 * because the terminal should reach the edges of the glass. What must not
 * reach the edges is anything a finger has to hit, which on the phone chrome
 * is the tab bar and the action button above it.
 *
 * It is not only the phone chrome's problem. A notched phone in landscape is
 * wider than the breakpoint, so the desk chrome is what it draws -- and the
 * top bar and the sidebar's outer edge are then the two things under the
 * cutout. Both ask for their inset here.
 *
 * One helper rather than a literal per rule, because the fallback is the part
 * that gets forgotten: a browser that does not know `safe-area-inset-bottom`
 * drops the whole declaration, taking the padding the bar asked for with it,
 * and the bar loses the eight pixels it would have had on a desk browser too.
 */

/** The sides a display can keep for itself. */
export type SafeSide = 'top' | 'bottom' | 'left' | 'right';

/**
 * A padding, plus whatever the display keeps for itself on that side.
 *
 * Returned as a string rather than applied here: the caller is a component
 * with a style object, and the value belongs to whichever property it is
 * padding -- `paddingBottom` on the bar, `bottom` on the button floating above
 * it.
 */
export function withSafeArea(padding: number, side: SafeSide): string {
  return `calc(${String(padding)}px + env(safe-area-inset-${side}, 0px))`;
}
