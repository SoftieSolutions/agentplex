import type { Clipboard } from './clipboard.js';

/**
 * A `Clipboard` a test can read and set, and one that refuses the way a
 * browser refuses.
 *
 * The refusing one is not an afterthought: the whole reason this seam exists
 * is that a refusal is the case the pane has to handle in words, and it is the
 * case no real browser will produce on demand.
 */
export interface FakeClipboard extends Clipboard {
  /** What a read will answer, and what the last write put here. */
  text: string;
  /** How many times the pane wrote, so a test can see a copy that did not happen. */
  readonly writes: number;
}

export function createFakeClipboard(text = ''): FakeClipboard {
  let held = text;
  let writes = 0;
  return {
    readText(): Promise<string> {
      return Promise.resolve(held);
    },
    writeText(next: string): Promise<void> {
      held = next;
      writes += 1;
      return Promise.resolve();
    },
    get text(): string {
      return held;
    },
    set text(next: string) {
      held = next;
    },
    get writes(): number {
      return writes;
    },
  };
}

/**
 * A clipboard that says no, in the shape a browser says it: a rejected promise
 * carrying a sentence. `DOMException` is what Chrome throws for a denied
 * permission and jsdom has one, but the pane reads `message` off an `unknown`
 * and cares about nothing else, so a plain Error is the honest stand-in.
 */
export function createRefusingClipboard(reason: string): Clipboard {
  return {
    readText(): Promise<string> {
      return Promise.reject(new Error(reason));
    },
    writeText(): Promise<void> {
      return Promise.reject(new Error(reason));
    },
  };
}
