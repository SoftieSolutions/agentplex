/**
 * Loaded before every suite in this package, in whichever environment the file
 * asked for.
 *
 * xterm asks for a 2D canvas context when it opens, and never draws with it in
 * these tests. jsdom has no canvas without the native `canvas` package, so its
 * `getContext` prints "Not implemented" to stderr and returns `null`. This stub
 * returns the same `null` without the line: the behaviour a test sees is
 * unchanged, and a stderr that is quiet by default is one where a new warning
 * is noticed.
 *
 * Guarded, because a suite under the node environment has no
 * `HTMLCanvasElement` at all, and for it this file does nothing.
 */
if (typeof globalThis.HTMLCanvasElement === 'function') {
  Object.defineProperty(globalThis.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: (): null => null,
  });
}
