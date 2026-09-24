-- Graphs: the one kind of content the hub holds itself, and what a version is.
--
-- A graph is a node in the user's tree, like a document, with a side table
-- saying what makes it one. Unlike a document its content is here and nowhere
-- else. A document is the index of a file on a machine, and 0008 argues at
-- length why the hub must hold no copy of one; a graph is the reverse case.
-- Nothing on any machine is the graph -- the canvas draws it, the hub runs it,
-- and every step of a run lands on whichever machine the node's placement
-- picks -- so the only honest home for the document is the database the hub
-- owns. There is no machine to be stale against.
--
-- 0012 through 0016 are skipped, as 0007 was: numbers are minted per stack so
-- that two branches cannot mint the same one, and 0016 is the highest that has
-- landed. The runner orders by number and refuses duplicates, not gaps.
--
-- ## What a version is
--
-- A graph has exactly one draft and any number of published versions, and the
-- two are rows of one table told apart by `published_at`. A draft is the
-- document the canvas edits, replaced whole on every save. Publishing stamps
-- the draft's `published_at`, which is the moment it stops changing, and opens
-- the next draft as a copy of it. A run and a SUB-GRAPH pin name a published
-- version and never the draft, so what ran can always be read back exactly.
--
-- Immutability is a trigger and not a CHECK, and that is a constraint of the
-- engine rather than a preference: a CHECK sees one row and cannot compare OLD
-- with NEW, and "a published row does not change" is a statement about the
-- change. The trigger aborts any UPDATE of a row whose `published_at` is set.
-- There is no DELETE trigger, deliberately -- removing the node cascades to
-- every version, because a graph the user removed is gone whole, and a
-- version that outlived its graph would be a row nothing can name.
--
-- The one-draft rule is a partial unique index over the rows with no
-- `published_at`. Two drafts would be two documents the canvas could edit, and
-- a publish would have to choose between them; the index makes the state
-- unrepresentable rather than leaving it to the code that writes drafts.
--
-- ## Why the document is text
--
-- `document` is the JSON the protocol's `graphDocumentSchema` describes, held
-- as text and parsed by that schema on every read. Not columns per node,
-- because a node's fields depend on its kind and the kinds are the runtime's
-- to grow; not SQLite's JSON functions, because a query that reached inside
-- the document would be a second reader of its shape and the hub has one. A
-- row that does not parse is a refusal on read, never a cast.
--
-- Every timestamp is epoch milliseconds with no default, for the reason 0001
-- through 0016 each give. Here they are the hub's own clock throughout: the
-- hub is the machine that holds a graph, so unlike a document's `updated_at`
-- there is no other clock that could be the right one.

-- A third kind, which is the whole cost 0004 promised a new kind would be.
-- Seeded here rather than at startup for the reason 0006 gives: the kinds
-- are the vocabulary of the tree, and a lookup table whose contents depended
-- on which build last booted would differ between two machines on the same
-- migration. A graph holds no children and anchors no session.
INSERT INTO node_kinds (kind, container, anchors_session) VALUES ('graph', 0, 0);

-- What makes one of those nodes a graph. A side table rather than columns on
-- `nodes`, which is the argument 0006 made for projects and 0008 for
-- documents, inherited unchanged.
CREATE TABLE graphs (
  node_id          text    PRIMARY KEY REFERENCES nodes (id) ON DELETE CASCADE,

  -- The project the graph belongs to, which is also its parent in the tree
  -- today. Stored for the reason `docs.project_node_id` is: the parent is
  -- where the user put the node, and this is which project's sessions a run
  -- starts in. They part the moment somebody drags the node into a folder.
  project_node_id  text    NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,

  created_at       integer NOT NULL
) WITHOUT ROWID;

CREATE TABLE graph_versions (
  graph_node_id  text    NOT NULL REFERENCES graphs (node_id) ON DELETE CASCADE,

  -- Counts from 1 per graph. The draft is always the highest number, and a
  -- publish stamps it and inserts the next.
  version        integer NOT NULL CHECK (version > 0),

  -- The JSON of a `GraphDocument`, parsed by the protocol's schema on read.
  document       text    NOT NULL,

  -- When the draft was last saved, or for a published row, when it was last
  -- saved before it was published.
  updated_at     integer NOT NULL,

  -- NULL for the draft; the moment of publishing otherwise. Once set, the row
  -- is immutable -- see the trigger below.
  published_at   integer,

  PRIMARY KEY (graph_node_id, version)
) WITHOUT ROWID;

-- Exactly one draft per graph, as a schema fact.
CREATE UNIQUE INDEX graph_versions_one_draft
  ON graph_versions (graph_node_id)
  WHERE published_at IS NULL;

-- A published version never changes. RAISE(ABORT) rolls back the statement
-- and reports why in the words a caller reads back.
CREATE TRIGGER graph_versions_published_immutable
  BEFORE UPDATE ON graph_versions
  WHEN OLD.published_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a published graph version is immutable');
END;
