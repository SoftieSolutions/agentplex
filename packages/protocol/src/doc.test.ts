import { describe, expect, it } from 'vitest';
import {
  DOC_CONTENT_MAX_CHARS,
  DOC_NAME_EXTENSIONS,
  DOC_NAME_MAX_LENGTH,
  docContentSchema,
  docDirectorySchema,
  docEntrySchema,
  docNameSchema,
} from './doc.js';

describe('docNameSchema', () => {
  it.each([
    ['a markdown note', 'plan.md'],
    ['a text file', 'notes.txt'],
    ['a json file', 'settings.json'],
    ['a csv file', 'results.csv'],
    ['a name with a hyphen and an underscore', 'auth-refresh_v2.md'],
    ['a name with a dot inside it', 'release.notes.md'],
    ['an upper-case name', 'README.md'],
    ['a digit to start', '2026-09-12-standup.md'],
  ])('accepts %s', (_why, name) => {
    expect(docNameSchema.safeParse(name).success).toBe(true);
  });

  // The list below is the reason this file exists. Each entry is a string
  // that has been a directory traversal in somebody's program, and the
  // assertion is that none of them can ever name a file this server writes.
  it.each([
    ['an empty name', ''],
    ['a parent reference', '..'],
    ['a parent reference with an extension', '...md'],
    ['a traversal', '../plan.md'],
    ['a traversal inside the name', 'notes/../plan.md'],
    ['a separator', 'notes/plan.md'],
    ['a leading separator, which is an absolute path', '/etc/passwd.md'],
    ['a trailing separator', 'plan.md/'],
    ['a backslash, which is a separator on the disk a volume came from', 'notes\\plan.md'],
    ['a backslash traversal', '..\\..\\plan.md'],
    ['a drive letter', 'c:plan.md'],
    ['a NUL byte, which truncates a path inside a syscall', 'plan\u0000.md'],
    ['a newline, which would end the name early in a log line', 'plan\n.md'],
    ['a space', 'my plan.md'],
    ['a leading dot, which would hide the file', '.plan.md'],
    ['a name that is only an extension', '.md'],
    ['two dots in a row, which is a parent reference wherever it sits', 'plan..md'],
    ['a tilde, which a shell would expand', '~.md'],
    ['a leading hyphen, which a program would read as a flag', '-rf.md'],
    ['no extension', 'plan'],
    ['an extension that is not on the list', 'plan.sh'],
    ['an executable extension', 'plan.exe'],
    ['an upper-case extension, which is a second name for one file on macOS', 'plan.MD'],
    ['an extension with a trailing dot', 'plan.md.'],
    ['a non-ASCII name, which has two byte spellings on two filesystems', 'caf\u00e9.md'],
  ])('refuses %s', (_why, name) => {
    expect(docNameSchema.safeParse(name).success).toBe(false);
  });

  it('refuses a name longer than a filesystem will take', () => {
    expect(docNameSchema.safeParse(`${'a'.repeat(DOC_NAME_MAX_LENGTH)}.md`).success).toBe(false);
    expect(docNameSchema.safeParse(`${'a'.repeat(DOC_NAME_MAX_LENGTH - 3)}.md`).success).toBe(true);
  });

  it('lists exactly the extensions it accepts, each with its dot', () => {
    for (const extension of DOC_NAME_EXTENSIONS) {
      expect(extension.startsWith('.')).toBe(true);
      expect(docNameSchema.safeParse(`plan${extension}`).success).toBe(true);
    }
  });

  it('refuses both Unicode spellings of one name, so no file has two', () => {
    const composed = 'caf\u00e9.md';
    const decomposed = 'cafe\u0301.md';

    expect(composed.normalize('NFD')).toBe(decomposed);
    expect(docNameSchema.safeParse(composed).success).toBe(false);
    expect(docNameSchema.safeParse(decomposed).success).toBe(false);
  });
});

describe('docDirectorySchema', () => {
  it('accepts an absolute path', () => {
    expect(docDirectorySchema.safeParse('/Users/dev/Code/agentplex').success).toBe(true);
    expect(docDirectorySchema.safeParse('/').success).toBe(true);
  });

  it.each([
    ['an empty directory', ''],
    ['a relative directory, which names no working tree on its own', 'Code/agentplex'],
    ['a parent reference', '../agentplex'],
    ['a home shorthand, which only a shell expands', '~/Code/agentplex'],
    ['a NUL byte', '/srv/work\u0000/etc'],
  ])('refuses %s', (_why, directory) => {
    expect(docDirectorySchema.safeParse(directory).success).toBe(false);
  });
});

describe('docContentSchema', () => {
  it('accepts an empty document and one at the cap', () => {
    expect(docContentSchema.safeParse('').success).toBe(true);
    expect(docContentSchema.safeParse('x'.repeat(DOC_CONTENT_MAX_CHARS)).success).toBe(true);
  });

  it('refuses one character past the cap', () => {
    expect(docContentSchema.safeParse('x'.repeat(DOC_CONTENT_MAX_CHARS + 1)).success).toBe(false);
  });
});

describe('docEntrySchema', () => {
  it('accepts a name the name parser takes, with when and how big', () => {
    const parsed = docEntrySchema.safeParse({
      name: 'plan.md',
      updatedAt: 1_756_000_000_000,
      bytes: 42,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an entry whose name the name parser would not', () => {
    expect(
      docEntrySchema.safeParse({ name: '../plan.md', updatedAt: 1_756_000_000_000, bytes: 42 })
        .success,
    ).toBe(false);
  });

  it('refuses a negative size or a fractional time', () => {
    expect(docEntrySchema.safeParse({ name: 'plan.md', updatedAt: 1, bytes: -1 }).success).toBe(
      false,
    );
    expect(docEntrySchema.safeParse({ name: 'plan.md', updatedAt: 1.5, bytes: 1 }).success).toBe(
      false,
    );
  });
});
