/**
 * Where a bare program name would come from.
 *
 * A seam, because it is a filesystem: the directories a child searches and
 * which of them holds an executable file are facts about a machine, and a test
 * that had to create real programs in real directories to ask a question about
 * a missing one would be testing the disk.
 *
 * It answers with a directory and never with a path to the binary, which is the
 * same rule `binPath` is built on: `file` in an argv is a program name and never
 * a path, so nothing here can hand a caller something that would be spawned
 * directly. What it produces is an answer to "which directory did this come
 * from", which is what an operator asks when the wrong version runs, and it is
 * the only place that answer exists -- once a pty has forked, the resolution has
 * happened on the far side of it and nothing can be asked afterwards.
 */
export interface ProgramResolver {
  /**
   * The first directory on the search path holding an executable by that name,
   * or `null` when none does.
   *
   * Never rejects. A directory that cannot be listed is a directory that
   * supplies no program, and one unreadable entry on a PATH must not cost the
   * answer for the entries after it.
   */
  resolve(name: string): Promise<string | null>;
}
