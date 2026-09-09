/** Initialize the isolated Railway demo database over its private network. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectDatabase } from "../../packages/database/src/client.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

const bootstrap = process.env.DEMO_BOOTSTRAP_DATABASE_URL;
if (!bootstrap || process.env.MANDATE_DEMO !== "1")
  throw new Error("Demo bootstrap requires MANDATE_DEMO=1 and its database connection.");
const connection = connectDatabase(bootstrap);
try {
  await connection.pool.query(
    readFileSync(new URL("../../infra/postgres/01-roles.sql", import.meta.url), "utf8"),
  );
  for (const [role, key] of [
    ["mandate_owner", "DEMO_OWNER_PASSWORD"],
    ["mandate", "DEMO_API_PASSWORD"],
    ["mandate_worker", "DEMO_WORKER_PASSWORD"],
  ]) {
    const password = process.env[key!];
    if (!password || !/^[a-f0-9]{64}$/.test(password))
      throw new Error("Demo database password is missing or malformed.");
    await connection.pool.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
  }
  const owner = new URL(bootstrap);
  owner.username = "mandate_owner";
  owner.password = process.env.DEMO_OWNER_PASSWORD!;
  await migrateDatabase(
    owner.toString(),
    fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url)),
  );
  await connection.pool.query(
    readFileSync(new URL("../../infra/postgres/03-grants.sql", import.meta.url), "utf8"),
  );
  console.log("Demo database roles, migrations, and grants are ready.");
} catch {
  console.error("Demo database setup failed; check its private connection and role configuration.");
  process.exitCode = 1;
} finally {
  await connection.close();
}
