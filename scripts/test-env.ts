/**
 * The environment every test run gets, decided once here rather than left to
 * the machine the run happens on.
 *
 * A suite reads the machine in more places than a reviewer counts. Every
 * timestamp this codebase formats goes through the process timezone, every
 * locale-aware comparison goes through the process locale, and every parser
 * reading a subprocess's human-readable output goes through whatever locale
 * that child was handed. None of that is visible while everybody is on one
 * laptop. It shows up the first time CI, a container and a machine in another
 * timezone disagree, as a failure whose message names a date or a string order
 * and says nothing about the environment being the cause -- which is the
 * expensive kind, because the message points away from the reason.
 *
 * `TZ=UTC` is the one that changes this process. `LANG` and `LC_ALL` are mostly
 * about what crosses the process boundary: Node on Linux reads them for its
 * default `Intl` locale, Node on macOS does not -- it asks the operating system
 * -- but a child started anywhere reads them, so they are what makes `git`,
 * `npm` and a coding agent speak one language to the parsers on this side.
 * `C.UTF-8` rather than `en_US.UTF-8` because it is the locale a Debian slim
 * image has without an extra package, and it is where ICU falls back to `en-US`
 * rather than to a formatting nobody wrote a fixture against.
 *
 * A variable the run must *not* carry belongs here too, beside the pins: what
 * the environment is, and what it is deliberately missing, are one decision and
 * should be readable in one file. `TEST_CREDENTIAL_VARIABLES` is that half.
 *
 * It takes the environment rather than reaching for `process.env` so that the
 * unit test can hand it an object, and so that this module needs no Node
 * types -- `apps/web` typechecks its own config with the browser's, and it
 * calls this.
 */
export const TEST_ENVIRONMENT_PINS: Readonly<Record<string, string>> = {
  TZ: 'UTC',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
};

/**
 * The provider credentials the run is deliberately without.
 *
 * Nothing otherwise stops a test from passing because the person running it
 * happens to be logged in. The suites that spawn a real provider are the ones
 * this is about, and the distinction they rest on is exactly the one an
 * inherited credential erases: `provider-login.ts` separates a provider that
 * answered "logged out" from one that printed something no parser recognised,
 * because those two want different words from setup -- and on a logged-in
 * machine both can come back "logged in" instead, from a key the test never
 * put there. A green suite then means "this developer has an account", which
 * is not what anybody reads it as.
 *
 * Deletion here is deliberately wider than the runtime scrub, and the two are
 * answering different questions. `CLAUDE_SCRUB_PREFIXES` and
 * `CODEX_SCRUB_PREFIXES` already cover `CLAUDE_CODE_OAUTH_TOKEN` and
 * `CODEX_API_KEY` by prefix, so for a child started through the pty supervisor
 * this is defence in depth -- which is the right side to be on, since the
 * supervisor is not the only thing a suite spawns. The other two are the
 * reason this list exists at all: `ANTHROPIC_API_KEY` is under no scrubbed
 * prefix, and `codex-launch.ts` argues at length for leaving `OPENAI_API_KEY`
 * alone at runtime -- an operator running other tooling on that key should
 * keep it, and codex ignores it anyway. Neither argument survives the move to
 * a test run, where the only environment that matters is the one the suite
 * decided on.
 *
 * Exactly these four, and not a prefix sweep. A prefix wide enough to catch
 * `ANTHROPIC_API_KEY` catches `ANTHROPIC_BASE_URL` with it, and a run that
 * silently drops the endpoint a corporate wrapper needs is the failure this
 * ticket is about, pointing the other way. Adding one is a line here and a
 * sentence in the commit that says which program reads it.
 */
export const TEST_CREDENTIAL_VARIABLES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
];

/**
 * Set to `1` to keep the credentials above for one run.
 *
 * The eval suite is the one thing here that genuinely needs them: its subject
 * is a real provider answering a real question, and it cannot have one without
 * a credential. So the rule is "a test that needs a credential asks for it",
 * and this is the asking -- one documented variable, named in the run that
 * wants it, rather than nine suites each finding their own way around the
 * deletion.
 *
 * Exactly `1`, the shape `CAPTURE_FIXTURES` already uses. A variable that any
 * value at all turned on is a variable a stale `=0` left in a shell profile
 * turns on, and the whole point is that widening the run is a thing somebody
 * did on purpose.
 */
export const TEST_KEEP_CREDENTIALS = 'AGENTPLEX_TEST_KEEP_CREDENTIALS';

/**
 * Overwrites rather than defaults. A developer in another timezone has `TZ`
 * set, and a pin that yielded to what was already there would pin nothing on
 * exactly the machine it exists for.
 *
 * The deletions go through the same function rather than a second one for the
 * same reason the values share a file: both call sites -- the shared vitest
 * config and `apps/web/vite.config.ts` -- get the whole decision by making one
 * call, and a third call site added later cannot get half of it.
 *
 * `delete` rather than assigning an empty string. A program handed
 * `ANTHROPIC_API_KEY=''` can read that as a key it was given and refuse on it,
 * which is a third answer between logged in and logged out and the one nothing
 * in this codebase is written against.
 */
export function pinTestEnvironment(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(TEST_ENVIRONMENT_PINS)) {
    env[name] = value;
  }

  if (env[TEST_KEEP_CREDENTIALS] === '1') return;

  for (const name of TEST_CREDENTIAL_VARIABLES) {
    delete env[name];
  }
}
