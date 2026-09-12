import type { StoreDescriptor } from '@agentplex/protocol';
import type { Launch } from './provider-adapter.js';
import { parseWorkingDirectory } from './working-directory.js';

/**
 * Everything about starting a `codex` that is true of every `codex` agentplex
 * starts.
 *
 * Its own file for the reason `claude-launch.ts` is one: two callers with
 * nothing else in common — the session adapter, which spawns and resumes work,
 * and provisioning, which drives a login — and a login that scrubbed a
 * different set of variables would be a second definition of what a codex child
 * is, the one that rots because nobody looks at it.
 */

/** The executable, looked up on PATH by the supervisor. Never a shell string. */
export const CODEX_COMMAND = 'codex';

/**
 * The variables that must not reach a codex child.
 *
 * `CODEX` catches the markers codex sets on programs it runs itself —
 * `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_THREAD_ID`,
 * `CODEX_NON_INTERACTIVE` — which is the set an agentplex started from inside a
 * codex session inherits. It also catches `CODEX_HOME`, which is the important
 * one: an inherited `CODEX_HOME` would send the child's sessions into whatever
 * store the grandparent was using, and the store the session was started in
 * would never hear about it. The prefix is what makes the scrub survive codex
 * adding another one.
 *
 * What is deliberately *not* here is `OPENAI_API_KEY`. The obvious worry is
 * that an inherited key silently decides which account a session runs as,
 * exactly as an inherited `CODEX_HOME` would decide which store it writes to.
 * It was checked at the origin rather than reasoned about: with an empty store
 * and `OPENAI_API_KEY` set, codex-cli 0.154.0 still reports `Not logged in` and
 * exits 1, and the same holds for `CODEX_API_KEY`. The store's `auth.json` is
 * the authority, so there is nothing here for a scrub to fix, and scrubbing it
 * would break an operator who deliberately runs other tooling on that key in
 * the same environment.
 */
export const CODEX_SCRUB_PREFIXES: readonly string[] = ['CODEX'];

/**
 * Where codex keeps the state this adapter reads.
 *
 * The store *is* the codex home — `<store>/sessions` and
 * `<store>/session_index.jsonl` are exactly the layout of a `~/.codex` — so a
 * child that is not told about it writes its rollouts into whichever home
 * directory agentplex is running as. Set after the scrub, deliberately:
 * `CODEX_HOME` is inside a scrubbed prefix, and the supervisor applying a
 * plan's variables last is what makes an adapter able to state one on purpose.
 */
export const CODEX_HOME = 'CODEX_HOME';

/**
 * The directory codex uses when `CODEX_HOME` says nothing, under the
 * operator's own home.
 *
 * Beside the variable that overrides it, because the two are one fact. Nothing
 * at runtime reads it: where a store is stays configuration. It is the
 * directory setup can offer an operator installing on their own laptop, with
 * every session they have already run already in it.
 */
export const CODEX_DEFAULT_STORE_DIRECTORY = '.codex';

/**
 * One place every launch is built, because the difference between them is argv
 * and nothing else. Everything a launch can be refused for — a directory that
 * is not absolute, one inside the store, a session the provider never recorded
 * a directory for — is the working directory, and it is parsed rather than
 * trusted whether it came from a caller or out of a rollout.
 */
export function planCodexLaunch(
  store: StoreDescriptor,
  cwd: string | null,
  args: readonly string[],
): Launch {
  const workingDirectory = parseWorkingDirectory(cwd, store);
  if (!workingDirectory.ok) return { ok: false, problem: workingDirectory.problem };

  return {
    ok: true,
    plan: {
      command: CODEX_COMMAND,
      args,
      cwd: workingDirectory.cwd,
      env: { [CODEX_HOME]: store.path },
      scrubEnvPrefixes: CODEX_SCRUB_PREFIXES,
    },
  };
}
