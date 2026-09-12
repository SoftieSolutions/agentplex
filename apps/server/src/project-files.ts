import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import type { DirectoryCreate } from './data-root.js';

/**
 * The project file store: one folder per project, for the files a project
 * accumulates that are nobody else's to hold.
 *
 * A session produces things that are not transcripts -- notes, a plan, a
 * specification, the markdown somebody wrote at an agent and wants back
 * tomorrow. Until this file there were two places either could go and both were
 * wrong. A provider's store is the provider's directory: `data-root.ts` says
 * why nothing of ours goes in it, and a store mounted by two servers would
 * collect both their writes. A session's working tree is the user's repository,
 * and leaving a file in one makes agentplex a program that changes projects
 * nobody asked it to change.
 *
 * So this is the third place, and it is under the data root because that is
 * what the data root is for: it survives a restart, no other program on the
 * machine names these files, and the rule there already anticipated it.
 *
 * ## What a project is here
 *
 * **A working tree, as a string.** The key is derived from the absolute path a
 * session was working in, and from nothing else.
 *
 * It is deliberately not the hub's notion. AGX-133 defines a project in the hub
 * as a grouping over stores and sessions, and a server cannot see one: the hub
 * owns the database and a server holds none. The other road was open -- the hub
 * tells the server which project a session belongs to -- and it was not taken,
 * for two reasons that are the same reason twice.
 *
 * The first is that a server filing a folder under an id only a hub can resolve
 * owns files it cannot attribute. Replace the hub, rebuild its database, pair
 * the machine to a second one, and every folder on this disk is named for a row
 * that no longer exists. Nothing on the server can say whose notes those were,
 * and the thing that knew is gone. Deriving from the working tree means the
 * server can always answer the question itself, and a hub that has never been
 * seen before can answer it too, by deriving the same key from the `cwd` it
 * already receives on every session.
 *
 * The second is that two hubs may group the same sessions differently, and both
 * are entitled to. A grouping is an opinion; a working tree is a fact about
 * this disk. A server that stored the opinion would have to pick one hub's, and
 * a folder whose contents depend on which hub was paired first is a folder
 * nobody can reason about.
 *
 * What the hub loses is nothing it had: a project in the hub's sense maps onto
 * a set of these folders, and the mapping is the hub's to keep, which is where
 * every other grouping it owns already lives.
 *
 * What this costs, honestly: two checkouts of one repository are two projects
 * here, and a working tree that moves takes a new folder and leaves the old one
 * behind. Both are visible -- a folder records the path it was derived from --
 * and both are the direction that does not over-claim. The alternative is one
 * folder holding two projects' files, and that is a leak rather than a
 * duplicate.
 *
 * ## Who writes
 *
 * **This server, on its own account.** Nothing here is reachable by a session's
 * agent, and no path in this module is handed to a child process.
 *
 * That is the whole of it, and it is a smaller thing than it looks. An agent
 * writing into its project's folder means the folder's path reaches a child
 * process, which means it is an environment variable or an argv element, and
 * `CONTRIBUTING.md` spends a rule on why a spawn takes neither from anything
 * outside the operation registry. It would also mean the path is the only thing
 * keeping one session out of another project's folder, and a path is not an
 * access control: a process that can read an environment variable can read the
 * directory above it.
 *
 * A file written by this server in response to a request it parsed is a
 * different thing entirely. The request names a session; this server already
 * knows that session's working tree, because it read it out of the provider's
 * transcript or spawned the process itself; the key is derived here and the
 * name is checked here. Nothing outside ever names a folder, so nothing outside
 * can name somebody else's.
 *
 * `project-docs.ts` is that request: the three document frames a hub sends,
 * answered by this server writing into, reading from and listing a folder
 * derived here. It inherits the rule rather than restating it -- the frame
 * carries the working tree as a key, the key is derived here, the name is
 * checked at the protocol, and no path either builds is handed to a process.
 *
 * ## What it is called, and what it is not called
 *
 * `.agentplex` is the obvious name and it is taken. It is the install prefix --
 * `bin`, and the programs `agentplex setup` provisions -- and on the default
 * tier it is also the data root, so a `.agentplex` inside a data root that is
 * already `.agentplex` is a sentence nobody should have to read. Two different
 * things with one name is a confusion that outlives everybody who remembers the
 * distinction.
 *
 * `project-files` says what is in it rather than what owns it, which is the
 * useful half: the data root already says who owns it. It is not hidden,
 * because hiding a directory inside a directory no other program writes to
 * buys nothing and costs the operator a `-a`.
 *
 * ## What is deliberately not here
 *
 * No syncing of these files to a hub, no rendering of them, and no versioning.
 * Each is its own ticket and each needs something to read first. This file is
 * the place and the rules for it.
 */

/** The one directory under the data root that holds them. */
export const PROJECT_FILES_DIRECTORY = 'project-files';

/**
 * The note in each folder saying what it is for.
 *
 * Not prefixed the way `agentplex-store.json` is. That name is namespaced
 * because it is minted at the root of somebody else's volume and has to not
 * collide with what the provider keeps there. This folder is ours, and
 * everything in it is ours.
 */
export const PROJECT_FILE_NAME = 'project.json';

/**
 * A project key: what one project's folder is called.
 *
 * The shape is the whole security property of this module, so it is a parser
 * rather than a convention. Lower-case ASCII letters and digits in
 * hyphen-separated runs, and nothing else:
 *
 * - No separator and no parent reference, so a key cannot leave the folder it
 *   names. This is the traversal the tests are written against.
 * - No dot at all, so a key can be neither `.`, `..`, nor a hidden file.
 * - No NUL, no newline, no space: the first truncates a path inside a syscall,
 *   the second ends a name early in a log line, the third invites a quoting bug
 *   in whatever reads the directory next.
 * - No leading hyphen, so a key read by any program is never a flag.
 * - **ASCII only**, which is the answer to NFC and NFD. `café` has two byte
 *   spellings, macOS and Linux disagree about which one a filesystem stores,
 *   and a directory with two spellings is two directories that look identical.
 *   A key has one spelling on every filesystem because there is no character in
 *   it that has a second one.
 * - **Lower case only**, for the same reason one step further: a
 *   case-insensitive filesystem would otherwise give `Work` and `work` one
 *   directory and two keys.
 *
 * The brand is not decoration. `projectPath` takes a `ProjectKey` and not a
 * string, so the only way to a path under the project root is through this
 * parser, and a name that never passed it cannot be joined onto anything.
 */
const PROJECT_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Comfortably inside the 255 bytes a filesystem takes for one name, and well
 * above anything the deriver emits. The cap is for a key that arrives from
 * somewhere else, which one day one will.
 */
const PROJECT_KEY_MAX_LENGTH = 100;

export const projectKeySchema = z
  .string()
  .min(1)
  .max(PROJECT_KEY_MAX_LENGTH)
  .regex(PROJECT_KEY_PATTERN)
  .brand<'ProjectKey'>();
export type ProjectKey = z.infer<typeof projectKeySchema>;

export type ProjectKeyResult =
  | { readonly ok: true; readonly projectKey: ProjectKey }
  | { readonly ok: false; readonly problem: string };

/**
 * The parser that can say no. Every path into a directory name goes through it.
 *
 * The refusal quotes the name because the person reading it is looking for
 * which name was rejected, and a message that describes the shape without
 * naming the offender sends them back to the logs.
 */
export function parseProjectKey(name: string): ProjectKeyResult {
  const parsed = projectKeySchema.safeParse(name);
  return parsed.success
    ? { ok: true, projectKey: parsed.data }
    : {
        ok: false,
        problem:
          `${JSON.stringify(name)} is not a project key: ` +
          `a key is lower-case ASCII letters and digits in hyphen-separated runs, ` +
          `at most ${PROJECT_KEY_MAX_LENGTH} of them, so that it can name no directory but its own`,
      };
}

/** Where every project's folder lives. One directory, under the data root. */
export function projectFilesRoot(dataRoot: string): string {
  return join(dataRoot, PROJECT_FILES_DIRECTORY);
}

/**
 * One project's folder.
 *
 * It takes a `ProjectKey` rather than a string on purpose: the join is not what
 * makes this safe, the parser that produced the key is, and a signature that
 * accepted a string would move the question to every caller.
 */
export function projectPath(dataRoot: string, projectKey: ProjectKey): string {
  return join(projectFilesRoot(dataRoot), projectKey);
}

/** How much of the working tree's own name survives into the key. */
const KEY_SLUG_LENGTH = 32;

/** Hex characters of the digest. 64 bits of it, which no disk will collide. */
const KEY_DIGEST_LENGTH = 16;

/** What a working tree whose name has no ASCII in it is called. */
const FALLBACK_SLUG = 'project';

/**
 * The key for one working tree.
 *
 * Two halves, and each is there for something the other cannot do. The slug is
 * the working tree's own name, flattened to the key's shape, so that a person
 * looking in `project-files` sees `agentplex-...` rather than a row of hashes.
 * The digest is of the whole absolute path, so that two checkouts called
 * `agentplex` are two folders rather than one.
 *
 * **It never touches the disk.** No `realpath`, no `stat`: a key must be
 * derivable for a working tree that has been deleted, or this store forgets a
 * project the moment its directory is gone -- which is precisely when somebody
 * wants the notes. The cost is that two paths through a symlink to one
 * directory are two projects, which is the same trade as the case and Unicode
 * ones below and made the same way.
 *
 * **Two byte-different paths are two projects.** `/srv/Work` and `/srv/work`
 * may be one directory on macOS and are certainly two on Linux; `café` in its
 * two Unicode spellings likewise. Folding them together would put one project's
 * files in another's folder on the systems where they are genuinely distinct,
 * and that is a leak. Keeping them apart costs a duplicate folder on the
 * systems where they are not, which is visible and harmless. Only the path
 * normalisation POSIX itself defines -- a redundant `.`, a resolved `..`, a
 * trailing separator -- is applied, because that is string semantics rather
 * than a guess about a filesystem.
 */
export function projectKeyFor(workingTree: string): ProjectKeyResult {
  const canonical = canonicalWorkingTree(workingTree);
  if (!canonical.ok) return canonical;

  const digest = createHash('sha256')
    .update(canonical.path, 'utf8')
    .digest('hex')
    .slice(0, KEY_DIGEST_LENGTH);

  return parseProjectKey(`${slugOf(basename(canonical.path))}-${digest}`);
}

/**
 * The disk seam, for the reason `data-root.ts` and `store-identity.ts` give for
 * theirs: errno becomes a value, so the rules above can tell a folder they may
 * make from one they must not without matching on the text of an error.
 *
 * Five methods, one per thing that happens to a project folder and no more.
 * `createDirectory` is the data root's, recursive and contented with a
 * directory already there. `createFile` writes only where no file is,
 * atomically: the note in a folder is written once and never rewritten, and an
 * implementation that reads first and then writes is not this one. The other
 * three are the documents': `writeFile` replaces a file whole, `readFile`
 * reads one back, `listFiles` says what is in a folder.
 *
 * Every path handed to any of them was built by `projectPath` and a name the
 * document parser took, and that is the whole of what keeps them inside the
 * project root. The seam checks nothing about the path, because it cannot: an
 * implementation that second-guessed a path would be a second policy to keep
 * in step with the parser, and the day they disagreed one of them would be
 * wrong about a file that already exists.
 */
export type FileCreate =
  | { readonly kind: 'created' }
  /** A file was already there. The ordinary case on every use after the first. */
  | { readonly kind: 'exists' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * What a whole-file replacement answered.
 *
 * Whole, and through a temporary name in the same folder followed by a rename:
 * a reader that opens the file at any moment sees the old document or the new
 * one and never the first half of the new one, and a process killed mid-write
 * leaves a hidden temporary file and an intact document rather than a
 * truncated document. `updatedAt` is what the filesystem then recorded as
 * the write time, so the answer to "when was this written" is read off the
 * disk that will answer it next time rather than off a clock that may not
 * agree with it.
 */
export type FileWrite =
  | { readonly kind: 'written'; readonly updatedAt: number }
  | { readonly kind: 'failed'; readonly reason: string };

export type FileRead =
  | { readonly kind: 'read'; readonly contents: string; readonly updatedAt: number }
  /** No file at that path. A fact and not a failure: a document nobody has written. */
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

/** One file in a folder, as the directory listing and a stat of it said. */
export interface FileEntry {
  readonly name: string;
  readonly updatedAt: number;
  readonly bytes: number;
}

/**
 * What a folder holds. Files only: a directory inside a project folder is
 * nothing this store makes and nothing it lists. An entry that could not be
 * stat-ed between the listing and the answer costs itself and not the listing,
 * which is the direction that does not over-claim about a folder somebody is
 * writing into as it is read.
 */
export type FileListing =
  | { readonly kind: 'listed'; readonly entries: readonly FileEntry[] }
  /** No folder at that path. A project nobody has written to. */
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ProjectFileSystem {
  /** Creates the folder and every parent, and succeeds on one already there. */
  createDirectory(path: string): Promise<DirectoryCreate>;
  createFile(path: string, contents: string): Promise<FileCreate>;
  /** Replaces the file whole, or makes it. See `FileWrite` for the atomicity. */
  writeFile(path: string, contents: string): Promise<FileWrite>;
  readFile(path: string): Promise<FileRead>;
  listFiles(path: string): Promise<FileListing>;
}

/**
 * What a folder records about itself.
 *
 * Non-strict, like every other file this repository keeps on disk: a later
 * version may add a field, and an older build that meets one should read what
 * it knows rather than declare the folder broken.
 */
export const projectFileSchema = z.object({
  projectKey: projectKeySchema,
  /** The absolute path the key was derived from, as it was spelled then. */
  workingTree: z.string().min(1),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

export type ProjectFileParse =
  | { readonly ok: true; readonly file: ProjectFile }
  | { readonly ok: false; readonly problem: string };

/**
 * The parser for the note, and the reason writing it is worth anything.
 *
 * A key is a one-way function of a path, so a folder with nothing in it saying
 * where it came from is a folder whose origin is guessable at best. This is the
 * record that makes the derivation answerable after the fact -- by a person
 * reading the directory, by `doctor`, and by the hub that is one day asked to
 * group these folders into projects in its own sense.
 */
export function parseProjectFile(contents: string): ProjectFileParse {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    return { ok: false, problem: `${PROJECT_FILE_NAME} is not JSON: ${String(error)}` };
  }

  const parsed = projectFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, problem: `${PROJECT_FILE_NAME} is not a project file: ${issues}` };
  }

  return { ok: true, file: parsed.data };
}

export type ProjectFilesResult =
  | {
      readonly ok: true;
      readonly projectKey: ProjectKey;
      readonly path: string;
      /** True when this call made the folder. Log-worthy on a first use; nothing branches on it. */
      readonly created: boolean;
      /**
       * True when the folder holds a note saying what it is for.
       *
       * False is a folder that is perfectly usable and slightly harder to
       * attribute later, which is why it is reported rather than thrown: see
       * `ensureProjectFiles`.
       */
      readonly described: boolean;
    }
  | { readonly ok: false; readonly workingTree: string; readonly problem: string };

/**
 * One project's folder, ready to be written into, or the reason it is not.
 *
 * The note is written after the folder and its failure does not fail the call.
 * A folder with no note is a folder: everything this store is for still works,
 * and the only thing lost is a line somebody may want a year from now. Failing
 * the whole call over it would cost the thing the note is about, which is the
 * wrong direction to degrade in. `described` is how the caller says so out loud
 * rather than implying it.
 */
export async function ensureProjectFiles(
  dataRoot: string,
  workingTree: string,
  files: ProjectFileSystem,
): Promise<ProjectFilesResult> {
  const key = projectKeyFor(workingTree);
  if (!key.ok) return { ok: false, workingTree, problem: key.problem };

  const path = projectPath(dataRoot, key.projectKey);
  const created = await files.createDirectory(path);

  if (created.kind === 'not-a-directory') {
    return {
      ok: false,
      workingTree,
      problem:
        `the project folder ${path} is not a directory: ` +
        `something else is in the way, at that path or above it`,
    };
  }

  if (created.kind === 'failed') {
    return {
      ok: false,
      workingTree,
      problem: `cannot create the project folder ${path}: ${created.reason}`,
    };
  }

  const note = await files.createFile(
    join(path, PROJECT_FILE_NAME),
    serializeProjectFile({ projectKey: key.projectKey, workingTree }),
  );

  return {
    ok: true,
    projectKey: key.projectKey,
    path,
    created: created.kind === 'created',
    described: note.kind !== 'failed',
  };
}

type CanonicalPath =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly problem: string };

/**
 * The working tree as one canonical string, or the reason it is not a working
 * tree at all.
 *
 * Absolute because a relative path names no directory without a second thing to
 * read it against, and this module has no such thing and must not acquire one:
 * a key that depended on the server's own working directory would change when
 * systemd started it differently. NUL-free because a path with a NUL in it is
 * one string to this program and a shorter one to the kernel, which is a whole
 * family of bugs to decline at the door rather than to reason about.
 */
function canonicalWorkingTree(workingTree: string): CanonicalPath {
  if (workingTree.includes('\u0000')) {
    return {
      ok: false,
      problem: 'a working tree with a NUL byte in it names one path here and another to the kernel',
    };
  }

  if (!isAbsolute(workingTree)) {
    return {
      ok: false,
      problem: `${JSON.stringify(workingTree)} is not an absolute path, so it names no working tree on its own`,
    };
  }

  const normalised = normalize(workingTree);
  const trimmed = normalised.replace(/\/+$/, '');
  return { ok: true, path: trimmed === '' ? '/' : trimmed };
}

/**
 * The working tree's own name, flattened into the key's shape.
 *
 * Every run of anything that is not a lower-case ASCII letter or digit becomes
 * one hyphen, which is what makes the result satisfy the parser by
 * construction: no dots, no separators, no Unicode, no case. It is truncated
 * rather than hashed because it is a label -- the digest is what makes the key
 * unique -- and a name with nothing left after flattening gets a word instead,
 * because a key beginning with a hyphen is a key some program will read as a
 * flag.
 */
function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, KEY_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');

  return slug === '' ? FALLBACK_SLUG : slug;
}

/** Indented with a trailing newline: this file gets opened by people. */
function serializeProjectFile(file: ProjectFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
