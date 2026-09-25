/**
 * The first line a program printed, trimmed, for a problem that quotes it.
 *
 * A program's first line is its sentence -- "not a git repository", "No such
 * file or directory" -- and whatever follows is usage text nobody asked for.
 * Empty input yields `''` rather than a stock phrase, because what "nothing"
 * should read as differs per caller: one falls through to another stream, one
 * to an exit code, one splits the line into words. Each writes its own `||`.
 */
export function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').trim();
}
