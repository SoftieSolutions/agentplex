/**
 * Pane and region shortcuts, resolved before the emulator can eat the key.
 *
 * xterm turns nearly every keydown that reaches it into bytes for the pty —
 * that is its job — so any chord meant for the app must be decided earlier in
 * the dispatch than the emulator's own listener. The layout root handles
 * `keydown` in the CAPTURE phase and consults this registry; a match is
 * consumed there (preventDefault and stopPropagation) and the emulator never
 * sees it, a miss falls through untouched and becomes keystrokes as usual.
 *
 * Every binding holds Ctrl+Shift or Cmd+Shift, deliberately: the plain
 * Ctrl-letter space is the terminal's (Ctrl+C is an interrupt, not a copy),
 * and plain Cmd-letter is the browser's. The three-key chord is the corner
 * neither of them uses.
 *
 * The registry is a value the pane owns today and the layout ticket (AGX-34)
 * extends: region navigation registers more bindings, into the same registry,
 * consulted by the same one capture handler.
 */

export interface ShortcutBinding {
  /**
   * The base key, as `KeyboardEvent.key` reports it without modifiers: a
   * lowercase letter, a digit, or a named key ('arrowleft'). Compared
   * case-insensitively, because with Shift held the event reports 'T' on some
   * layouts and 't' on others.
   */
  readonly key: string;
  /** What it does, in words, for the shortcut help the layout will grow. */
  readonly description: string;
  run(): void;
}

/**
 * The modifier-relevant slice of a KeyboardEvent, as an interface so a test
 * can hand in a plain object instead of constructing DOM events.
 */
export interface ChordKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface ShortcutRegistry {
  /** Registers one binding; the returned function removes it. Last wins on a key. */
  register(binding: ShortcutBinding): () => void;
  /** Every current binding, for rendering a shortcut list. */
  bindings(): readonly ShortcutBinding[];
  /**
   * The capture-phase handler. Returns whether the event was consumed; a
   * consumed event has been prevented and stopped and must not be re-handled.
   */
  handleKeyDown(event: ChordKeyEvent): boolean;
}

/** Whether an event is in the chord space at all: Ctrl/Cmd plus Shift, no Alt. */
export function isChord(event: ChordKeyEvent): boolean {
  // Alt excluded on purpose: on macOS it composes characters, so an
  // Alt-bearing chord means different keys on different layouts.
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey;
}

export function createShortcutRegistry(): ShortcutRegistry {
  const byKey = new Map<string, ShortcutBinding>();

  return {
    register(binding: ShortcutBinding): () => void {
      const key = binding.key.toLowerCase();
      byKey.set(key, binding);
      return () => {
        // Removes only its own registration: a later binding on the same key
        // replaced this one, and its unregister must not tear that one down.
        if (byKey.get(key) === binding) byKey.delete(key);
      };
    },

    bindings(): readonly ShortcutBinding[] {
      return [...byKey.values()];
    },

    handleKeyDown(event: ChordKeyEvent): boolean {
      if (!isChord(event)) return false;
      const binding = byKey.get(event.key.toLowerCase());
      if (binding === undefined) return false;
      event.preventDefault();
      event.stopPropagation();
      binding.run();
      return true;
    },
  };
}
