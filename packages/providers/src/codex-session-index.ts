import { z } from 'zod';

/**
 * codex's own names for its sessions.
 *
 * The seam's `DiscoveredSession.title` is "what the provider calls this
 * session", and for codex that is not in the transcript. It is one JSONL file
 * at the root of the store:
 *
 *     <store>/session_index.jsonl
 *
 * with a line per session naming it. Claude Code writes its `ai-title` into
 * the transcript itself, so this is the first place the two providers keep the
 * same fact in structurally different places — and it costs the seam nothing,
 * because discovery is the adapter's to compose. Nothing above it learns that
 * one provider reads one file per session and the other reads one more file
 * for the whole store.
 *
 * Read once per discovery rather than once per session, for the reason the
 * Claude registry is: it is one file for the whole store, and every session in
 * the store resolves against the same snapshot of it.
 */

/** Where codex keeps its session names inside a store. */
export const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl';

/**
 * Two fields out of the three codex writes.
 *
 * `updated_at` is deliberately not read. It is the index's idea of when the
 * session changed, and the rollout — which is the file discovery has to open
 * anyway — states the same thing first-hand. Dating a session by a summary of
 * it when the thing itself is in hand is how two answers start disagreeing.
 */
const entrySchema = z.object({ id: z.string().min(1), thread_name: z.string().min(1) });

/**
 * Session id to the name codex gave it.
 *
 * Later lines win. codex appends rather than rewrites when it renames a
 * session, and taking the last is correct either way: if a release starts
 * rewriting the file instead, there is only ever one line per session to take.
 *
 * Never throws and never fails as a whole. A torn line — this file is written
 * while sessions are being named — costs its own title and nothing else. A
 * missing name is a `null` title, which the seam already has a meaning for; a
 * store that lost its whole session list over one bad line would not.
 */
export function parseCodexSessionIndex(contents: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();

  for (const line of contents.split('\n')) {
    if (line.trim() === '') continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const parsed = entrySchema.safeParse(entry);
    if (parsed.success) names.set(parsed.data.id, parsed.data.thread_name);
  }

  return names;
}
