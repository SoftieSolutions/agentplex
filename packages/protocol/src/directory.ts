import { z } from 'zod';
import { frameIdSchema } from './frames.js';

/**
 * The one shape a directory takes on this wire, and the rule that lets it
 * cross at all.
 *
 * The v2 rule said no frame carries an operation name, an argv element, an env
 * var or a cwd. The last of those is amended here, in the commit that adds the
 * first frame to carry one, and the amendment is narrow:
 *
 * > No frame carries an operation name, an argv element or an env var. A
 * > directory crosses the wire only as a `directory` field parsed by
 * > `directorySchema`, refused unless under a configured browse root, and the
 * > only spawn field it may reach is `cwd`.
 *
 * The rule's argument was that a `{ command }` or `{ cwd }` field is a generic
 * execution surface. Three things together are what make this one not that,
 * and none of them is optional: the value is parsed here rather than taken as
 * read; the server refuses it unless it sits under a root its own operator
 * configured, which is a list no frame can add to; and the only spawn field it
 * may ever reach is `cwd`, on a spawn that still goes through the operation
 * registry with `shell: false` and an argv this process built.
 *
 * The rejected alternative was server-declared workspaces with opaque ids on
 * the wire, which keeps the old rule verbatim. It was rejected because it makes
 * adding a directory a server-side setup action, and the decision this protocol
 * is built around is that the user browses for one. `CONTRIBUTING.md` carries
 * that argument so it is not re-argued.
 *
 * Absolute, because a relative path would resolve against whatever directory
 * the peer happens to have been started in, and because an absolute path cannot
 * be mistaken by a program for one of its own options. No NUL, because a NUL
 * truncates the path at the syscall, so what is opened is a prefix of what was
 * checked.
 *
 * Absolute means POSIX-absolute -- a leading `/` -- rather than whatever
 * `node:path` says on the machine doing the parsing. This module is bundled
 * into a browser as well as loaded by both services, so it may not reach
 * `node:path` at all; and a wire schema whose meaning changed with the reader's
 * operating system would be two schemas. Every machine agentplex runs a server
 * on is one where that is the same answer.
 *
 * It is one schema for the whole repository rather than one per frame or one
 * per operation: the things that take a directory must agree about what one is,
 * and the day two copies disagree, one accepts a path the other refuses and it
 * reads as a bug in whatever ran last.
 */
export const directorySchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'a directory may not contain a null byte')
  .refine((value) => value.startsWith('/'), 'a directory must be an absolute path');

/**
 * What one entry in a listing turned out to be.
 *
 * Three words rather than two. `other` is not a tidy-up for the unusual: it is
 * where a symlink goes, and a symlink is the one entry kind whose honest answer
 * is "this is not what it looks like". Reporting one as a directory would
 * invite a client to descend through it, and descending is exactly what the
 * containment rule is there to bound -- a link inside a root can point
 * anywhere. So links are named for what they are, never followed, and a client
 * that wants what is behind one has to be given a root that contains it.
 *
 * Sockets, fifos and devices land here too, for the weaker reason that a
 * picker has nothing to do with them and nothing should have to guess.
 */
export const directoryEntryKindSchema = z.enum(['directory', 'file', 'other']);
export type DirectoryEntryKind = z.infer<typeof directoryEntryKindSchema>;

/**
 * One entry, named the way the directory names it.
 *
 * A name and not a path, except at the top: when the reply's `directory` is
 * `null` the entries are the roots themselves, and a root has no parent to be
 * named relative to, so each carries its own absolute path. Everywhere else the
 * name is a single segment and the client joins it onto the directory it asked
 * about. `roots` is on every reply, so a client always knows which of the two
 * it is holding without having to remember what it asked for.
 *
 * Hidden entries are listed. A dotfile is not a secret -- `.git` and `.env` are
 * the two directories somebody browsing for a project most wants to see -- and
 * a picker that quietly omitted them would be a picker that cannot reach half a
 * checkout.
 */
export const directoryEntrySchema = z.object({
  name: z.string().min(1),
  kind: directoryEntryKindSchema,
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

/**
 * How many entries one listing may carry.
 *
 * A bound rather than paging, because what this is for is a person choosing a
 * project directory, and a directory with more than this many entries in it is
 * not one anybody scrolls. The frame says `truncated` when it hit the cap, so
 * the client can say "there are more" instead of quietly showing a prefix as
 * though it were the whole -- which is the same rule the terminal's dropped
 * chunk counter follows, in the direction that does not over-claim.
 *
 * A thousand: larger than any checkout's top level and small enough that the
 * frame stays a frame. `node_modules` is the directory that reaches it, and
 * reaching it there is the correct outcome.
 */
export const DIRECTORY_ENTRIES_MAX = 1000;

/**
 * Ask what is in a directory on one server. The hub-to-server leg.
 *
 * `null` asks for the roots themselves, which is how a browse starts: the
 * client does not know what this machine will allow and must not have to
 * guess, so the first request names nothing and the answer names everything it
 * may name from here.
 *
 * The client leg carries one more field -- which server -- and is defined in
 * `client.ts` beside the rest of that direction. By the time a request reaches
 * this leg the hub has already picked the connection, so naming the machine
 * again would be the hub telling a server which server it is.
 */
export const directoryListFrameSchema = z.object({
  type: z.literal('directory-list'),
  id: frameIdSchema,
  directory: directorySchema.nullable(),
});

/**
 * What is in that directory, on both legs unchanged.
 *
 * One shape for the client leg and the server leg, for the reason the terminal
 * frames have one: a listing is relayed rather than rebuilt, and two copies of
 * this would be two things to keep in step for no gain.
 *
 * `directory` is what was actually listed, echoed back rather than left to be
 * remembered, because a client may have more than one browse in flight and a
 * reply that only carried a `replyTo` would make it join two facts to know
 * where it is. `roots` is on every reply for the same reason: the breadcrumb
 * has to stop somewhere, and where it stops is the server's answer and not the
 * client's to infer.
 */
export const directoryListingFrameSchema = z.object({
  type: z.literal('directory-listing'),
  replyTo: frameIdSchema,
  /** The directory listed, or `null` for the listing of roots. */
  directory: directorySchema.nullable(),
  /** Every root this server will browse under, absolute. Never empty on a reply. */
  roots: z.array(directorySchema),
  /** Sorted by name, capped at `DIRECTORY_ENTRIES_MAX`. */
  entries: z.array(directoryEntrySchema).max(DIRECTORY_ENTRIES_MAX),
  /** True when the cap cut the listing short. */
  truncated: z.boolean(),
});
export type DirectoryListingFrame = z.infer<typeof directoryListingFrameSchema>;

/**
 * The one spelling of a directory two peers compare by.
 *
 * `directorySchema` says what a directory may be; this says which of several
 * spellings of one directory is the one anything stores or compares. They are
 * different jobs and the second only exists because two things now have to
 * agree about sameness across a wire: the hub files a session under a project
 * when the `cwd` the server reported *is* the project's directory, and the
 * server derives a project file store's key from the same string. A comparison
 * of raw paths would make `/srv/work` and `/srv/work/` two projects, which is
 * a distinction no filesystem draws and no person intends.
 *
 * Only the normalisation POSIX itself defines is applied -- a redundant `.`, a
 * resolved `..`, a repeated or trailing separator -- because that is string
 * semantics rather than a guess about a filesystem. Nothing here touches a
 * disk, and that is deliberate in both directions: a project whose directory
 * has been deleted still has a directory, and `..` past the root resolves to
 * the root the way every POSIX path resolver does rather than climbing out.
 *
 * What is deliberately *not* folded: case, Unicode spelling, and symlinks.
 * `/srv/Work` and `/srv/work` are one directory on macOS and two on Linux, the
 * two byte spellings of `café` likewise, and two paths through a link to one
 * directory are one directory to the kernel. Folding any of them would put one
 * project's sessions under another's on the systems where they are genuinely
 * distinct, which is a leak; keeping them apart costs a duplicate project on
 * the systems where they are not, which is visible and harmless.
 *
 * Written as string work rather than as `node:path`, because this module is
 * bundled into a browser as well as loaded by both services -- and checked
 * against `node:path`'s POSIX `normalize` at the origin, over the cases in
 * `directory.test.ts`.
 */
export function normaliseDirectory(directory: string): string {
  const segments: string[] = [];
  for (const segment of directory.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}
