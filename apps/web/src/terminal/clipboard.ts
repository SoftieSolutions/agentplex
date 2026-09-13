/**
 * The system clipboard seam: the two things a pane does with it, and no more.
 *
 * An interface rather than `navigator.clipboard` reached for directly, for the
 * same reason the emulator is one: the real thing cannot be driven by a test.
 * It is absent in jsdom, it is absent in any browser on a page that is not a
 * secure context, and where it exists it answers a permission prompt that no
 * suite can click. Everything worth testing here -- that a copy writes the
 * selection, that a paste sends what was read, that a refusal is said out loud
 * rather than swallowed -- is about what crosses this seam.
 *
 * Both halves are asynchronous because the browser's are: reading is gated on
 * a permission the user may be asked for, and a synchronous answer would have
 * to be a guess.
 */
export interface Clipboard {
  /**
   * The clipboard's text.
   *
   * Rejects rather than answering empty when it cannot be read -- a refused
   * permission and an empty clipboard are different things to tell a user, and
   * a seam that returned `''` for both would make the pane unable to.
   */
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

/**
 * Why a page can have no clipboard at all, in the words a user can act on.
 *
 * `navigator.clipboard` is undefined outside a secure context, and the hub is
 * routinely reached over plain HTTP on a LAN address, which is exactly that
 * case. The browser reports it as the API simply not being there, so a pane
 * that said "the clipboard refused" would be naming the wrong culprit: nobody
 * refused anything, this page was never offered one. Naming the origin is what
 * makes the fix -- reach the hub over HTTPS, or over localhost, both of which
 * are secure contexts -- something the reader can find.
 */
export const NO_CLIPBOARD_HERE =
  'this page has no clipboard: browsers give one only to a secure context, and this hub is being read over plain HTTP';

/**
 * The browser's clipboard, as the app runs it. The one module that names
 * `navigator.clipboard`, the way `xterm-emulator.ts` is the one that names
 * xterm.
 *
 * The absence check is not redundant with the rejection the API would produce,
 * because there is no API to produce one: on an insecure origin the property is
 * undefined and a call through it throws a TypeError about reading `readText`
 * of undefined, which is a sentence about this app's own bug rather than about
 * the reader's situation. TypeScript types the property as always present, so
 * the cast is the seam's admission that the DOM lib is describing a secure
 * context and the pane may not be in one.
 */
export const browserClipboard: Clipboard = {
  readText(): Promise<string> {
    const api = navigator.clipboard as Clipboard | undefined;
    if (api === undefined) return Promise.reject(new Error(NO_CLIPBOARD_HERE));
    return api.readText();
  },
  writeText(text: string): Promise<void> {
    const api = navigator.clipboard as Clipboard | undefined;
    if (api === undefined) return Promise.reject(new Error(NO_CLIPBOARD_HERE));
    return api.writeText(text);
  },
};

/** Which way the clipboard was being used when it would not answer. */
export type ClipboardUse = 'copy' | 'paste';

/**
 * What the pane says when the clipboard would not answer.
 *
 * The browser's own message is kept and named rather than replaced with one
 * sentence for every failure, because the two failures a user meets want
 * different things done about them: a `NotAllowedError` is a permission the
 * reader can grant, and an absent API is an origin they have to change. The
 * pane cannot tell them apart by type -- a DOMException and an Error are the
 * same `unknown` here -- so it repeats what it was told and says which half of
 * the operation it was in the middle of.
 *
 * Degrading in the direction that does not over-claim: a thrown thing that is
 * not an Error still gets a sentence, because the alternative is a button that
 * did nothing and said nothing.
 */
export function clipboardProblem(use: ClipboardUse, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  const verb = use === 'copy' ? 'copy to' : 'paste from';
  return `could not ${verb} the clipboard: ${reason}`;
}

/** Nothing to copy, which is a thing to say rather than a no-op. */
export const NOTHING_SELECTED =
  'nothing is selected in this pane, so nothing was copied: drag across the output first';

/** Nothing to paste, said rather than a keystroke that visibly does nothing. */
export const CLIPBOARD_EMPTY = 'the clipboard is empty, so nothing was pasted';
