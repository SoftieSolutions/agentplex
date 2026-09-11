/**
 * Reading back the settings file, which nothing else here has ever had to do.
 *
 * `settings-file.ts` writes into this file without parsing it, and says why:
 * what setup needs is to replace two lines without losing the others, and a
 * parser would be a second opinion about a format systemd already has one
 * about. That argument holds for writing and stops holding here. `start`,
 * `stop` and `status` need two values out of it -- the prefix an installer
 * recorded and the role it was given -- and there is no way to have a value
 * without reading the format.
 *
 * So this reads it, and the shape of what it reads is the whole of the
 * discipline: two keys, by name, out of a file whose other lines it does not
 * claim to understand. It is not a systemd `EnvironmentFile` parser and must
 * not grow into one. The things it deliberately does not do -- continuation
 * lines, `$VARIABLE` expansion, single-quoted C-escapes -- are all things
 * systemd does, and a reader that did half of them would be more wrong than one
 * that does none: an operator whose file uses them would get a value that is
 * quietly not the one the daemon is started with.
 *
 * What it does handle is exactly what the installer and setup write:
 * `KEY=value` with `#` comments, and the double-quoted form `settings-file.ts`
 * produces for a value with whitespace or a `#` in it. A line it cannot make
 * sense of is skipped rather than failing the read, because the alternative is
 * `status` refusing to say anything about a machine over a comment somebody
 * typed by hand.
 */

/** What a settings file says about itself, as far as these commands care. */
export interface RecordedSettings {
  /** `AGENTPLEX_PREFIX`, or `null` when the file records none. */
  readonly prefix: string | null;
  /** `AGENTPLEX_ROLE`, or `null`. Not parsed into a role: see below. */
  readonly role: string | null;
}

const PREFIX_KEY = 'AGENTPLEX_PREFIX';
const ROLE_KEY = 'AGENTPLEX_ROLE';

/**
 * The two values, or `null` for each the file does not carry.
 *
 * The role is carried through as the word the file holds rather than parsed
 * against the three roles that exist. `status` reports what is installed, and
 * the honest report of a settings file that says `AGENTPLEX_ROLE=hubb` is that
 * it says `hubb` -- which is also the thing that tells the operator why their
 * daemon will not start. Refusing it here would replace that with "no role",
 * which is a different and untrue statement. The daemons parse it, and their
 * refusal is where a bad role is an error.
 */
export function readEnvironmentFile(contents: string): RecordedSettings {
  const values = new Map<string, string>();

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key !== PREFIX_KEY && key !== ROLE_KEY) continue;
    // The last assignment wins, which is what systemd does with a file that
    // names one key twice and therefore what the daemon was started with.
    values.set(key, unquote(trimmed.slice(separator + 1).trim()));
  }

  return { prefix: values.get(PREFIX_KEY) ?? null, role: values.get(ROLE_KEY) ?? null };
}

/**
 * The double-quoted form undone, exactly as `settings-file.ts` writes it.
 *
 * Anything that is not a complete double-quoted string is taken as it stands,
 * which is the bare-path case the installer writes and the case that matters.
 */
function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
}
