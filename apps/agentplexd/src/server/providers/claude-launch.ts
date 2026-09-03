import type { StoreDescriptor } from '@agentplex/protocol';
import type { Launch } from './provider-adapter.js';
import { parseWorkingDirectory } from './working-directory.js';

/**
 * Everything about starting a `claude` that is true of every `claude`
 * agentplexd starts.
 *
 * It is its own file because there are now two callers with nothing else in
 * common: the session adapter, which spawns and resumes work, and provisioning,
 * which drives a login. A login that inherited a different environment, or
 * scrubbed a different set of variables, would be a second definition of what a
 * Claude Code child is — and the one that would rot is the one nobody looks at.
 */

/** The executable, looked up on PATH by the supervisor. Never a shell string. */
export const CLAUDE_COMMAND = 'claude';

/**
 * The variables that must not reach a Claude Code child.
 *
 * `CLAUDE` catches `CLAUDECODE` and the `CLAUDE_CODE_*` family, which is the
 * set an agentplexd started *from inside* a Claude Code session inherits. A
 * child that sees them concludes it is a nested run and stops writing a
 * transcript — and a transcript is the only thing discovery reads, so the
 * session runs perfectly and agentplex never sees it again. Nothing errors,
 * which is what makes it worth a named constant and a test.
 *
 * `AI_AGENT` is the same class of marker from the other direction: tools set it
 * to say "an agent is driving", and a child that inherits one changes its own
 * behaviour on a fact about its grandparent.
 *
 * They live here rather than in the supervisor because they are provider
 * knowledge: `CLAUDE_` means nothing to codex, and a supervisor with a
 * hardcoded list would need editing for every adapter that lands.
 */
export const CLAUDE_SCRUB_PREFIXES: readonly string[] = ['CLAUDE', 'AI_AGENT'];

/**
 * Where Claude Code keeps the state this adapter reads.
 *
 * The store *is* the config directory — `<store>/projects` and
 * `<store>/sessions` are exactly the layout of a `~/.claude` — so a child that
 * is not told about it writes its transcript into whichever home directory
 * agentplexd is running as, and the store the session was started in never
 * hears about it. Set after the scrub, deliberately: `CLAUDE_CONFIG_DIR` is
 * inside a scrubbed prefix, and the supervisor applying a plan's variables
 * last is what makes an adapter able to state one on purpose.
 */
export const CLAUDE_CONFIG_DIR = 'CLAUDE_CONFIG_DIR';

/**
 * One place every launch is built, because the difference between them is argv
 * and nothing else. Everything a launch can be refused for — a directory that
 * is not absolute, one inside the store, a session the provider never recorded
 * a directory for — is the working directory, and it is parsed rather than
 * trusted whether it came from a caller or out of a transcript.
 */
export function planClaudeLaunch(
  store: StoreDescriptor,
  cwd: string | null,
  args: readonly string[],
): Launch {
  const workingDirectory = parseWorkingDirectory(cwd, store);
  if (!workingDirectory.ok) return { ok: false, problem: workingDirectory.problem };

  return {
    ok: true,
    plan: {
      command: CLAUDE_COMMAND,
      args,
      cwd: workingDirectory.cwd,
      env: { [CLAUDE_CONFIG_DIR]: store.path },
      scrubEnvPrefixes: CLAUDE_SCRUB_PREFIXES,
    },
  };
}
