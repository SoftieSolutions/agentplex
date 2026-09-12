import { createClaudeAdapter } from './claude-adapter.js';
import { createCodexAdapter } from './codex-adapter.js';
import { createNodeProcessProbe } from './node-process-probe.js';
import type { ProcessRunner } from './operations/process-runner.js';
import type { ProviderFiles } from './provider-files.js';
import { createProviderRegistry, type ProviderRegistry } from './provider-registry.js';

/**
 * Which providers this build drives, in one place.
 *
 * `provider-adapter.ts` says the seam exists so that "the second adapter is a
 * new file rather than an edit to the server", and until this function the
 * claim was half true: the adapter was one file, but reaching it meant an
 * identical `createProviderRegistry([createClaudeAdapter(...)])` in the server,
 * in `doctor` and on the setup path. Three copies of one list is three places
 * to forget, and the one that gets forgotten is whichever program nobody ran
 * that afternoon -- a machine whose `doctor` reports on one set of providers
 * while its server drives another. The list lives here now, and registering the
 * next adapter is a line in this file and nothing outside it.
 *
 * It is in `packages/providers` rather than in the app that has two of the
 * three callers, because a composition inside `apps/cli` would leave the server
 * building its own and put us back at two lists that can disagree. The seam
 * already owns every adapter; owning the list of them is the same fact stated
 * once more.
 *
 * What it takes is what an entrypoint has and the seam cannot invent: a store
 * filesystem, and the one-shot runner whose environment `main` composed. Seams
 * rather than the things built from them -- a `ProcessRunner` and not a
 * `ProcessProbe` -- because what an adapter is built out of is this file's
 * business: a provider that needs something else from a runner becomes a line
 * here, where a wider dependency type would have become an edit to all three
 * entrypoints again.
 *
 * Note what is deliberately absent, and would be a bug rather than a
 * convenience: nothing about a pty. `doctor` reads a machine and must not be
 * able to change it, and it reaches its adapters through this function; a
 * composition that took a supervisor, or built one, would hand every caller the
 * one dependency `doctor` is defined by not having. The package manifest and
 * `eslint.config.js` both say `providers` may not import `@agentplex/pty`, so
 * the shape is enforced and not merely intended.
 */
export interface RegisteredProvidersDependencies {
  /** The read-only view of a store the adapters discover through. */
  readonly files: ProviderFiles;
  /**
   * The one-shot runner an adapter's probes go through.
   *
   * Injected rather than made, for the reason the preflight's is: what a child
   * inherits is decided where the runner is constructed, and `main` is the only
   * place allowed to read this process's own environment. Setup composes a
   * different one per recorded `binPath`, which is exactly the per-app
   * configuration this parameter exists to carry.
   */
  readonly runner: ProcessRunner;
}

export function createRegisteredProviders({
  files,
  runner,
}: RegisteredProvidersDependencies): ProviderRegistry {
  return createProviderRegistry([
    createClaudeAdapter({ files, probe: createNodeProcessProbe({ runner }) }),
    // The line AGX-174 said the next adapter would be. It takes `files` and
    // nothing else: codex keeps no process registry, so there is no probe to
    // hand it, and the dependency this function already carried was enough.
    createCodexAdapter({ files }),
  ]);
}
