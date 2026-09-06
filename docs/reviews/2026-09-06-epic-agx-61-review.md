# Epic AGX-61 review: pendings, and the gaps the epic exposed

Date: 2026-09-06. Scope: the install-and-provisioning epic AGX-61, implemented
as two stacked pull request chains, all nine open and green at review time:

- Setup path: #56 (AGX-71) < #58 (AGX-72) < #60 (AGX-73) < #62 (AGX-74)
  < #63 (AGX-75).
- Ship path: #55 (AGX-69) < #57 (AGX-76) < #59 (AGX-77) < #61 (AGX-78).

This document records what the epic deliberately left open, what it could not
verify from this environment, and the product gaps the work made visible. The
milestone 3 self-review's findings are re-checked at the end, because three of
its four are still open and this epic raised the cost of two of them.

## Merge mechanics

Bottom-up within each chain, retargeting each pull request to `master` as its
base merges. A dry-run merge showed the setup chain lands on `master` clean and
the ship chain then conflicts only on `apps/agentplexd/src/main.ts`, where both
chains add CLI wiring; whichever chain merges second carries that one small
resolution. `install.sh` (ship chain) executes `agentplexd setup`, which exists
only once the setup chain merges — stated in #61's body. Until both are in,
the bootstrap container check proves everything short of an interactive setup.

After the merges: delete the nine branches and their worktrees under
`~/Code/agentplex-worktrees`, and transition AGX-69 and AGX-71..78 in Jira.

## Pendings from the epic, in dependency order

### 1. The install.sh domain has a structure and no value

#61 settles the constraints (project-controlled, HTTPS, a version in the path)
in one constant held to the docs by a test, and today's value is the tag-pinned
repository path. The short domain is unregistered, and no unregistered host is
printed as a runnable command anywhere. Registering it and flipping the
constant is a one-line change plus a doc pass.

### 2. Nothing is published

`pnpm package` assembles the artifact and CI installs it in a bare container,
but `npm publish` has never run and there is no release workflow: no version
bump discipline, no tag-to-publish job, no provenance. The first real publish
should be its own ticket, because the account, the 2FA policy and the decision
of who can publish are organizational facts the repository cannot test.

### 3. The full bootstrap has never crossed the two chains

CI proves stock Debian to `doctor` reporting an installed, unauthenticated
provider (#61), and separately proves the wizard adopting, logging in and
pairing against fakes (#60, #62, #63). Nobody has run
`install.sh` into the *interactive* setup on one machine, because the two
halves live on different chains. Once both merge, extend the bootstrap
container check to drive the wizard over a pty the way
`setup-exit.integration.test.ts` already does natively — the pieces exist and
only the composition is untested.

### 4. `doctor` has never said `ready` in CI

A ready provider requires a real login, and no build environment holds
credentials. The container check deliberately asserts every state short of it.
This stays a manual verification on a credentialed machine until someone
decides whether CI should hold a provider credential, which is a security
decision, not a test-coverage one.

### 5. The `--system` path is verified by its artifacts only

Creating a service account and writing `/etc/systemd/system` on a development
machine is a change, not a test; #61 verified the rendered unit
(`systemd-analyze verify`, exit 0) and the plan. The fleet path needs one run
on a disposable systemd machine — the LXC the deployments doc describes is the
natural candidate.

### 6. Preflight is a boot-time fact

Provider readiness is probed at startup and carried into the handshake (#55),
so a machine reconfigured under a running service reports stale readiness
until restart. Deliberate — two spawns per provider on every session start
was rejected as the wrong cost — but the honest follow-up is a re-probe on a
refused start or a `doctor`-triggered refresh pushed through the existing
report path, so an operator can fix a machine without bouncing the service.

### 7. Version-manager shims are refused, not handled

The wizard refuses to adopt a copy that resolves but cannot answer a version
probe, and offers install or skip (#60). That is the honest floor. A later
ticket could record a shim's environment deliberately — asked of the person at
the terminal, stored beside the directory — but only if someone actually hits
this; do not build it on speculation.

## Product gaps

### 8. A remote server cannot be paired from the product at all

The settings screen has a pairing form (AGX-35) and the beacon fills in the
address (AGX-45/46), but the client frame union has no pair or unpair frame
and the HTTP surface is the health check and the ticket exchange —
`pairing-operations.ts` in the web app says exactly this in a comment, and the
hub's `registerServer`/`revokeServer` are still called only by tests. This is
finding 1 of the milestone 3 review, unmoved. AGX-61 raised its cost: the
deployments doc now describes the one-network story as beacon-assisted
pairing, and AGX-75 pairs the loopback server precisely because a pairing must
exist for the hub to dial — every path to a *second* machine dead-ends at a
form with nothing behind it. This is the single highest-value ticket the
backlog does not have.

### 9. The layout answer still over-claims

`discoverNodes` and `pruneNodes` remain unwired to the reducer's report seam
(milestone 3 review, finding 2), so a live hub answers layout requests with an
empty tree whatever exists. The split-pane client work (AGX-34) merged against
this. Wire discovery on arrival and prune on a whole report, or record the
decision not to.

### 10. The ticket endpoint is still unthrottled

Milestone 3 review, finding 3, restated: nothing limits attempts against
`POST /client/ticket`, so the long-lived client token can be guessed at
connection-accept rate. The epic made the hub installable on networks; the
counter-with-decay (or the reverse proxy doing it, made real in the compose
file) should land before anyone points this at a network they do not control.

### 11. The MCP endpoint is specified and absent

The spec commits to a same-origin, token-authed MCP endpoint; AGX-76 built the
same-origin half of that argument (the hub serves the UI) and calls itself the
prerequisite. The endpoint itself has no ticket. If MCP is still wanted, it
now has everything it was waiting for.

### 12. One provider adapter exists

The provider seam (adapter, provisioning, registry, fixtures) is plural
everywhere, and the UI happily renders a machine with a missing `codex` — but
`claude` is the only adapter in the tree. The second adapter is the test of
every "per-provider" decision this epic made (postinstall policy, login
driving, store discovery); until one exists, those seams are load-bearing
claims with a single data point.

### 13. Plain HTTP undermines the PWA off the loopback

The hub serves HTTP; TLS lives only in the Compose path's Caddy. On
`localhost` that is fine. On the one-network deployment the docs now describe,
a browser on another machine gets an insecure origin: no service worker, no
installability, and the PWA degrades to a tab. The install story and the PWA
story currently meet only on one box. Options worth arguing in a ticket:
document Caddy (or any terminating proxy) as part of the bare-metal network
deployment, or teach the hub TLS with an operator-supplied certificate. The
wrong outcome is discovering this in a support conversation.

### 14. Upgrades are an install with no story around it

`npm install --global agentplexd@<next>` plus forward-only migrations is a
sound mechanism, and `doctor` can say what is running — but nothing documents
the order (stop service, install, migrate-on-start, verify), and nothing
warns that a hub and a paired server on different protocol versions refuse
each other by design after an upgrade of one. A short upgrades section in
`docs/install.md` closes it; the refusal behavior already exists and is
correct.

## Milestone 3 review scorecard

Of its four findings: 1, 2 and 3 are open (restated above as gaps 8, 9, 10
with their costs updated); 4 — AGX-69 unmerged — is closed by #55.
