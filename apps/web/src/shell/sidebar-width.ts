import { WIDE_FROM } from './shell-form.js';

/**
 * How wide the wide shell's sidebar is, kept in this browser only.
 *
 * Per device rather than per hub, on the mock switch's precedent
 * (src/mock/mock-switch.ts), which is also where the shape comes from: an
 * injected storage access, a page-local value that outranks disk, and
 * subscribe/notify for `useSyncExternalStore`. How wide a column reads well is
 * a fact about a screen, and the laptop's choice is not the desk monitor's.
 *
 * Two widths, and keeping them apart is the point of this file. The stored
 * width is what somebody chose. The drawn width is that, capped by what the
 * window can spare (`sidebarMaxFor`), and it is the frame's to work out; a
 * narrower window never writes here, so widening the window again brings the
 * chosen width back rather than whatever the squeeze left behind.
 */

/** The narrowest the sidebar is drawn, which is what it was before it moved. */
export const SIDEBAR_MIN = 240;

/** What a device that never chose gets: the column as it always was. */
export const SIDEBAR_DEFAULT = SIDEBAR_MIN;

/** The widest, past which the column stops being a sidebar and starts being a page. */
export const SIDEBAR_MAX = 480;

/**
 * The narrowest content region the wide shell promises, derived rather than
 * chosen: what the breakpoint leaves beside the narrowest sidebar. Below that
 * the shell is a phone, so above it the sidebar may take only what the window
 * has past this.
 */
export const CONTENT_MIN = WIDE_FROM - SIDEBAR_MIN;

const STORAGE_KEY = 'agentplex.sidebarWidth';

/** Only a whole number of pixels is a width this file wrote. */
const STORED = /^\d+$/;

/**
 * A width bounded to what the sidebar may ever be, whatever the window, and
 * whole: the stored word is a run of digits, so a width that is not a whole
 * number of pixels would be written as one this file then refuses to read.
 * Not a number at all is the default rather than a width nothing can draw.
 */
export function clampSidebarWidth(width: number): number {
  if (Number.isNaN(width)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
}

/**
 * The widest the sidebar may be drawn in a window this wide: whatever leaves
 * the content region its minimum, held between the two bounds. The one place
 * the window's rule is written; the frame draws `min(stored, this)`.
 */
export function sidebarMaxFor(viewport: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewport - CONTENT_MIN));
}

/**
 * The stored word, parsed. Anything but a run of digits is a word this file
 * did not write and reads as the default; a run of digits is clamped, because
 * a width from an older bound -- or one long enough to parse to Infinity -- is
 * still a width that has to be drawable.
 */
export function parseStoredWidth(word: string | null): number {
  if (word === null || !STORED.test(word)) return SIDEBAR_DEFAULT;
  return clampSidebarWidth(Number(word));
}

export interface SidebarWidth {
  /** The width chosen on this device, in CSS pixels, within the bounds. */
  read(): number;
  /**
   * Chooses a width on this device, clamped into the bounds. True when that is
   * now stored; false when this browser refused, in which case it holds for
   * this page only.
   */
  set(width: number): boolean;
  /** For `useSyncExternalStore`; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface SidebarWidthSeams {
  /**
   * The storage access, a function because the property access is itself
   * what throws in a browser that refuses site data.
   */
  readonly storage: () => Storage;
}

export function createSidebarWidth({ storage }: SidebarWidthSeams): SidebarWidth {
  const listeners = new Set<() => void>();
  /** What this page chose, whatever disk says; null until it chooses. */
  let here: number | null = null;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  return {
    read(): number {
      if (here !== null) return here;
      try {
        return parseStoredWidth(storage().getItem(STORAGE_KEY));
      } catch {
        return SIDEBAR_DEFAULT;
      }
    },
    set(width: number): boolean {
      const clamped = clampSidebarWidth(width);
      here = clamped;
      let kept: boolean;
      try {
        storage().setItem(STORAGE_KEY, String(clamped));
        kept = true;
      } catch {
        kept = false;
      }
      notify();
      return kept;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The browser's own, and the one the page hands the shell. The property access
 * lives inside the guarded call, so importing this outside a browser is safe.
 */
export const browserSidebarWidth: SidebarWidth = createSidebarWidth({
  storage: () => window.localStorage,
});
