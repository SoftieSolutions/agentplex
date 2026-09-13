-- Documents: the index the hub keeps of files it does not hold.
--
-- A document is a markdown or text file in a project's folder on one server,
-- under the data root that server made for itself. The content is there and
-- only there. This table is the hub's index of what exists, so that a tree can
-- be drawn, a name can be renamed and a client can be told what a project has
-- without every machine in the fleet being awake.
--
-- 0007 is the catalogue's sort index (AGX-240) and is deliberately skipped
-- here: migration numbers are reserved per stack in the design document so that
-- two branches cannot mint the same one, and a stack that lands second must not
-- have to renumber a file that has already run on somebody's disk.
--
-- ## Why content is not a column
--
-- The obvious alternative is a `content` column, with the server's file as a
-- cache. It was rejected for what it would make the hub responsible for. A
-- document edited on the machine -- by a person in an editor, or by the agent
-- the document was written for -- would make the hub's copy wrong, and a hub
-- that holds a copy it cannot keep current is a hub that serves a stale
-- document as though it were the document. There is no version the two ends
-- could agree on without a protocol for merging them, and a merge is a feature
-- nobody asked for.
--
-- What this costs is stated plainly, because it is the trade: a document whose
-- server is not connected cannot be opened, and the refusal names the machine.
-- The index is still readable, so a listing shows every document the project
-- has with the machine that has it -- which is the direction that does not
-- over-claim. A row here is a claim that a file existed on that machine when
-- the hub last wrote to it, and nothing stronger.
--
-- ## Why the server is part of the key
--
-- A project is not tied to a server: 0006 says so, and it is the reason no
-- column there names one. A document is, and that is not a contradiction. The
-- project is a directory, and two machines may have the same checkout at the
-- same path; the file store is under each server's own data root, which is a
-- volume exactly one server owns -- `data-root.ts` calls it exclusive, and the
-- server refuses to share it. So "plan.md in this project" is not one file in
-- the fleet: it is one file per machine that has been written to, and a row
-- that named only the project and the name would be a row that could not say
-- which of them it meant.
--
-- Naming the server is therefore the honest shape, and the unique index below
-- states it: one name, per project, per machine. Two servers with a document of
-- the same name in the same project are two documents, two nodes and two rows,
-- and a client shows the machine beside each. The alternative -- one row per
-- (project, name), with the server as a mutable column -- would mean a write to
-- the second machine silently repointing the first machine's row at a file it
-- does not describe.
--
-- `server_registration_id` references `servers (id)` without CASCADE, unlike
-- the two node references. That is deliberate: unpairing a machine must not
-- quietly delete the hub's record of the documents on it. The delete fails
-- while a row here points at the registration, which is a refusal somebody can
-- act on -- remove the documents, or keep the pairing -- rather than a tree
-- that loses nodes because a machine was unpaired.
--
-- Every timestamp is epoch milliseconds with no default, for the reason 0001
-- through 0006 each give: time comes from an injected clock, and a schema
-- default is the one reading of the wall clock that no test could set. Here it
-- is the *server's* clock and not the hub's -- see `updated_at` below.
CREATE TABLE docs (
  -- The node, which is what every frame after the create names. `doc` is a kind
  -- 0006 already seeded, for the reason that migration gives: the kinds are the
  -- vocabulary of the tree, and a build that meets an unknown kind because two
  -- stacks landed out of order is worse than a lookup row nothing used yet.
  --
  -- A side table rather than columns on `nodes`, which is the argument 0006
  -- made for projects and this inherits unchanged: a column that is NULL except
  -- for one kind is a column whose meaning depends on another column, and
  -- SQLite cannot state that dependency.
  node_id                 text    PRIMARY KEY REFERENCES nodes (id) ON DELETE CASCADE,

  -- The project this document belongs to, which is also this node's parent in
  -- the tree. Stored rather than read off `nodes.parent_id`, and the difference
  -- is what each one means: the parent is where the user put the node, and this
  -- is which project's folder the file is in. They are the same today because a
  -- doc is created under its project, and they part the moment AGX-239 lets
  -- somebody drag a node into a folder -- at which point the file has not moved
  -- and this column is still right.
  project_node_id         text    NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,

  -- The machine that holds the file. See the header for why this is part of
  -- what identifies a document rather than a detail about one.
  server_registration_id  text    NOT NULL REFERENCES servers (id),

  -- What the file is called in that folder: one path segment, already parsed by
  -- `docNameSchema` before it reached here. The tree's own `nodes.name` is what
  -- the user sees and may rename; this is what the server is asked for, and
  -- renaming a node must never change which file a read opens.
  name                    text    NOT NULL CHECK (length(name) > 0),

  -- When the machine holding the file says it was last written, as that
  -- machine's filesystem recorded it -- not when the hub heard about it.
  --
  -- Two clocks, and this is the one that describes the file. A hub that stamped
  -- its own receipt time would answer "edited two minutes ago" with however
  -- long the reply took to cross two machines folded in. It is written only
  -- from a reply a server actually sent, so a failed write leaves the last
  -- truthful value here rather than a guess.
  updated_at              integer NOT NULL
) WITHOUT ROWID;

-- One document of that name, in that project, on that machine.
--
-- A schema fact rather than a habit of the code that writes it, the same choice
-- `projects_directory` made. The rule matters because a write replaces a file
-- whole: two rows for one file would be two nodes a user could edit in two
-- panes, each overwriting the other, with the tree showing both as though they
-- were different documents. The index turns the second create into a refusal
-- with a sentence -- that project already has one of those on that machine --
-- which is something a person can act on.
CREATE UNIQUE INDEX docs_project_server_name
  ON docs (project_node_id, server_registration_id, name);
