import { z } from 'zod';

/**
 * The shapes a project document travels in: its name, the project it belongs
 * to, its content and its listing entry.
 *
 * A document is a file the server keeps in a project's folder under its own
 * data root -- notes, a plan, the markdown somebody wrote at an agent and wants
 * back tomorrow. The server side of that store says what a project folder is
 * and who may write in it; this file says what may cross the wire to name one.
 * Every rule here is a parser rather than a convention, because the name is
 * the one string in this protocol that ends up joined onto a path on somebody's
 * disk, and a path is not an access control.
 */

/**
 * What a document may be called. The shape is the whole security property.
 *
 * One path segment, ASCII, and nothing a filesystem or a shell would read as
 * anything but a name:
 *
 * - No separator of either kind and no `..` anywhere in it, so a name cannot
 *   leave the folder it is written into. This is the traversal the tests are
 *   written against.
 * - No leading dot, so a name can be neither `.` nor `..` nor a hidden file --
 *   and the temporary file a write goes through is hidden, so nothing on the
 *   wire can name one.
 * - No NUL, no newline, no space: the first truncates a path inside a syscall,
 *   the second ends a name early in a log line, the third invites a quoting bug
 *   in whatever reads the directory next.
 * - No leading hyphen, so a name read by any program is never a flag.
 * - ASCII only, for the reason a project key is: `café` has two byte
 *   spellings, macOS and Linux disagree about which one a filesystem stores,
 *   and a file with two spellings is two files that look identical.
 * - An extension from a closed list, lower case, so what the store holds is
 *   what it was made for -- text a person reads -- and never something a
 *   double-click would run.
 *
 * Upper case is allowed in the stem, unlike a project key, and that is a
 * trade made with open eyes. A key is minted by the server and read by nobody;
 * a name is typed by a person, and `README.md` is a name people type. On a
 * case-insensitive filesystem `Plan.md` and `plan.md` are one file, and the
 * listing reports whichever spelling the disk kept, which is the direction
 * that does not over-claim.
 */
export const DOC_NAME_EXTENSIONS = ['.md', '.txt', '.json', '.csv'] as const;

/**
 * Comfortably inside the 255 bytes a filesystem takes for one name, with room
 * for the hidden temporary name a write goes through beside it.
 */
export const DOC_NAME_MAX_LENGTH = 120;

/** Letters, digits, dots, hyphens and underscores, starting and ending on something that is not a dot. */
const DOC_NAME_STEM = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;

export const docNameSchema = z
  .string()
  .min(1)
  .max(DOC_NAME_MAX_LENGTH)
  .refine(
    (name) => DOC_NAME_EXTENSIONS.some((extension) => name.endsWith(extension)),
    `a document name ends in one of ${DOC_NAME_EXTENSIONS.join(', ')}`,
  )
  .refine((name) => !name.includes('..'), 'a document name never contains two dots in a row')
  .refine((name) => {
    const extension = DOC_NAME_EXTENSIONS.find((candidate) => name.endsWith(candidate));
    const stem = extension === undefined ? name : name.slice(0, -extension.length);
    return DOC_NAME_STEM.test(stem);
  }, 'a document name is one path segment of ASCII letters, digits, dots, hyphens and underscores, ' + 'starting with a letter or a digit and never containing two dots in a row')
  .brand<'DocName'>();
export type DocName = z.infer<typeof docNameSchema>;

/**
 * The project a document belongs to, named by its working tree.
 *
 * A key into the server's project file store and nothing else: the server
 * derives a folder name from it by a one-way function and never hands it to a
 * process. Absolute, because a relative path names no directory without a
 * second thing to read it against; NUL-free, because a path with a NUL in it
 * is one string to this program and a shorter one to the kernel.
 *
 * The same two rules `directorySchema` applies on the server, spelled without
 * `node:path` because this package is bundled into a browser. A leading `/`
 * is what absolute means on every platform a server runs on.
 */
export const docDirectorySchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\u0000'), 'a directory may not contain a null byte')
  .refine((value) => value.startsWith('/'), 'a directory must be an absolute path');

/**
 * How large a document may be, in UTF-16 code units, which is what a string's
 * length is in the runtime that measures it.
 *
 * A quarter of a million characters is around sixty pages of prose, which is
 * more than a note, a plan or a specification ever is and enough that nobody
 * has to think about it. The bound is there for the socket: a frame is held
 * whole by the peer that reads it, and the message socket drops a connection
 * over a frame past a megabyte. Ordinary text is one byte per character on the
 * wire and any character in the Basic Multilingual Plane is at most three, so
 * a document at this cap arrives as one frame under that ceiling rather than
 * as a dropped connection nothing explains.
 */
export const DOC_CONTENT_MAX_CHARS = 256_000;

export const docContentSchema = z.string().max(DOC_CONTENT_MAX_CHARS);

/**
 * One document in a listing: what it is called, when it was last written, and
 * how big it is on disk.
 *
 * `updatedAt` is the server's clock as the filesystem recorded it, in
 * milliseconds since the epoch. It is a fact about a file on that machine
 * rather than a time the hub should compare with its own, which is the same
 * caveat a session descriptor's `updatedAt` carries.
 */
export const docEntrySchema = z.object({
  name: docNameSchema,
  updatedAt: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
});
export type DocEntry = z.infer<typeof docEntrySchema>;
