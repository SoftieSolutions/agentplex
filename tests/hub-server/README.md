# hub-server

The hub and the server in one process, so that the hub can be driven against
the real server end of its protocol.

Nothing imports an app, and these suites are the one exception, argued once:
a hub test that needs "a server to talk to" needs the server's own
`serveHubConnection` behind a fake session controller, because a second
implementation of the server's half of the protocol written for tests would
be a fake that drifts from the thing it stands in for. They load both apps
by relative path, the way `scripts/assemble-package.ts` composes their built
output by path, and they live here rather than in either app so that neither
app's source reaches the other's. `pnpm lint` allows the crossing in this
directory and nowhere else.
