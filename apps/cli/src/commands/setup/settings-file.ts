/**
 * The settings file the daemons start from, as setup fills it in.
 *
 * `install.sh` writes this file once, with the two facts it had and every
 * other setting commented out, and says in it that `agentplex setup` is what
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

/**
 * The two settings setup writes when it records a local server, as the hub's
 * config parser reads them.
 *
 * Setup's own copy of the names, because setup may not import the hub. The
 * hub's `config.test.ts` asserts on the same literals, so two spellings of one
 * setting -- a machine that provisions cleanly and then comes up unpaired --
 * fail there rather than on somebody's box.
 */
export const LOCAL_SERVER_SETTINGS = {
  identityFile: {
    flag: '--local-server-identity-file',
    env: 'AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE',
  },
  port: { flag: '--local-server-port', env: 'AGENTPLEX_LOCAL_SERVER_PORT' },
} as const;

/**
 * A server setting setup writes into the same file. The other is the server's
 * identity file, which the wizard names from the shared table in node-shared.
 *
 * Setup's own copy of the name, for the reason above: setup may not import the
 * server, and the server's `config.test.ts` asserts on the same literal, so two
 * spellings fail there rather than as a machine that browses nothing after a
 * run in which somebody named a root.
 *
 * It is here rather than left to the installer's commented-out line because it
 * is the one server setting a person answers a question about: a store path is
 * usually the provider directory the survey already found, and a browse root is
 * a decision about what a client may see, asked in words and worth recording
 * where the daemon will actually read it.
 */
export const BROWSE_ROOTS_SETTING = {
  flag: '--browse-root',
  env: 'AGENTPLEX_BROWSE_ROOTS',
} as const;

/**
 * The separator a path list takes in this file: the platform's, which is what
 * `readAbsolutePaths` splits an env var on.
 *
 * A colon on every platform agentplex runs a daemon on. It is written here
 * rather than imported for the reason the names above are -- setup may not
 * import the daemon that reads it -- and a value that disagreed would be a
 * machine whose roots all parsed as one directory nobody has.
 */
const PATH_LIST_SEPARATOR = ':';

/** A path list as one settings value, or `null` when there is nothing to say. */
export function pathListValue(paths: readonly string[]): string | null {
  return paths.length === 0 ? null : paths.join(PATH_LIST_SEPARATOR);
}

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
