/**
 * Whether a passive update notice is wanted at all, decided before anything
 * that could print one is loaded.
 *
 * Its own module, with no imports, and that is the point rather than tidiness.
 * The bin dispatches to every command through a lazy `import()` so that
 * `agentplex --version` never evaluates the wizard's module graph, and a notice
 * that pulled the release schema, the provider seam and zod into every run
 * would undo that for a line most runs do not print. So the cheap question is
 * answered from here, eagerly, and the module that can answer the expensive one
 * is loaded only when the answer is yes.
 */

/** The flag that turns it off for one run. */
export const NO_UPDATE_CHECK_FLAG = '--no-update-check';

/** The variable that turns it off for a machine, a CI job or a shell. */
export const NO_UPDATE_CHECK_VARIABLE = 'AGENTPLEX_NO_UPDATE_CHECK';

/**
 * Whether anybody is there to read a notice.
 *
 * The TTY test is the one that does most of the work. It is what keeps this out
 * of pipes, logs, CI output, `$(...)` and -- the one that would otherwise
 * recurse -- the notice's own background refresh, which is started with its
 * stdio going nowhere and therefore has no terminal.
 */
export function noticeWanted(sources: {
  readonly stderrIsTty: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
}): boolean {
  if (!sources.stderrIsTty) return false;
  const silenced = sources.environment[NO_UPDATE_CHECK_VARIABLE];
  // Any value at all, including `0`. Somebody who exported this wants silence,
  // and a variable whose value has to be parsed is one more thing to get wrong
  // about a feature whose whole job is to be unobtrusive.
  if (silenced !== undefined && silenced.length > 0) return false;
  return !sources.argv.includes(NO_UPDATE_CHECK_FLAG);
}

/**
 * The flag removed from an argv.
 *
 * Every command reads `process.argv.slice(2)` and refuses an argument it does
 * not know, so a flag the bin handles has to be gone before the command sees
 * it -- the same removal the command word itself gets.
 */
export function withoutNoticeFlag(argv: readonly string[]): readonly string[] {
  return argv.filter((argument) => argument !== NO_UPDATE_CHECK_FLAG);
}
