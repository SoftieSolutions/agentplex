import { machineOsSchema } from '@agentplex/protocol';

/**
 * Where a Linux distribution says what it is, in the order `os-release(5)`
 * says to look: `/etc/os-release`, and `/usr/lib/os-release` when the first is
 * absent. The first is usually a link to the second; an image that dropped the
 * link still ships the file it pointed at.
 */
export const OS_RELEASE_PATHS: readonly string[] = ['/etc/os-release', '/usr/lib/os-release'];

/**
 * The name a Linux machine's distribution gives itself, out of the text of its
 * `os-release` file, or `null` when the text names none.
 *
 * `PRETTY_NAME` first, because it is the field the format defines for exactly
 * this -- a name to show a person -- and the distribution chose its words:
 * `Debian GNU/Linux 12 (bookworm)`, `Ubuntu 24.04.5 LTS`. Then `NAME` with
 * `VERSION_ID`, the format's own fallback, and `NAME` alone for a rolling
 * release that has no version to give. A candidate the wire would refuse --
 * too long for the card, or holding a control character -- is passed over for
 * the next one rather than sent, because the hub refusing it would refuse the
 * whole handshake over a label.
 *
 * A file and not a program, so it is read rather than run: there is no
 * operation for it, and `cat` would be a spawn standing in for `readFile`.
 */
export function osReleaseName(text: string): string | null {
  const fields = parseOsRelease(text);
  const name = fields.get('NAME');
  const version = fields.get('VERSION_ID');

  const candidates = [
    fields.get('PRETTY_NAME'),
    name !== undefined && version !== undefined ? `${name} ${version}` : undefined,
    name,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const parsed = machineOsSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** `KEY=value`, where a key is what the format allows: capitals, digits, underscores. */
const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/**
 * Every assignment in the file that reads cleanly, by key.
 *
 * The format is a shell-compatible subset, and this reads the subset and no
 * more: a value bare, in single quotes, or in double quotes with the four
 * backslash escapes the format names. It expands nothing -- a `$` is a dollar
 * sign -- and a line it cannot read is skipped rather than guessed at, which
 * costs that one key and not the file.
 */
function parseOsRelease(text: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = ASSIGNMENT.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const value = unquote(match[2]);
    if (value !== null) fields.set(match[1], value);
  }
  return fields;
}

/** The characters a backslash may escape inside double quotes. */
const ESCAPABLE = new Set(['"', '\\', '$', '`']);

function unquote(value: string): string | null {
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === value.length - 1 ? value.slice(1, end) : null;
  }

  if (value.startsWith('"')) {
    let read = '';
    for (let at = 1; at < value.length; at += 1) {
      const character = value.charAt(at);
      if (character === '"') return at === value.length - 1 ? read : null;
      if (character === '\\' && ESCAPABLE.has(value.charAt(at + 1))) {
        read += value.charAt(at + 1);
        at += 1;
        continue;
      }
      read += character;
    }
    // The quote never closed.
    return null;
  }

  // Bare: the format quotes anything with a space or a shell character in it,
  // so a bare value holding one is a line written some other way.
  return /^[^\s"'`$\\]*$/.test(value) ? value : null;
}
