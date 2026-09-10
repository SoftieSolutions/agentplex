/**
 * The fake for this package's seam, exported beside the seam it stands in for
 * so that a test in any app reaches the one fake pty. A fake is a captured,
 * argued stand-in, and a second copy of one drifts from the first.
 */
export { createFakePtyFactory } from './fake-pty.js';
export type { FakeChild, FakePty, FakePtyFactory, FakePtyFactoryOptions } from './fake-pty.js';
