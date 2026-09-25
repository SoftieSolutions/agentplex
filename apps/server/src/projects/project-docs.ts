import { join } from 'node:path';
import { docNameSchema, type DocEntry, type DocName } from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import {
  ensureProjectFiles,
  PROJECT_FILE_NAME,
  projectKeyFor,
  projectPath,
  type ProjectFileSystem,
} from './project-files.js';

/**
 * A project's documents: the files a hub asks this server to keep in a
 * project's folder, read back, and list.
 *
 * `project-files.ts` made the place and the rule -- one folder per working
 * tree under the data root, written by this server on its own account and
 * reachable by no child process. This is the first thing that writes through
 * it, and it inherits the rule rather than restating it: every path built
 * here is `projectPath` plus a name the document parser took, and nothing
 * here is handed to a spawn. A document write is a file this server writes
 * because a parsed frame asked it to. It is not an operation, so it does not
 * go through the operation registry, which exists for the case where a child
 * process is started; there is no child here.
 *
 * ## What is refused, and with which code
 *
 * `refused` is "the request was well-formed and the state of the world says
 * no": a document nobody has written, a directory the key deriver will not
 * take, and the folder note by name. `internal` is this server's own disk
 * failing under it -- a folder it could not make, a write the filesystem
 * refused -- and it is the code that says retrying may work.
 *
 * The note is refused by name on every operation, and for a reason each: a
 * write to it would replace the record of what the folder is for with a
 * document, a read of it would hand a hub a file this server keeps for
 * itself, and a listing that showed it would invite both. It parses as a
 * document name -- it ends in `.json` -- and the protocol cannot know it is
 * reserved, because the protocol does not know the folder has a note. This
 * is the one place that does.
 *
 * ## What a read and a listing do to a folder
 *
 * Nothing. The folder is made on the first write and never on a read: a hub
 * asking after a project nobody has written to gets an empty listing or a
 * refusal, and the disk is as it was. Making folders for questions would
 * fill the data root with a directory per path anybody ever typed.
 */

export interface DocRefusal {
  readonly ok: false;
  readonly code: 'refused' | 'internal';
  readonly problem: string;
}

export type DocWriteResult = { readonly ok: true; readonly updatedAt: number } | DocRefusal;

export type DocReadResult =
  { readonly ok: true; readonly content: string; readonly updatedAt: number } | DocRefusal;

export type DocListResult =
  { readonly ok: true; readonly entries: readonly DocEntry[] } | DocRefusal;

export interface ProjectDocs {
  write(request: {
    readonly directory: string;
    readonly name: DocName;
    readonly content: string;
  }): Promise<DocWriteResult>;
  read(request: { readonly directory: string; readonly name: DocName }): Promise<DocReadResult>;
  list(request: { readonly directory: string }): Promise<DocListResult>;
}

export interface ProjectDocsDependencies {
  /** The data root, already ensured at boot. */
  readonly dataRoot: string;
  readonly files: ProjectFileSystem;
  readonly logger: Logger;
}

export function createProjectDocs({
  dataRoot,
  files,
  logger,
}: ProjectDocsDependencies): ProjectDocs {
  /** One project's folder, or the reason the directory names none. */
  function folderOf(directory: string): { ok: true; path: string } | DocRefusal {
    const key = projectKeyFor(directory);
    if (!key.ok) return { ok: false, code: 'refused', problem: key.problem };
    return { ok: true, path: projectPath(dataRoot, key.projectKey) };
  }

  function reserved(name: DocName): DocRefusal | null {
    if (name !== PROJECT_FILE_NAME) return null;
    return {
      ok: false,
      code: 'refused',
      problem: `${PROJECT_FILE_NAME} is the folder's own note and not a document`,
    };
  }

  return {
    async write({ directory, name, content }): Promise<DocWriteResult> {
      const refusal = reserved(name);
      if (refusal !== null) return refusal;

      // The key first and on its own, so a directory that names no project is
      // a refusal and not the disk's fault: `ensureProjectFiles` reports both
      // as one failure, and the codes say different things to the hub.
      const named = folderOf(directory);
      if (!named.ok) return named;

      const folder = await ensureProjectFiles(dataRoot, directory, files);
      if (!folder.ok) return { ok: false, code: 'internal', problem: folder.problem };
      if (folder.created) logger.info('project folder made', { path: folder.path, directory });

      const written = await files.writeFile(join(folder.path, name), content);
      if (written.kind === 'failed') {
        return { ok: false, code: 'internal', problem: `cannot write ${name}: ${written.reason}` };
      }
      return { ok: true, updatedAt: written.updatedAt };
    },

    async read({ directory, name }): Promise<DocReadResult> {
      const refusal = reserved(name);
      if (refusal !== null) return refusal;

      const folder = folderOf(directory);
      if (!folder.ok) return folder;

      const read = await files.readFile(join(folder.path, name));
      if (read.kind === 'missing') {
        return { ok: false, code: 'refused', problem: `no document named ${name} in that project` };
      }
      if (read.kind === 'failed') {
        return { ok: false, code: 'internal', problem: `cannot read ${name}: ${read.reason}` };
      }
      return { ok: true, content: read.contents, updatedAt: read.updatedAt };
    },

    async list({ directory }): Promise<DocListResult> {
      const folder = folderOf(directory);
      if (!folder.ok) return folder;

      const listing = await files.listFiles(folder.path);
      if (listing.kind === 'missing') return { ok: true, entries: [] };
      if (listing.kind === 'failed') {
        return {
          ok: false,
          code: 'internal',
          problem: `cannot list the project: ${listing.reason}`,
        };
      }

      // Documents and only documents. The note is not one, and neither is a
      // temporary file from an interrupted write, a hidden file, or whatever
      // a person left in the folder by hand: each fails the name parser, and
      // each costs itself rather than the listing. Sorted by name, because a
      // directory's own order is whatever the filesystem felt like.
      const entries: DocEntry[] = [];
      for (const entry of listing.entries) {
        if (entry.name === PROJECT_FILE_NAME) continue;
        const name = docNameSchema.safeParse(entry.name);
        if (!name.success) continue;
        entries.push({ name: name.data, updatedAt: entry.updatedAt, bytes: entry.bytes });
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { ok: true, entries };
    },
  };
}
