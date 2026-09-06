# Production image for the Mandate API.
#
#   docker build -f infra/docker/api.Dockerfile -t mandate-api .
#
# The build context is the REPOSITORY ROOT, not this directory: the API bundle is apps/api plus
# every packages/* workspace it imports, and a build cannot read above its own context.
#
# Bun installs and bundles -- it is the workspace's package manager and bun.lock is the only
# lockfile -- and Node runs the result, because `start:api` runs on Node and Node is the runtime
# the API's pool, signal handling and 15-second shutdown deadline were written and tested
# against. Running the bundle under Bun instead would be a different runtime with different
# stream and timer behaviour on the same untested code path.
#
# No secret is baked into any layer. Every setting is read from the environment at startup by
# packages/config, so no image layer holds a database URL, a Privy secret or a signing key; the
# ARGs below are versions, and the .dockerignore beside this file keeps .env and key material
# out of the build context entirely.

# Kept in step with the root package.json: `packageManager` pins bun exactly (the lockfile
# format is bun's own), and `engines.node` plus .node-version pin the Node major.
ARG BUN_VERSION=1.3.9
ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
# source -- repository sources with any host-built node_modules removed
# ---------------------------------------------------------------------------
#
# api.Dockerfile.dockerignore already excludes them, but only a BuildKit builder reads a
# Dockerfile-specific ignore file; an older or differently-configured builder looks for a
# .dockerignore at the context root, which this repository does not have. A developer's
# node_modules is a tree of symlinks into a macOS store that does not exist in this image, and
# COPY merges rather than replaces, so one of them landing on top of the installed tree produces
# an image that dies at its first import. Deleting them here makes the build independent of
# which builder ran it.
FROM oven/bun:${BUN_VERSION}-alpine AS source
WORKDIR /src
COPY . .
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && rm -rf .git apps/api/dist apps/worker/dist \
 && rm -f .env .env.*

# ---------------------------------------------------------------------------
# deps -- production dependency closure for the API
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app

# Manifests only, and taken from the build context rather than from `source`, so editing a .ts
# file does not invalidate the install layer. Every workspace member is listed even though the
# API's closure names seven: bun expands the `workspaces` globs before it compares against
# bun.lock, and a member whose package.json is absent reads as a lockfile change, which
# --frozen-lockfile refuses. A new workspace package therefore needs a line here.
COPY package.json bun.lock bunfig.toml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/auth/package.json ./packages/auth/
COPY packages/config/package.json ./packages/config/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/database/package.json ./packages/database/
COPY packages/evm/package.json ./packages/evm/
COPY packages/execution/package.json ./packages/execution/
COPY packages/observability/package.json ./packages/observability/
COPY packages/strategy/package.json ./packages/strategy/

# --filter is what keeps the browser out of the server image. Without it this installs the whole
# workspace -- Next, React, wagmi, the wallet SDKs -- measured at 1.8 GB against 240 MB for the
# API's own closure. The filter follows workspace dependency edges, so `./apps/api` alone pulls
# in what @mandate/auth, @mandate/database and the rest declare (verified: every third-party
# dependency named by apps/api and by packages/* resolves in the resulting tree).
#
# The whole closure is needed at runtime, not just apps/api's own dependencies: build-api.ts
# marks every non-workspace dependency of every workspace member as external, so the bundle
# still imports @privy-io/node, pg and viem from node_modules at startup.
#
# --ignore-scripts matches the install in docs/runbooks/api-local.md. Nothing in this closure
# needs a lifecycle script: the only native packages are bufferutil and utf-8-validate, which ws
# requires inside a try/catch and falls back to JavaScript for (they ship no linux-arm64
# prebuild at all, so that fallback is already the normal path on an ARM host).
#
# --linker=hoisted: bun's default isolated layout materialises two copies of viem for two peer
# resolutions -- 317 MB against 240 MB for the same packages -- and the isolation it buys is a
# development-time guarantee about undeclared imports, which a built bundle has already settled.
RUN bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted \
      --filter './apps/api'

# --production drops devDependencies, but two of them come back as optional PEER dependencies of
# production packages: drizzle-orm optionally peers on @electric-sql/pglite (the WASM PostgreSQL
# the tests run against, 25 MB), and abitype -- which viem depends on -- optionally peers on
# typescript (the compiler and its platform binary, 31 MB). Neither is reachable from the
# bundle: packages/database imports only drizzle-orm/node-postgres, .../migrator and pg-core,
# and a peer that exists to type an API is not something a running process loads. A production
# image has no business shipping a compiler and a second database engine.
#
# Removed by name rather than by a general reachability sweep: a sweep that guesses wrong fails
# with "Cannot find module" in production, while each of these three paths is individually
# justified above. Missing paths make this a no-op, so it cannot fail the build.
RUN rm -rf node_modules/@electric-sql/pglite node_modules/typescript node_modules/@typescript

# ---------------------------------------------------------------------------
# build -- bundle apps/api and the workspaces it imports into one file
# ---------------------------------------------------------------------------
FROM deps AS build

# tsconfig comes along because Bun reads it when it transpiles -- `target` decides
# useDefineForClassFields, and a future `paths` would decide resolution. Building without the
# file is building with different compiler defaults from `bun run build:api` on a laptop, which
# is exactly the kind of difference that only shows up in the image.
COPY --from=source /src/tsconfig.json /src/tsconfig.base.json ./
COPY --from=source /src/scripts ./scripts
COPY --from=source /src/packages ./packages
COPY --from=source /src/apps/api ./apps/api

# The repository's own build command, not a hand-rolled `bun build` line: build-api.ts decides
# what stays external, and an image that bundles differently from `bun run build:api` is an
# artifact nobody has tested.
RUN bun run build:api

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

# HOST especially: packages/config defaults it to 127.0.0.1, which is correct on a laptop and
# means "unreachable from outside" in a container. NODE_ENV=production is also load-bearing --
# it makes config reject a non-HTTPS APP_ORIGIN and ignore DEV_COUNTRY.
#
# --enable-source-maps because the artifact is a single generated file: without it every stack
# trace in production reads main.js:1:284913, and build:api already emits the map beside it.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# Left owned by root and run as `node`: the process can read its own bundle and cannot rewrite
# it, so a code-execution bug has no persistent foothold in the image. The application writes
# nothing to disk -- all state is in PostgreSQL and on chain.
COPY --from=deps /app/node_modules ./node_modules
# apps/api/package.json is not decoration: the bundle is ESM with a .js extension, and Node
# reads the nearest package.json to decide that. Without `"type": "module"` here the process
# fails at startup with ERR_REQUIRE_ESM.
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist

USER node

EXPOSE 8080

# /health, not /ready. Liveness answers "is this process still serving"; /ready also checks the
# database and Base RPC, and restarting the API does not fix either of those -- it just drops
# every in-flight request each time an upstream blips. Point the orchestrator's *readiness*
# probe at /ready instead; this HEALTHCHECK is what `docker ps` reports.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Exec form, so Node is PID 1 and receives SIGTERM directly: main.ts closes the HTTP server and
# the pool on that signal and gives itself 15 seconds. Run with a stop timeout above that
# (`docker run --stop-timeout 20`) or the daemon's default 10s SIGKILL truncates the drain.
STOPSIGNAL SIGTERM
CMD ["node", "apps/api/dist/main.js"]
