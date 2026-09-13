import { describe, expect, it } from 'vitest';
import { frameIdSchema } from '@agentplex/protocol';
import {
  documentArrived,
  documentAsked,
  editorWords,
  EMPTY_EDITOR,
  isDirty,
  notSent,
  refused,
  saveAsked,
  saveLanded,
  saveOwed,
  typed,
  type EditorState,
} from './editor-model.js';

/**
 * The editor as a value: every question about dirtiness, about what a reply
 * means and about what a refusal may not touch, answered without a DOM.
 */

const OPEN = frameIdSchema.parse(10);
const SAVE = frameIdSchema.parse(11);
const SOMEBODY_ELSE = frameIdSchema.parse(12);
const MACHINE_TIME = 1_756_000_000_000;

/** An editor holding a document the machine answered with. */
function opened(content = '# Plan\n'): EditorState {
  return documentArrived(documentAsked(EMPTY_EDITOR, OPEN, false), content, MACHINE_TIME);
}

describe('before the document has been read', () => {
  it('is not loaded, holds nothing and cannot be typed into', () => {
    const asking = documentAsked(EMPTY_EDITOR, OPEN, false);
    expect(asking.loaded).toBe(false);
    expect(asking.text).toBe('');
    // The guard is the read-only editor stated as a value: typing into a
    // document this client has never seen would be writing over one.
    expect(typed(asking, 'something')).toEqual(asking);
    expect(editorWords(asking, MACHINE_TIME)).toBe('reading the document');
  });

  it('says the connection is down when the open is still queued', () => {
    const queued = documentAsked(EMPTY_EDITOR, OPEN, true);
    expect(editorWords(queued, MACHINE_TIME)).toBe('the connection is down; waiting to read it');
  });

  it('stays empty and read-only when the open was refused, keeping the sentence', () => {
    const away = refused(
      documentAsked(EMPTY_EDITOR, OPEN, false),
      OPEN,
      'mbp-robert is not connected right now',
    );
    expect(away.loaded).toBe(false);
    expect(away.text).toBe('');
    expect(away.refusal).toBe('mbp-robert is not connected right now');
    expect(editorWords(away, MACHINE_TIME)).toBe('this document could not be read');
  });
});

describe('once the machine has answered with the document', () => {
  it('adopts the characters and the machine time, clean', () => {
    const state = opened();
    expect(state.loaded).toBe(true);
    expect(state.text).toBe('# Plan\n');
    expect(state.savedAt).toBe(MACHINE_TIME);
    expect(isDirty(state)).toBe(false);
    expect(saveOwed(state)).toBe(false);
  });

  it('is dirty exactly when the text differs from what the machine confirmed', () => {
    const edited = typed(opened(), '# Plan\n\n- one more thing\n');
    expect(isDirty(edited)).toBe(true);
    expect(saveOwed(edited)).toBe(true);
    expect(editorWords(edited, MACHINE_TIME)).toBe('unsaved changes');
    // Typed back to what is on the disk: dirty is a difference, not a memory
    // of having typed.
    expect(isDirty(typed(edited, '# Plan\n'))).toBe(false);
  });

  it('never re-adopts the disk over unsaved work', () => {
    const edited = typed(opened(), 'mine');
    const reread = documentArrived(edited, 'theirs', MACHINE_TIME + 1);
    expect(reread.text).toBe('mine');
    expect(reread.saved).toBe('# Plan\n');
  });
});

describe('saving', () => {
  it('owes no second save while one is in the air', () => {
    const saving = saveAsked(typed(opened(), 'new'), SAVE, 'new', false);
    expect(saveOwed(saving)).toBe(false);
    expect(editorWords(saving, MACHINE_TIME)).toBe('saving');
  });

  it('takes the baseline from what was sent, not from what is on screen', () => {
    // Somebody typed while the save was crossing two machines. The document
    // that landed is the older one, so the editor is still dirty -- a flag
    // cleared on the reply would have called this clean and lost the tail.
    const saving = saveAsked(typed(opened(), 'first'), SAVE, 'first', false);
    const later = typed(saving, 'first and second');
    const landed = saveLanded(later, MACHINE_TIME + 5_000);
    expect(landed.saved).toBe('first');
    expect(landed.text).toBe('first and second');
    expect(isDirty(landed)).toBe(true);
    expect(landed.savedAt).toBe(MACHINE_TIME + 5_000);
  });

  it('keeps every character when the machine refused the write', () => {
    const saving = saveAsked(typed(opened(), 'work'), SAVE, 'work', false);
    const no = refused(saving, SAVE, 'mbp-robert is not connected right now');
    expect(no.text).toBe('work');
    expect(no.loaded).toBe(true);
    expect(no.refusal).toBe('mbp-robert is not connected right now');
    // Still owed, so the next save -- explicit or idle -- carries it again.
    expect(saveOwed(no)).toBe(true);
  });

  it('says a queued save is waiting for the connection rather than saving', () => {
    const queued = saveAsked(typed(opened(), 'work'), SAVE, 'work', true);
    expect(editorWords(queued, MACHINE_TIME)).toBe('the connection is down; this save is waiting');
  });

  it('keeps the text when the store would not take the command at all', () => {
    const rejected = notSent(typed(opened(), 'work'), 'the connection has failed');
    expect(rejected.text).toBe('work');
    expect(rejected.refusal).toBe('the connection has failed');
    expect(saveOwed(rejected)).toBe(true);
  });
});

describe("a refusal of another screen's frame", () => {
  it('changes nothing here', () => {
    const saving = saveAsked(typed(opened(), 'work'), SAVE, 'work', false);
    expect(refused(saving, SOMEBODY_ELSE, 'no server has that store mounted')).toEqual(saving);
  });
});

describe('the status line', () => {
  it('ages the machine time rather than minting one of its own', () => {
    const state = opened();
    expect(editorWords(state, MACHINE_TIME)).toBe('saved just now');
    expect(editorWords(state, MACHINE_TIME + 5 * 60_000)).toBe('saved 5m ago');
    expect(editorWords(state, MACHINE_TIME + 3 * 3_600_000)).toBe('saved 3h ago');
  });
});
