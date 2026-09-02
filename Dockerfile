# syntax=docker/dockerfile:1

# One image, both roles. The role is a runtime choice — AGENTPLEX_ROLE, or a
# --role flag appended to `docker run` — because baking it in would give us two
# images of the same program and a way for them to drift apart.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Non-interactive corepack: without this it stops to ask before fetching pnpm,
# and a build has nobody to answer.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json .npmrc ./
# `corepack install` reads the version out of packageManager, so the pinned
# pnpm lives in exactly one place.
RUN corepack enable && corepack install

# Manifests before sources: the install layer is then reused across every edit
# that does not touch a dependency.
FROM base AS manifests
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/agentplexd/package.json ./apps/agentplexd/
COPY apps/web/package.json ./apps/web/
COPY packages/protocol/package.json ./packages/protocol/

# The full workspace: every dependency, every source file, everything built.
# This is what the test compose file runs its checks in, so a check in a
# container sees the same tree a check on a laptop does.
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# Typecheck and tests both resolve @agentplex/protocol through its built
# declarations, so the build is a precondition for checking, not a step after.
RUN pnpm build

# Runtime dependencies only, resolved on their own rather than pruned out of
# the build stage: a prune leaves whatever it failed to notice.
FROM manifests AS runtime-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter agentplexd...

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The workspace layout is kept rather than flattened: the dependency tree that
# pnpm linked is a web of relative symlinks, and it resolves only where it was
# linked. `migrations/` sits beside `dist/` because main.js resolves it as
# ../migrations relative to itself.
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/apps/agentplexd/node_modules ./apps/agentplexd/node_modules
COPY --from=runtime-deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY apps/agentplexd/package.json ./apps/agentplexd/
COPY packages/protocol/package.json ./packages/protocol/
COPY --from=build /app/apps/agentplexd/dist ./apps/agentplexd/dist
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY apps/agentplexd/migrations ./apps/agentplexd/migrations

# The node user ships with the image. A hub reads a database over the network
# and writes nothing to its own filesystem, so root buys it nothing.
USER node

EXPOSE 8080 8081

# The health check reads the same environment the process does, so a container
# that picks its role with a flag instead of AGENTPLEX_ROLE should set the env
# var too or its health will be measured on the wrong port.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "const role=process.env.AGENTPLEX_ROLE||'hub';const ports=[];if(role!=='server')ports.push(process.env.AGENTPLEX_HUB_PORT||'8080');if(role!=='hub')ports.push(process.env.AGENTPLEX_SERVER_PORT||'8081');Promise.all(ports.map((p)=>fetch('http://127.0.0.1:'+p+'/health').then((r)=>{if(!r.ok)throw new Error(p+' answered '+r.status);}))).then(()=>process.exit(0),(error)=>{console.error(String(error));process.exit(1);});"]

# Exec form, so node is pid 1 and Docker's SIGTERM reaches the handler in
# main.ts directly. Anything appended to `docker run` lands here as flags.
ENTRYPOINT ["node", "apps/agentplexd/dist/main.js"]
