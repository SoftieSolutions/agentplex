// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserClipboard,
  clipboardProblem,
  NO_CLIPBOARD_HERE,
  type Clipboard,
} from './clipboard.js';

/**
 * The seam's two halves that are not the pane's: what the real one does with a
 * browser that has no clipboard to give, and what the pane is handed to say
 * when one says no.
 *
 * jsdom is the insecure-origin case for free -- it implements no
 * `navigator.clipboard` at all, which is exactly the shape a page served over
 * plain HTTP sees. That is the reason this file is worth having: the failure
 * everybody's hub will actually meet is the one no browser can be asked to
 * reproduce on demand.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A navigator whose clipboard is there and answers, as a secure context has. */
function withClipboard(clipboard: Clipboard): void {
  vi.stubGlobal('navigator', { clipboard });
}

describe('the browser clipboard', () => {
  it('names the origin when the page was given no clipboard', async () => {
    // Not stubbed: jsdom has none, and neither does any page on plain HTTP.
    expect(navigator.clipboard as Clipboard | undefined).toBeUndefined();

    await expect(browserClipboard.readText()).rejects.toThrow(NO_CLIPBOARD_HERE);
    await expect(browserClipboard.writeText('x')).rejects.toThrow(NO_CLIPBOARD_HERE);
  });

  it('rejects rather than throwing, so one path handles every refusal', () => {
    // The call itself must not throw synchronously: the pane awaits these
    // inside a try, and a synchronous throw out of a function that returns a
    // promise would land outside it.
    const read = browserClipboard.readText();
    const write = browserClipboard.writeText('x');

    expect(read).toBeInstanceOf(Promise);
    expect(write).toBeInstanceOf(Promise);
    // Answered, so neither is an unhandled rejection.
    return Promise.all([read.catch(() => {}), write.catch(() => {})]);
  });

  it('passes straight through to the browser where there is one', async () => {
    let written: string | null = null;
    withClipboard({
      readText: () => Promise.resolve('from the clipboard'),
      writeText: (text) => {
        written = text;
        return Promise.resolve();
      },
    });

    await expect(browserClipboard.readText()).resolves.toBe('from the clipboard');
    await browserClipboard.writeText('to the clipboard');

    expect(written).toBe('to the clipboard');
  });

  it('lets a refusal through in the words the browser used', async () => {
    withClipboard({
      readText: () => Promise.reject(new Error('Read permission denied.')),
      writeText: () => Promise.reject(new Error('Write permission denied.')),
    });

    await expect(browserClipboard.readText()).rejects.toThrow('Read permission denied.');
  });
});

describe('clipboardProblem', () => {
  it('keeps what the browser said and adds which half it happened in', () => {
    expect(clipboardProblem('paste', new Error('Read permission denied.'))).toBe(
      'could not paste from the clipboard: Read permission denied.',
    );
    expect(clipboardProblem('copy', new Error('Write permission denied.'))).toBe(
      'could not copy to the clipboard: Write permission denied.',
    );
  });

  it('says something for a rejection that is not an Error at all', () => {
    // A promise can be rejected with anything, and a control that did nothing
    // and said nothing is the thing this whole path exists to avoid.
    expect(clipboardProblem('paste', 'NotAllowedError')).toBe(
      'could not paste from the clipboard: NotAllowedError',
    );
  });

  it('names the origin, not a culprit, when there was no clipboard to refuse', () => {
    const sentence = clipboardProblem('paste', new Error(NO_CLIPBOARD_HERE));

    expect(sentence).toContain('secure context');
    expect(sentence).toContain('plain HTTP');
  });
});
