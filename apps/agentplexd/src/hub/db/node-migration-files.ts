import { readdir, readFile } from 'node:fs/promises';
import type { MigrationFileSystem } from './migration-files.js';

/** The real disk, named in one place so tests never have to reach for it. */
export const nodeMigrationFileSystem: MigrationFileSystem = {
  readDirectory: (path) => readdir(path),
  readFile: (path) => readFile(path, 'utf8'),
};
