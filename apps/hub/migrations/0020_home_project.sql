-- HOME: the project every session without one is filed under.
--
-- After this migration the tree has one shape. Three decisions make it, all
-- recorded on epic AGX-380:
--
-- (1) A folder at the root that holds no project moves into HOME with its
--     contents. A folder is an arrangement somebody made, so it is carried
--     whole rather than flattened: its sessions keep their place inside it.
-- (2) Every project is lifted to the root, and projects never nest. A project
--     a user had put in a folder leaves that folder, taking its own subtree
--     with it; the folder stays where it was, possibly empty.
-- (3) The root holds projects only. Everything else at the root -- sessions,
--     folders, docs, graphs, and any kind a later migration seeds -- goes
--     into HOME, keeping its position. Positions are not unique and
--     `(position, id)` already orders siblings, so the old relative order
--     inside HOME is the old order at the root.
--
-- HOME is a `nodes` row of kind `project` with the well-known id `home`
-- (`HOME_PROJECT_ID` in the protocol) and no `projects` row. That is the
-- decided "no single directory": `projects.directory` keeps its NOT NULL and
-- its uniqueness, and a project node without a directory is already a shape the
-- catalogue answers (`directory: null`). It is pinned by that id in the hub's
-- tree mutations rather than by a column here, because there is one such node
-- and the schema has no other way to say which.
--
-- ## The order of the three steps
--
-- Lift, then seed, then gather, and each depends on the one before it.
--
-- Lift first, so that no project is carried into HOME inside a folder: gather
-- moves a root folder whole, and a project still inside one would end up under
-- HOME, which is a project inside a project.
--
-- Seed second, because gather points rows at `home` and `parent_id` is a
-- foreign key: the row has to exist first. Seeding after the lift also keeps
-- HOME out of the lift's numbering, which ranks only the projects there were.
--
-- Gather last, and only `parent_id IS NULL AND kind <> 'project'`: by then the
-- root holds the lifted projects and HOME itself, and the kind test is what
-- keeps HOME from being placed inside itself.
--
-- ## Positions at the root
--
-- HOME is first among the root projects, always: position 0. The projects that
-- were already at the root follow from 1, in the `(position, id)` order the
-- user arranged them in. The lifted projects follow those, ranked by
-- `(created_at, id)` -- they had no position at the root to keep, and the order
-- they were made in is the one stable fact every one of them has. Ranking every
-- project by `created_at` instead would reorder what users arranged.
--
-- ## Why HOME's created_at is 0
--
-- A migration has no injected clock, and this repository never reads the wall
-- clock in SQL -- `CURRENT_TIMESTAMP` and `unixepoch()` are out, for the reason
-- 0001 gives: they are the one reading of time no test could set. 0 is the
-- honest value for a row that predates every project: nobody made HOME at a
-- moment anybody could name.
--
-- No BEGIN or COMMIT here: the runner already holds the whole run inside one
-- `BEGIN IMMEDIATE` (`apps/hub/src/db/migrations.ts`), so the three steps
-- land together or not at all.

-- 1. Lift. Root projects first in their own order, lifted ones after them.
UPDATE nodes
SET parent_id = NULL,
    position = ranked.rank
FROM (
  SELECT id,
         row_number() OVER (
           ORDER BY (parent_id IS NOT NULL),
                    CASE WHEN parent_id IS NULL THEN position ELSE created_at END,
                    id
         ) AS rank
  FROM nodes
  WHERE kind = 'project'
) AS ranked
WHERE nodes.id = ranked.id;

-- 2. Seed.
INSERT INTO nodes (id, parent_id, kind, position, name, name_source,
                   anchor_store_id, anchor_session_id, created_at)
VALUES ('home', NULL, 'project', 0, 'HOME', 'user', NULL, NULL, 0);

-- 3. Gather.
UPDATE nodes
SET parent_id = 'home'
WHERE parent_id IS NULL AND kind <> 'project';
