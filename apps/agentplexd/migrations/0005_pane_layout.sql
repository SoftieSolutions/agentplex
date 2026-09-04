-- The pane layout: the split-pane arrangement of the user's screen, stored as
-- the characters a client saved and never parsed by the hub.
--
-- One TEXT column and deliberately not a table of panes. The node tree (0004)
-- is rows because the hub acts on it -- discovery inserts, the prune sweeps,
-- position is renumbered -- so its shape is the hub's business. Nothing in the
-- hub acts on a pane: what a split is, what a ratio means, what kinds of pane
-- exist are all client rules, and a schema stating them here would put a
-- service release in front of every new pane type. The client parses what it
-- reads back and degrades whatever it cannot read; the hub's whole promise is
-- to answer the same characters it was handed.
--
-- One row, by CHECK rather than by convention: there is one stored layout per
-- hub, the way there is one node tree. A second row would be a second answer
-- to "what does the screen look like", and nothing could say which one wins.
--
-- The timestamp is epoch milliseconds with no default, for the reason every
-- earlier migration gives: time comes from an injected clock, and a schema
-- default is the one reading of the wall clock no test could set.
CREATE TABLE pane_layout (
  only       integer PRIMARY KEY CHECK (only = 1),
  layout     text    NOT NULL,
  updated_at integer NOT NULL
);
