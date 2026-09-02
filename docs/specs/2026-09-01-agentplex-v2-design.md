# agentplex v2 — Design

Date: 2026-09-01
Status: approved pending review

## What this is

agentplex v2 turns the single-machine session multiplexer into a small distributed
system for watching and driving coding-agent sessions across machines. It is a new
standalone repository (this one), planned to be open source, and it eventually
replaces `universe/apps/agentplex` (v1). Nothing here depends on the `universe`
monorepo or any `@softie/*` package.

Three ideas, two artifacts:

```
phone PWA ──┐
laptop PWA ─┼─ wss/https ─> HUB (role) ── wss ─> SERVER (role) ── pty/fs ─> sessions + store volume
MCP agent ──┘                 │                  SERVER (role) ─────────────> same or another store
                           Postgres
```

- **`agentplexd`** — one deployable Node service that runs with `--role=hub`,
  `--role=server`, or both (the homelab common case is both in one process). The
  trailing `d` is the Unix daemon convention (`sshd`): this is the long-running
  background process, as opposed to the web client.
- **`web`** — one React PWA served by the hub, used from laptop and phone alike.

## Vocabulary

- **Server (role)**: runs sessions on its own machine via a PTY, watches a session
  store on disk, reports to the hub. Stateless apart from the disk.
- **Hub (role)**: connects to every paired server, merges their state, owns the
  database, serves the PWA, the client websocket, the MCP endpoint, and web push.
- **Store**: a directory (often a mounted volume) holding session transcripts and
  state for one or more providers. Identified by an `agentplex-store.json` file at
  its root, minted on first use. Several servers may mount the same store; a
  session runs on exactly one server at a time.
- **Provider**: a coding agent CLI (Claude Code, codex, opencode). An adapter per
  provider. v2 ships Claude Code fully; the seam is first-class from day one.
- **Session identity** is `{ storeId, sessionId }`. Never machine. "Which server is
  running it right now" is a live fact the hub tracks, not identity.

## Decisions and their reasons

### Topology: hostable hub, thin clients

The hub is itself deployable anywhere (homelab, mac mini, laptop, VPS). Laptop
browser, phone browser, and MCP agents all connect to the one hub. v1's "there is
no hub" decision is deliberately reversed: in v1 a hub was a second connection
mechanism competing with the browser's own sockets; in v2 the hub is the product's
center and the *only* connection mechanism. Clients never talk to servers directly.

The hub dials servers, not the reverse. A server needs one inbound port reachable
by the hub and dials out to nothing.

### One codebase, role flags

A single `agentplexd` with `--role=hub|server|both` rather than two apps. One
protocol, one release artifact, one thing for a self-hoster to install. The roles
stay separable inside the codebase (`src/hub/`, `src/server/`, shared protocol),
so splitting later is possible; shipping them split now buys ceremony, not
isolation.

### Client: PWA, not Electron

Electron's two jobs — hosting the aggregator and OS notifications — are covered
better elsewhere: the aggregator is the hostable hub, and web push delivers real
OS-level notifications on both laptop and phone once the origin is secure. One
client codebase, installable on a phone home screen and a mac dock. Electron
remains possible later as a thin wrapper; nothing forecloses it.

Consequence: **TLS is a hub requirement** (web push is HTTPS-only). Bring your own
cert, or the bundled Caddy handles it. v1's "TLS for the LAN: settled against"
does not carry over — that rejection priced a per-laptop CA; the hub is a hosted
service with a stable address.

### Database: Postgres, hub-owned, single writer

All durable state lives in one Postgres owned by the hub. There is no store-scoped
database on the volume: everything travels through the hub anyway, and an embedded
DB on a multi-attached volume (NFS, EBS multi-attach) has unreliable locking and
fails silently. Exactly one writer — the hub — so no coordination problem exists.

Postgres over SQLite was the user's call, and it buys real things here:
LISTEN/NOTIFY fits the push-everything architecture, JSONB holds cached provider
and far-system payloads, mature migration tooling, pgvector available if the
orchestrator agent grows memory. The cost — a second service to run — is absorbed
by the compose file.

Carried over from v1 verbatim:

- Disk owns session content; the DB owns identity, placement, names, layouts,
  pairings, caches. Delete the DB and the next scan rebuilds the derived columns;
  delete a transcript and no amount of database has the session back.
- Node tree with kind-as-foreign-key (a new node kind is an INSERT, not a schema
  rewrite). Session-keyed tables hold no FK into nodes; a prune sweeps them.
- A removal is remembered, not merely applied.
- Migrations forward-only, append-only, one transaction each; a database ahead of
  the running build throws rather than opening.
- Caches are `Projection`s of the far system, never authority: a failed refresh
  writes nothing, a lapsed entry is served stale and labeled with its age, a
  definite "gone" answer drops the entry.

New tables: `servers` (pairing: address, token, serverId), `stores`,
`push_subscriptions`; `provider` is a column on every session row.

### Scheduling: the hub decides, the user can override

A session start names a store. The hub picks the least-loaded live server attached
to that store unless the user chose one. No server-to-server coordination exists
anywhere in the design. One-live-process-per-session is enforced at the hub — the
only place that can see every server on a store. A live holder is refused and
named; the way out is a stop button resolved hub-side; a busy holder gets no
button; never `--fork-session` or `--session-id`.

### Provider seam

A provider adapter implements:

- `discover(storePath)` — parse this provider's transcript layout into sessions.
- `spawn(session)` / `resume(session)` — argv + env for a PTY.
- `status(...)` — derive status from transcript, process registry, elapsed time.

The adapter knows its layout *within* the store; the store path itself is
configuration (v1's hardwired `~/.claude/projects` generalized). v2 implements the
Claude Code adapter completely (drive + watch); codex/opencode are later adapters
behind the same interface, with no protocol change. Provider is a field on every
session frame.

v1 server gotchas carry over as requirements:

- PTY attach is the only way to drive a session (TUIs check `isTTY`).
- The child environment is scrubbed (`CLAUDE*`, `AI_AGENT`) before spawning.
- `node-pty` needs an executable-bit fix postinstall; keep it.
- Byte streams are trimmed by whole chunks, never by bytes.
- Terminal bytes never enter client rendering state; they go to the emulator.
- The registry's pid entries are stale-prone: verify pid liveness and that the
  epoch `startedAt` postdates the spawn.
- Never write into a provider's own state directory (v1's `~/.claude/` rule,
  generalized per provider).

### Connectivity, discovery, and auth

Three ways a server becomes known; one way it becomes trusted.

- **Same network**: a server configured with `announce: true` broadcasts a UDP
  beacon: `serverId`, address, port, protocol version — never a token. The hub
  listens unconditionally. A discovered server is a *candidate*: selecting it
  pre-fills the pairing form and stops. Announcing opt-in, listening
  unconditional; being heard on the network is nowhere near being trusted by it.
  A beacon claim ages out after six missed announcements.
- **Different network** (the EC2 case): the user enters the address — public DNS,
  Tailscale/WireGuard hostname, or an SSH-tunneled port. The protocol is
  transport-agnostic: the hub needs a reachable `wss://host:port`; how the route
  exists (VPN, tunnel, security group) is deployment, not protocol.
- **Handshake**: the hub dials the server over TLS and presents that server's
  token. The server verifies, replies with `serverId`, protocol version, and its
  mounted stores. Protocol version is an exact `===` match. Per-server tokens, so
  revoking one instance touches nothing else. Pairing is always the user typing
  that server's token into the hub.

Client↔hub: shared token typed on the device, exchanged for a single-use ticket
that authenticates the websocket (the `WebSocket` constructor cannot set headers;
a query-string credential must be void after one use). A 401 and a 1008 close are
one fact to the user.

Tokens at rest in the hub DB are in the clear: encrypting with a key on the same
disk is theatre. Do not imply otherwise in schema or UI.

### Hub internals

v1's browser-side merge moved server-side and made durable:

- One connection supervisor per paired server: reconnect with backoff; an
  unreachable server keeps its rows, marked stale, and its sessions leave the
  attention count (a badge you cannot clear by looking is worse than none).
- A reducer stamps `storeId`, dedupes multi-server stores (one store, one session
  list, N attached servers), and produces whole snapshots. Rows are replaced
  whole, never merged field by field.
- Broadcast pipeline: machine-state frames go whole to every client; refusals are
  replies to the asking client; the stored layout is answered only to the asking
  client. No deltas.
- Every spawn goes through the operation registry: name → typed parser → argv
  builder, `shell: false` always. No frame carries an operation name, an argv
  element, an env var, or a cwd. A generic `{ command }` frame is the failure mode
  the registry exists to prevent — more so once open source.

### Attention and push

Web push (VAPID) carries `needs-you` events and only those — diluting the loud
channel devalues it. The in-page floor carries over for open tabs: bell in the
chrome, needs-you-first ordering (a stable partition, not a sort), document title.
An acknowledgement is a timestamp, not a flag; mute silences the alert, never the
fact. `awaiting-permission` comes from the provider's registry entry where
declared, transcript inference as fallback — status derived once, hub-side.

### MCP

The hub exposes an MCP endpoint (streamable HTTP, same origin, token-authed).
Tools are a curated projection of the client protocol: list stores/sessions with
status, read a session's recent transcript, start a session, send a prompt, answer
a permission prompt, stop a holder. Every tool routes through the same operation
registry as the UI — MCP gains no capability the UI lacks, and there is no
generic-command tool, ever. The built-in orchestrator agent is a later milestone
consuming this same contract; v2 ships the surface.

### Docker

Design-minimum deliverables, not an afterthought:

- One image for `agentplexd`; role chosen by env/flag.
- `docker-compose.yml` standing up hub + Postgres + Caddy in one command. Caddy
  exists only to terminate TLS with automatic certificate issue/renewal (web
  push requires HTTPS); it is optional — anyone with TLS already handled
  (Tailscale HTTPS, an existing reverse proxy) drops it from the compose file.
- The server role's container mounts the store volume and needs a PTY-capable
  image with provider CLIs installed. Running the server role directly on the
  OS with no container ("bare metal": `node` on a mac mini or laptop) is the
  equally supported path and is documented — the server role spawns PTYs
  against the machine's real filesystem and credentials, which on a personal
  machine is more natural outside a container.

## Repository layout

pnpm workspace, standalone repo, `master` branch:

```
apps/agentplexd/     # the service; src/hub/, src/server/ (incl. providers/), src/shared/
apps/web/            # the PWA
packages/protocol/   # frame types, shared by service and web (types-only import)
docs/specs/          # this document and successors
```

`packages/protocol` must be a package: it is shared by two apps, and a shared
type cannot live inside either without one app importing the other's internals.
Provider adapters are NOT a package — only `agentplexd` consumes them, so they
live at `apps/agentplexd/src/server/providers/` and move out only if a real
second consumer appears (e.g., community adapters once open source).

Rules imported from v1 because they were paid for:

- `protocol.ts`-style sharing: the protocol package is types-only where the
  service imports it; each half of the protocol owns exactly one parser; nothing
  downstream re-checks `type` by hand.
- Everything a test cannot supply is injected (sockets, schedulers, file
  surfaces, id generators, storage). Injected seams before mocks.
- Fixtures are captured real output, never hand-written.
- A word read off disk, network, or another program is a claim: parse it, never
  cast it.
- Degrade in the direction that does not over-claim.
- A claim about what a runtime offers is not settled until run at the origin.
- `crypto.randomUUID` is secure-context-only; frame ids come from a counter.
- No emojis in code or UI copy.

UI stack: React + Vite PWA, Mantine taken directly (with a thin local
pass-through module, since `@softie/design-system` cannot be a dependency),
`@tanstack/react-table` for tabular surfaces, xterm for terminals. Status is a
semantic tone; the app names no hues outside one tokens file. Dark-first.
`useEffect` requires explicit justification; prefer `useSyncExternalStore`, ref
callbacks, render-time guards.

## Feature arc — where future features land

The placement rule: **a new feature lands in the hub and its database, exposed
through the protocol and the MCP surface. The server role stays a dumb,
stateless session runner forever.** That keeps the distributed part of the
system small while the product grows.

- **Agent integration** (milestone 8): the built-in orchestrator agent,
  consuming the MCP surface from milestone 6 — same contract any external agent
  gets, no privileged backdoor.
- **Multi-agents / graph of agents**: hub-side orchestration state. A graph is
  nodes (sessions/agents) and edges (routing rules) in Postgres; the hub
  already owns starting, watching, and feeding sessions by milestone 3, so a
  graph is coordination data over existing capabilities.
- **Routines**: scheduled or recurring runs — a hub scheduler table triggering
  the existing session-start operation. A trigger, not a new capability.
- **Search**: Postgres full-text over the transcript-derived columns the hub
  already caches.
- **Vector search**: pgvector over the same rows (part of why Postgres over an
  embedded DB was the right call).

## Out of scope for v2

- codex/opencode adapters (the seam ships; the adapters don't).
- Server-to-server coordination of any kind.
- Electron or any native shell.
- Multi-hub, multi-user, tenants, cloud anything.

## Open questions deferred, deliberately

- Jira/GitHub side panels: v1's projections port over, but *when* in the v2
  sequence is a plan-level call, not a design change.
- Store DB rebuild semantics when a store moves between hubs (export/import of
  placement state) — not needed until someone has two hubs.
- Web push through iOS Safari's PWA constraints: verify at the origin during
  implementation (claims about browser capabilities must be run where claimed).

## Milestones (shape, not schedule)

1. Repo scaffold, protocol package, `agentplexd` skeleton with both roles in one
   process, Postgres migrations runner, compose file.
2. Server role: store identity, Claude adapter discovery, PTY supervisor with the
   v1 invariants (cap, eviction, env scrub, one-writer).
3. Hub role: server pairing + handshake, connection supervisor, reducer,
   client websocket with ticket auth.
4. Web PWA: session list, terminal pane, layout tree, settings/pairing.
5. Attention + web push end-to-end over TLS.
6. MCP endpoint.
7. LAN beacon discovery; scheduling default (least-loaded).
8. Agent integration: the built-in orchestrator agent over the MCP surface.
