import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeIdSchema, sessionRefSchema, type NodeId } from '@agentplex/protocol';
import type { Database } from '../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../db/test-migrated-schema.js';
import { findProjectFor } from './reads.js';

/**
 * Which project a session is filed under, read off the tree.
 *
 * Against a real schema, because the answer is a walk: a session node is not
 * always a child of the project it belongs to -- somebody can put a folder in
 * between -- so the question is "the nearest project above it" and not "its
 * parent". The standing policy is the first caller, and it is the caller that
 * makes the difference matter: a walk that stopped at the parent would leave
 * every session somebody tidied into a folder with no policy at all, silently.
 */

const NOW = 1_756_000_000_000;

const WORK = nodeIdSchema.parse('node-project-work');
const FOLDER = nodeIdSchema.parse('node-folder-spikes');
const LOOSE = nodeIdSchema.parse('node-folder-loose');

const FILED = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-fix-auth' });
const NESTED = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-spike' });
const UNFILED = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-loose' });
const UNKNOWN = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-nowhere' });

let migrated: MigratedSchema | null = null;

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeEach did not run');
  return migrated.database;
}

async function node(
  id: NodeId,
  parentId: NodeId | null,
  kind: string,
  anchor: { storeId: string; sessionId: string } | null,
): Promise<void> {
  await db().query(
    `INSERT INTO nodes (id, parent_id, kind, position, name, anchor_store_id, anchor_session_id, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    [id, parentId, kind, id, anchor?.storeId ?? null, anchor?.sessionId ?? null, NOW],
  );
}

describe('the project a session is filed under', () => {
  beforeEach(async () => {
    migrated = await openMigratedSchema('reads-placement-probe');
    await node(WORK, null, 'project', null);
    await db().query('INSERT INTO projects (node_id, directory, created_at) VALUES (?, ?, ?)', [
      WORK,
      '/srv/work',
      NOW,
    ]);
    await node(FOLDER, WORK, 'folder', null);
    await node(LOOSE, null, 'folder', null);
    await node(nodeIdSchema.parse('node-session-filed'), WORK, 'session', FILED);
    await node(nodeIdSchema.parse('node-session-nested'), FOLDER, 'session', NESTED);
    await node(nodeIdSchema.parse('node-session-loose'), LOOSE, 'session', UNFILED);
  });

  afterEach(async () => {
    await migrated?.close();
    migrated = null;
  });

  it('is the project the session node sits directly under', async () => {
    expect(await findProjectFor(db(), FILED)).toBe(WORK);
  });

  it('is the nearest project above it, through whatever folders are in the way', async () => {
    expect(await findProjectFor(db(), NESTED)).toBe(WORK);
  });

  it('is nothing for a session filed outside every project', async () => {
    expect(await findProjectFor(db(), UNFILED)).toBe(null);
  });

  it('is nothing for a session the tree has never heard of', async () => {
    // A session discovered since the last scan wrote the tree. It has no
    // placement yet, so it has no policy, so it is asked about.
    expect(await findProjectFor(db(), UNKNOWN)).toBe(null);
  });
});
