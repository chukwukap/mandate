import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

/**
 * Railway demo configuration. All application builds use the monorepo root.
 * Credentials and role-specific database URLs are configured privately in Railway.
 * The fork is uploaded separately from its prepared state snapshot.
 */
export default defineRailway(() => {
  const db = postgres("Postgres");

  const tooling = {
    RAILPACK_NODE_VERSION: "24",
    RAILPACK_INSTALL_COMMAND: "bun install --frozen-lockfile",
  };

  const api = service("api", {
    build: "bun run build:api",
    // Migrations run before the new release takes traffic, and as the OWNER role rather than the
    // runtime one. The runtime role is deliberately NOSUPERUSER/NOBYPASSRLS and does not own the
    // schema, because a role that owns its tables is exempt from the row-level security isolating
    // one user's strategies from another's — databaseReady() refuses to start against such a role.
    preDeploy: "node --import tsx scripts/database/migrate.ts",
    start: "node apps/api/dist/main.js",
    healthcheck: "/health",
    env: {
      ...tooling,
      NODE_ENV: preserve(),
      // Railway's proxy reaches the container over its private network, so binding the default
      // 127.0.0.1 would make the service unreachable while looking perfectly healthy in logs.
      HOST: "0.0.0.0",
      PORT: "8080",
      DATABASE_URL: preserve(),
      MIGRATION_DATABASE_URL: preserve(),
      BASE_RPC_URL: preserve(),
      APP_ORIGIN: preserve(),
      ELIGIBLE_COUNTRIES: preserve(),
      PRIVY_APP_ID: preserve(),
      PRIVY_APP_SECRET: preserve(),
      PRIVY_KEY_QUORUM_ID: preserve(),
      MANDATE_DEMO: preserve(),
      DEV_COUNTRY: preserve(),
      LOG_LEVEL: "info",
      API_DOCS: "0",
    },
  });

  const web = service("just-enjoyment", {
    source: github("chukwukap/mandate", { branch: "main", rootDirectory: "/" }),
    build: "bun run build:web",
    start: "node apps/web/node_modules/next/dist/bin/next start apps/web --hostname 0.0.0.0",
    healthcheck: "/welcome",
    env: {
      ...tooling,
      NODE_ENV: preserve(),
      // next.config.ts rewrites /api/mandate/:path* to this origin. The private domain keeps that
      // traffic inside Railway's network: it never leaves for the public internet, and the API
      // does not need a public domain of its own for the browser to reach it.
      MANDATE_API_URL: preserve(),
      // Public because the browser bundle needs it to start the Privy login flow. It is an app
      // identifier, not a secret; PRIVY_APP_SECRET is server-only and lives on the API.
      NEXT_PUBLIC_PRIVY_APP_ID: preserve(),
      NEXT_PUBLIC_DEMO_MODE: preserve(),
      PORT: "3000",
    },
  });

  const worker = service("worker", {
    build: "bun run build:worker",
    start: "node apps/worker/dist/main.js",
    env: {
      ...tooling,
      NODE_ENV: preserve(),
      DATABASE_URL: preserve(),
      APP_ORIGIN: preserve(),
      BASE_RPC_URL: preserve(),
      ELIGIBLE_COUNTRIES: preserve(),
      // Preserve the explicitly configured execution mode and Privy wallet authorization.
      WORKER_EXECUTE: preserve(),
      WORKER_IGNORE_SESSION: preserve(),
      MANDATE_DEMO: preserve(),
      PRIVY_APP_ID: preserve(),
      PRIVY_APP_SECRET: preserve(),
      PRIVY_AUTHORIZATION_KEY: preserve(),
      WORKER_POLL_MS: "2000",
      WORKER_MAX_BATCH: "10",
      WORKER_CONFIRMATIONS: "2",
      WORKER_RECEIPT_TIMEOUT_MS: "1800000",
      LOG_LEVEL: "info",
    },
  });

  const fork = service("fork", {
    env: { FORK_UPSTREAM_URL: preserve(), FORK_BLOCK_NUMBER: preserve() },
    volumeMounts: { "/data": volume("fork-volume", { sizeMB: 5000, region: "us-east4-eqdc4a" }) },
  });
  return project("Mandate - Base Builder Quest", { resources: [db, api, web, worker, fork] });
});
