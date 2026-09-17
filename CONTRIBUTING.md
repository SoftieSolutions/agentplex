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

**No frame carries an operation name, an argv element or an env var. A
directory crosses the wire only as a `directory` field parsed by
`directorySchema`, refused unless under a configured browse root, and the only
spawn field it may reach is `cwd`.** Every spawn goes through the operation
registry, `shell: false` always. A generic `{ command }` frame is the failure
mode the registry exists to prevent.

The cwd half of that rule is an amendment, taken deliberately and argued here so
it is not re-argued. A project holds a directory on a server and the user picks
it by browsing, so a directory has to cross. The rule's reason was that a
`{ command }` or `{ cwd }` field is a generic execution surface; three things
together are what make this one not that, and none is optional. The value is
parsed by one schema, `packages/protocol/src/directory.ts`, which is the same
schema an operation's request is parsed by — absolute, no NUL. The server
refuses it unless its **real** path sits under a root that server's operator
configured, which is a list nothing on the wire can add to and which is empty by
default, so a machine nobody has configured browses nothing and says so. And the
only spawn field it may ever reach is `cwd`, on a spawn that still goes through
the registry with an argv this process built.

The rejected alternative is server-declared workspaces with opaque ids on the
wire, which keeps the old rule verbatim. It was rejected because it makes adding
a directory a server-side setup action, and the decision the catalogue rests on
is that the user browses for one — an operator editing a settings file to make a
checkout pickable is the workflow the browse exists to remove.

Three uses are covered by the amended wording, and each was argued separately.
`directory-list` (AGX-238) is a browse request. `project-create` (AGX-133)
records a directory in a hub row, and the `session-start` that names that
project is the only one of the three that reaches a spawn — as `cwd`, and
nothing else. The document frames (AGX-241) carry a `directory` as the key of a
per-project file store and reach no spawn at all. One rule covers all three
because what bounds them is the same thing — a parser that can say no, and a
root list only the machine's operator writes.

A client never sends the path a session spawns in, and that is the shape of the
project frames rather than a habit of the code: `session-start` carries a
`project` node id, the hub resolves the directory out of its own rows, and the
machine refuses it unless a root is above it. The party that types a path and
the party that runs a process are two hops apart, with a parser and a root list
between them.

`apps/server/src/directory-browse.ts` holds the containment rule and the reason
it runs on `fs.realpath` rather than on the string. Its `allow` is that rule
alone — a session start asks it, and takes no listing with it — and
`tests/hub-server/src/session-start.integration.test.ts` is where the wire shape
is asserted: `args`, `argv`, `env`, `command`, `operation`, `pid` and
`terminalId` absent everywhere, and every `directory` on a hub-to-server
instruction either null or under a configured root.

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

## Features

`apps/hub/src/features/` is one folder per feature: the fleet state, the paired
servers, pairing, sessions, the terminal relay, projects, documents, the
catalogue, the pane layout, the clients, client auth, discovery, the web
assets, and MCP. Four rules hold it together, and `pnpm lint` enforces the
first one.

**A feature is a folder with one entry file.** `features/catalogue/catalogue.ts`
exports the interface `Catalogue` and `createCatalogue(deps)`, and another
feature imports that file and nothing else from the folder. It is not a barrel:
it defines the interface and the factory and re-exports nothing, so what is on
it is a decision somebody made rather than the accumulated surface of every file
behind it. The rule is what makes a move inside a folder free — splitting
`node-tree.ts` into `rows.ts`, `reads.ts` and `writes.ts` changed no import
outside `catalogue/` — and it is the reason a vocabulary type lives on the entry
file rather than in whichever file happens to produce it. `ServerConnectionReport`
is defined in `servers/servers.ts` and not in the dial loop that builds one.

The lint rule is in `eslint.config.js` and names the feature folders, so adding
a feature means adding a line. Forgetting the line fails closed — nothing may
import the new feature — which is the right direction for a rule about who may
reach whom. A rule that fails open is one nobody notices has stopped holding.

**Dependencies are interfaces.** A feature takes other features, and seams —
`Database`, `Clock`, `Timers`, `IdGenerator`, `Logger`, `SocketDialer` — and
nothing concrete. `hub.ts` is the only file that knows the whole set, and it is
composition and nothing else. The servers feature takes `Pairing` rather than
the `Database`, because which servers may be dialled is the pairing feature's
answer and a second reader of that table would be a second answer to it.

**A fake beside the entry file.** `fake-<feature>.ts` sits next to
`<feature>.ts`, and a suite in another feature stands on the fake rather than on
the real thing. Test files may import one and service modules may not, which is
the one place the lint rule above is looser for a test.

**Frames enter through one switch per direction, and the switch is exhaustive.**
`features/clients/client-connection.ts` and `features/servers/frame-router.ts`
both end in `assertNever`, so a frame added to the protocol with no case fails
typecheck. Neither did, and the cost was not a crash: the four client terminal
frames and four of the server's parsed cleanly, matched no case, and fell out of
the bottom with no reply, no log line and nothing to find. The drain notice was
one of them, and it is the one that shows what silence cost: a server
announcing a graceful shutdown and a server whose battery died produced the
same screen, because the frame that told them apart was being dropped. A client was left
holding a frame id that would never be answered. What this build cannot serve it
now says so — a refusal in words to a client, a debug line naming the frame from
a server — and neither is silence.

**A feature with two callers is what a feature is for.** `features/docs/docs.ts`
exposes four functions and reaches a server through the connections seam;
`client-connection.ts` calls them on a frame and the four MCP document tools
call the same four in the same process. Neither reaches a connection itself, and
that is the point rather than a tidiness: a second caller putting its own
`doc-write` on a socket would be a second answer to what a document write means
-- which index rows it touches, which refusals it produces, what happens when
the machine is away -- and the two would part company the first time one of them
was fixed.

One file is deliberately thin. `features/servers/transport.ts` is how the hub
speaks to a server once it is connected, and it declares only what is actually
used: `ask`, `stream`, the handlers for what arrives unprompted, and `close`.
The stream half was named in a comment and not declared until there was a relay
to stand behind it, because an interface that promised a stream nothing
implements would be a promise the loop could be written against and then broken.
It is the one file the Connect-over-HTTP/2 epic replaces, which is why the dial
loop above it never sees a socket.

The two halves are two methods rather than one with a wider frame union, and
that is the terminal relay's one structural demand on this seam. `ask` is unary
and awaited: one instruction, one answer. A terminal frame is answered on a
different schedule, sometimes not at all — an input and a resize are silent
when they work — and, decisively, its answer has to be delivered where the
frame was read. A server writes a subscription's reply and the scrollback it
just promised in the same turn, so a relay built on a promise would settle a
microtask later and hand a client its history before the frame that counts it.
`stream` therefore takes a callback, and the ordering is a property of the seam
rather than something each caller has to remember.

## Workspace boundaries

Both apps may depend on `@agentplex/protocol`. Nothing else crosses a package
line, and neither app may import the other. `pnpm lint` enforces this.

`packages/protocol` is shared by a Node service and a browser bundle, so it may
use neither Node builtins nor another workspace package.

## Where new capability lands

Every ticket arrives as the same question: this has to happen somewhere, and
there are five somewheres. The order below is by what the change costs to be
true -- how many parties have to move, and how many of them are on machines
nobody here controls -- and the cheapest is always the code already open in the
editor. Climb a rung only when the one below it has been tried and has named
the thing it could not do.

**1. A new file in the package or feature that already owns the concern.** This
is where almost everything belongs, and it is the rung the rest of the ladder
exists to protect. `packages/providers` is the worked example because the claim
was tested rather than asserted: `provider-adapter.ts` says the seam exists so
that "the second adapter is a new file rather than an edit to the server", and
AGX-175 added codex as the first thing permitted to disprove it. The diff is six
new files and three touched, all inside `packages/providers`. No frame changed,
no field was added to `ProviderAdapter`, `apps/server` was never opened, and
registering the adapter is one line in `registered-providers.ts`.

**The rung is cheap only when the seam has already been paid for, and writing
the file is how you find out whether it has.** Two defects surfaced by drafting
the codex ticket were fixed before it landed: `apps/server/src/hub-connection.ts`
had hand-copied the provider union out of `providerSchema` (AGX-173), and
`createProviderRegistry([createClaudeAdapter(...)])` was written out in three
entrypoints, so a second adapter would have been an edit to all three (AGX-174).
Neither is visible while there is one provider. The way to find what a seam has
not paid for is to write the second thing and watch what it drags.

**A leak the second thing exposes is usually another file beside it, not a rung
up.** Both provisioning files parsed npm's `--json` install report, which is a
fact about npm and about neither provider; the second adapter is what turned one
parser into two copies of one, and the fix (AGX-219) is `npm-install.ts` in the
same package. The argv did not move with it, because `--no-ignore-scripts` is
Claude Code's answer to Claude Code's postinstall, and putting it behind a
parameter would hide a provider's own fact from the provider's own file.

**Some of what the second thing finds is not the ladder's to fix.** codex writes
no approval event into its rollout, so a session stopped at an approval prompt
and a session running a slow tool are identical bytes on disk, and
`awaiting-permission` -- the status the notifications, the Allow and Deny
buttons and the sidebar ordering are all built around -- is unreachable for that
provider (AGX-218). It is a product consequence and not an interface defect: a
union does not oblige every adapter to reach every member. When a rung feels
tight the temptation is to climb, and a provider that cannot answer a question
is not an argument for a wider interface.

**2. A new feature folder in the app**, when the concern is nobody's yet and
holds state of its own. It costs a folder with one entry file, a
`fake-<feature>.ts` beside it, a line in `HUB_FEATURES` in `eslint.config.js`
and a line of composition in `hub.ts`, and nothing outside that app moves.
`features/docs` (AGX-242) is `docs.ts`, `doc-rows.ts`, `fake-docs.ts` and a
forward-only migration. Two callers are what make it a feature rather than a
file: the client connection calls its four functions on a frame and the MCP
document tools call the same four in the same process, and a second caller
putting its own `doc-write` on a socket would be a second answer to what a
document write means.

**3. A package, once the second consumer actually exists.** `AGENTS.md` states
the rule -- `packages/` holds seams with at least two consumers, and one
consumer is a folder -- and the cost is why the rule has a number in it: a
manifest, a tsconfig, a build, a block in `eslint.config.js` naming what the
package may import, and a place in the packaging step. `node-shared` (the hub
and the server), `release` (the bin and `scripts/`) and `providers` each had
both consumers on the day they were created.

Placement on this rung can carry more than the rule. AGX-174 put the adapter
list in `packages/providers` rather than in `apps/cli`, which holds two of its
three callers, and the deciding argument was not tidiness: `packages/providers`
may not import `@agentplex/pty` and lint enforces it, so the composition cannot
hand `doctor` the one dependency `doctor` is defined by not having. The same
list in `apps/cli` passes lint with a pty import one hop away -- checked by
experiment, in that pull request, rather than assumed. Where a thing lives
decides which rules can see it.

**4. A protocol frame, and every party moves together.** This is the expensive
rung, and it is expensive in a currency the others are not: `PROTOCOL_VERSION`
is compared with `===` and never with a range, so a hub and a server that
disagree do not speak at all. A frame change is the bump, both parsers, both
exhaustive switches, a re-captured client fixture and an upgrade on every paired
machine. That is the right behaviour rather than a tax -- the alternative is
carrying forever the question of which fields the other end understood -- but it
is paid by people who did not read the ticket. AGX-242's three document frames
are what it looks like: protocol 20, `packages/protocol/src/client.ts`, the
hub's `client-connection.ts` and `frame-router.ts`, the web store, a regenerated
`hub-frames.fixture.ts` and the `tests/hub-server` suite. The feature folder was
the cheap half of that diff.

The provider seam shows the other way to pay this rung, which is in advance.
`providerSchema` has read `['claude', 'codex', 'opencode']` since protocol v0,
so registering codex changed no frame at all. A fourth provider name would be a
frame's shape changing: one word in one file, and a version every machine in the
fleet has to take. Before writing a frame, ask whether the other end needs to
know. Most capability does not.

**5. A new app, last.** An app here is a deployable: a package somebody
installs, a role `install.sh` can be asked for, a unit systemd starts or a bin a
person types. `setup` and `doctor` were `apps/setup` and `apps/doctor` and had
none of that -- neither had a bin anybody installed, neither was ever started
except by `agentplex setup` or `agentplex doctor`, and the only thing reaching
either was the dispatcher in `apps/cli`. A directory with a manifest is the
paperwork of an app and not an app; they are commands in `apps/cli/src/commands/`
now. Add an app when something must be installed, started, stopped or upgraded
separately from everything else, which is what makes the hub and the server two:
one owns the database and the other owns a pty on a machine the hub only dials.
A different kind of work is not that.

The ladder is as much about the cost of being wrong as the cost of being right.
A file in the wrong package moves with a `git mv` and an import, and an app
nobody installed moves the same way. A frame that should not have existed is a
version number every machine already took, and an app somebody did install is an
install script, a unit and an upgrade path to withdraw.

## Dependency versions

`AGENTS.md` says to install the latest version of a new dependency and pin it
deliberately. This section is what deliberately means. It is one rule with no
judgement in it, so that applying it across a manifest is mechanical and a
check can enforce it afterwards.

**A caret is the absence of a decision.** `pnpm add` writes one by default, so
`^4.1.13` is what a manifest holds when nobody chose anything, which is the
half of that sentence with nothing behind it. It is also a bound whose value is
not in the file: `^4.1.13` stops below 5.0.0 and `^0.11.0` stops below 0.12.0,
one character meaning two different things depending on the version it is
attached to, so a reader applies a semver special case to learn what a manifest
permits. Writing the bound out makes it a fact in the file rather than a
derivation from one, and it is what lets a failing check name the bound it
wanted instead of pointing at a document.

**Three forms, and nothing else.** Every value under `dependencies`,
`devDependencies`, `optionalDependencies` and `peerDependencies`, in every
manifest in this workspace, is one of:

- `workspace:*` for a sibling in this tree. It never resolves against a
  registry, and `scripts/assemble-package.ts` replaces it with the exact
  version it bundled before the package is published.
- `>=x.y.z <X.0.0` for a third-party package at 1.0.0 or later, where `X` is
  `x + 1`. The floor is the version the lockfile resolves today, not a guess at
  the oldest that might work.
- `x.y.z`, exact, for a package below 1.0 and for anything that compiles at
  install. Exact is also always allowed to win an argument the other two forms
  lost, and then the argument is written next to it.

**A window above 1.0, because there is a promise to take.** Inside the
workspace a range decides nothing: the lockfile is committed, `pnpm install` in
a fresh worktree resolves through it, and CI installs frozen, so a contributor
gets what CI ran either way. The range is the only thing there is exactly once,
on a stranger's machine: `scripts/assemble-package.ts` copies a third-party
range verbatim out of a manifest into the published package's `dependencies`,
and npm resolves it there against the registry with no lockfile of ours in
sight. A window is the honest thing to say in that position. It lets an
upstream patch reach a daemon that has been running for months without waiting
for a release of ours, and it stops where the author's compatibility promise
stops. An exact pin there would turn every upstream patch into a release of
ours, which is a maintenance burden we would pay in order to publish a claim we
have no more evidence for.

**Exact below 1.0, because there is no promise to take.** Below 1.0 semver
makes the minor the breaking change, so the widest honest window is
`>=0.11.0 <0.12.0`: patch releases only, of a package whose author has not
committed to patches being safe either. That window admits one kind of release
and costs a second grammar, and the tree already agrees it is not worth it.
Every dependency here below 1.0 is one of the four `@xterm/addon-*` packages,
each pinned exactly, and nobody argued about it. Keeping it that way leaves the
window form with exactly one shape, `<X.0.0` with `X` at least 1, so neither
the rule nor the check that follows it has a 0.x branch.

**Exact for anything that compiles, and `node-pty` is the instance rather than
the exception.** A package that builds a native addon is the only kind whose
install is a compilation, against whatever compiler and Node ABI the machine
happens to have. A minor there is a different binary, and the failure it
produces is a compiler error during somebody else's install rather than a test
failure here, so the version has to be one that was built and run. `node-pty`
sits at `1.1.0` in `packages/pty` for that reason, and so does the next such
dependency. The set this can be true of is legible: `allowBuilds` in
`pnpm-workspace.yaml` is the list of packages permitted to run an install
script at all, and a package that cannot run one has no opportunity to compile
anything.

**Dev tooling is held to the same rule, for a different reason.** Nothing under
a `devDependencies` key reaches a tarball — the manifest schema in
`scripts/assemble-package.ts` does not even read the field — so the paragraph
about a stranger's machine does not reach the root manifest, which is dev
tooling only and publishes nothing. The rule still applies there, because the
root manifest is where `pnpm add -D` gets run most often and therefore where a
default caret is most likely to be written, and an exemption at exactly the
place the default appears is an exemption that eats the rule. It also costs
nothing to hold: the window changes nothing a contributor installs, since the
lockfile does that, and the saving a looser rule would buy is an occasional
one-line edit. The price would be a check with a branch in it and a question at
every review about which manifest is which.

**`engines` is not a dependency range, and carries no upper bound.** The root
manifest's node floor of `>=24` and its pnpm floor of `>=11` resolve nothing
and fetch nothing. They are evaluated against the runtime already on the
machine, so there is no version to choose and no drift to bound: the entry
either accepts what is there or refuses it. Capping the first at `<25` would
make every package refuse Node 25 on the day it ships, and that refusal would
be a claim we had tested something, when in truth nobody has run Node 25 and
nobody has run Node 24.11 either. Only one of those two would be enforced. So
the floors stay floors, and a check does not read the field. `packageManager` is exact already, at `pnpm@11.17.0`,
because corepack needs one version rather than a range, and it is not a
dependency either. `scripts/assemble-package.ts` carries `engines.node` into
every published manifest and deliberately drops `engines.pnpm`, since a
published package is installed by npm on a machine that has no pnpm.

**No git or URL dependencies.** There are none today. If one is ever needed it
names a 40-character commit SHA, because a tag and a branch both move, and a
dependency whose version can change with no diff anywhere is the thing this
whole section exists to prevent.

**What a check reads.** Every `package.json` in the workspace outside
`node_modules`, and every value under the four dependency fields named above. A
value passes when it is `workspace:*`, or an exact `x.y.z` with an optional
prerelease suffix, or `>=x.y.z <X.0.0` written with a single space between the
two comparators and `X` at least 1. Everything else fails, `^` and `~`
included, and the message names the manifest, the dependency and the bound it
wanted. `engines`, `packageManager` and anything under a `pnpm` key are not
dependency fields and are not read.

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
deliberately indifferent between them — `packages/protocol/src/pairing.ts`
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
  two, and revoking either leaves the other working. It is the one credential a
  client frame carries — `server-pair` brings the token a person read off that
  server and pasted — and it travels in that direction only: the hub stores it,
  no reply or `machine-state` row has a field for it, and tests on both sides
  assert that no frame the hub sends afterwards contains it.
- **The enrollment token** is short-lived, minted by a hub for a single
  enrollment. It expires in minutes rather than hours because it is a string
  that gets pasted in front of other people, and the only safe assumption about
  such a string is that more people saw it than were meant to.

Reusing one for another's job is the failure this list exists to prevent. The
client token is not a pairing token — handing a server the credential that
attaches to the hub would give every paired machine the user's own access — and
a pairing token is not an enrollment token, because one is meant to last until
somebody revokes it and the other is meant to expire before the meeting ends.

One boundary is not a package line, and so is not lint's to carry. `agentplex
doctor` reads a machine and must not be able to change it, and it lives in a
directory of `apps/cli` — an app that declares `@agentplex/pty` legitimately,
because the wizard beside it opens terminals. ESLint sees one file at a time, so
a rule scoped to the doctor's directory catches a direct import and misses one
reached through any sibling module in the same app.
`apps/cli/src/commands/doctor/pty-boundary.test.ts` is the half that holds the
property: it follows the import graph out of the doctor's entrypoint and fails
if any module in it binds anything from that package beyond the three names that
ask whether a pty can be opened without being able to open one. A constraint
that cannot be drawn at a package line gets a test, not a comment — a
half-enforced rule is worse than an unenforced one, because the second gets read
and the first gets trusted.

## Commits and pull requests

One ticket per branch, one branch per pull request. Keep the diff reviewable:
if a change needs a paragraph of context, that paragraph belongs in the pull
request body.

## License

By contributing you agree that your contributions are licensed under
[Apache-2.0](LICENSE).
