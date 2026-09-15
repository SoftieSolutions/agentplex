-- Projects: the grouping a user makes, and the directory it is.
--
-- A project is a name and a directory on a server -- a repository, typically --
-- and the sessions in it are the sessions that ran there. Two facts about it
-- are worth stating up front because every decision below follows from them.
--
-- It is a node. The tree already holds containers the user makes and names, so
-- a project is one of those with something extra attached, and everything the
-- tree can already do -- name it, order it, put it in a folder, remove it and
-- take its children with it -- it can do to a project on the day this lands.
-- A second table of top-level groupings beside `nodes` would have been a
-- second tree, with its own ordering, its own removal rule and its own answer
-- to "where is this on screen".
--
-- It is not tied to a server. The directory is a path, and more than one
-- machine may have that checkout at that path; the laptop that was awake when
-- the project was made is not necessarily the one that runs it. So no column
-- here names a server, and nothing in this schema can be asked which machine a
-- project belongs to. Which machine runs a session is decided at start time,
-- against the fleet as it is then, and the machine's own browse roots are what
-- say whether it will spawn there.
--
-- Every timestamp is epoch milliseconds with no default, for the reason 0001
-- through 0005 each give: time comes from an injected clock, and a schema
-- default is the one reading of the wall clock that no test could set.

-- Two more kinds, which is the whole cost 0004 promised a new kind would be.
-- No ALTER, no table rebuild, and every node written before this keeps its
-- meaning.
INSERT INTO node_kinds (kind, container, anchors_session) VALUES
  -- A project holds children: its sessions, and the docs AGX-241 files under
  -- it. It anchors no session -- a project is a place, not a transcript -- so
  -- nothing discovers one and nothing prunes one.
  ('project', 1, 0),
  -- A doc: one markdown file in a project's file store on a server. Seeded
  -- here rather than in the docs stack's own migration because a lookup table
  -- is cheap and a migration number is not: the kinds are the vocabulary of
  -- the tree, and a build that can read a `doc` row is better than one that
  -- meets an unknown kind because two stacks landed out of order. The rows
  -- that point at content are stack D's migration, and this seeds no doc.
  ('doc', 0, 0);

-- What makes one of those project nodes a project.
--
-- A side table rather than a column on `nodes`, and this is the decision the
-- file exists to argue.
--
-- A column would be NULL for every node that is not a project, which is nearly
-- all of them -- folders, sessions, and every doc stack D adds. A column that
-- is NULL except for one kind is a column whose meaning depends on a second
-- column, and SQLite cannot state that dependency: there is no CHECK that can
-- say "NOT NULL when kind = 'project'", because `kind` is a foreign key into a
-- table of kinds that grows, and a CHECK naming a literal kind would have to be
-- rewritten -- a table rebuild against live data -- every time one is added.
-- The whole point of `node_kinds` being rows is that adding a kind is an
-- INSERT, and a per-kind column undoes it.
--
-- Held here, the constraint is ordinary: `directory` is NOT NULL because a
-- project without one is not a project, and a node with no row here is simply
-- not a project. The two states a column would have made representable -- a
-- project with no directory, and a folder with one -- are states this schema
-- cannot hold at all.
--
-- The rejected alternative is a JSON payload column on `nodes` carrying
-- whatever each kind needs. That is a schema that can hold anything and
-- therefore states nothing, which is the same argument 0004 already made
-- against it for anchors.
--
-- What the side table costs is a join to read a project whole, which is one
-- extra statement in a hub that reads a few hundred rows. `ON DELETE CASCADE`
-- is what keeps the two halves from parting: removing the node removes the
-- project, so there is no row here describing a node that is gone.
CREATE TABLE projects (
  node_id    text    PRIMARY KEY REFERENCES nodes (id) ON DELETE CASCADE,

  -- The absolute path, normalised before it is stored: a redundant `.`, a
  -- resolved `..` and a trailing separator are gone, so that one directory is
  -- one project however it was spelled. Case and Unicode spelling are *not*
  -- folded, and symlinks are not resolved -- see `normaliseDirectory` in the
  -- protocol for why folding any of those would be a leak on the systems where
  -- the paths are genuinely distinct.
  directory  text    NOT NULL CHECK (length(directory) > 0),

  created_at integer NOT NULL
) WITHOUT ROWID;

-- One project per directory, as a schema fact rather than a habit of the code
-- that happens to write it -- the same choice `nodes_session_anchor` made for
-- the same reason.
--
-- The rule is not tidiness. Discovery files a session under the project whose
-- directory equals the `cwd` the server reported, and "the project" has to be
-- a definite article: two rows with one directory would make that lookup a
-- choice, and the tree would place a session under whichever row the query
-- planner reached first. A unique index turns the second create into a refusal
-- with a sentence, which is a thing the person can act on -- they already have
-- that project -- instead of a duplicate they find out about later.
--
-- It is byte equality over the normalised path, so `/srv/work` and `/srv/work/`
-- collide and `/srv/Work` does not. That is the same trade the normalisation
-- makes, made once.
CREATE UNIQUE INDEX projects_directory ON projects (directory);
