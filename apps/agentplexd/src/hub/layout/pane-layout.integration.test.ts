import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openMigratedSchema, type MigratedSchema } from '../pairing/test-migrated-schema.js';
import { readPaneLayout, writePaneLayout } from './pane-layout.js';

/**
 * The opaque row, against a real database.
 *
 * Worth asserting here is exactly what the module promises: the characters
 * come back verbatim (including ones no current client would write, which is
 * the point of storing without parsing), a save replaces the previous save,
 * and the single-row CHECK holds.
 */

let migrated: MigratedSchema | null = null;

const clock = { now: () => 1_756_000_000_000 };

function db(): MigratedSchema['database'] {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

describe('the pane layout row', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('pane-layout-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  it('answers null before anything has been saved', async () => {
    expect(await readPaneLayout(db())).toBeNull();
  });

  it('answers back the exact characters it was handed, shape unread', async () => {
    // Deliberately not a shape any current client writes: the row must carry a
    // future client's layout untouched, because no rule here reads it.
    const saved = '{"v":9,"root":{"kind":"hologram","spin":0.5}}';
    await writePaneLayout(db(), saved, clock);
    expect(await readPaneLayout(db())).toBe(saved);
  });

  it('replaces the previous save whole, leaving one row', async () => {
    await writePaneLayout(db(), '{"v":1,"root":{"kind":"pane"}}', clock);
    await writePaneLayout(db(), '{"v":1,"root":{"kind":"split"}}', clock);
    expect(await readPaneLayout(db())).toBe('{"v":1,"root":{"kind":"split"}}');
    const rows = await db().query('SELECT count(*) AS n FROM pane_layout');
    expect(rows.rows[0]).toEqual({ n: 1 });
  });

  it('cannot hold a second arrangement: the CHECK refuses any other key', async () => {
    await expect(
      db().query('INSERT INTO pane_layout (only, layout, updated_at) VALUES (2, ?, ?)', [
        '{}',
        clock.now(),
      ]),
    ).rejects.toThrow();
  });
});
