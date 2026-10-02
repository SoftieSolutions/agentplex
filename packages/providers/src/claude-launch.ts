import { isAbsolute, resolve } from 'node:path';
import type { StoreDescriptor } from '@agentplex/protocol';
import { CLAUDE_PERMISSION_HOOK_EVENT } from './claude-permission.js';
import type {
  Launch,
  LaunchApproval,
  PermissionHook,
  PermissionHookCommand,
} from './provider-adapter.js';
import { parseWorkingDirectory } from './working-directory.js';

/**
 * Everything about starting a `claude` that is true of every `claude`
 * agentplex starts.
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
 * set an agentplex started *from inside* a Claude Code session inherits. A
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
 * Where Claude Code keeps the state this adapter reads, when the store is not
 * the one it would find on its own.
 *
 * The store *is* the config directory -- `<store>/projects` and
 * `<store>/sessions` are exactly the layout of a `~/.claude` -- so a child
 * started in a store anywhere but the account's `~/.claude` has to be told
 * where it is, or it writes its transcript under `~/.claude` and the store the
 * session was started in never hears about it. Set after the scrub,
 * deliberately: `CLAUDE_CONFIG_DIR` is inside a scrubbed prefix, and the
 * supervisor applying a plan's variables last is what makes an adapter able to
 * state one on purpose.
 *
 * It is *not* set for the default store, and that is not an optimisation. The
 * variable means more to Claude Code than "where the transcripts go". Run at
 * the origin, on 2.1.287 under macOS: unset, the global config is
 * `~/.claude.json` and the credentials are the keychain item `Claude
 * Code-credentials`; set to `~/.claude` -- the very same directory -- the
 * global config becomes `~/.claude/.claude.json` and the keychain item one
 * suffixed with a hash of the directory. `claude auth status` says logged in
 * the first way and logged out the second. A session started that way opens
 * on the onboarding screen, with none of the account's theme, trust or login,
 * while its transcript and its `sessions/<pid>.json` land under `~/.claude`
 * exactly as they do when the variable is unset. Naming the default store
 * gains nothing and costs the account its own Claude Code.
 */
export const CLAUDE_CONFIG_DIR = 'CLAUDE_CONFIG_DIR';

/**
 * The directory Claude Code uses when `CLAUDE_CONFIG_DIR` says nothing, under
 * the operator's own home.
 *
 * Beside the variable that overrides it, because the two are one fact. This is
 * the store an operator installing agentplex on their own machine already has,
 * with every session they have already run in it, so it is the store setup can
 * offer them instead of asking for a path. A launch reads it for one thing
 * only: to recognise that store and leave the variable unset (see above).
 * Where a store is stays configuration.
 */
export const CLAUDE_DEFAULT_STORE_DIRECTORY = '.claude';

/** The flag that points one launch at one settings file, and nothing else. */
const CLAUDE_SETTINGS_FLAG = '--settings';

/**
 * What the per-launch settings file is called, under a directory the server
 * makes for that launch alone.
 *
 * The provider's own name for the kind of file it is, so that an operator who
 * finds one while it is live reads something they recognise rather than a
 * codename of ours.
 */
export const CLAUDE_SETTINGS_FILE_NAME = 'settings.json';

/**
 * How Claude Code is made to ask before it runs a tool.
 *
 * **`--settings` merges; it does not replace.** The file named here is one more
 * layer above the operator's own `~/.claude/settings.json` and a project's
 * `.claude/settings.json`, so every setting they configured is still in force
 * and -- the part worth stating out loud -- so is any `PermissionRequest` hook
 * *they* registered. Both hooks run for the same tool call, and Claude Code
 * takes the first denial: an operator's own guard cannot be switched off by
 * starting the session through agentplex, and agentplex cannot be talked past
 * by one either. What agentplex can do is add an ask that would not otherwise
 * exist. Nobody's answer is silently dropped; the strictest one wins.
 *
 * **Shell form, and quoted for it.** With no `args` beside it the provider
 * passes `command` to `sh -c`, so a program path with a space in it would be
 * two words. There is an exec form that takes an argv array and no shell, which
 * would be the better shape -- and it is not used yet, because what this
 * repository has actually run against a real `claude` is the shell form, in the
 * capture that produced the payload fixture. A form nobody has run is a claim,
 * and the failure mode of a settings entry this provider does not understand is
 * the quiet one: no hook fires, nothing is logged here, and every session goes
 * on asking at its own terminal instead.
 */
export const claudePermissionHook: PermissionHook = {
  settingsFileName: CLAUDE_SETTINGS_FILE_NAME,

  settings({ command, args, timeoutSeconds }: PermissionHookCommand): string {
    return JSON.stringify({
      hooks: {
        // No `matcher`, which is how this provider spells "every occurrence of
        // the event". Naming tools here would be agentplex deciding which tool
        // calls are worth asking a person about -- a policy question, and one
        // with a ticket of its own -- inside a line that builds a launch.
        [CLAUDE_PERMISSION_HOOK_EVENT]: [
          {
            hooks: [
              {
                type: 'command',
                command: [command, ...args].map(shellQuoted).join(' '),
                // The provider's own patience, decided by the machine that
                // holds the blocked process rather than restated here: the gate
                // expires a request shortly before this, and two files naming
                // the number separately would eventually name two numbers.
                timeout: timeoutSeconds,
              },
            ],
          },
        ],
      },
    });
  },
};

/**
 * One argument, as a POSIX shell will read it back whole.
 *
 * Single quotes rather than double, because nothing inside them is expanded: a
 * path containing `$HOME` or a backtick is a path. The one character that
 * cannot appear inside them is a single quote, which is closed, escaped and
 * reopened in the usual way.
 */
function shellQuoted(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

/**
 * One place every launch is built, because the difference between them is argv
 * and nothing else. Everything a launch can be refused for — a directory that
 * is not absolute, one inside the store, a session the provider never recorded
 * a directory for — is the working directory, and it is parsed rather than
 * trusted whether it came from a caller or out of a transcript.
 *
 * The approval is the one addition, and it splits in two on purpose: the
 * settings file is named on argv, where a path is a path, and everything secret
 * about the launch travels in the environment, where `ps` cannot read it. See
 * `claudePermissionHook` above for what is in that file, and for what happens
 * when the operator has a `PermissionRequest` hook of their own.
 *
 * `homeDirectory` is the home of the account the child runs as, injected by the
 * entrypoint that read it: it decides whether the store is the one Claude Code
 * finds unaided, and a builder that looked the home up itself would answer for
 * whatever account a test happened to run under.
 */
export function planClaudeLaunch(
  store: StoreDescriptor,
  cwd: string | null,
  args: readonly string[],
  approval: LaunchApproval | null,
  homeDirectory: string,
): Launch {
  const workingDirectory = parseWorkingDirectory(cwd, store);
  if (!workingDirectory.ok) return { ok: false, problem: workingDirectory.problem };

  return {
    ok: true,
    plan: {
      command: CLAUDE_COMMAND,
      // Before the caller's own arguments rather than after them. A spawn's
      // arguments are the user's prompt, which is content and may begin with
      // anything at all, and an option that follows one is an option whose
      // parse depends on what somebody typed into a form.
      args: approval === null ? args : [CLAUDE_SETTINGS_FLAG, approval.settingsFile, ...args],
      cwd: workingDirectory.cwd,
      // The store last, so that a launch cannot lose `CLAUDE_CONFIG_DIR` to a
      // variable the approval brought: a child in a store outside the home
      // that writes its transcript under `~/.claude` is a session this store
      // never hears about again. Absent for the default store, where naming
      // it would move the child's global config and credentials elsewhere.
      env: isDefaultStore(store, homeDirectory)
        ? { ...approval?.env }
        : { ...approval?.env, [CLAUDE_CONFIG_DIR]: store.path },
      scrubEnvPrefixes: CLAUDE_SCRUB_PREFIXES,
    },
  };
}

/**
 * Whether a store is the directory Claude Code would use with no
 * `CLAUDE_CONFIG_DIR` at all.
 *
 * Only for an absolute home. The server starts without one, and an empty or
 * relative home is not a place a store can be under: the launch then names the
 * store, which is the answer that cannot lose a transcript. Both sides are
 * resolved so that a trailing slash, or a `..` in configuration, compares as
 * the directory it names.
 */
function isDefaultStore(store: StoreDescriptor, homeDirectory: string): boolean {
  if (!isAbsolute(homeDirectory)) return false;
  return resolve(store.path) === resolve(homeDirectory, CLAUDE_DEFAULT_STORE_DIRECTORY);
}
