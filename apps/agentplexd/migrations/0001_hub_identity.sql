-- The hub's own durable identity.
--
-- Clients and paired servers both need a stable name for "this hub" that
-- survives a restart and a change of address. It is minted once, on the first
-- migration, and the single-row constraint makes a second one impossible
-- rather than merely unlikely.

CREATE TABLE hub_identity (
  only_row   boolean     PRIMARY KEY DEFAULT true CHECK (only_row),
  hub_id     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
