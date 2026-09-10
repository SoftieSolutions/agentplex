-- The node tree: the user's arrangement of their own screen.
--
-- Disk owns session content; this owns placement and names. Delete these rows
-- and the next discovery rebuilds a default tree; delete a transcript and no
-- amount of database has the session back. Everything below follows from that
-- split, and from one further fact: the hub does not persist sessions at all
-- (see `state/reducer.ts` for why a sessions table would read back after a
-- crash as a claim that machines nobody is connected to are current). So a node
-- points at a session that only disk can confirm, and nothing in this schema
-- can check that the session is still there. That is what the prune is for.
--
-- Every timestamp is epoch milliseconds with no default, for the reason 0001,
-- 0002 and 0003 each give: time comes from an injected clock, and a schema
-- default is the one reading of the wall clock that no test could set.

-- The kinds a node can be, as rows rather than as a CHECK or an enum.
--
-- This is the point of the table. A new kind -- a saved search, an agent, a
-- pinned prompt -- is an INSERT in a new migration, and every node written
-- before it keeps its meaning. Held as a CHECK constraint instead, adding one
-- would be a table rebuild in SQLite: no `ALTER TABLE ... DROP CONSTRAINT`
-- exists, so the recipe is a new table, a copy, a drop and a rename, run
-- against live data, in a schema whose whole promise is that the tree grows.
--
-- What an INSERT buys is a new kind over the two shapes the columns below
-- already describe. It does not buy a genuinely new *anchor* -- a node pointing
-- at something that is neither a session nor nothing -- and this file does not
-- pretend otherwise. That would be a new column and a new migration, and the
-- alternative that would have avoided it is an unconstrained JSON payload,
-- which is a schema that can hold anything and therefore states nothing.
CREATE TABLE node_kinds (
  kind            text    PRIMARY KEY CHECK (length(kind) > 0),

  -- Whether a node of this kind may hold children. Read by the data layer,
  -- which refuses a parent that is not one: SQL cannot express a CHECK over
  -- another table's row, so this is a fact the schema states and the layer
  -- above enforces, rather than a fact nobody wrote down.
  container       integer NOT NULL CHECK (container IN (0, 1)),

  -- Whether a node of this kind must name a session. Same division of labour.
  anchors_session integer NOT NULL CHECK (anchors_session IN (0, 1))
) WITHOUT ROWID;

-- The two kinds v2 ships, seeded here rather than by code at startup: a lookup
-- table whose contents depend on which build last booted is a lookup table that
-- differs between two machines running the same migration.
INSERT INTO node_kinds (kind, container, anchors_session) VALUES
  -- A container the user makes and names. Anchors nothing, so nothing
  -- discovers it and nothing prunes it.
  ('folder',  1, 0),
  -- One discovered session, in its place in the tree.
  ('session', 0, 1);

CREATE TABLE nodes (
  id             text    PRIMARY KEY,

  -- NULL is the root. There is one tree and the root is not a row in it: a row
  -- for the root would be a row the user could rename, move under itself, or
  -- remove, and every one of those is a state with no meaning.
  --
  -- CASCADE because a child of a removed folder has nowhere to be. It is the
  -- one delete that may take rows with it, and it is enforced here rather than
  -- by a loop above, so that a folder cannot be removed and leave a subtree
  -- parented to something that is gone.
  parent_id      text    REFERENCES nodes (id) ON DELETE CASCADE,

  -- Kind as a foreign key, which is the ticket. A row here can only name a
  -- kind that exists, and the engine says so: `PRAGMA foreign_keys` is on by
  -- default in `node:sqlite`, verified at the origin on the Node the image
  -- pins, so this is a constraint and not a comment.
  kind           text    NOT NULL REFERENCES node_kinds (kind),

  -- Order among siblings. Not unique, deliberately. A unique index would make
  -- every reorder a sequence of transiently-colliding updates -- SQLite checks
  -- a unique index per row as a statement writes it, and has no deferred
  -- uniqueness for anything but foreign keys -- so the constraint would be paid
  -- for on every move and would buy an ordering that `(position, id)` already
  -- makes total.
  position       integer NOT NULL,

  -- What the tree calls this node, or NULL when nothing has named it: a
  -- discovered session whose provider gave its transcript no title. NULL is
  -- the honest answer there, and lets a client show the session's own id
  -- rather than a placeholder invented down here.
  name           text    CHECK (name IS NULL OR length(name) > 0),

  -- Who last named it, and the reason this column exists while a matching
  -- `placed_by` does not.
  --
  -- Discovery writes `name` again on every scan, so it needs somewhere to
  -- learn that it must stop: a name follows the transcript title until the user
  -- renames it, and then the rename wins permanently. Discovery writes
  -- `parent_id` and `position` exactly once, when it creates the node, and
  -- never again -- so "who placed it" is a fact nothing would read, and a
  -- column nothing reads is one that goes wrong without anybody finding out.
  name_source    text    NOT NULL DEFAULT 'discovered'
                         CHECK (name_source IN ('discovered', 'user')),

  -- What this node points at: a session, as `{ storeId, sessionId }` and never
  -- the machine. Both halves or neither -- a session id without its store
  -- identifies nothing, since a session id is unique only within its store.
  --
  -- Neither column is a foreign key, and there is nothing for them to
  -- reference: sessions are not rows anywhere. That is the design and not an
  -- omission, and the prune is its other half.
  anchor_store_id   text CHECK (anchor_store_id IS NULL OR length(anchor_store_id) > 0),
  anchor_session_id text CHECK (anchor_session_id IS NULL OR length(anchor_session_id) > 0),

  created_at     integer NOT NULL,

  CONSTRAINT nodes_anchor_is_whole
    CHECK ((anchor_store_id IS NULL) = (anchor_session_id IS NULL))
);

-- Reading a folder's children is the tree's only hot read.
CREATE INDEX nodes_children ON nodes (parent_id, position);

-- One node per session, as a schema fact rather than a habit of the code that
-- happens to write it. Partial, because every folder has a NULL anchor and
-- there is no limit on folders.
CREATE UNIQUE INDEX nodes_session_anchor
  ON nodes (anchor_store_id, anchor_session_id)
  WHERE anchor_session_id IS NOT NULL;

-- A removal the hub remembers.
--
-- Removing a session node is not the same act as deleting a folder. Discovery
-- would see the session on the next scan and put the node straight back, so
-- taking the row out and stopping there gives the user a tree that undoes their
-- edit a few seconds later with no explanation. Either the removal is
-- remembered or discovery restores the node; this table is what makes those the
-- only two outcomes.
--
-- Keyed by the session and not by the node id, and it has to be: the node is
-- gone, so a key naming it would name nothing, and discovery asks its question
-- in the other direction anyway -- "have I been told not to place this
-- session?" -- which is a question only the session's identity can answer.
--
-- This is a session-keyed table and it holds no foreign key into `nodes`. It is
-- the table most tempted to, which is why the rule is asserted by a test that
-- reads this schema back rather than stated here and forgotten: a session-keyed
-- row must outlive the node it is about, and an FK is precisely a promise that
-- it will not.
CREATE TABLE node_removals (
  store_id   text    NOT NULL CHECK (length(store_id) > 0),
  session_id text    NOT NULL CHECK (length(session_id) > 0),
  removed_at integer NOT NULL,
  PRIMARY KEY (store_id, session_id)
) WITHOUT ROWID;
