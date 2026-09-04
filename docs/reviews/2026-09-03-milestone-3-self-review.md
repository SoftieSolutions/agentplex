# Milestone 3 self-review — hub role, on master at 1ddaf4a

Date: 2026-09-03. Scope: everything merged for epic AGX-3 (AGX-22..29, PRs
21, 23, 34..39) plus the SQLite storage epic AGX-60 (PRs 25, 27..31, 33) as it
landed underneath the stack. Method: re-read the milestone 3 line of the v2
design spec and its Connectivity and Hub internals sections, then walked the
merged code on a fresh master checkout asking, for each spec claim, where the
production caller is. `pnpm check` on this commit: green, 59 files, 742 tests.

## What milestone 3 promised and what stands

The milestone line reads: "Hub role: server pairing + handshake, connection
supervisor, reducer, client websocket with ticket auth."

- Handshake: done. The hub dials over an injected socket seam, presents the
  per-server token, requires an exact protocol version match, and records the
  reply's serverId and stores (`src/hub/pairing/server-handshake.ts`,
  `src/hub/connections/server-connection.ts`). The server side verifies with a
  constant-time compare (`src/server/hub-connection.ts`).
- Connection supervisor: done. Backoff, staleness as a live fact, heartbeat,
  attention exclusion for unreachable servers; only `last_connected_at` is
  durable, liveness is in-memory by design.
- Reducer: done. storeId stamping, multi-server store dedupe, whole-row
  snapshots, versioned memoized state; wired to both the connectivity and the
  report seams in `src/hub/hub.ts`.
- Client websocket with ticket auth: done. Token to single-use 10-second
  ticket, query-string credential void after one use, 401 and 1008 as one
  fact. Broadcast sends whole machine-state frames under a single dirty flag.
- Beyond the line, the stack also delivered the node tree schema and layout
  answers (AGX-28) and store-addressed session start with one-writer refusals
  (AGX-29).

## Findings

Ordered by how much they matter. None of them breaks what is merged; the first
two mean the merged code cannot yet be exercised end to end.

### 1. No production path pairs a server with the hub

`registerServer` and `revokeServer` in `src/hub/pairing/server-registrations.ts`
are called only by tests. There is no client frame, no HTTP endpoint, and no
CLI flag that inserts a server row, so the connection supervisor's
`listServers` always finds an empty table on a fresh hub and everything built
on top — handshake, reducer, broadcast, session start — is reachable only from
tests or by hand-editing the database. The spec says pairing is the user typing
the server's token into the hub, and the pairing form is milestone 4, but the
form needs a hub-side operation to call and that operation does not exist yet.
Recommendation: give milestone 4 an explicit early ticket for the pairing
operation (a client frame routed like session-start, or an authed HTTP
endpoint), and treat it as blocking any end-to-end demo of milestone 3 work.

### 2. The node tree is never populated or pruned at runtime

`discoverNodes` (`src/hub/layout/node-discovery.ts`) and `pruneNodes`
(`src/hub/layout/node-prune.ts`) are called only by their tests. `readLayout`
is wired into the layout answer, so a client asking for the layout of a live
hub always receives an empty tree, whatever sessions exist. The discovery
half was written to run off the reducer's reports and the prune half off the
same reports' absences; neither is subscribed. Recommendation: wire both to
the reducer's report seam in `startHub` (discovery on arrival, prune on a
whole report), or fold that wiring into the first milestone 4 ticket that
renders the tree — but record the decision, because today the layout answer
over-claims: it reports an empty layout rather than an unknown one.

### 3. The ticket endpoint is unthrottled

`POST /client/ticket` compares the presented token in constant time but
nothing limits attempts, so the long-lived client token can be guessed at
whatever rate the listener accepts connections. Known at review time of
AGX-27 (PR 37) and accepted; restated here so it is a ticket rather than a
memory. A counter with a decay per source address in front of
`createClientTickets` would do; TLS termination is the reverse proxy's job
and rate limiting could land there instead, but then the compose file must
actually configure it.

### 4. AGX-69 is the one unmerged piece of the storage work

`agentplexd doctor` and the startup preflight carried into the handshake
(AGX-69) never got a PR; every other child of the SQLite epic and of the
install-and-provisioning batch is merged (AGX-62..68, AGX-70, AGX-79). The
handshake currently reports stores without any preflight claim. Nothing
depends on it yet, but the install docs promise a doctor.

### 5. Smaller notes, no action forced

- Sessions and stores are in-memory only between restarts, except placement
  (nodes) and pairing (servers, stores): matches the spec's durability line,
  noted so nobody mistakes it for a gap later.
- `attention.ts` exports `countsTowardAttention` consumed by the reducer and
  session routing; the badge and push side arrive with milestone 5.
- The layout answer goes only to the asking client and refusals are replies,
  as specified; the broadcast never carries layout.
- Wire-shape tests assert no frame carries argv, env, command, operation,
  pid, or terminalId; the operation registry remains the single spawn path.
- The worktrees for this epic were created under `.claude/worktrees/` inside
  the repository, while AGENTS.md says worktrees live outside it. Process
  note for the next epic, not a code finding.

## Verification

- `pnpm check` on master 1ddaf4a: build, lint, typecheck, test all green
  (742 tests, 59 files).
- Unreferenced-module sweep over `apps/agentplexd/src`: no source file is
  orphaned; the two runtime-unwired modules above are imported by tests,
  which is how they escaped notice.
- Postgres sweep (`postgres|testcontainer|pg_`): nothing outside
  `pnpm-lock.yaml` history.
