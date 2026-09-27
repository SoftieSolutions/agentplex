/**
 * Whether this device shows sample data for features that have no backend
 * yet, kept in this browser only.
 *
 * Why the folder exists: the v2 mockups draw things the hub does not report
 * yet, and the decision on AGX-330 is to build those screens anyway and feed
 * them sample values, labelled as such. Off, a fact the state does not carry
 * is absent from the screen. On, it is drawn and every element it feeds wears
 * `MockTag` (src/ui/mock-tag.tsx). Sample data is drawn beside real state and
 * never in place of it.
 *
 * The convention for the data itself, which each mocked feature follows:
 *
 * - One file per feature, `src/mock/<feature>-mock.ts`, and nothing else in
 *   the app hardcodes a sample value. A feature's sample data is removed with
 *   one file when its backend lands, and a single shared data file would be
 *   the one file every mocked ticket edits.
 * - Typed against the real shapes, `@agentplex/protocol` and
 *   `src/store/views.ts`, never a parallel hand-written one: a mock that
 *   compiles against the real view is one the real data can replace without
 *   touching the screen.
 * - Read through `useMockMode()` (./use-mock-mode.ts), which is false without
 *   this switch on, so a screen asks one boolean before drawing a sample.
 *
 * Per device rather than per hub, on the onboarding dismissal's precedent
 * (src/onboarding/dismissal.ts), which is also where the shape comes from: an
 * injected storage access, a page-local flag that outranks disk, and
 * subscribe/notify for `useSyncExternalStore`. A developer looking at sample
 * rows on a laptop has not asked for them on the phone beside it.
 *
 * `?mock=1` in the page address turns it on and keeps it on, exactly as the
 * Settings toggle does, so a link can open the app with sample data showing.
 * It only turns the switch on: off is the toggle, and any other value of the
 * parameter is ignored rather than guessed at. The address is read once, when
 * the switch is built, so turning it off from Settings holds on a page whose
 * address still carries the parameter.
 */

const STORAGE_KEY = 'agentplex.mock';

/** The one word that means on. Anything else is a word this file did not write. */
const ON = 'on';

/** The one value of the address parameter that turns the switch on. */
const PARAM = 'mock';
const PARAM_ON = '1';

export interface MockSwitch {
  /** True when sample data is to be shown on this device. */
  read(): boolean;
  /**
   * Turns sample data on or off on this device. True when that is now
   * stored; false when this browser refused, in which case it holds for this
   * page only.
   */
  set(on: boolean): boolean;
  /** For `useSyncExternalStore`; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface MockSwitchSeams {
  /**
   * The storage access, a function because the property access is itself
   * what throws in a browser that refuses site data.
   */
  readonly storage: () => Storage;
  /** The page address's query string, `location.search` in a browser. */
  readonly search: () => string;
}

/** The stored word, parsed: only the word this file writes means on. */
function parseStored(word: string | null): boolean {
  return word === ON;
}

/** Whether the address asks for sample data. Unreadable asks for nothing. */
function askedByAddress(search: () => string): boolean {
  try {
    return new URLSearchParams(search()).get(PARAM) === PARAM_ON;
  } catch {
    return false;
  }
}

export function createMockSwitch({ storage, search }: MockSwitchSeams): MockSwitch {
  const listeners = new Set<() => void>();
  /**
   * What this page chose, whatever disk says; null until it chooses. Three
   * values rather than two because "off" has to outrank disk as well as "on":
   * a browser that refuses to forget an earlier "on" must still turn sample
   * data off when asked.
   */
  let here: boolean | null = null;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function keep(on: boolean): boolean {
    here = on;
    try {
      const store = storage();
      if (on) store.setItem(STORAGE_KEY, ON);
      else store.removeItem(STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  // Before anything can subscribe, so there is nobody to tell.
  if (askedByAddress(search)) keep(true);

  return {
    read(): boolean {
      if (here !== null) return here;
      try {
        return parseStored(storage().getItem(STORAGE_KEY));
      } catch {
        return false;
      }
    },
    set(on: boolean): boolean {
      const kept = keep(on);
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
