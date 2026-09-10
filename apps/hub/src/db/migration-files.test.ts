import { describe, expect, it } from 'vitest';
import {
  loadMigrations,
  parseMigrationFilename,
  type MigrationFileSystem,
} from './migration-files.js';
import { MigrationError } from './migrations.js';

function fileSystem(files: Record<string, string>): MigrationFileSystem {
  return {
    readDirectory: async () => Object.keys(files),
    readFile: async (path) => {
      const contents = files[path.slice(path.lastIndexOf('/') + 1)];
      if (contents === undefined) throw new Error(`no such file: ${path}`);
      return contents;
    },
  };
}

describe('parseMigrationFilename', () => {
  it('reads the version and the name', () => {
    expect(parseMigrationFilename('0001_hub_identity.sql')).toEqual({
      version: 1,
      name: 'hub_identity',
    });
  });

  it('reads a version whose padding has run out', () => {
    expect(parseMigrationFilename('1234_late.sql').version).toBe(1234);
  });

  it('refuses a filename with no version, rather than guessing an order', () => {
    expect(() => parseMigrationFilename('init.sql')).toThrow(MigrationError);
  });

  it('refuses an unpadded version, so lexical and numeric order agree on disk', () => {
    expect(() => parseMigrationFilename('1_init.sql')).toThrow(MigrationError);
  });

  it('refuses a name that is not lower snake case', () => {
    expect(() => parseMigrationFilename('0001_HubIdentity.sql')).toThrow(MigrationError);
    expect(() => parseMigrationFilename('0001_hub-identity.sql')).toThrow(MigrationError);
  });
});

describe('loadMigrations', () => {
  it('returns migrations ordered by version with their contents', async () => {
    const migrations = await loadMigrations(
      '/migrations',
      fileSystem({
        '0002_servers.sql': 'CREATE TABLE servers ()',
        '0001_hub_identity.sql': 'CREATE TABLE hub_identity ()',
      }),
    );

    expect(migrations).toEqual([
      { version: 1, name: 'hub_identity', sql: 'CREATE TABLE hub_identity ()' },
      { version: 2, name: 'servers', sql: 'CREATE TABLE servers ()' },
    ]);
  });

  it('ignores files that are not SQL, so a README may sit in the directory', async () => {
    const migrations = await loadMigrations(
      '/migrations',
      fileSystem({ '0001_hub_identity.sql': 'CREATE TABLE hub_identity ()', 'README.md': 'notes' }),
    );

    expect(migrations).toHaveLength(1);
  });

  it('refuses the whole load when one file is not a migration', async () => {
    await expect(
      loadMigrations('/migrations', fileSystem({ 'oops.sql': 'SELECT 1' })),
    ).rejects.toMatchObject({ code: 'bad-filename' });
  });

  it('returns nothing for an empty directory rather than failing', async () => {
    await expect(loadMigrations('/migrations', fileSystem({}))).resolves.toEqual([]);
  });
});
