import type { FrameId } from '@agentplex/protocol';
import { ageLabel } from '../sessions/session-list-model.js';

/**
 * What an open document is, as a value: the characters, what the machine last
 * confirmed, and whatever the hub said no to.
 *
 * Pure, and that is the point rather than tidiness. Everything an editor gets
 * wrong is a question about two texts and a reply -- is this dirty, did this
 * save land, does a refusal to somebody else's frame clear my unsaved work --
 * and each of those is one assertion here, with no DOM, no socket and no
 * clock. The store beside this file owns the socket and the debounce and does
 * no arithmetic of its own.
 *
 * ## Two texts, never one
 *
 * `text` is what the person has typed. `saved` is the characters the machine
 * holding the file confirmed, and dirty is the difference between them --
 * never a flag somebody remembers to set. The third, `inFlight`, is what a
 * save that has not been answered carries: when the answer comes, the baseline
 * becomes the text that was *sent*, not the text on screen, because somebody
 * typing while a save is in the air has already moved on from it. A flag would
 * have called that document clean.
 *
 * ## Not loaded is not empty
 *
 * `loaded` is false until the machine has answered with the document. An
 * editor that is not loaded is read-only and shows nothing, because the
 * alternative -- an empty box somebody can type into -- is an invitation to
 * write a document that would replace one this client has never seen.
 */
export interface EditorState {
  /** What the textarea shows. Only a person's typing changes this. */
  readonly text: string;
  /** The characters the machine last confirmed, or `null` before any answer. */
  readonly saved: string | null;
  /** When that machine says it wrote them. Its clock, never this browser's. */
  readonly savedAt: number | null;
  /** The open this editor is waiting on, or `null`. */
  readonly openFrame: FrameId | null;
  /** The save this editor is waiting on, or `null`. */
  readonly saveFrame: FrameId | null;
  /** The characters that save carries, kept until it is answered. */
  readonly inFlight: string | null;
  /** True while the command in flight is still in the store's offline queue. */
  readonly queued: boolean;
  /** The last thing the hub said no to, in its words, or `null`. */
  readonly refusal: string | null;
  /** True once the document has been read back, which is what makes it editable. */
  readonly loaded: boolean;
}

export const EMPTY_EDITOR: EditorState = {
  text: '',
  saved: null,
  savedAt: null,
  openFrame: null,
  saveFrame: null,
  inFlight: null,
  queued: false,
  refusal: null,
  loaded: false,
};

/** An open went out. `queued` is the store saying the connection was down. */
export function documentAsked(state: EditorState, frame: FrameId, queued: boolean): EditorState {
  return { ...state, openFrame: frame, queued, refusal: null };
}

/**
 * The machine answered with the document.
 *
 * Adopted whole, including the baseline: this is the only thing that knows
 * what is on that disk. Unsaved work is never overwritten -- a re-read is only
 * ever asked for when there is none -- and the guard is here as well as at the
 * caller because "adopt the disk over what somebody typed" is the one mistake
 * in this file that would lose work rather than annoy anybody.
 */
export function documentArrived(
  state: EditorState,
  content: string,
  updatedAt: number,
): EditorState {
  if (isDirty(state)) return { ...state, openFrame: null, queued: false };
  return {
    ...state,
    text: content,
    saved: content,
    savedAt: updatedAt,
    openFrame: null,
    queued: false,
    refusal: null,
    loaded: true,
  };
}

/** Somebody typed. Nothing but this changes `text`, and only when loaded. */
export function typed(state: EditorState, text: string): EditorState {
  if (!state.loaded || text === state.text) return state;
  return { ...state, text };
}

/** A save went out, carrying `text`. */
export function saveAsked(
  state: EditorState,
  frame: FrameId,
  text: string,
  queued: boolean,
): EditorState {
  return { ...state, saveFrame: frame, inFlight: text, queued, refusal: null };
}

/** The machine wrote it, and says when. The baseline becomes what was sent. */
export function saveLanded(state: EditorState, updatedAt: number): EditorState {
  return {
    ...state,
    saved: state.inFlight ?? state.saved,
    savedAt: updatedAt,
    saveFrame: null,
    inFlight: null,
    queued: false,
    refusal: null,
  };
}

/**
 * The hub said no to one frame.
 *
 * Matched on the frame id and unchanged for any other, which is the whole
 * reason the ids are kept: one client may have a browse, a start and a save in
 * the air at once, and a refusal of somebody else's frame must not put its
 * sentence on this document. A refused save keeps every character -- the text
 * is the user's work and the refusal is about a machine, not about the words.
 */
export function refused(state: EditorState, replyTo: FrameId, words: string): EditorState {
  if (state.openFrame === replyTo) {
    return { ...state, openFrame: null, queued: false, refusal: words };
  }
  if (state.saveFrame === replyTo) {
    return { ...state, saveFrame: null, inFlight: null, queued: false, refusal: words };
  }
  return state;
}

/** The store would not take the command at all: nothing is in flight. */
export function notSent(state: EditorState, words: string): EditorState {
  return {
    ...state,
    openFrame: null,
    saveFrame: null,
    inFlight: null,
    queued: false,
    refusal: words,
  };
}

/** The difference between what is typed and what the machine confirmed. */
export function isDirty(state: EditorState): boolean {
  return state.loaded && state.text !== state.saved;
}

/** Whether a save is owed: something to write, and nothing already writing it. */
export function saveOwed(state: EditorState): boolean {
  return isDirty(state) && state.saveFrame === null;
}

/**
 * The status line, in words.
 *
 * The age is measured against the machine's own clock, which is the honest
 * thing to show and an approximate one: two machines' clocks differ, so "2m
 * ago" is that file's timestamp read against this browser's now. A time this
 * client minted on receipt would look more precise and mean less.
 */
export function editorWords(state: EditorState, now: number): string {
  if (state.saveFrame !== null) {
    return state.queued ? 'the connection is down; this save is waiting' : 'saving';
  }
  if (!state.loaded) {
    if (state.refusal !== null) return 'this document could not be read';
    return state.queued ? 'the connection is down; waiting to read it' : 'reading the document';
  }
  if (isDirty(state)) return 'unsaved changes';
  if (state.savedAt === null) return 'no changes';
  const age = ageLabel(now, state.savedAt);
  return age === 'now' ? 'saved just now' : `saved ${age} ago`;
}
