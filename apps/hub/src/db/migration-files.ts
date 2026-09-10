import { MigrationError, orderMigrations, type Migration } from './migrations.js';

/**
 * Reading migrations off disk.
 *
 * The filesystem arrives as an injected surface so the rules below — what a
 * migration filename means, which files count — are testable without a disk.
 */
export interface MigrationFileSystem {
  readDirectory(path: string): Promise<readonly string[]>;
  readFile(path: string): Promise<string>;
}

/** `0001_init.sql`: a zero-padded version, an underscore, a name, `.sql`. */
const FILENAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export interface ParsedFilename {
  readonly version: number;
  readonly name: string;
}

export function parseMigrationFilename(filename: string): ParsedFilename {
  const match = FILENAME.exec(filename);
  if (match === null) {
    throw new MigrationError(
      'bad-filename',
      `${JSON.stringify(filename)} is not a migration: expected a name like 0001_init.sql`,
    );
  }
  // Both groups exist whenever the pattern matched.
  const [, version = '', name = ''] = match;
  return { version: Number(version), name };
}

/**
 * Loads every migration in a directory, ordered by version.
 *
 * Unlike a session listing, where an unreadable item costs only itself, a
 * migration that cannot be read stops the load: a schema applied with a gap in
 * it is not a schema anyone can reason about afterwards.
 */
export async function loadMigrations(
  directory: string,
  fileSystem: MigrationFileSystem,
): Promise<readonly Migration[]> {
  const filenames = (await fileSystem.readDirectory(directory)).filter((filename) =>
    filename.endsWith('.sql'),
  );

  const migrations = await Promise.all(
    filenames.map(async (filename): Promise<Migration> => {
      const { version, name } = parseMigrationFilename(filename);
      const sql = await fileSystem.readFile(`${directory}/${filename}`);
      return { version, name, sql };
    }),
  );

  return orderMigrations(migrations);
}
