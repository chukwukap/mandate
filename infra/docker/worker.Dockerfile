# Production image for the Mandate worker.
#
#   docker build -f infra/docker/worker.Dockerfile -t mandate-worker .
#
# The build context is the REPOSITORY ROOT, not this directory: the worker bundle is apps/worker
# plus every packages/* workspace it imports, and a build cannot read above its own context.
#
# Deliberately a separate file from api.Dockerfile rather than one parameterised by a build ARG.
# The two differ in what they install, what they bundle, whether they expose a port and how they
# are probed -- and the entrypoint is the part an ARG cannot reach: an exec-form CMD does not
# interpolate build arguments, and rewriting it in shell form would put /bin/sh at PID 1, where
# SIGTERM stops at the shell and the worker never releases its leadership lease.
#
# This image is the one process in the system that can sign and broadcast. It still contains no
# key: WORKER_PRIVATE_KEY is read from the environment at startup, and with WORKER_EXECUTE unset
# no signer is constructed at all. Nothing here bakes a secret into a layer, and the
# .dockerignore beside this file keeps .env files and key material out of the build context.

# Kept in step with the root package.json: `packageManager` pins bun exactly (the lockfile
# format is bun's own), and `engines.node` plus .node-version pin the Node major.
ARG BUN_VERSION=1.3.9
ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
# source -- repository sources with any host-built node_modules removed
# ---------------------------------------------------------------------------
#
# worker.Dockerfile.dockerignore already excludes them, but only a BuildKit builder reads a
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
# deps -- production dependency closure for the worker
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app

# Manifests only, and taken from the build context rather than from `source`, so editing a .ts
# file does not invalidate the install layer. Every workspace member is listed even though the
# worker's closure names seven: bun expands the `workspaces` globs before it compares against
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

# The filter follows workspace dependency edges, so `./apps/worker` pulls in what
# @mandate/execution, @mandate/database and @mandate/evm declare and nothing else: 68 packages
# and 181 MB, against 1.8 GB for the unfiltered workspace. It also leaves out @mandate/auth,
# which the worker manifest does not name -- so @privy-io/node and the browser session code are
# absent from the one image that holds a signing key, which is worth more than the 8 MB.
#
# The closure is needed at runtime, not just to link: build-worker.ts marks every non-workspace
# dependency of every workspace member as external, so the bundle still imports pg, viem and
# pino from node_modules at startup.
#
# --ignore-scripts matches the install in docs/runbooks/worker-local.md. Nothing in this closure
# needs a lifecycle script: the only native packages are bufferutil and utf-8-validate, which ws
# requires inside a try/catch and falls back to JavaScript for (they ship no linux-arm64
# prebuild at all, so that fallback is already the normal path on an ARM host).
#
# --linker=hoisted: bun's default isolated layout materialises duplicate copies of viem for
# different peer resolutions and the isolation it buys is a development-time guarantee about
# undeclared imports, which a built bundle has already settled.
RUN bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted \
      --filter './apps/worker'

# --production drops devDependencies, but @electric-sql/pglite comes back as an optional PEER
# dependency of drizzle-orm (the WASM PostgreSQL the tests run against, 25 MB), and typescript
# with its platform binary comes back as an optional peer of abitype, under viem (31 MB).
# Neither is reachable from the bundle: packages/database imports only
# drizzle-orm/node-postgres, .../migrator and pg-core, and a peer that exists to type an API is
# not something a running process loads. The one process that signs transactions should not
# also carry a compiler and a second database engine it never opens.
#
# Removed by name rather than by a general reachability sweep: a sweep that guesses wrong fails
# with "Cannot find module" in production, while each of these three paths is individually
# justified above. Missing paths make this a no-op, so it cannot fail the build.
RUN rm -rf node_modules/@electric-sql/pglite node_modules/typescript node_modules/@typescript

# ---------------------------------------------------------------------------
# build -- bundle apps/worker and the workspaces it imports into one file
# ---------------------------------------------------------------------------
FROM deps AS build

# tsconfig comes along because Bun reads it when it transpiles -- `target` decides
# useDefineForClassFields, and a future `paths` would decide resolution. Building without the
# file is building with different compiler defaults from `bun run build:worker` on a laptop.
COPY --from=source /src/tsconfig.json /src/tsconfig.base.json ./
COPY --from=source /src/scripts ./scripts
COPY --from=source /src/packages ./packages
COPY --from=source /src/apps/worker ./apps/worker

# The repository's own build command, not a hand-rolled `bun build` line: build-worker.ts
# decides what stays external, and an image that bundles differently from
# `bun run build:worker` is an artifact nobody has tested.
RUN bun run build:worker

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

# No HOST or PORT: the worker has no listener. WORKER_EXECUTE is deliberately NOT set here --
# loadWorkerConfig defaults it to off, so an image that starts with an incomplete environment
# observes and records signals rather than signing anything. Turning it on is a decision made
# per deployment, together with WORKER_PRIVATE_KEY, SPENDER_ADDRESS and ELIGIBLE_COUNTRIES.
#
# --enable-source-maps because the artifact is a single generated file: without it every stack
# trace in production reads main.js:1:284913, and build:worker already emits the map beside it.
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# Left owned by root and run as `node`: the process can read its own bundle and cannot rewrite
# it, so a code-execution bug has no persistent foothold in the image of the process that holds
# the signing key. The worker writes nothing to disk -- its durable state is the database.
COPY --from=deps /app/node_modules ./node_modules
# apps/worker/package.json is not decoration: the bundle is ESM with a .js extension, and Node
# reads the nearest package.json to decide how to parse that. Without `"type": "module"` here
# it is loaded as CommonJS and dies on the first line: "Cannot use import statement outside a
# module".
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY --from=build /app/apps/worker/dist ./apps/worker/dist

USER node

# No HEALTHCHECK on purpose. The worker serves nothing to probe, and the questions worth asking
# -- is it the leader, is it keeping up, is an execution stuck -- are answered from the database
# it shares: worker_state's heartbeat, the API's /ready `execution_available`, and the aggregate
# functions in infra/postgres/04-metrics.sql. A container-local check could only report that the
# process exists, which Docker already knows, and a wrong one restarts a process that is holding
# an advisory lock through a reconciliation.

# Exec form, so Node is PID 1 and receives SIGTERM directly: main.ts aborts the cycle, releases
# the leadership lease and closes the pool on that signal, and hard-exits after 30 seconds if
# that stalls. Run with a stop timeout above that (`docker run --stop-timeout 40`); the daemon's
# default 10s SIGKILL leaves the lease to expire on its own, which delays the next worker's
# takeover, and can orphan a broadcast transaction until reconciliation picks it up.
STOPSIGNAL SIGTERM
CMD ["node", "apps/worker/dist/main.js"]
