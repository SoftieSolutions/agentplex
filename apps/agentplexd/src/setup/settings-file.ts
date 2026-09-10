/**
 * The settings file the daemons start from, as setup fills it in.
 *
 * `install.sh` writes this file once, with the two facts it had and every
 * other setting commented out, and says in it that `agentplexd setup` is what
 * fills the rest in. This module is that: a line for a setting that has none,
 * in place of the commented-out line the installer left for it where there is
 * one, and nothing else in the file touched. An operator's own edits are theirs;
 * the file is theirs; setup owns the lines it names and no others.
 *
 * The format is what systemd reads as an `EnvironmentFile`: `KEY=value`, one
 * per line, `#` for a comment. A value that would not survive that reader
 * unquoted is double-quoted the way systemd unquotes it. Nothing here parses
 * the file: what setup needs is to write two lines without losing the others,
 * and a parser would be a second opinion about a format systemd already has
 * one about.
 */

/** Where the installer puts the settings, inside the prefix agentplex owns. */
export const SETTINGS_FILE_NAME = 'agentplexd.env';

export interface Setting {
  /** An environment variable name: what the daemon's config parser reads. */
  readonly key: string;
  readonly value: string;
}

/**
 * The file with these settings in it, whatever was there before.
 *
 * `null` for a file that does not exist yet, which gets exactly the lines
 * asked for. An existing line for a key is replaced in place, an installer's
 * commented-out line for it is replaced in place, and a key the file has never
 * heard of is appended. The first match wins and later duplicates are left,
 * because a second uncommented line for one key is somebody's edit and not
 * this module's to tidy.
 */
export function upsertSettings(existing: string | null, settings: readonly Setting[]): string {
  const lines = existing === null || existing.length === 0 ? [] : existing.split('\n');
  // A trailing newline splits into a final empty element. Kept aside so that
  // appending goes before it and the file still ends in a newline.
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();

  for (const setting of settings) {
    const line = `${setting.key}=${quote(setting.value)}`;
    const set = lines.findIndex((candidate) => isAssignment(candidate, setting.key));
    if (set !== -1) {
      lines[set] = line;
      continue;
    }
    const commented = lines.findIndex((candidate) => isCommentedAssignment(candidate, setting.key));
    if (commented !== -1) {
      lines[commented] = line;
      continue;
    }
    lines.push(line);
  }

  return `${lines.join('\n')}\n`;
}

function isAssignment(line: string, key: string): boolean {
  return line.startsWith(`${key}=`);
}

function isCommentedAssignment(line: string, key: string): boolean {
  return /^#\s*/.test(line) && line.replace(/^#\s*/, '').startsWith(`${key}=`);
}

/**
 * Quoted only when it has to be. A bare absolute path and a port are what these
 * lines nearly always hold, and a file somebody opens to check a setting should
 * read like the one the installer wrote.
 */
function quote(value: string): string {
  if (!/[\s"'#\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
