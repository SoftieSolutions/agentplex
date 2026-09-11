/**
 * The fakes for this package's seams, and the captured fixtures they replay,
 * exported beside the seams they stand in for so that a test in any app reaches
 * the one fake for a seam. A fake is a captured, argued stand-in, and a second
 * copy of one drifts from the first.
 */
export {
  FAKE_SESSIONS_DIRECTORY,
  createFakeProviderAdapter,
  missingProvider,
  readyProvider,
} from './fake-provider-adapter.js';
export type { FakeProviderAdapter, FakeProviderAdapterOptions } from './fake-provider-adapter.js';

export { createFakeProviderFiles } from './fake-provider-files.js';
export type { FakeProviderFilesOptions } from './fake-provider-files.js';

export { createFakeStoreFiles } from './fake-store-files.js';
export type { FakeStoreFiles, FakeStoreFilesOptions } from './fake-store-files.js';

export { createFakeProcessProbe } from './fake-process-probe.js';
export type { FakeProcessProbeOptions } from './fake-process-probe.js';

export {
  createFakeDetachedSpawner,
  createFakeProcessRunner,
  printed,
  refused,
} from './operations/fake-process-runner.js';
export type {
  FakeDetachedSpawner,
  FakeDetachedSpawnerOptions,
  FakeProcessRunner,
  FakeProcessRunnerOptions,
} from './operations/fake-process-runner.js';

export { createMarkerProgram, createProbeProgram } from './probe-program.js';
export type { ProbeProgram } from './probe-program.js';

export { providerFixturePath, readProviderFixture } from './fixture-files.js';
