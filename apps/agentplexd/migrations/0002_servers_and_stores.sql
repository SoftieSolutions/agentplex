-- Pairing: the servers this hub may dial, and the stores it has heard of.
--
-- Per-server tokens. One token per paired server, so revoking one instance
-- touches nothing else: a stolen laptop stops being able to speak to this hub
-- without the EC2 box having to be re-paired. A single shared secret makes
-- every revocation a fleet-wide event, and the predictable consequence of that
-- is that nobody ever revokes anything.
--
-- The tokens here are in the clear, deliberately, and nothing above this table
-- may imply otherwise. Two reasons, and the second is the one that settles it:
--
--   * Encrypting them with a key that lives on the same disk is theatre.
--     Whatever can read this table can read the key beside it.
--   * They cannot be hashed the way a password can. A password hash works
--     because the hub only ever has to *check* one. This token is an outbound
--     credential: the hub presents it to the server on every dial, so it must
--     be able to reproduce it. Storage in the clear is not a shortcut taken
--     here, it is the only shape the protocol leaves.
--
-- What follows from that is an operational requirement, not a schema one:
-- protect the database and its backups. Saying so honestly is worth more than
-- a column named `token_encrypted` that means nothing.
--
-- Every timestamp here is epoch milliseconds with no default, for the reason
-- `0001` gives: time in this codebase comes from an injected clock, and a
-- schema default would be the one reading of the wall clock no test could set.
-- Neither table is WITHOUT ROWID. That keyword is load-bearing in `0001`,
-- where an `integer PRIMARY KEY` column is the rowid and would swallow its own
-- DEFAULT; both keys here are `text`, so it would buy storage layout and no
-- correctness, and a keyword that means something different two files apart is
-- worth more as an absence than as a habit.

CREATE TABLE servers (
  -- The hub's name for this pairing, minted here.
  --
  -- Not the server's own id, because at the moment a pairing is created there
  -- is no such thing yet. Pairing is the user typing an address and the token
  -- that server printed; the server's `serverId` only arrives when a handshake
  -- answers. A primary key taken from an unverified claim is a primary key
  -- that changes, so `server_id` below is a separate, later fact.
  id          text        PRIMARY KEY,

  -- What the user calls this machine. A label and never an argument: nothing
  -- is spawned from it and nothing is dialled by it.
  label       text        NOT NULL CHECK (length(label) > 0),

  -- The `wss://` URL the hub dials, as parsed before it reached this table.
  address     text        NOT NULL CHECK (length(address) > 0),

  -- The per-server token the user typed. NULL once revoked: a secret that can
  -- no longer authenticate anything has no business outliving its use in a
  -- backup, and dropping it is not encryption by another name.
  token       text,

  -- The id the server gave for itself, once a handshake confirmed it. NULL
  -- until then, which is a different fact from "this server has no id".
  server_id   text        CHECK (server_id IS NULL OR length(server_id) > 0),

  created_at  integer     NOT NULL,

  -- A removal is remembered, not merely applied. The row stays so that a
  -- revoked pairing is a fact the hub can show and reason about, rather than
  -- an absence that looks identical to never having paired at all.
  revoked_at  integer,

  -- Being live and holding a token are the same fact, and this is where that
  -- is true. Code that reads these rows parses them as two shapes -- live with
  -- a token, revoked without one -- and this constraint is what makes the
  -- third shape unreachable rather than merely unwritten.
  CONSTRAINT servers_token_matches_liveness
    CHECK ((revoked_at IS NULL) = (token IS NOT NULL))
);

-- At most one live pairing per actual server. Partial rather than a plain
-- UNIQUE, because a revoked pairing must not stop the same machine from being
-- paired again -- which is the ordinary way a token gets rotated.
CREATE UNIQUE INDEX servers_live_server_id
  ON servers (server_id)
  WHERE revoked_at IS NULL AND server_id IS NOT NULL;

-- The dial list: every read that is about to connect wants the live rows.
CREATE INDEX servers_live ON servers (created_at) WHERE revoked_at IS NULL;

-- Stores, keyed by the id in the store's own agentplex-store.json.
--
-- The key is the store's, never the hub's and never the machine's. A session
-- is {storeId, sessionId}; a volume mounted on two servers is one store; a
-- volume copied to another disk keeps its sessions. Keying a store by server,
-- by hostname or by path loses all three, and loses them silently.
--
-- There is no path column, and that is not an omission. A path is a property
-- of a mount rather than of a store: the same store is /mnt/work on one server
-- and /home/me/work on another. The path travels on the store descriptor a
-- server reports, and belongs wherever attachments come to live.
CREATE TABLE stores (
  store_id      text        PRIMARY KEY CHECK (length(store_id) > 0),

  -- When any server first told this hub the store exists, and when one last
  -- did. Two columns rather than one, because a listing that can say how old
  -- what it knows is can decline to imply the store is still there.
  first_seen_at integer     NOT NULL,
  last_seen_at  integer     NOT NULL
);
