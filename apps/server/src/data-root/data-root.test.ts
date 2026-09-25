import { describe, expect, it } from 'vitest';
import { ensureDataRoot } from './data-root.js';
import { createFakeDataRoot } from './fake-data-root.js';

const DATA_ROOT = '/var/lib/agentplex';

describe('ensureDataRoot', () => {
  it('creates the directory on a first start, so nothing else has to', () => {
    // Who creates it is part of the rule: an installer that has to be told to
    // make a directory is an installer that will be wrong on the machine that
    // was upgraded rather than installed.
    const files = createFakeDataRoot();

    return expect(ensureDataRoot(DATA_ROOT, files)).resolves.toEqual({
      ok: true,
      path: DATA_ROOT,
      created: true,
    });
  });

  it('takes the directory that is already there, which is every start after the first', async () => {
    const files = createFakeDataRoot({ directories: [DATA_ROOT] });

    await expect(ensureDataRoot(DATA_ROOT, files)).resolves.toEqual({
      ok: true,
      path: DATA_ROOT,
      created: false,
    });
  });

  it('refuses when something that is not a directory is at the path', async () => {
    const files = createFakeDataRoot({ files: [DATA_ROOT] });

    const result = await ensureDataRoot(DATA_ROOT, files);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toContain('is not a directory');
  });

  it('refuses when it cannot create the directory', async () => {
    const files = createFakeDataRoot({ uncreatable: [DATA_ROOT] });

    const result = await ensureDataRoot(DATA_ROOT, files);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toContain('cannot create the data root');
  });

  it('refuses a directory it cannot write in, rather than finding out at the first write', async () => {
    // The whole asymmetry with a store path: a store this server cannot read
    // costs itself, and a data root it cannot write is a server that will
    // forget something one restart from now and say nothing now.
    const files = createFakeDataRoot({ directories: [DATA_ROOT], unwritable: [DATA_ROOT] });

    const result = await ensureDataRoot(DATA_ROOT, files);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toContain('cannot write in the data root');
  });

  it('checks writability of a directory it just created, not only of one it found', async () => {
    const files = createFakeDataRoot({ unwritable: [DATA_ROOT] });

    await expect(ensureDataRoot(DATA_ROOT, files)).resolves.toMatchObject({ ok: false });
  });

  it('names the path and the setting in every refusal', async () => {
    // Two people read this line: the one whose configured directory is wrong,
    // and the one whose permissions are.
    for (const files of [
      createFakeDataRoot({ files: [DATA_ROOT] }),
      createFakeDataRoot({ uncreatable: [DATA_ROOT] }),
      createFakeDataRoot({ directories: [DATA_ROOT], unwritable: [DATA_ROOT] }),
    ]) {
      const result = await ensureDataRoot(DATA_ROOT, files);

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.problem).toContain(DATA_ROOT);
      expect(result.ok ? '' : result.problem).toContain('AGENTPLEX_DATA_PATH');
    }
  });

  it('touches the configured directory and nothing above or beside it', async () => {
    const files = createFakeDataRoot();

    await ensureDataRoot(DATA_ROOT, files);

    expect(files.creates).toEqual([DATA_ROOT]);
  });
});
