import { test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { type Database, Repository, schema } from "../../packages/database/src/index.js";
import { loadConfig } from "../../packages/config/src/index.js";
import { buildApp } from "../../apps/api/src/app.js";
import { FakeChainClient, ACCOUNTS, SHIPPED_ASSETS } from "../fixtures/chain/index.js";

test("dump", async () => {
  const pg = new PGlite();
  const dir = new URL("../../packages/database/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort())
    await pg.exec(await readFile(new URL(f, dir), "utf8"));
  const db = drizzle(pg, { schema }) as unknown as Database;
  const repo = new Repository(db);
  const chain = new FakeChainClient();
  const config = loadConfig({
    NODE_ENV: "test", DATABASE_URL: "postgres://t:t@localhost/t", PRIVY_APP_ID: "t",
    PRIVY_APP_SECRET: "t", LOG_LEVEL: "silent", ELIGIBLE_COUNTRIES: "GB", DEV_COUNTRY: "GB",
    SPENDER_ADDRESS: ACCOUNTS.spender, API_DOCS: "1",
  });
  const app = await buildApp({
    config,
    auth: { authenticate: async () => ({ privyDid: "did:privy:a", sessionId: "s", wallets: [ACCOUNTS.user] }) },
    users: repo, databaseReady: async () => true, chainReady: () => chain.ready(),
    workerAvailable: async () => true,
    trading: { repository: repo, chain, assets: SHIPPED_ASSETS },
  });
  const doc = (await app.inject({ url: "/openapi.json" })).json();
  await Bun.write("/private/tmp/claude-502/-Users-ChukwukaUba-Documents-sch-onchain-analyst/9f7f5a4a-e868-42b1-936c-8a951dca6bab/scratchpad/openapi.json", JSON.stringify(doc, null, 2));
  const market = await app.inject({ url: "/v1/market" });
  await Bun.write("/private/tmp/claude-502/-Users-ChukwukaUba-Documents-sch-onchain-analyst/9f7f5a4a-e868-42b1-936c-8a951dca6bab/scratchpad/market.json", market.body);
  await app.close();
  await pg.close();
}, 60000);
