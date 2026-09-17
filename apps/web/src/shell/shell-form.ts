import { useSyncExternalStore } from 'react';

/**
 * Which shape the one shell is in.
 *
 * Not two apps. The route model, the screens and the facts the chrome holds
 * are the same in both; what differs is where the chrome puts itself -- a
 * sidebar beside the content, or a compact header above it and a tab bar
 * below. `app-shell.tsx` reads this once and renders one of the two frames
 * around the same content region.
 */
export type ShellForm = 'phone' | 'wide';

/**
 * The one width the shell changes shape at, in CSS pixels.
 *
 * 768 is Mantine's `sm`, which is the breakpoint the screens inside the shell
 * already draw against: the session list's New session button is
 * `visibleFrom="sm"`, and the phone chrome's action button is what stands in
 * for it below. One number for both, so a band where a screen shows neither --
 * or both -- cannot exist.
 *
 * Read against `window.innerWidth`, which is CSS pixels, while Mantine's `sm`
 * is `48em` against the root font size. They are the same 768 at the 16px root
 * this app ships and they drift together if that ever changes, which is the
 * direction that costs nothing: a reader who has scaled text up gets the phone
 * chrome slightly sooner, which is the chrome that fits scaled text.
 */
export const WIDE_FROM = 768;

/**
 * The form a width calls for. A pure function because that is the whole of the
 * decision, and because nothing else in a headless test has a viewport.
 */
export function shellForm(width: number): ShellForm {
  return width < WIDE_FROM ? 'phone' : 'wide';
}

function subscribeToWidth(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
}

function readShellForm(): ShellForm {
  return shellForm(window.innerWidth);
}

/**
 * The form the window is in now.
 *
 * The window is an external store and is read through `useSyncExternalStore`
 * rather than an effect, the same way the hash routes are. The snapshot is the
 * form and not the width, so a drag across a hundred pixels re-renders nothing:
 * React bails out on an unchanged snapshot, and the snapshot changes once, at
 * the breakpoint.
 *
 * A media query would answer the same question. This does not use one because
 * the rule is then written twice -- once as a query string, once as the
 * function a test can hold -- and two spellings of one breakpoint is exactly
 * what `shellForm` exists to prevent.
 */
export function useShellForm(): ShellForm {
  return useSyncExternalStore(subscribeToWidth, readShellForm);
}
