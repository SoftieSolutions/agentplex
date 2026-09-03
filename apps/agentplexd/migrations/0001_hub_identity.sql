-- The hub's own durable identity.
--
-- Clients and paired servers both need a stable name for "this hub" that
-- survives a restart and a change of address. It is minted once, on the first
-- migration, and the single-row constraint makes a second one impossible
-- rather than merely unlikely.
--
-- WITHOUT ROWID is load-bearing rather than an optimisation. In a rowid table
-- an `integer PRIMARY KEY` column *is* the rowid, and SQLite fills an omitted
-- rowid with the next unused integer instead of the column's DEFAULT: the
-- second `INSERT ... ON CONFLICT (only_row) DO NOTHING` would arrive as row 2,
-- fail the CHECK, and turn an idempotent mint into a hub that will not start
-- twice. Without the rowid the column is an ordinary primary key, the DEFAULT
-- applies, and the second insert conflicts with the first and does nothing.
--
-- `created_at` is epoch milliseconds and has no default, because time in this
-- codebase comes from an injected clock rather than from whichever machine the
-- statement happened to run on. A schema default would be the one reading of
-- the wall clock that no test could set.

CREATE TABLE hub_identity (
  only_row   integer PRIMARY KEY DEFAULT 1 CHECK (only_row = 1),
  hub_id     text    NOT NULL,
  created_at integer NOT NULL
) WITHOUT ROWID;
