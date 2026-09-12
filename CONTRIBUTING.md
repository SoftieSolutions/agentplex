# Contributing to agentplex

## Getting set up

Docker is the primary path; Node 24 and pnpm 11 are the alternative.

```sh
pnpm install
pnpm check          # build, lint, typecheck, test — the same set CI runs
pnpm docker:check   # the same, in a container
```

`pnpm check` runs the whole set, starting with the build, because typecheck and
tests both resolve `@agentplex/protocol` through its built declarations. Run it
before opening a pull request; CI runs exactly the same tasks, so a green local
run should mean a green CI run.

CI runs them as four separate jobs — `build`, then `lint`, `typecheck` and
`test` in parallel — so a red pull request names the check that failed instead
of just the run. Each has a container-backed counterpart you can run on its
own, which is what to reach for when one job is red and the others are green:

```sh
pnpm docker:lint
pnpm docker:typecheck
pnpm docker:test
```

Two further checks are about what a stranger gets rather than about this tree,
and CI runs each under its own name for that reason:

```sh
pnpm docker:install    # the published package, installed by a bare npm
pnpm docker:bootstrap  # install.sh, on a Debian container with no Node on it
pnpm lint:shell        # shellcheck over install.sh
```

`pnpm lint:shell` is deliberately not part of `pnpm lint`: the image the checks
run in is a Node image, and adding shellcheck to it to lint one file is a worse
trade than a second command. CI runs it on the runner, which ships one.

## The shape of the codebase

A few rules carry most of the weight. They are not style preferences; each one
is here because the alternative failed quietly somewhere.

**Parse, never cast.** A word read off disk, off the network, or out of another
program is a claim. It goes through a parser that can say no. `as SomeType` on
external input is the bug, not the fix.

**Inject what a test cannot supply.** Sockets, clocks, filesystems, id sources
and the database arrive as dependencies. A module that reaches for the real
world directly is a module that can only be tested against the real world.
Prefer an injected seam to a mock.

**Fixtures are captured real output.** A hand-written fixture tests your idea of
the format. Capture the actual bytes.

**Degrade in the direction that does not over-claim.** A stale cache is served
stale and labelled with its age. A failed refresh writes nothing. An unreadable
item in a listing costs itself and not the listing.

**One parser per direction.** Each half of the protocol owns exactly one parser,
and nothing downstream re-checks a frame's `type` by hand.

**No frame carries an operation name, an argv element, an env var, or a cwd.**
Every spawn goes through the operation registry, `shell: false` always. A
generic `{ command }` frame is the failure mode the registry exists to prevent.

**Setup's spawns go through a second registry, not a wider one.** Installing a
provider is a spawn, so it obeys every rule above, and it is registered where
the wire cannot reach it: `createSetupOperationRegistry` is constructed on the
setup path only, and the wire-facing registry does not contain
`provider.install` at all. A long-running daemon that can be asked over a socket
to fetch and execute an installer is exactly what the previous rule exists to
prevent, and two disjoint lists say so in a way a flag could not. A test asserts
the disjointness over whatever both registries hold.

**Migrations are forward-only and append-only.** There is no `down`. An applied
migration is history: add a new one rather than editing it.

**No emojis in code or UI copy.**

## Workspace boundaries

Both apps may depend on `@agentplex/protocol`. Nothing else crosses a package
line, and neither app may import the other. `pnpm lint` enforces this.

`packages/protocol` is shared by a Node service and a browser bundle, so it may
use neither Node builtins nor another workspace package.

## Connectivity

**The hub dials. A server dials out to nothing.** Every socket a server has is
one a hub opened; `apps/server/src/hub-connection.ts` answers connections and
opens none. The rejected option is the obvious one — servers calling home — and
it buys exactly one thing: a server behind NAT would need no forwarded port.
What it costs is the property the rest of the design rests on. A server that
called home would have to hold the hub's address and a credential the hub
accepts, so every machine running an agent would carry a secret that reaches
the database, and a compromised agent machine would be one that can talk to the
hub rather than one that can only answer it. Dialling inward keeps a server's
one secret a thing it verifies rather than a thing it presents: the token on
`ServerIdentity` is never logged and never appears in a frame the server sends,
and it can hold to that only because the server is never the party opening a
connection. The direction also makes failure legible. The hub knows every
pairing it has, so a server it cannot reach is a recorded pairing marked stale;
if servers dialled in, silence from a machine would be indistinguishable from a
machine nobody ever paired, and the hub would additionally have to decide what
to do about strangers arriving on a port.

**A server announces; it does not call.** The UDP beacon on `BEACON_PORT`
(50081) says there is a server at this address, calling itself this, speaking
this protocol version, and nothing else. That "nothing else" is enforced rather
than intended: `serverBeaconSchema` in `packages/protocol/src/beacon.ts` is the
one strict schema in a package whose frame schemas otherwise tolerate unknown
fields. The others can afford tolerance because they arrive on an authenticated
connection from a peer whose version was checked; this one arrives on an open
port from anyone. A tolerant parser would strip an unknown field silently,
which means it would accept a build that had quietly started broadcasting a
token, and neither end would ever report that a secret had been handed to a
whole subnet. Announcing is opt-in and off by default for the same reason:
`readAnnounce` in `apps/server/src/config.ts` returns false for an unset
`AGENTPLEX_ANNOUNCE`, so a machine broadcasts its existence only because
somebody decided it should.

**Discovery is a convenience, never a requirement.** A hub that has been given
an address connects to a server that has never announced, and that path is not
a lesser one. Being heard on the network, being reachable, and being trusted
are three separate facts, and a beacon establishes only the first: every field
in a datagram is a claim by whoever sent it, and UDP on a local network will
carry a claim from anyone. What a beacon is allowed to do is pre-fill a pairing
form. The distance from there to trusted is the user typing that server's
token, and nothing shortens it.

The caveat that "use a VPN" does not state on its own: UDP broadcast does not
cross subnets, and routed VPNs — WireGuard and Tailscale among them —
generally do not carry broadcast at all. A VPN therefore gives the hub a
routable address and gives it no beacon. The machine never appears in the
pairing form, however long the user waits for it, and its address is typed.
That makes the manual-address path the primary path for every remote machine
rather than the degraded one, and any wording that presents a typed address as
the unhappy path is describing the common case as an exception.

**Reachability is the operator's problem.** The hub has to be able to open a
connection to the address it was given, and getting it there is a forwarded
port, or both ends on one network over a VPN, or a tunnel. The protocol is
deliberately indifferent between them — `apps/hub/src/pairing/server-address.ts`
parses a URL and never a route — and agentplex neither solves this nor pretends
to. Saying so is the same rule as the rest of the codebase: degrade in the
direction that does not over-claim.

**There is no relay, and there will not be one.** The original mockup proposed
a hosted "us-west relay" that both ends would dial so that neither had to be
reachable. It is dropped, and not on technical grounds: a relay is hosted
infrastructure, it would have to be run by somebody, and running infrastructure
is not what this project is. Shipping one would also move the failure off the
operator's network and out of their reach, which is the opposite of the
paragraph above — a pairing that works until a service somewhere else stops is
a pairing whose failure has no local cause to find.

**Three credential kinds, and they must not be confused.** They differ in who
holds one, who checks it, and how long it lives, and every one of those
differences is load-bearing:

- **The client token** is long-lived, held by a person's browser, and checked
  by the hub. The hub takes it from configuration — `AGENTPLEX_CLIENT_TOKEN`,
  at least 32 characters — and the browser keeps it per device in
  `apps/web/src/auth/token.ts`, presenting it as a bearer header on the ticket
  exchange and nowhere else. It authenticates a user to a hub.
- **The pairing token** is long-lived, held by one server, and checked by that
  server. `ensureServerIdentity` in `packages/providers/src/server-identity.ts`
  mints it the first time that server starts, because the minting side is the
  side that can get the entropy right, and writes it beside the server's id so
  that both survive a restart. It only ever arrives. It authenticates a hub to
  one server, and there is one per pairing rather than one per server: a pairing
  is the unit an operator revokes, so a server two hubs have paired with holds
  two, and revoking either leaves the other working.
- **The enrollment token** is short-lived, minted by a hub for a single
  enrollment. It expires in minutes rather than hours because it is a string
  that gets pasted in front of other people, and the only safe assumption about
  such a string is that more people saw it than were meant to.

Reusing one for another's job is the failure this list exists to prevent. The
client token is not a pairing token — handing a server the credential that
attaches to the hub would give every paired machine the user's own access — and
a pairing token is not an enrollment token, because one is meant to last until
somebody revokes it and the other is meant to expire before the meeting ends.

## Commits and pull requests

One ticket per branch, one branch per pull request. Keep the diff reviewable:
if a change needs a paragraph of context, that paragraph belongs in the pull
request body.

## License

By contributing you agree that your contributions are licensed under
[Apache-2.0](LICENSE).
