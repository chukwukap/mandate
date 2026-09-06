import { defineRailway, postgres, preserve, project, service } from "railway/iac";

/**
 * Mandate on Railway: one Postgres, one Fastify API, one Next.js web app, one worker.
 *
 * Every service builds from the repository root rather than its own directory. This is a Bun
 * workspace: apps/api imports @mandate/evm, @mandate/strategy and six other local packages, so a
 * build rooted at apps/api cannot resolve them. The root scripts already know how to build each
 * target into a single bundle, so they are used as-is instead of being restated here.
 *
 * No `source` is declared. This repository has no git remote, so there is nothing for Railway to
 * watch; deploys come from `railway up` at the repository root. Once the code is pushed to
 * GitHub, add `source: github("<owner>/<repo>", { branch: "master" })` to each service — note the
 * branch here is `master`, not `main`.
 *
 * Secrets are `preserve()`, never literals. That keeps private keys and API secrets out of the
 * repository while still declaring that the service requires them — an omitted variable is
 * indistinguishable from one nobody remembered, and this file is the list of what must be set.
 */
export default defineRailway(() => {
  const db = postgres("postgres");

  const api = service("api", {
    build: "npm run build:api",
    // Migrations run before the new release takes traffic, and as the OWNER role rather than the
    // runtime one. The runtime role is deliberately NOSUPERUSER/NOBYPASSRLS and does not own the
    // schema, because a role that owns its tables is exempt from the row-level security isolating
    // one user's strategies from another's — databaseReady() refuses to start against such a role.
    preDeploy: "npm run db:migrate",
    start: "npm run start:api",
    env: {
      NODE_ENV: "production",
      // Railway's proxy reaches the container over its private network, so binding the default
      // 127.0.0.1 would make the service unreachable while looking perfectly healthy in logs.
      HOST: "0.0.0.0",
      DATABASE_URL: db.env.DATABASE_URL,
      MIGRATION_DATABASE_URL: db.env.DATABASE_URL,
      BASE_RPC_URL: preserve(),
      APP_ORIGIN: preserve(),
      ELIGIBLE_COUNTRIES: preserve(),
      PRIVY_APP_ID: preserve(),
      PRIVY_APP_SECRET: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      ANTHROPIC_MODEL: preserve(),
      SPENDER_ADDRESS: preserve(),
      LOG_LEVEL: "info",
      API_DOCS: "0",
    },
  });

  const web = service("web", {
    build: "npm run build:web",
    start: "npm run start:web",
    env: {
      NODE_ENV: "production",
      // next.config.ts rewrites /api/mandate/:path* to this origin. The private domain keeps that
      // traffic inside Railway's network: it never leaves for the public internet, and the API
      // does not need a public domain of its own for the browser to reach it.
      MANDATE_API_URL: `http://${api.env.RAILWAY_PRIVATE_DOMAIN}:8080`,
      // Public because the browser bundle needs it to start the Privy login flow. It is an app
      // identifier, not a secret; PRIVY_APP_SECRET is server-only and lives on the API.
      NEXT_PUBLIC_PRIVY_APP_ID: preserve(),
    },
  });

  const worker = service("worker", {
    build: "npm run build:worker",
    start: "npm run start:worker",
    env: {
      NODE_ENV: "production",
      DATABASE_URL: db.env.DATABASE_URL,
      APP_ORIGIN: preserve(),
      BASE_RPC_URL: preserve(),
      ELIGIBLE_COUNTRIES: preserve(),
      // Off by default. The worker signs and broadcasts real transactions on Base when this is 1,
      // so switching it on is a deliberate act after the wallet is funded and the spender address
      // is confirmed — not something a first deploy should do on its own.
      WORKER_EXECUTE: "0",
      WORKER_PRIVATE_KEY: preserve(),
      SPENDER_ADDRESS: preserve(),
      WORKER_POLL_MS: "2000",
      WORKER_MAX_BATCH: "10",
      WORKER_CONFIRMATIONS: "3",
      WORKER_RECEIPT_TIMEOUT_MS: "1800000",
      LOG_LEVEL: "info",
    },
  });

  return project("mandate", { resources: [db, api, web, worker] });
});
