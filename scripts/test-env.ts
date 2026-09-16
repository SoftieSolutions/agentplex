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
 * should be readable in one file.
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
 * Overwrites rather than defaults. A developer in another timezone has `TZ`
 * set, and a pin that yielded to what was already there would pin nothing on
 * exactly the machine it exists for.
 */
export function pinTestEnvironment(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(TEST_ENVIRONMENT_PINS)) {
    env[name] = value;
  }
}
